/**
 * What the confidential transport's qualifier refuses before a deposit is
 * spent on a node: missing helper binaries, a request the signed offer
 * cannot pin (a pinned parameter set to another value, an image request no
 * variant serves), and a model the offer does not price. A one-off Cashu
 * deposit minted for a session that then fails locally would stay in the
 * store, unspent, until a refund sweep.
 */

import { afterEach, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { VENICE_CHAT } from "./fixtures/chat";
import { canonicalJson } from "../../client/confidential/canonical";
import { ConfidentialError, ProverMissingError } from "../../client/confidential/errors";
import type { ConfidentialImagesOffer } from "../../client/confidential/offer";
import { chatSuffixKeys } from "../../client/confidential/suffix";
import { qualifyConfidentialNode } from "../../client/confidential/transport";
import { requireHelperBinaries } from "../../client/confidential/twopc";

const priv = new Uint8Array(32).fill(7);
const pubHex = bytesToHex(schnorr.getPublicKey(priv));

const IMAGES: ConfidentialImagesOffer = {
  head_template:
    "POST /api/v1/image/generate HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\nContent-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
  response_shape: "venice",
  response_idle_s: 300,
  max_count: 4,
  count_key: "variants",
  fixed_pins: [["return_binary", false]],
  param_space: { resolution: ["1K", "2K"], format: ["webp"] },
  price_list: {
    "nano-banana-pro": [
      { id: "1K-webp", pins: [["resolution", "1K"], ["format", "webp"]], msat_per_image: 217800 },
      { id: "2K-webp", pins: [["resolution", "2K"], ["format", "webp"]], msat_per_image: 278300 },
    ],
  },
};

function offer(): Record<string, unknown> {
  const o: Record<string, unknown> = {
    v: 2,
    min_v: 2,
    max_v: 2,
    upstream_host: "api.venice.ai",
    notary_pubkey: pubHex,
    max_tokens_cap: 4096,
    key_length: 42,
    key_alphabet: "[A-Za-z0-9_-]",
    head_template:
      "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
      "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
    suffix_keys: chatSuffixKeys(VENICE_CHAT),
    chat: VENICE_CHAT,
    price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
    capabilities: ["chat", "images"],
    images: IMAGES,
  };
  const payload = canonicalJson(o);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
  return { ...o, sig, sig_payload: payload };
}

let fetches = 0;
const realFetch = globalThis.fetch;
function mockNode() {
  fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify(offer()), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

let n = 0;
const node = () => `https://prespend-${++n}.example`;
// Any executable stands in for the helper binaries: only their presence is checked.
const BIN = process.execPath;
const options = (extra: Record<string, unknown> = {}) => ({
  trustedHosts: ["*.venice.ai"],
  nodePubkeys: [pubHex],
  proverPath: BIN,
  twoPcPath: BIN,
  ...extra,
});
const CHAT = { model: "cheap", messages: [{ role: "user", content: "hi" }] };
const code = (e: unknown) => (e as ConfidentialError).code;

describe("helper binaries", () => {
  it("names the missing binary", () => {
    expect(() => requireHelperBinaries({ proverPath: BIN, twoPcPath: BIN })).not.toThrow();
    expect(() => requireHelperBinaries({ proverPath: "/nonexistent/cu-prover", twoPcPath: BIN })).toThrow(
      /cu-prover not found/,
    );
    expect(() => requireHelperBinaries({ proverPath: BIN, twoPcPath: "/nonexistent/cu-2pc" })).toThrow(
      /cu-2pc not found/,
    );
    // cu-2pc sits next to cu-prover unless a path is given.
    expect(() => requireHelperBinaries({ proverPath: "/nonexistent/dir/cu-prover", twoPc: false })).toThrow(
      /cu-prover not found/,
    );
    expect(() => requireHelperBinaries({ twoPcPath: BIN })).not.toThrow();
  });
});

describe("qualifying a node before a deposit is spent", () => {
  it("returns the verified offer for a request it can pin", async () => {
    mockNode();
    const got = await qualifyConfidentialNode(node(), "cheap", options(), "chat", CHAT);
    expect(Object.keys(got.price_list)).toEqual(["cheap"]);
    // Without a request only the node is checked (as before).
    await expect(qualifyConfidentialNode(node(), "cheap", options())).resolves.toBeTruthy();
  });

  it("refuses when cu-prover or cu-2pc cannot be run, before it asks any node", async () => {
    mockNode();
    for (const missing of [{ proverPath: "/nonexistent/cu-prover" }, { twoPcPath: "/nonexistent/cu-2pc" }]) {
      const error = await qualifyConfidentialNode(node(), "cheap", options(missing), "chat", CHAT).catch((e) => e);
      expect(error).toBeInstanceOf(ProverMissingError);
      expect(code(error)).toBe("prover_missing");
    }
    expect(fetches).toBe(0);
  });

  it("refuses a model the offer does not price", async () => {
    mockNode();
    await expect(qualifyConfidentialNode(node(), "other", options(), "chat", CHAT)).rejects.toThrow(
      /does not serve other confidentially/,
    );
  });

  it("refuses a chat request that sets a pinned parameter to another value", async () => {
    mockNode();
    const conflict = { ...CHAT, venice_parameters: { enable_web_search: "on" } };
    const error = await qualifyConfidentialNode(node(), "cheap", options(), "chat", conflict).catch((e) => e);
    expect(code(error)).toBe("pinned_parameter");
    // The pinned value itself is fine, and so is a request with no messages check failing.
    const same = { ...CHAT, venice_parameters: { include_venice_system_prompt: false, enable_web_search: "off" } };
    await expect(qualifyConfidentialNode(node(), "cheap", options(), "chat", same)).resolves.toBeTruthy();
    await expect(qualifyConfidentialNode(node(), "cheap", options(), "chat", { model: "cheap" })).rejects.toThrow(
      /needs messages/,
    );
  });

  it("qualifies the request under the model id it is given, not the body's", async () => {
    mockNode();
    // The body still carries the caller's alias; the node lists `cheap`.
    await expect(
      qualifyConfidentialNode(node(), "cheap", options(), "chat", { ...CHAT, model: "cheap-alias" }),
    ).resolves.toBeTruthy();
  });

  it("refuses an image request the offer's variants cannot serve", async () => {
    mockNode();
    const ok = { model: "nano-banana-pro", prompt: "a cat", n: 2 };
    await expect(qualifyConfidentialNode(node(), "nano-banana-pro", options(), "images", ok)).resolves.toBeTruthy();
    const noTier = { model: "nano-banana-pro", prompt: "a cat", resolution: "4K" };
    const error = await qualifyConfidentialNode(node(), "nano-banana-pro", options(), "images", noTier).catch((e) => e);
    expect(code(error)).toBe("unsupported_endpoint");
    expect(String(error.message)).toMatch(/no confidential nano-banana-pro variant/);
    await expect(
      qualifyConfidentialNode(node(), "nano-banana-pro", options(), "images", { model: "nano-banana-pro", prompt: "x", n: 9 }),
    ).rejects.toThrow(/1 to 4 images/);
  });
});
