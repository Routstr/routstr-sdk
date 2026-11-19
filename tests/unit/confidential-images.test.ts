/**
 * Confidential image generation: the offer's `images` block, the pinned
 * suffix (byte-exact with the relay), the request split and variant choice,
 * the flat receipt check, and the image session's setup frame.
 */

import { describe, expect, it, vi } from "vitest";
import { VENICE_CHAT } from "./fixtures/chat";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import { canonicalJson } from "../../client/confidential/canonical";
import {
  imageCountKeyForRoute,
  imagesOfferProblem,
  offerSupportsImages,
  renderImageSuffix,
  validateImagesOffer,
  validateOfferShape,
  verifyConfidentialOffer,
  type ConfidentialImagesOffer,
} from "../../client/confidential/offer";
import { confidentialKind } from "../../client/confidential/endpoints";
import { verifyFlatReceipt } from "../../client/confidential/receipt";
import {
  isConfidentialEndpoint,
  isConfidentialImageEndpoint,
  planImageRequest,
} from "../../client/confidential/transport";
import { ConfidentialConnection } from "../../client/confidential/connection";
import { imageOutcome } from "../../client/confidential/wire";
import { CuProverBackend } from "../../client/confidential/prover";
import { ConfidentialError, ReceiptVerificationError, SessionProtocolError } from "../../client/confidential/errors";
import { confidentialImageRequiredSats } from "../../client/RoutstrClient";

const FIXED: [string, unknown][] = [
  ["return_binary", false],
  ["enhance_prompt", false],
  ["enable_web_search", false],
  ["style_references", []],
];

const IMAGES: ConfidentialImagesOffer = {
  head_template:
    "POST /api/v1/image/generate HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
  response_shape: "venice",
  response_idle_s: 300,
  max_count: 4,
  count_key: "variants",
  fixed_pins: FIXED,
  param_space: { resolution: ["1K", "2K", "4K"], quality: ["low", "medium", "high"], format: ["webp"] },
  price_list: {
    "z-image-turbo": [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 12100 }],
    "nano-banana-pro": [
      { id: "1K-webp", pins: [["resolution", "1K"], ["format", "webp"]], msat_per_image: 217800 },
      { id: "2K-webp", pins: [["resolution", "2K"], ["format", "webp"]], msat_per_image: 278300 },
    ],
  },
};

function signedOffer(overrides: Record<string, unknown> = {}) {
  const priv = new Uint8Array(32).fill(7);
  const pubHex = bytesToHex(schnorr.getPublicKey(priv));
  const offer: Record<string, unknown> = {
    v: 3,
    twopc: "split-public-1",
    upstream_host: "api.venice.ai",
    notary_pubkey: pubHex,
    max_tokens_cap: 4096,
    key_length: 42,
    key_alphabet: "[A-Za-z0-9_-]",
    head_template:
      "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
    suffix_keys: ["model", "max_tokens", "max_completion_tokens", "n", "stream", "stream_options", "venice_parameters"],
    chat: VENICE_CHAT,
    price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
    capabilities: ["chat", "images"],
    images: IMAGES,
    ...overrides,
  };
  const payload = canonicalJson(offer);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
  return { offer: { ...offer, sig, sig_payload: payload }, pubHex };
}

describe("image suffix", () => {
  it("renders the contract's test vector byte for byte", () => {
    expect(renderImageSuffix("z-image-turbo", 2, "variants", FIXED, [["format", "webp"]])).toBe(
      ',"model":"z-image-turbo","variants":2,"return_binary":false,"enhance_prompt":false,"enable_web_search":false,"style_references":[],"format":"webp"}',
    );
  });
});

describe("offer images block", () => {
  it("verifies a signed offer with the images capability", () => {
    const { offer, pubHex } = signedOffer();
    const v = verifyConfidentialOffer(offer, { pinnedPubkey: pubHex, trustedHosts: ["api.venice.ai"] });
    expect(offerSupportsImages(v)).toBe(true);
    const { offer: chatOnly } = signedOffer({ capabilities: ["chat"] });
    expect(offerSupportsImages(chatOnly as never)).toBe(false);
  });

  it("refuses malformed image terms", () => {
    const base = signedOffer().offer;
    const bad = (images: unknown) => () => validateImagesOffer(images, "api.venice.ai");
    const variant = (v: Record<string, unknown>) => ({ ...IMAGES, price_list: { m: [{ id: "a", pins: [], msat_per_image: 1, ...v }] } });
    expect(bad({ ...IMAGES, count_key: "" })).toThrow(/count_key/);
    expect(bad({ ...IMAGES, fixed_pins: [["variants", false]] })).toThrow(/fixed_pins/);
    expect(bad({ ...IMAGES, fixed_pins: [["model", false]] })).toThrow(/fixed_pins/);
    expect(bad({ ...IMAGES, response_shape: "png" })).toThrow(/response_shape/);
    expect(bad(variant({ msat_per_image: -1 }))).toThrow(/msat_per_image/);
    expect(bad({ ...IMAGES, price_list: { m: [] } })).toThrow(/no variants/);
    expect(() => validateOfferShape({ ...base, capabilities: "images" })).toThrow(/capabilities/);
    // Fixed pins only switch extras off.
    for (const v of [true, 1, "x", ["u"], { a: 1 }, null]) {
      expect(bad({ ...IMAGES, fixed_pins: [["enable_web_search", v]] })).toThrow(/switched off/);
    }
    expect(bad({ ...IMAGES, fixed_pins: [["embed_exif_metadata", true]] })).toThrow(/switched off/);
    // Variant pins only choose a published tier or the format.
    expect(bad(variant({ pins: [["return_binary", true]] }))).toThrow(/fixed key/);
    expect(bad(variant({ pins: [["aspect_ratio", "1:1"]] }))).toThrow(/price tier or the format/);
    expect(bad(variant({ pins: [["safe_mode", "off"]] }))).toThrow(/price tier or the format/);
    expect(bad(variant({ pins: [["resolution", "8K"]] }))).toThrow(/param_space/);
    expect(bad(variant({ pins: [["resolution", 1]] }))).toThrow(/param_space/);
    expect(bad(variant({ pins: [["format", "png"]] }))).toThrow(/param_space/);
    expect(bad({ ...IMAGES, param_space: undefined })).toThrow(/param_space/);
    expect(bad({ ...IMAGES, param_space: { format: [1] } })).toThrow(/param_space/);
    // Bounded numbers.
    expect(bad(variant({ msat_per_image: 1.5 }))).toThrow(/msat_per_image/);
    expect(bad(variant({ msat_per_image: 0 }))).toThrow(/msat_per_image/);
    expect(bad(variant({ max_count: 5 }))).toThrow(/max_count/);
    expect(bad(variant({ max_count: 0 }))).toThrow(/max_count/);
    expect(bad({ ...IMAGES, max_count: 5 })).toThrow(/max_count/);
    expect(bad({ ...IMAGES, max_count: 1000 })).toThrow(/max_count/);
    for (const idle of [1, 29, 601, 30.5]) expect(bad({ ...IMAGES, response_idle_s: idle })).toThrow(/response_idle_s/);
    expect(bad({ ...IMAGES, price_list: { m: [{ id: "a", pins: [], msat_per_image: 1 }, { id: "a", pins: [], msat_per_image: 2 }] } })).toThrow(
      /unique id/,
    );
    // A plain request head to the image endpoint.
    const tpl = IMAGES.head_template;
    for (const t of [
      tpl.replace("/api/v1/image/generate", "/api/v1/image/generate?store=1"),
      tpl.replace("/api/v1/image/generate", "/api/v1/chat/completions"),
      tpl.replace("Connection: close\r\n", "Expect: 100-continue\r\nConnection: close\r\n"),
      tpl.replace("Accept-Encoding: identity", "Accept-Encoding: gzip"),
      tpl.replace("Connection: close", "Connection: keep-alive"),
      tpl.replace("Connection: close\r\n", ""),
    ]) {
      expect(bad({ ...IMAGES, head_template: t })).toThrow(/head_template/);
    }
    expect(imagesOfferProblem(IMAGES, "api.venice.ai")).toBeUndefined();
  });

  it("drops a refused images block without refusing chat", () => {
    const { offer, pubHex } = signedOffer({ images: { ...IMAGES, fixed_pins: [["enable_web_search", true]] } });
    const v = verifyConfidentialOffer(offer, { pinnedPubkey: pubHex, trustedHosts: ["api.venice.ai"] });
    expect(offerSupportsImages(v)).toBe(false);
    expect(v.imagesRefused).toMatch(/switched off/);
    expect(v.price_list.cheap).toBeDefined();
  });
});

describe("image request split", () => {
  const parse = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;

  it("pins model, count and variant; keeps the prompt and price-free options private", () => {
    const plan = planImageRequest(
      {
        model: "nano-banana-pro",
        prompt: "a bakery",
        aspect_ratio: "16:9",
        resolution: "2k",
        n: 2,
        size: "2048x2048",
        response_format: "b64_json",
      },
      IMAGES,
    );
    expect(plan.variant.id).toBe("2K-webp");
    expect(plan.count).toBe(2);
    const text = new TextDecoder().decode(plan.body);
    expect(text.endsWith(plan.suffix)).toBe(true);
    const body = parse(plan.body);
    expect(body).toMatchObject({
      prompt: "a bakery",
      aspect_ratio: "16:9",
      model: "nano-banana-pro",
      variants: 2,
      resolution: "2K",
      format: "webp",
      enhance_prompt: false,
    });
    // Selector keys choose the variant; they never reach the provider privately.
    for (const k of ["n", "size", "response_format"]) expect(body).not.toHaveProperty(k);
    // The paid extra appears once, pinned off in the suffix.
    expect(text.match(/enhance_prompt/g)).toHaveLength(1);
  });

  it("refuses a caller who sets a key the offer pins, or buys a tier privately", () => {
    const plan = (r: Record<string, unknown>) => () => planImageRequest({ prompt: "x", ...r }, IMAGES);
    expect(plan({ model: "z-image-turbo", enhance_prompt: true })).toThrow(/fixed by the node's offer/);
    expect(plan({ model: "nano-banana-pro", width: 2048, height: 2048 })).toThrow(/priced by resolution tier/);
    expect(plan({ model: "z-image-turbo", quality: "high" })).toThrow(/no quality tiers/);
  });

  it("maps an OpenAI size to its resolution class and picks the cheapest open tier", () => {
    expect(planImageRequest({ model: "nano-banana-pro", prompt: "x", size: "1024x1536" }, IMAGES).variant.id).toBe(
      "1K-webp",
    );
    expect(planImageRequest({ model: "nano-banana-pro", prompt: "x" }, IMAGES).variant.id).toBe("1K-webp");
    // A model without tiers takes any size; its price does not depend on it.
    const flat = planImageRequest({ model: "z-image-turbo", prompt: "x", size: "4096x4096" }, IMAGES);
    expect(flat.variant.id).toBe("webp");
    expect(flat.count).toBe(1);
  });

  it("refuses what the offer does not price, instead of substituting", () => {
    const plan = (r: Record<string, unknown>) => () => planImageRequest({ prompt: "x", ...r }, IMAGES);
    expect(plan({ model: "nano-banana-pro", resolution: "4K" })).toThrow(/no confidential nano-banana-pro variant/);
    expect(plan({ model: "z-image-turbo", output_format: "png" })).toThrow(/WebP only/);
    expect(plan({ model: "z-image-turbo", n: 5 })).toThrow(/1 to 4 images/);
    expect(plan({ model: "z-image-turbo", n: 0 })).toThrow(ConfidentialError);
    expect(plan({ model: "flux" })).toThrow(/does not generate flux/);
  });

  it("routes the image endpoints, and only those, to image sessions", () => {
    expect(isConfidentialImageEndpoint("POST", "/v1/images/generations")).toBe(true);
    expect(isConfidentialImageEndpoint("POST", "/v1/image/generate")).toBe(true);
    expect(isConfidentialImageEndpoint("GET", "/v1/images/generations")).toBe(false);
    expect(isConfidentialImageEndpoint("POST", "/v1/images/edits")).toBe(false);
    expect(isConfidentialEndpoint("POST", "/v1/images/generations")).toBe(false);
    // The client's pre-spend check and the transport read one definition.
    for (const [path, kind] of [
      ["/v1/chat/completions", "chat"],
      ["/chat/completions/?x=1", "chat"],
      ["/v1/images/generations", "images"],
      ["/image/generate/", "images"],
      ["/v1/images/edits", undefined],
      ["/v1/v1/chat/completions", undefined],
      ["/v1/responses", undefined],
    ] as const) {
      expect(confidentialKind(path), path).toBe(kind);
      expect(isConfidentialEndpoint("POST", path), path).toBe(kind === "chat");
      expect(isConfidentialImageEndpoint("POST", path), path).toBe(kind === "images");
    }
  });
});

describe("image outcome", () => {
  it("accepts only a 2xx, discloses an error head, refuses anything else", () => {
    for (const s of [200, 201, 299]) expect(imageOutcome(s)).toBe("accept");
    for (const s of [400, 402, 429, 500, 503, 504]) expect(imageOutcome(s)).toBe("disclose");
    for (const s of [0, 100, 199, 301, 302, 304, 399]) expect(imageOutcome(s)).toBe("refuse");
  });
});

describe("flat receipt", () => {
  const own = { model: "nano-banana-pro", variant: "1K-webp", count: 2, msatPerImage: 217800, sessionFeeMsat: 100 };
  const receipt = (o: Record<string, unknown> = {}) =>
    ({
      sid: "s",
      kind: "images",
      model: "nano-banana-pro",
      variant: "1K-webp",
      count: 2,
      msat_per_image: 217800,
      usage: { flat: true },
      cost_msats: 2 * 217800 + 100,
      session_fee_msat: 100,
      ...o,
    }) as never;

  it("accepts exactly price × count + session fee", () => {
    expect(() => verifyFlatReceipt(receipt(), own)).not.toThrow();
  });

  it("refuses any other cost, price, variant, count or kind", () => {
    for (const o of [
      { cost_msats: 2 * 217800 + 101 },
      { cost_msats: 2 * 217800 },
      { cost_msats: undefined },
      { msat_per_image: 217801 },
      { variant: "2K-webp" },
      { count: 1 },
      { kind: "chat" },
      { usage: { prompt_tokens: 1 } },
      { model: "z-image-turbo" },
      { session_fee_msat: 200 },
    ]) {
      expect(() => verifyFlatReceipt(receipt(o), own)).toThrow(ReceiptVerificationError);
    }
  });
});

describe("the image count key", () => {
  const bad = (images: unknown) => () => validateImagesOffer(images, "api.venice.ai");
  const OPENAI_ROUTE = IMAGES.head_template.replace("/api/v1/image/generate", "/api/v1/images/generations");

  it("is the one the endpoint reads: variants for /image/generate, n for /images/generations", () => {
    expect(imageCountKeyForRoute(IMAGES.head_template)).toBe("variants");
    expect(imageCountKeyForRoute(OPENAI_ROUTE)).toBe("n");
    expect(imageCountKeyForRoute("POST /api/v1/other HTTP/1.1\r\n")).toBeUndefined();
    expect(bad(IMAGES)).not.toThrow();
    expect(bad({ ...IMAGES, head_template: OPENAI_ROUTE, count_key: "n" })).not.toThrow();
  });

  it("refuses a count key the provider would not read", () => {
    // The count is pinned under this key and the price is count × the image
    // price: under a key the endpoint ignores the provider makes one image
    // and the client pays for four.
    expect(bad({ ...IMAGES, count_key: "x_unused" })).toThrow(/count_key/);
    expect(bad({ ...IMAGES, count_key: "n" })).toThrow(/count_key/);
    expect(bad({ ...IMAGES, head_template: OPENAI_ROUTE })).toThrow(/count_key/);
    expect(bad({ ...IMAGES, head_template: OPENAI_ROUTE, count_key: "variants" })).toThrow(/count_key/);
    // A signed offer with such a block serves no confidential images (chat is unaffected).
    const { offer, pubHex } = signedOffer({ images: { ...IMAGES, count_key: "x_unused" } });
    const verified = verifyConfidentialOffer(offer, { pinnedPubkeys: [pubHex], trustedHosts: ["*.venice.ai"] });
    expect(offerSupportsImages(verified)).toBe(false);
    expect(Object.keys(verified.price_list)).toEqual(["cheap"]);
  });
});

describe("node offer defaults and rounding", () => {
  it("defaults the count key to variants and accepts param_space and fractional prices", () => {
    const { count_key: _omit, ...noKey } = IMAGES;
    const images = {
      ...noKey,
      param_space: { resolution: ["1K", "2K"], format: ["webp"] },
      price_list: { "z-image-turbo": [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 12100.5 }] },
    };
    const base = signedOffer().offer;
    expect(() => validateOfferShape({ ...base, images })).not.toThrow();
    const plan = planImageRequest({ model: "z-image-turbo", prompt: "x", n: 3 }, images as never);
    expect(plan.suffix).toContain('"variants":3');
  });

  it("rounds a fractional flat charge up, as the node does", () => {
    const own = { model: "m", variant: "webp", count: 3, msatPerImage: 12100.5, sessionFeeMsat: 0 };
    const r = (cost: number) =>
      ({ sid: "s", kind: "images", model: "m", variant: "webp", count: 3, msat_per_image: 12100.5, usage: { flat: true }, cost_msats: cost }) as never;
    expect(() => verifyFlatReceipt(r(36302), own)).not.toThrow();
    expect(() => verifyFlatReceipt(r(36301), own)).toThrow(ReceiptVerificationError);
  });
});

describe("image deposit", () => {
  it("is the selected variant times the count plus the larger fee", () => {
    const offer = { images: IMAGES, session_fee_msat: 0, abandon_fee_msat: 2000 } as never;
    // No tier asked: the request takes the cheapest (1K), and so does the deposit.
    expect(confidentialImageRequiredSats(offer, "nano-banana-pro", { prompt: "p", n: 2 })).toBe(Math.ceil((2 * 217800 + 2000) / 1000));
    expect(confidentialImageRequiredSats(offer, "nano-banana-pro", { prompt: "p", n: 2, resolution: "2K" })).toBe(
      Math.ceil((2 * 278300 + 2000) / 1000),
    );
    // A request the offer cannot serve is refused here, before a deposit is spent on it.
    expect(() => confidentialImageRequiredSats(offer, "nano-banana-pro", { prompt: "p", resolution: "4K" })).toThrow(
      /no confidential nano-banana-pro variant/,
    );
    expect(() => confidentialImageRequiredSats(offer, "nano-banana-pro", { prompt: "p", n: 9 })).toThrow(/1 to 4 images/);
    expect(confidentialImageRequiredSats(offer, "z-image-turbo", { prompt: "p" })).toBe(Math.ceil((12100 + 2000) / 1000));
    expect(confidentialImageRequiredSats(offer, "unknown", {})).toBeUndefined();
    expect(confidentialImageRequiredSats(undefined, "z-image-turbo", {})).toBeUndefined();
  });
});

describe("image session", () => {
  const opts = (extra: Record<string, unknown> = {}) =>
    ({
      baseUrl: "http://127.0.0.1:8010",
      offer: signedOffer().offer,
      framing: "1.1",
      auth: "sk-x",
      prover: {},
      ...extra,
    }) as never;
  const enc = (t: string) => new TextEncoder().encode(t);
  /** An armed connection whose network side never runs. */
  const armed = (extra: Record<string, unknown> = {}) => {
    const c = new ConfidentialConnection(opts(extra)) as any;
    c.phaseNow = "armed";
    const run = vi.spyOn(c, "runRequest11").mockReturnValue(new Promise(() => {}));
    return { c, run };
  };
  const suffixOf = (variant: [string, unknown][], count: number) =>
    renderImageSuffix("nano-banana-pro", count, "variants", FIXED, variant);
  const ask = (c: any, image: { variant: string; count: number }, suffix: string) =>
    c.request({ model: "nano-banana-pro", maxTokens: 0, image, body: enc(`{"prompt":"x"${suffix}`) });

  it("a request's image terms are checked against the signed offer, and its body must end with the offer's suffix", () => {
    const K2: [string, unknown][] = [["resolution", "2K"], ["format", "webp"]];
    const good = armed();
    expect(() => ask(good.c, { variant: "2K-webp", count: 3 }, suffixOf(K2, 3))).not.toThrow();
    // The suffix handed to the request's run is the offer's rendering.
    expect(new TextDecoder().decode(good.run.mock.calls[0]![1] as Uint8Array)).toBe(suffixOf(K2, 3));
    // Another count in the body than the request names: refused before anything is sent.
    expect(() => ask(armed().c, { variant: "2K-webp", count: 2 }, suffixOf(K2, 3))).toThrow(/does not end with the pinned suffix/);
    expect(() => ask(armed().c, { variant: "4K-webp", count: 1 }, suffixOf(K2, 1))).toThrow(SessionProtocolError);
    expect(() => ask(armed().c, { variant: "1K-webp", count: 5 }, suffixOf(K2, 5))).toThrow(/outside 1..4/);
    expect(() =>
      ask(armed({ offer: signedOffer({ capabilities: ["chat"] }).offer }).c, { variant: "2K-webp", count: 1 }, suffixOf(K2, 1)),
    ).toThrow(/serves no image requests/);
    // A variant's own count cap is below the offer's.
    const K4: [string, unknown][] = [["resolution", "4K"], ["format", "webp"]];
    const capped = {
      ...IMAGES,
      price_list: { ...IMAGES.price_list, "nano-banana-pro": [{ id: "4K-webp", pins: K4, msat_per_image: 400000, max_count: 1 }] },
    };
    const cappedOffer = signedOffer({ images: capped }).offer;
    expect(() => ask(armed({ offer: cappedOffer }).c, { variant: "4K-webp", count: 2 }, suffixOf(K4, 2))).toThrow(/outside 1..1/);
    expect(() => ask(armed({ offer: cappedOffer }).c, { variant: "4K-webp", count: 1 }, suffixOf(K4, 1))).not.toThrow();
    // An offer that did not go through verification is held to the same shape.
    const hostile = signedOffer({ images: { ...IMAGES, fixed_pins: [["enable_web_search", true]] } }).offer;
    expect(() => ask(armed({ offer: hostile }).c, { variant: "2K-webp", count: 3 }, suffixOf(K2, 3))).toThrow(/switched off/);
  });

  it("framing 2 serves images only when the offer's h2.kinds lists them", () => {
    const h2 = { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 100 };
    const chatOnly = signedOffer({ http: ["2", "1.1"], h2 }).offer;
    const c = new ConfidentialConnection(opts({ offer: chatOnly, framing: "2" })) as any;
    c.phaseNow = "ready";
    expect(() => ask(c, { variant: "2K-webp", count: 1 }, suffixOf([["resolution", "2K"], ["format", "webp"]], 1))).toThrow(
      /no image requests on framing "2"/,
    );
  });

  it("the setup names the framing and the credential, never a request's terms (§12.3)", async () => {
    const realWs = (globalThis as any).WebSocket;
    const sent: Record<string, unknown>[] = [];
    (globalThis as any).WebSocket = class {
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) {
        sent.push({ url });
        setTimeout(() => this.onopen?.(), 0);
      }
      send(d: string) {
        sent.push(JSON.parse(d));
        // A node error ends the connection after the setup was seen.
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "error", reason: "test" }) }), 0);
      }
      close() {}
    };
    try {
      for (const prewarm of [false, true]) {
        sent.length = 0;
        const conn = new ConfidentialConnection(
          opts({ prover: new CuProverBackend({ binaryPath: process.execPath }), twoPcFactory: () => ({}) as never }),
        );
        await expect(conn.arm(prewarm)).rejects.toThrow(/node rejected/);
        expect(String(sent[0]!.url)).toMatch(/\/v1\/confidential\/ws\?session_id=[0-9a-f-]{36}&v=3$/);
        const setup = sent[1]!;
        expect(Object.keys(setup).sort()).toEqual(["armed", "auth", "http", "nonce_c", "offer_sig", "type", "v"]);
        expect(setup).toMatchObject({ type: "setup", v: 3, http: "1.1", armed: prewarm, auth: "sk-x" });
        expect(setup.nonce_c).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      (globalThis as any).WebSocket = realWs;
    }
  });
});
