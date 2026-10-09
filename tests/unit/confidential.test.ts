/**
 * Confidential-upstream SDK unit tests.
 *
 * Covers offer signature verification (good/bad), npub pinning, protocol
 * version negotiation, trusted-host matching, canonical suffix bytes,
 * receipt verification and the confidential transport's body handling. Fixtures are a real
 * offer recorded from the local routstr-core node (branch `confidential-upstream`).
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
  checkPiNParams,
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
import { parseSignedReceipt, verifyReceipt } from "../../client/confidential/receipt";
import {
  aggregateChatCompletionSse,
  buildPinnedBody,
  fetchConfidential,
  isConfidentialEndpoint,
} from "../../client/confidential/transport";
import { checkPiC2Params, checkPiC3Params } from "../../client/confidential/params";
import { ReceiptVerificationError } from "../../client/confidential/errors";
import {
  TrustedHostMatcher,
  matchHostname,
  normalizeHostname,
  parseTrustedHostPattern,
} from "../../client/confidential/hosts";
import {
  OfferBadSignatureError,
  OfferPinMismatchError,
  OfferUnpinnedError,
  OfferUnsupportedVersionError,
  SessionProtocolError,
  TrustedHostError,
} from "../../client/confidential/errors";

import offerFixture from "../fixtures/confidential/venice-offer.json";

const OFFER = offerFixture as unknown as Record<string, unknown>;

function makeKey() {
  const priv = new Uint8Array(32).fill(7);
  const pub = schnorr.getPublicKey(priv);
  return { priv, pubHex: bytesToHex(pub) };
}

/** Build an offer signed the way the node does: BIP-340 over sha256(canonical). */
function signedOffer(overrides: Record<string, unknown> = {}) {
  const { priv, pubHex } = makeKey();
  const offer: Record<string, unknown> = {
    v: 1,
    min_v: 1,
    max_v: 1,
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
    expect(verified.v).toBe(1);
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
    const { offer } = signedOffer({ v: 2, min_v: 2, max_v: 2 });
    expect(() => verifyConfidentialOffer(offer, { allowUnpinned: true })).toThrow(
      OfferUnsupportedVersionError,
    );
    expect(supportedVersion({ v: 2, min_v: 2, max_v: 2 } as never)).toBe(false);
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

describe("π_N statement rebuild", () => {
  it("accepts the statement the node would build for our body", () => {
    const keyLen = 4;
    const tpl = "POST /x HTTP/1.1\r\nAuthorization: Bearer {KEY:4}\r\nContent-Length: {LEN}\r\n\r\n";
    const filled = new TextEncoder().encode(
      tpl.replace("{KEY:4}", "\u0000".repeat(keyLen)).replace("{LEN}", "10"),
    );
    const offs: number[] = [];
    filled.forEach((b, i) => {
      if (b === 0) offs.push(i);
    });
    const n = filled.length + 1;
    const params = {
      PiN: {
        template: Array.from(filled),
        key_len: keyLen,
        key_offsets: offs,
        head_len: filled.length,
        header: [0x17, 0x03, 0x03, (n + 16) >> 8, (n + 16) & 0xff],
        s: Array.from(new Uint8Array(filled.length + 1).fill(0xaa)),
        key_alphabet: "[A-Za-z0-9_-]",
      },
    };
    const s = new Uint8Array(filled.length + 1).fill(0xaa);
    checkPiNParams(params, { offer: { head_template: tpl, key_length: keyLen, key_alphabet: "[A-Za-z0-9_-]" } }, s, 10);
  });

  it("rejects a statement with a different keystream", () => {
    const tpl = "POST /x HTTP/1.1\r\nAuthorization: Bearer {KEY:4}\r\n\r\n";
    const filled = new TextEncoder().encode(tpl.replace("{KEY:4}", "\u0000".repeat(4)));
    const offs: number[] = [];
    filled.forEach((b, i) => {
      if (b === 0) offs.push(i);
    });
    const n = filled.length + 1;
    const params = {
      PiN: {
        template: Array.from(filled),
        key_len: 4,
        key_offsets: offs,
        head_len: filled.length,
        header: [0x17, 0x03, 0x03, (n + 16) >> 8, (n + 16) & 0xff],
        s: Array.from(new Uint8Array(filled.length + 1).fill(1)),
      },
    };
    expect(() =>
      checkPiNParams(
        params,
        { offer: { head_template: tpl, key_length: 4 } },
        new Uint8Array(filled.length + 1).fill(2),
        0,
      ),
    ).toThrow(SessionProtocolError);
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

  it("re-applies the caller's policy to a cached offer", async () => {
    const { offer } = signedOffer();
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify(offer), { status: 200 });
    }) as typeof fetch;
    try {
      const base = { baseUrl: "http://cache-policy.example", body: { model: "absent" }, bearer: "sk-x" };
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
      parseSignedReceipt({ receiptJson, sig: undefined, pubkey: pubHex, sid: "s1" }),
    ).toThrow(ReceiptVerificationError);
    const tampered = receiptJson.replace('"cost_msats":5', '"cost_msats":1');
    expect(() =>
      parseSignedReceipt({ receiptJson: tampered, sig, pubkey: pubHex, sid: "s1" }),
    ).toThrow(ReceiptVerificationError);
    // A validly signed receipt of another session.
    expect(() => parseSignedReceipt({ receiptJson, sig, pubkey: pubHex, sid: "s2" })).toThrow(
      /not s2/,
    );
    // Bound to a different attestation.
    expect(() =>
      parseSignedReceipt({ receiptJson, sig, pubkey: pubHex, sid: "s1", attestationJson: "{}" }),
    ).toThrow(/attestation/);
  });

  describe("node-supplied proof parameters", () => {
    const session = {
      clientHs: new Uint8Array(32).fill(1),
      serverHs: new Uint8Array(32).fill(2),
      thSH: new Uint8Array(32).fill(3),
      thSF: new Uint8Array(32).fill(4),
    };
    const sessionParams = {
      client_hs: Array.from(session.clientHs),
      server_hs: Array.from(session.serverHs),
      th_sh: Array.from(session.thSH),
      th_sf: Array.from(session.thSF),
    };
    const suffix = utf8ToBytes(',"model":"m","max_tokens":3}');
    // Header + ciphertext (100 inner bytes) + 16-byte tag.
    const record = new Uint8Array(5 + 100 + 16).map((_, i) => (i * 7) & 0xff);
    const ctLen = 100;
    const w = suffix.length + 14;
    const honestC2 = {
      PiC2: {
        session: sessionParams,
        seq: 2,
        ct_window: Array.from(record.subarray(5 + ctLen - w, 5 + ctLen)),
        off: ctLen - w,
        w,
        sel_start: w - 1 - suffix.length,
        sel_len: suffix.length,
        expected: Array.from(suffix),
      },
    };
    const own = { session, seq: 2, record, suffix };

    it("accepts a window over our own final record", () => {
      expect(() => checkPiC2Params(honestC2, own)).not.toThrow();
    });

    it("rejects a window the node moved onto other plaintext", () => {
      const moved = structuredClone(honestC2);
      moved.PiC2.off = 0;
      moved.PiC2.ct_window = Array.from(record.subarray(5, 5 + w));
      expect(() => checkPiC2Params(moved, own)).toThrow(SessionProtocolError);
      const earlier = structuredClone(honestC2);
      earlier.PiC2.seq = 0;
      expect(() => checkPiC2Params(earlier, own)).toThrow(SessionProtocolError);
      const otherSession = structuredClone(honestC2);
      otherSession.PiC2.session.th_sf = Array.from(new Uint8Array(32));
      expect(() => checkPiC2Params(otherSession, own)).toThrow(SessionProtocolError);
    });

    it("π_C3 must cover exactly the final records we received", () => {
      const recs = [new Uint8Array(60).fill(1), new Uint8Array(80).fill(2), new Uint8Array(70).fill(3)];
      const r = new Uint8Array(40).fill(9);
      const params = (records: { seq: number; ct: number[] }[], skip = 0) => ({
        PiC3: { session: sessionParams, records, expected: Array.from(r), skip },
      });
      const tail = [
        { seq: 1, ct: Array.from(recs[1]!.subarray(0, 64)) },
        { seq: 2, ct: Array.from(recs[2]!.subarray(0, 54)) },
      ];
      const ownC3 = { session, serverRecords: recs, r, skip: 0 };
      expect(() => checkPiC3Params(params(tail), ownC3)).not.toThrow();
      // An earlier record (e.g. the request-bearing part of the stream).
      expect(() =>
        checkPiC3Params(params([{ seq: 0, ct: Array.from(recs[0]!.subarray(0, 44)) }]), ownC3),
      ).toThrow(SessionProtocolError);
      // A different skip than ours.
      expect(() => checkPiC3Params(params(tail, 5), ownC3)).toThrow(SessionProtocolError);
    });
  });
});
