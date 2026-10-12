/**
 * Confidential-upstream SDK unit tests.
 *
 * Covers offer signature verification (good/bad), npub pinning, protocol
 * version negotiation, trusted-host matching, canonical suffix bytes,
 * receipt verification and the confidential transport's body handling. Fixtures are a real
 * v2 offer recorded from a production node (routstr-core branch `confidential-2pc`) and a
 * real offer from an older node running the retired protocol v1 (refused).
 */

import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";

import {
  canonicalJson,
  npubToHex,
  verifySchnorrSignature,
} from "../../client/confidential/canonical";
import {
  canonicalSuffix,
  effectiveModelFromText,
  extractUsageDisclosure,
  parseHttpResponse,
  usageEventFromDisclosure,
} from "../../client/confidential/suffix";
import {
  verifyConfidentialOffer,
  verifyOfferSignature,
  supportedVersion,
} from "../../client/confidential/offer";
import {
  feeOnlyChargeOk,
  maxChargeMsats,
  checkAttestationBinding,
  parseSignedReceipt,
  verifyReceipt,
} from "../../client/confidential/receipt";
import {
  offerAbandonFeeMsat,
  offerSessionFeeMsat,
  validateOfferShape,
} from "../../client/confidential/offer";
import { confidentialRequiredSats } from "../../client/RoutstrClient";
import {
  aggregateChatCompletionSse,
  buildPinnedBody,
  fetchConfidential,
  isConfidentialEndpoint,
  SseDoneHoldback,
} from "../../client/confidential/transport";
import { ReceiptVerificationError } from "../../client/confidential/errors";
import { ConfidentialSession } from "../../client/confidential/session";
import {
  TrustedHostMatcher,
  matchHostname,
  normalizeHostname,
  parseTrustedHostPattern,
  encryptedNodeTransport,
} from "../../client/confidential/hosts";
import {
  OfferBadSignatureError,
  OfferMalformedError,
  OfferPinMismatchError,
  OfferUnpinnedError,
  OfferUnsupportedVersionError,
  TrustedHostError,
} from "../../client/confidential/errors";

import offerFixture from "../fixtures/confidential/venice-offer.json";
import offerFixtureV1 from "../fixtures/confidential/venice-offer-v1.json";

const OFFER = offerFixture as unknown as Record<string, unknown>;
/** A real offer from a node that still ran the retired protocol v1. */
const OFFER_V1 = offerFixtureV1 as unknown as Record<string, unknown>;

function makeKey() {
  const priv = new Uint8Array(32).fill(7);
  const pub = schnorr.getPublicKey(priv);
  return { priv, pubHex: bytesToHex(pub) };
}

/** Build an offer signed the way the node does: BIP-340 over sha256(canonical). */
function signedOffer(overrides: Record<string, unknown> = {}) {
  const { priv, pubHex } = makeKey();
  const offer: Record<string, unknown> = {
    v: 2,
    min_v: 2,
    max_v: 2,
    upstream_host: "api.venice.ai",
    ws: "wss://node.example/v1/confidential/ws",
    notary_pubkey: pubHex,
    max_tokens_cap: 4096,
    key_length: 42,
    key_alphabet: "[A-Za-z0-9_-]",
    head_template:
      "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\nContent-Length: {LEN}\r\n\r\n",
    suffix_keys: ["model", "max_tokens", "stream"],
    price_list: {
      cheap: { in: 1000, cached_in: 1000, out: 1000 },
      dear: { in: 2000, cached_in: 2000, out: 4000 },
    },
    mints: ["https://mint.example/"],
    ...overrides,
  };
  const payload = canonicalJson(offer);
  const digest = sha256(utf8ToBytes(payload));
  const sig = bytesToHex(schnorr.sign(digest, priv));
  return { offer: { ...offer, sig, sig_payload: payload }, priv, pubHex };
}

describe("canonical JSON + Schnorr", () => {
  it("serializes with sorted keys and no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("verifies a good signature", () => {
    const { offer } = signedOffer();
    expect(verifyOfferSignature(offer as never)).toBe(true);
  });

  it("rejects a tampered signed payload", () => {
    const { offer } = signedOffer();
    const payload = (offer as Record<string, unknown>).sig_payload as string;
    (offer as Record<string, unknown>).sig_payload = payload.replace("api.venice.ai", "evil.example");
    expect(verifyOfferSignature(offer as never)).toBe(false);
  });

  it("ignores tampering outside the signed payload", () => {
    // The client uses the signed payload's fields, so a mutated envelope cannot
    // change what the client trusts.
    const { offer } = signedOffer();
    const policy = { allowUnpinned: true, trustedHosts: ["*.venice.ai"] };
    const { offer: verified } = { offer: verifyConfidentialOffer(offer, policy) };
    (offer as Record<string, unknown>).upstream_host = "evil.example";
    const again = verifyConfidentialOffer(offer, policy);
    expect(verified.upstream_host).toBe("api.venice.ai");
    expect(again.upstream_host).toBe("api.venice.ai");
  });

  it("rejects a signature from the wrong key", () => {
    const { offer } = signedOffer();
    expect(
      verifySchnorrSignature(
        (offer as Record<string, unknown>).sig_payload as string,
        (offer as Record<string, unknown>).sig as string,
        bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(9))),
      ),
    ).toBe(false);
  });
});

describe("npub decoding", () => {
  it("decodes a known npub and passes hex through", () => {
    // Well-known Nostr test identity (jack).
    expect(npubToHex("npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9")).toBe(
      "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
    );
    const { pubHex } = makeKey();
    expect(npubToHex(pubHex)).toBe(pubHex);
    expect(npubToHex("npub1notvalid")).toBeNull();
  });
});

describe("offer verification + pinning", () => {
  it("accepts the real node offer with the pin from its own key", () => {
    const verified = verifyConfidentialOffer(OFFER, {
      pinnedPubkey: OFFER.notary_pubkey as string,
      trustedHosts: ["*.venice.ai"],
    });
    expect(verified.upstream_host).toBe("api.venice.ai");
    expect(verified.signedPayload.length).toBeGreaterThan(0);
  });

  it("rejects an offer signed by a different key than the pin (npub pin mismatch)", () => {
    const { offer } = signedOffer();
    const otherPin = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(3)));
    expect(() => verifyConfidentialOffer(offer, { pinnedPubkey: otherPin })).toThrow(
      OfferPinMismatchError,
    );
  });

  it("refuses an unpinned offer by default (review #16)", () => {
    const { offer } = signedOffer();
    expect(() => verifyConfidentialOffer(offer, {})).toThrow(OfferUnpinnedError);
  });

  it("accepts an unpinned offer only with the dev flag", () => {
    const verified = verifyConfidentialOffer(signedOffer().offer, {
      allowUnpinned: true,
      trustedHosts: ["*.venice.ai"],
    });
    expect(verified.v).toBe(2);
  });

  it("rejects a bad signature even when pinned", () => {
    const { offer } = signedOffer();
    (offer as Record<string, unknown>).sig_payload = (
      (offer as Record<string, unknown>).sig_payload as string
    ).replace("4096", "9999");
    expect(() =>
      verifyConfidentialOffer(offer, { pinnedPubkey: offer.notary_pubkey as string }),
    ).toThrow(OfferBadSignatureError);
  });

  it("rejects an unsupported protocol version", () => {
    const { offer } = signedOffer({ v: 3, min_v: 3, max_v: 3 });
    expect(() => verifyConfidentialOffer(offer, { allowUnpinned: true })).toThrow(
      OfferUnsupportedVersionError,
    );
    expect(supportedVersion({ v: 3, min_v: 3, max_v: 3 } as never)).toBe(false);
    // Only v2 (two-party handshake) is supported; an offer must run v2.
    expect(supportedVersion({ v: 2, min_v: 2, max_v: 2 } as never)).toBe(true);
    expect(supportedVersion({ v: 2, min_v: 1, max_v: 2 } as never)).toBe(true);
    expect(supportedVersion({ v: 1, min_v: 1, max_v: 2 } as never)).toBe(false);
  });

  it("refuses a node that offers only the retired protocol v1", () => {
    const { offer } = signedOffer({ v: 1, min_v: 1, max_v: 1 });
    expect(() => verifyConfidentialOffer(offer, { allowUnpinned: true })).toThrow(/v1 is retired/);
    expect(() => verifyConfidentialOffer(offer, { allowUnpinned: true })).toThrow(
      OfferUnsupportedVersionError,
    );
    // A real (correctly signed) offer recorded from a v1 node.
    expect(() =>
      verifyConfidentialOffer(OFFER_V1, {
        pinnedPubkey: OFFER_V1.notary_pubkey as string,
        trustedHosts: ["*.venice.ai"],
      }),
    ).toThrow(OfferUnsupportedVersionError);
  });

  it("refuses to build a session for a v1 offer", () => {
    expect(
      () =>
        new ConfidentialSession({
          baseUrl: "http://127.0.0.1:8010",
          offer: { v: 1, notary_pubkey: "00".repeat(32) },
          auth: "sk-x",
          model: "m",
          maxTokens: 10,
          bodyLength: 100,
          prover: {},
        } as never),
    ).toThrow(/only v2/);
  });

  it("rejects an offer whose version lies outside its own min_v..max_v", () => {
    // v=1 inside the client's range, but the node says it speaks only v2
    expect(supportedVersion({ v: 1, min_v: 2, max_v: 2 } as never)).toBe(false);
    expect(supportedVersion({ v: 2, min_v: 1, max_v: 1 } as never)).toBe(false);
    for (const bad of [
      { v: 1, min_v: 2, max_v: 2 },
      { v: 2, min_v: 1, max_v: 1 },
      { v: 2, min_v: 3 },
      { v: 1.5, min_v: 1, max_v: 2 },
      { v: 2, min_v: "1", max_v: 2 },
    ]) {
      const { offer } = signedOffer(bad as never);
      expect(() => verifyConfidentialOffer(offer, { allowUnpinned: true })).toThrow(OfferMalformedError);
    }
  });

  it("enforces the trusted-host list when provided", () => {
    expect(() =>
      verifyConfidentialOffer(signedOffer().offer, {
        allowUnpinned: true,
        trustedHosts: ["other.example"],
      }),
    ).toThrow(TrustedHostError);
    expect(
      verifyConfidentialOffer(signedOffer().offer, {
        allowUnpinned: true,
        trustedHosts: ["*.venice.ai"],
      }).upstream_host,
    ).toBe("api.venice.ai");
  });
});

describe("canonical suffix", () => {
  it("is byte-exact with the sidecar's reconstruction", () => {
    expect(canonicalSuffix("deepseek-v4-flash", 12)).toBe(
      ',"model":"deepseek-v4-flash","max_tokens":12,"max_completion_tokens":12,"n":1,' +
        '"stream":true,"stream_options":{"include_usage":true},' +
        '"venice_parameters":{"include_venice_system_prompt":false,"enable_web_search":"off"}}',
    );
  });

  it("JSON-escapes the model name", () => {
    expect(canonicalSuffix('a"b', 1)).toContain('"model":"a\\"b"');
  });
});

describe("trusted hostname matcher", () => {
  it("normalizes case and a trailing dot", () => {
    expect(normalizeHostname("API.Venice.AI.")).toBe("api.venice.ai");
  });

  it("exact match", () => {
    expect(matchHostname("api.venice.ai", "api.venice.ai")).toBe(true);
    expect(matchHostname("api.venice.ai", "venice.ai")).toBe(false);
    expect(matchHostname("api.venice.ai", "api.venice.ai.")).toBe(true);
  });

  it("`*` matches exactly one label", () => {
    expect(matchHostname("a.example.com", "*.example.com")).toBe(true);
    expect(matchHostname("a.b.example.com", "*.example.com")).toBe(false);
    expect(matchHostname("example.com", "*.example.com")).toBe(false);
  });

  it("`**` matches one or more labels", () => {
    expect(matchHostname("a.example.com", "**.example.com")).toBe(true);
    expect(matchHostname("a.b.example.com", "**.example.com")).toBe(true);
    expect(matchHostname("example.com", "**.example.com")).toBe(false);
    expect(matchHostname("x.a.b.c.example.com", "**.example.com")).toBe(true);
  });

  it("`**` works in the middle", () => {
    expect(matchHostname("a.b.c.example.com", "a.**.example.com")).toBe(true);
    expect(matchHostname("a.example.com", "a.**.example.com")).toBe(false);
  });

  it("is case-insensitive end to end", () => {
    expect(matchHostname("API.Venice.AI", "*.venice.ai")).toBe(true);
  });

  it("empty list rejects everything", () => {
    const m = new TrustedHostMatcher([]);
    expect(m.isEmpty).toBe(true);
    expect(m.matches("api.venice.ai")).toBe(false);
  });

  it("rejects unsafe patterns", () => {
    expect(() => parseTrustedHostPattern("")).toThrow();
    expect(() => parseTrustedHostPattern("   ")).toThrow();
    expect(() => parseTrustedHostPattern("*")).toThrow();
    expect(() => parseTrustedHostPattern("**")).toThrow();
    expect(() => parseTrustedHostPattern("*foo.com")).toThrow();
    expect(() => parseTrustedHostPattern("foo*.com")).toThrow();
    expect(() => parseTrustedHostPattern("a..b")).toThrow();
    expect(() => parseTrustedHostPattern("http://x.com")).toThrow();
    expect(() => parseTrustedHostPattern("x.com:443")).toThrow();
    expect(() => parseTrustedHostPattern("a@b.com")).toThrow();
  });

  it("accepts a whole-label wildcard in the middle or at the end", () => {
    expect(matchHostname("api.eu.example.com", "api.*.example.com")).toBe(true);
    expect(matchHostname("api.example.com", "api.*.example.com")).toBe(false);
    expect(matchHostname("foo.any", "foo.*")).toBe(true);
  });
});

describe("response parsing + usage disclosure", () => {
  const headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n";
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"model":"deepseek-v4-flash","usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n' +
    "data: [DONE]\n\n";

  function chunked(body: string): Uint8Array {
    const enc = new TextEncoder();
    const b = enc.encode(body);
    const hex = b.length.toString(16);
    return enc.encode(`${hex}\r\n${body}\r\n0\r\n\r\n`);
  }

  it("splits status/headers/body", () => {
    const raw = new TextEncoder().encode(headers + "hello");
    const parsed = parseHttpResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.contentType).toBe("text/event-stream");
    expect(parsed.bodyText).toBe("hello");
  });

  it("locates the π_C3 disclosure window and parses the usage event", () => {
    const raw = new TextEncoder().encode(headers).slice();
    const chunkedBytes = chunked(sse);
    const joined = new Uint8Array(raw.length + chunkedBytes.length);
    joined.set(raw, 0);
    joined.set(chunkedBytes, raw.length);
    const r = extractUsageDisclosure(joined);
    expect(r).not.toBeNull();
    const usage = usageEventFromDisclosure(r!);
    expect(usage?.model).toBe("deepseek-v4-flash");
    expect(usage?.usage.prompt_tokens).toBe(9);
    expect(effectiveModelFromText(sse)).toBe("deepseek-v4-flash");
  });
});

describe("receipt verification", () => {
  const ownUsage = {
    model: "deepseek-v4-flash",
    usage: { prompt_tokens: 9, completion_tokens: 1 },
  };
  const base = { sid: "abc", model: "deepseek-v4-flash", usage: { ...ownUsage }, reserved_msats: 20000 };

  function signReceipt(receipt: Record<string, unknown>) {
    const { priv, pubHex } = makeKey();
    const payload = canonicalJson(receipt);
    const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
    return { payload, sig, pubHex };
  }

  it("accepts a signed receipt with matching usage and a fair cost", () => {
    const receipt = { ...base, cost_msats: 10, balance_msats: 90000 };
    const { payload, sig, pubHex } = signReceipt(receipt);
    const res = verifyReceipt({
      receipt: receipt as never,
      receiptJson: payload,
      sig,
      pubkey: pubHex,
      ownUsage,
      priceEntry: { in: 1000, out: 1000 },
    });
    expect(res).toEqual({ receiptSigOk: true, usageMatch: true, costWithinOffer: true });
  });

  it("flags a cost above the usage at the signed offer's rates", () => {
    // 1000 msats/1k in+out, 9+1 tokens -> at most 10 msats.
    const res = verifyReceipt({
      receipt: { ...base, cost_msats: 15000 } as never,
      ownUsage,
      priceEntry: { in: 1000, out: 1000 },
    });
    expect(res.costWithinOffer).toBe(false);
  });

  it("never refuses the node's cached-input charge for float rounding", () => {
    // The node bills ceil((in·(p−c) + min(cached_in,in)·c + out·k)/1000). With
    // cached_in = in that equals the uncached price mathematically, but in
    // floating point 1.1·9999 + 1.1·1 rounds above 11000: the node charges 12.
    const priceEntry = { in: 1.1, cached_in: 1.1, out: 0 };
    const usage = { prompt_tokens: 10000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1 } };
    const node = Math.ceil((1.1 * (10000 - 1) + 1.1 * 1 + 0 * 0) / 1000);
    expect(node).toBe(12);
    expect(maxChargeMsats(priceEntry, usage)).toBe(12);
    // Without cached tokens the bound is unchanged.
    expect(maxChargeMsats(priceEntry, { prompt_tokens: 10000, completion_tokens: 0 })).toBe(11);
    // A cached rate above `in` is not honoured beyond `in`.
    expect(maxChargeMsats({ in: 1, cached_in: 5, out: 0 }, { ...usage, prompt_tokens: 1000 })).toBe(1);
    const own = { model: "m", usage } as never;
    const r = verifyReceipt({
      receipt: { sid: "s", model: "m", usage: { usage }, cost_msats: 12 } as never,
      ownUsage: own,
      priceEntry,
    });
    expect(r.costWithinOffer).toBe(true);
  });

  it("allows the signed session fee on top of the usage, never more", () => {
    // 10 msats of usage at the (already surcharged) signed rates + 2000 fee.
    const priceEntry = { in: 1000, out: 1000 };
    expect(maxChargeMsats(priceEntry, ownUsage.usage, 2000)).toBe(2010);
    const ok = verifyReceipt({
      receipt: { ...base, cost_msats: 2010, session_fee_msat: 2000 } as never,
      ownUsage,
      priceEntry,
      sessionFeeMsat: 2000,
    });
    expect(ok.costWithinOffer).toBe(true);
    const over = verifyReceipt({
      receipt: { ...base, cost_msats: 2011, session_fee_msat: 2000 } as never,
      ownUsage,
      priceEntry,
      sessionFeeMsat: 2000,
    });
    expect(over.costWithinOffer).toBe(false);
    // Without a signed fee the same charge is refused.
    const noFee = verifyReceipt({ receipt: { ...base, cost_msats: 2010 } as never, ownUsage, priceEntry });
    expect(noFee.costWithinOffer).toBe(false);
    // A receipt naming a larger fee than the signed one is refused.
    const bigger = verifyReceipt({
      receipt: { ...base, cost_msats: 10, session_fee_msat: 5000 } as never,
      ownUsage,
      priceEntry,
      sessionFeeMsat: 2000,
    });
    expect(bigger.costWithinOffer).toBe(false);
    // The abandon fee never applies to a completed request.
    const abandonCharged = verifyReceipt({
      receipt: { ...base, cost_msats: 10_010, session_fee_msat: 2000, abandon_fee_msat: 10_000 } as never,
      ownUsage,
      priceEntry,
      sessionFeeMsat: 2000,
      abandonFeeMsat: 10_000,
    });
    expect(abandonCharged.costWithinOffer).toBe(false);
    const biggerAbandon = verifyReceipt({
      receipt: { ...base, cost_msats: 10, abandon_fee_msat: 20_000 } as never,
      ownUsage,
      priceEntry,
      sessionFeeMsat: 2000,
      abandonFeeMsat: 10_000,
    });
    expect(biggerAbandon.costWithinOffer).toBe(false);
  });

  it("refuses any cost when the signed offer has no rate for the model", () => {
    // Without a price entry there is no bound to check against: a node that
    // signs an offer without the served model's rates gets no cost accepted.
    const res = verifyReceipt({ receipt: { ...base, cost_msats: 1 } as never, ownUsage });
    expect(res.costWithinOffer).toBe(false);
    const free = verifyReceipt({ receipt: { ...base, cost_msats: 0 } as never, ownUsage });
    expect(free.costWithinOffer).toBe(false);
  });

  it("allows at most the fee for a charge without usage (4xx/503, abandoned)", () => {
    expect(feeOnlyChargeOk(0, 0)).toBe(true);
    expect(feeOnlyChargeOk(1, 0)).toBe(false);
    expect(feeOnlyChargeOk(2000, 2000)).toBe(true);
    expect(feeOnlyChargeOk(2001, 2000)).toBe(false);
  });

  it("flags a usage mismatch", () => {
    const receipt = {
      ...base,
      usage: { model: "deepseek-v4-flash", usage: { prompt_tokens: 999, completion_tokens: 1 } },
      cost_msats: 14,
    };
    const { payload, sig, pubHex } = signReceipt(receipt);
    const res = verifyReceipt({ receipt: receipt as never, receiptJson: payload, sig, pubkey: pubHex, ownUsage });
    expect(res.usageMatch).toBe(false);
    expect(res.receiptSigOk).toBe(true);
  });

  it("flags a bad receipt signature", () => {
    const receipt = { ...base, cost_msats: 14 };
    const res = verifyReceipt({
      receipt: receipt as never,
      receiptJson: canonicalJson(receipt),
      sig: "00".repeat(64),
      pubkey: bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(7))),
      ownUsage,
    });
    expect(res.receiptSigOk).toBe(false);
  });
});

describe("confidential transport body handling", () => {
  it("strips caller-supplied pinned keys and ends with the canonical suffix", () => {
    const body = buildPinnedBody(
      { model: "evil", max_tokens: 99999, n: 4, messages: [{ role: "user", content: "hi" }], tools: [] },
      "deepseek-v4-flash",
      12,
    );
    const text = new TextDecoder().decode(body);
    const suffix = canonicalSuffix("deepseek-v4-flash", 12);
    expect(text.endsWith(suffix)).toBe(true);
    const priv = text.slice(0, -suffix.length);
    expect(priv).toBe('{"messages":[{"role":"user","content":"hi"}],"tools":[]');
    expect(JSON.parse(text).model).toBe("deepseek-v4-flash");
  });

  it("folds SSE into one chat.completion", () => {
    const sse = [
      'data: {"id":"x1","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
      'data: {"id":"x1","choices":[{"index":0,"delta":{"content":"lo","tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"f","arguments":"{\\"a\\""}}]}}]}',
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"stop"}]}',
      'data: {"id":"x1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const out = aggregateChatCompletionSse(sse) as any;
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("Hello");
    expect(out.choices[0].message.tool_calls[0].function).toEqual({ name: "f", arguments: '{"a":1}' });
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
  });
});


import {
  ChunkedDecoder,
  IncrementalHttpResponse,
  parseHttpResponse as parseHttp,
} from "../../client/confidential/suffix";

describe("usage disclosure window", () => {
  const usage = '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2},"model":"m"}';
  const head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
  const chunk = (d: string) => `${Buffer.byteLength(d).toString(16)}\r\n${d}\r\n`;

  it("starts at the usage event's line when the stream ends in one large chunk", () => {
    const events = Array.from({ length: 400 }, (_, i) => `data: {"choices":[{"delta":{"content":"tok${i}"}}]}\n\n`).join("");
    const big = chunk(`${events}data: ${usage}\n\ndata: [DONE]\n\n`);
    const resp = new TextEncoder().encode(`${head}${chunk("data: {}\n\n")}${big}0\r\n\r\n`);
    const r = extractUsageDisclosure(resp)!;
    const text = new TextDecoder().decode(r);
    expect(text.startsWith(`\ndata: ${usage}`)).toBe(true);
    expect(r.length).toBeLessThan(200);
    expect(usageEventFromDisclosure(r)?.usage.completion_tokens).toBe(2);
  });

  it("still uses a chunk boundary when the usage event starts its own chunk", () => {
    const resp = new TextEncoder().encode(
      `${head}${chunk("data: {}\n\n")}${chunk(`data: ${usage}\n\n`)}${chunk("data: [DONE]\n\n")}0\r\n\r\n`,
    );
    const r = extractUsageDisclosure(resp)!;
    expect(usageEventFromDisclosure(r)?.model).toBe("m");
    expect(r.length).toBeLessThan(140);
  });
});

describe("HTTP response decoding", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (parts: Uint8Array[]) => parts.map((p) => new TextDecoder().decode(p)).join("");
  const raw =
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
    "6\r\ndata: \r\n" + "9\r\n{\"x\":1}\n\n\r\n" + "0\r\n\r\n";

  it("parseHttpResponse de-chunks a chunked body", () => {
    const r = parseHttp(enc(raw));
    expect(r.status).toBe(200);
    expect(r.bodyText).toBe('data: {"x":1}\n\n');
  });

  it("streams the same body byte by byte", () => {
    const inc = new IncrementalHttpResponse();
    const out: Uint8Array[] = [];
    for (const b of enc(raw)) out.push(...inc.push(new Uint8Array([b])));
    expect(inc.head?.status).toBe(200);
    expect(dec(out)).toBe('data: {"x":1}\n\n');
    expect(inc.complete).toBe(true);
  });

  it("rejects a malformed chunk size", () => {
    expect(() => new ChunkedDecoder().push(enc("zz\r\nhello\r\n"))).toThrow();
  });
});

describe("security regressions", () => {
  const sha = (t: string) => bytesToHex(sha256(utf8ToBytes(t)));
  const sign = (payload: string, priv: Uint8Array) =>
    bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));

  it("refuses an offer when no trusted hosts are configured (TLS-03)", () => {
    expect(() => verifyConfidentialOffer(signedOffer().offer, { allowUnpinned: true })).toThrow(
      TrustedHostError,
    );
  });

  it("builds valid JSON when only pinned keys are present", () => {
    const body = JSON.parse(new TextDecoder().decode(buildPinnedBody({ model: "m", max_tokens: 3 }, "m", 3)));
    expect(body.model).toBe("m");
    expect(body.max_tokens).toBe(3);
  });

  it("supports only POST chat/completions", () => {
    expect(isConfidentialEndpoint("POST", "/v1/chat/completions")).toBe(true);
    expect(isConfidentialEndpoint("POST", "/v1/responses")).toBe(false);
    expect(isConfidentialEndpoint("POST", "/v1/embeddings")).toBe(false);
    expect(isConfidentialEndpoint("GET", "/v1/chat/completions")).toBe(false);
  });

  it("pins the announcing key only for an authenticated node URL", async () => {
    const { offer, pubHex } = signedOffer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(offer), { status: 200 })) as typeof fetch;
    const other = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(3)));
    try {
      const call = (baseUrl: string, announced: string[]) =>
        fetchConfidential({
          baseUrl,
          body: { model: "absent" },
          bearer: "sk-x",
          options: { trustedHosts: ["*.venice.ai"], nodePubkeysFor: () => announced },
        });
      // https and the announcing key: the offer verifies (then the model is refused).
      await expect(call("https://pin-a.example", [pubHex])).rejects.toThrow(/does not serve/);
      // Announced by someone else: the signature does not match the pin.
      await expect(call("https://pin-b.example", [other])).rejects.toThrow(OfferPinMismatchError);
      // Plain http does not authenticate the server: no pin from the announcement.
      await expect(call("http://pin-c.example", [pubHex])).rejects.toThrow(OfferUnpinnedError);
      // Nothing announced: no pin.
      await expect(call("https://pin-d.example", [])).rejects.toThrow(OfferUnpinnedError);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses plain http to a remote node even with a pinned key", async () => {
    const { offer, pubHex } = signedOffer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(offer), { status: 200 })) as typeof fetch;
    try {
      const call = (baseUrl: string, extra: Record<string, unknown> = {}) =>
        fetchConfidential({
          baseUrl,
          body: { model: "absent" },
          bearer: "sk-x",
          options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex], ...extra },
        });
      await expect(call("http://plain-a.example")).rejects.toThrow(/plain http/);
      await expect(call("http://10.0.0.5:8000")).rejects.toThrow(/plain http/);
      // Loopback, onion and https pass the gate (then the model is refused).
      for (const ok of ["http://127.0.0.1:8010", "http://localhost:8010", "http://[::1]:8010", "http://abc.onion", "https://plain-b.example"]) {
        await expect(call(ok)).rejects.toThrow(/does not serve/);
      }
      // The explicit development opt-in.
      await expect(call("http://plain-c.example", { allowInsecureTransport: true })).rejects.toThrow(/does not serve/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(encryptedNodeTransport("ws://127.0.0.1")).toBe(false);
    expect(encryptedNodeTransport("not a url")).toBe(false);
  });

  it("re-applies the caller's policy to a cached offer", async () => {
    const { offer } = signedOffer();
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify(offer), { status: 200 });
    }) as typeof fetch;
    try {
      const base = { baseUrl: "https://cache-policy.example", body: { model: "absent" }, bearer: "sk-x" };
      // Loose policy: the offer verifies, then the unknown model is refused.
      await expect(
        fetchConfidential({ ...base, options: { trustedHosts: ["*.venice.ai"], allowUnpinned: true } }),
      ).rejects.toThrow(/does not serve/);
      // Strict policy within the cache window: must be re-checked, not reused.
      const other = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(3)));
      await expect(
        fetchConfidential({ ...base, options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [other] } }),
      ).rejects.toThrow(OfferPinMismatchError);
      await expect(
        fetchConfidential({ ...base, options: { trustedHosts: ["other.example"], allowUnpinned: true } }),
      ).rejects.toThrow(TrustedHostError);
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("accepts only a signed receipt bound to this session and attestation", () => {
    const { priv, pubHex } = makeKey();
    const aJson = '{"sid":"s1","x":1}';
    const receipt = { sid: "s1", model: "m", cost_msats: 5, attestation_hash: sha(aJson) };
    const receiptJson = canonicalJson(receipt);
    const sig = sign(receiptJson, priv);
    const ok = parseSignedReceipt({ receiptJson, sig, pubkey: pubHex, sid: "s1", attestationJson: aJson });
    expect(ok.cost_msats).toBe(5);
    // Unsigned / wrongly signed.
    expect(() =>
      parseSignedReceipt({ receiptJson, sig: undefined, pubkey: pubHex, sid: "s1", attestationJson: aJson }),
    ).toThrow(ReceiptVerificationError);
    const tampered = receiptJson.replace('"cost_msats":5', '"cost_msats":1');
    expect(() =>
      parseSignedReceipt({ receiptJson: tampered, sig, pubkey: pubHex, sid: "s1", attestationJson: aJson }),
    ).toThrow(ReceiptVerificationError);
    // A validly signed receipt of another session.
    expect(() =>
      parseSignedReceipt({ receiptJson, sig, pubkey: pubHex, sid: "s2", attestationJson: aJson }),
    ).toThrow(/not s2/);
    // A receipt with no attestation hash at all is not bound to anything.
    const unbound = { sid: "s1", model: "m", cost_msats: 5 };
    const unboundJson = canonicalJson(unbound);
    expect(() =>
      parseSignedReceipt({
        receiptJson: unboundJson,
        sig: sign(unboundJson, priv),
        pubkey: pubHex,
        sid: "s1",
        attestationJson: aJson,
      }),
    ).toThrow(/attestation/);
    // Bound to a different attestation.
    expect(() =>
      parseSignedReceipt({ receiptJson, sig, pubkey: pubHex, sid: "s1", attestationJson: "{}" }),
    ).toThrow(/attestation/);
  });

  it("accepts only an attestation naming this session and handshake", () => {
    const thSH = new Uint8Array(32).fill(7);
    const thSF = new Uint8Array(32).fill(9);
    const own = { sid: "s1", thSH, thSF };
    const att = (o: Record<string, unknown>) =>
      canonicalJson({ sid: "s1", th_sh: bytesToHex(thSH), th_sf: bytesToHex(thSF), c_commit: null, ...o });
    expect(() => checkAttestationBinding(att({}), own)).not.toThrow();
    expect(() => checkAttestationBinding(att({ sid: "s2" }), own)).toThrow(/not s1/);
    expect(() => checkAttestationBinding(att({ th_sh: "00".repeat(32) }), own)).toThrow(/handshake/);
    expect(() => checkAttestationBinding(att({ th_sf: null }), own)).toThrow(/handshake/);
    expect(() => checkAttestationBinding(att({}), { sid: "s1" })).toThrow(ReceiptVerificationError);
    expect(() => checkAttestationBinding("null", own)).toThrow(ReceiptVerificationError);
    expect(() => checkAttestationBinding("{", own)).toThrow(/JSON/);
  });

  it("checks the attestation's commitment, certificate hash and upstream byte record against ours", () => {
    const thSH = new Uint8Array(32).fill(7);
    const thSF = new Uint8Array(32).fill(9);
    const chain = new Uint8Array(32).fill(3);
    const recv = new Uint8Array(32).fill(4);
    const own = { sid: "s1", thSH, thSF, cCommit: "ab".repeat(32), certChainHash: chain, serverRecords: 9, recvSha256: recv };
    const att = (o: Record<string, unknown>) =>
      canonicalJson({
        sid: "s1",
        th_sh: bytesToHex(thSH),
        th_sf: bytesToHex(thSF),
        c_commit: "ab".repeat(32),
        cert_chain_hash: bytesToHex(chain),
        server_records: 9,
        client_records: 4,
        sha256_recv: bytesToHex(recv),
        sha256_sent: "00".repeat(32),
        time: 1,
        ...o,
      });
    expect(() => checkAttestationBinding(att({}), own)).not.toThrow();
    expect(() => checkAttestationBinding(att({ c_commit: "cd".repeat(32) }), own)).toThrow(/commitment/);
    expect(() => checkAttestationBinding(att({ c_commit: null }), own)).toThrow(/commitment/);
    expect(() => checkAttestationBinding(att({ cert_chain_hash: "00".repeat(32) }), own)).toThrow(/certificate/);
    expect(() => checkAttestationBinding(att({ server_records: 10 }), own)).toThrow(/upstream records/);
    expect(() => checkAttestationBinding(att({ sha256_recv: "00".repeat(32) }), own)).toThrow(/upstream bytes/);
  });

});

describe("confidential session fee and surcharge in the offer", () => {
  const shape = {
    v: 2,
    upstream_host: "api.venice.ai",
    notary_pubkey: "ab".repeat(32),
    max_tokens_cap: 4096,
    key_length: 42,
    head_template: "POST /",
    suffix_keys: [],
    price_list: {},
  };

  it("accepts absent or valid pricing fields and reads the fee", () => {
    validateOfferShape({ ...shape });
    validateOfferShape({ ...shape, session_fee_msat: 2000, abandon_fee_msat: 10000, rate_surcharge_pct: 20 });
    expect(offerSessionFeeMsat({})).toBe(0);
    expect(offerSessionFeeMsat({ session_fee_msat: 2000 })).toBe(2000);
    // The abandon fee is never below the session fee.
    expect(offerAbandonFeeMsat({})).toBe(0);
    expect(offerAbandonFeeMsat({ session_fee_msat: 2000 })).toBe(2000);
    expect(offerAbandonFeeMsat({ session_fee_msat: 2000, abandon_fee_msat: 10000 })).toBe(10000);
    expect(offerAbandonFeeMsat({ session_fee_msat: 2000, abandon_fee_msat: 500 })).toBe(2000);
  });

  it("rejects malformed pricing fields", () => {
    for (const bad of [-1, 1.5, "2000", Number.NaN]) {
      expect(() => validateOfferShape({ ...shape, session_fee_msat: bad })).toThrow();
    }
    for (const bad of [-1, 2.5, "10"]) {
      expect(() => validateOfferShape({ ...shape, abandon_fee_msat: bad })).toThrow();
    }
    for (const bad of [-1, "20", Number.POSITIVE_INFINITY]) {
      expect(() => validateOfferShape({ ...shape, rate_surcharge_pct: bad })).toThrow();
    }
  });
});

describe("confidential deposit sizing", () => {
  const model = (cu?: Record<string, unknown>) =>
    ({
      id: "m",
      sats_pricing: { max_cost: 1000, max_prompt_cost: 900, completion: 0.1, request: 0 },
      ...(cu ? { confidential_upstream: { v: 2, offer_url: "x", ...cu } } : {}),
    }) as never;

  it("is unchanged without a fee or surcharge", () => {
    expect(confidentialRequiredSats(model(), 100)).toBeCloseTo(Math.min(1000, 910 * 1.05));
    expect(confidentialRequiredSats(model({}), 100)).toBeCloseTo(Math.min(1000, 910 * 1.05));
  });

  it("adds the surcharge and the larger of the session and abandon fees", () => {
    const base = Math.min(1000, 910 * 1.05);
    expect(confidentialRequiredSats(model({ rate_surcharge_pct: 20, session_fee_msat: 2000 }), 100)).toBeCloseTo(
      base * 1.2 + 2,
    );
    expect(confidentialRequiredSats(model({ session_fee_msat: 1500 }), 100)).toBeCloseTo(base + 2);
    expect(
      confidentialRequiredSats(model({ session_fee_msat: 2000, abandon_fee_msat: 10_000 }), 100),
    ).toBeCloseTo(base + 10);
  });
});

describe("stream end held until settlement", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const run = (parts: string[]) => {
    const h = new SseDoneHoldback();
    const now = parts.map((p) => dec(h.push(enc(p))));
    return { now, rest: dec(h.release()) };
  };

  it("passes events through and holds back from the [DONE] line on", () => {
    const ev = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
    const { now, rest } = run([ev, 'data: {"usage":{}}\n\n', "data: [DONE]\n\n"]);
    expect(now).toEqual([ev, 'data: {"usage":{}}\n\n', ""]);
    expect(rest).toBe("data: [DONE]\n\n");
  });

  it("finds the marker split across chunks and without the space", () => {
    for (const parts of [
      ["data: x\n\ndata: [DO", "NE]\n\n"],
      ["data: x\n\nd", "ata: [DONE]\n\n"],
      ["data: x\n\n", "data:[DONE]\n\n"],
      ["data: x\n\ndata: [DONE]\n\n"],
    ]) {
      const { now, rest } = run(parts);
      expect(now.join("")).toBe("data: x\n\n");
      expect(now.join("") + rest).toBe(parts.join(""));
    }
  });

  it("delays only a possible marker prefix, and only at a line start", () => {
    const h = new SseDoneHoldback();
    expect(dec(h.push(enc("data: a\n\nda")))).toBe("data: a\n\n");
    expect(dec(h.push(enc("ta: b\n\n")))).toBe("data: b\n\n");
    // "[DONE]" inside content is not the end of the stream
    expect(dec(h.push(enc('data: {"c":"data: [DONE]"}\n\n')))).toBe('data: {"c":"data: [DONE]"}\n\n');
    expect(dec(h.release())).toBe("");
  });
});

describe("session construction guards", () => {
  const opts = (extra: Record<string, unknown> = {}) =>
    ({
      baseUrl: "http://127.0.0.1:8010",
      offer: { v: 2, notary_pubkey: "00".repeat(32) },
      auth: "sk-x",
      model: "m",
      maxTokens: 10,
      bodyLength: 100,
      prover: {},
      ...extra,
    }) as never;

  it("refuses the insecure test hooks unless the process opts in", () => {
    const prev = process.env.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING;
    delete process.env.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING;
    try {
      expect(() => new ConfidentialSession(opts())).not.toThrow();
      expect(() => new ConfidentialSession(opts({ allowUnsignedSettlement: true }))).toThrow(/test hook/);
      process.env.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING = "1";
      expect(() => new ConfidentialSession(opts({ allowUnsignedSettlement: true }))).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING;
      else process.env.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING = prev;
    }
  });

  it("refuses a plain-http remote node", () => {
    expect(() => new ConfidentialSession(opts({ baseUrl: "http://node.example" }))).toThrow(/plain http/);
    expect(() =>
      new ConfidentialSession(opts({ baseUrl: "http://node.example", allowInsecureTransport: true })),
    ).not.toThrow();
  });
});
