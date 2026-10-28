/**
 * The confidential transport around the body release: what a node error, a
 * caller abort and a one-off bearer's change do before and after it, plus the
 * session's own release guards and the model the receipt may name.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { VENICE_CHAT } from "./fixtures/chat";
import { canonicalJson } from "../../client/confidential/canonical";
import { chatSuffixKeys } from "../../client/confidential/suffix";
import { verifyConfidentialOffer } from "../../client/confidential/offer";
import { verifyReceipt } from "../../client/confidential/receipt";
import {
  closeConfidentialPrewarm,
  confidentialPrewarmSnapshot,
  fetchConfidential,
} from "../../client/confidential/transport";
import {
  OfferUnpinnedError,
  ReceiptVerificationError,
  SessionRejectedError,
} from "../../client/confidential/errors";
import { ConfidentialSession } from "../../client/confidential/session";

const priv = new Uint8Array(32).fill(7);
const pubHex = bytesToHex(schnorr.getPublicKey(priv));

function offer(signed = true): Record<string, unknown> {
  const o: Record<string, unknown> = {
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
      "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
      "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
    suffix_keys: chatSuffixKeys(VENICE_CHAT),
    chat: VENICE_CHAT,
    price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
    mints: ["https://mint.example/"],
  };
  if (!signed) return o;
  const payload = canonicalJson(o);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
  return { ...o, sig, sig_payload: payload };
}

const enc = (t: string) => new TextEncoder().encode(t);
const SSE_HEAD = { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } };
const RESULT = { http: SSE_HEAD, receipt: {}, sid: "ab".repeat(32) };
const CHANGE = "cashuBchange";

let refunds = 0;
const realFetch = globalThis.fetch;
function mockNode() {
  refunds = 0;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith("/v1/wallet/refund")) {
      refunds++;
      return new Response(JSON.stringify({ token: CHANGE }), { status: 200 });
    }
    return new Response(JSON.stringify(offer()), { status: 200 });
  }) as typeof fetch;
}

let n = 0;
function call(extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return fetchConfidential({
    baseUrl: `https://release-${++n}.example`,
    body: { model: "cheap", messages: [], ...body },
    bearer: "sk-x",
    options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex] },
    ...extra,
  });
}

/** Stand-in for a session: `steps` runs with the session as `this`. */
function fakeRun(steps: (s: any) => Promise<unknown>) {
  return vi.spyOn(ConfidentialSession.prototype, "run").mockImplementation(async function (this: any) {
    return steps(this) as never;
  });
}

function released(s: any) {
  s.authSent = true;
  s.released = true;
  s.sid = "ab".repeat(32);
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  closeConfidentialPrewarm();
});

describe("node errors around the release", () => {
  it("a node error after the release is thrown, never a refusal Response to fail over on", async () => {
    mockNode();
    fakeRun(async (s) => {
      released(s);
      throw new SessionRejectedError("settlement failed", undefined, 500);
    });
    for (const stream of [false, true]) {
      const p = call({}, { stream });
      await expect(p).rejects.toBeInstanceOf(SessionRejectedError);
      await expect(p).rejects.toThrow(/settlement failed/);
    }
  });

  it("a node refusal before the release is the HTTP error, with the change of a one-off bearer", async () => {
    mockNode();
    fakeRun(async (s) => {
      s.authSent = true;
      throw new SessionRejectedError("insufficient balance", undefined, 402);
    });
    const res = await call({ returnChange: true });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-cashu")).toBe(CHANGE);
    expect(res.headers.has("x-routstr-confidential-sid")).toBe(false);
  });
});

describe("one-off bearer change", () => {
  it("a stream's settlement carries the change", async () => {
    mockNode();
    fakeRun(async (s) => {
      released(s);
      s.onResponseHead?.(SSE_HEAD);
      s.onResponseBody?.(enc("data: [DONE]\n\n"));
      return RESULT;
    });
    const res = await call({ returnChange: true }, { stream: true });
    await res.text();
    expect(await (res as any).confidentialSettled).toEqual({ change: CHANGE });
  });

  it("a failed stream's settlement rejects with the withdrawn change", async () => {
    mockNode();
    fakeRun(async (s) => {
      released(s);
      s.onResponseHead?.(SSE_HEAD);
      throw new ReceiptVerificationError("bad receipt");
    });
    const res = await call({ returnChange: true }, { stream: true });
    const error = await (res as any).confidentialSettled.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptVerificationError);
    expect(error.cashuChange).toBe(CHANGE);
  });

  it("a thrown failure carries the change; nothing is withdrawn before the credential went out", async () => {
    mockNode();
    const run = fakeRun(async (s) => {
      released(s);
      throw new ReceiptVerificationError("bad receipt");
    });
    const error = await call({ returnChange: true }).catch((e: unknown) => e);
    expect((error as any).cashuChange).toBe(CHANGE);
    run.mockImplementation(async () => {
      throw new Error("no prover");
    });
    refunds = 0;
    const early = await call({ returnChange: true }).catch((e: unknown) => e);
    expect((early as any).cashuChange).toBeUndefined();
    expect(refunds).toBe(0);
  });
});

describe("caller abort", () => {
  it("never starts a session for an already-aborted signal", async () => {
    mockNode();
    const run = fakeRun(async () => RESULT);
    const ac = new AbortController();
    ac.abort();
    await expect(call({ signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("before the release closes the session at once", async () => {
    mockNode();
    const close = vi.spyOn(ConfidentialSession.prototype, "close");
    fakeRun(() => new Promise(() => {}));
    const ac = new AbortController();
    const p = call({ signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
    expect(close).toHaveBeenCalled();
  });

  it("after the release detaches the caller and lets the session settle", async () => {
    mockNode();
    const close = vi.spyOn(ConfidentialSession.prototype, "close");
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    fakeRun(async (s) => {
      released(s);
      s.onResponseHead?.(SSE_HEAD);
      s.onResponseBody?.(enc('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      await gate;
      s.onResponseBody?.(enc("data: [DONE]\n\n"));
      return RESULT;
    });
    const ac = new AbortController();
    const res = await call({ signal: ac.signal }, { stream: true });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toThrow(/abort/i);
    // Still running: closing now would charge the whole reservation.
    expect(close).not.toHaveBeenCalled();
    finish();
    await expect((res as any).confidentialSettled).resolves.toEqual({ change: undefined });
    expect(close).toHaveBeenCalled();
  });

  it("after the release, a non-streamed call rejects at once and the session settles on its own", async () => {
    mockNode();
    const close = vi.spyOn(ConfidentialSession.prototype, "close");
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let ended = false;
    fakeRun(async (s) => {
      released(s);
      await gate;
      ended = true;
      return RESULT;
    });
    const ac = new AbortController();
    const p = call({ signal: ac.signal, returnChange: true });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
    expect(close).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(ended).toBe(true);
    // Nobody is left to take change: the deposit stays for the wallet's refund.
    expect(refunds).toBe(0);
  });
});

describe("pre-warm", () => {
  it("never pools a Cashu bearer", async () => {
    mockNode();
    const run = fakeRun(async () => RESULT);
    await fetchConfidential({
      baseUrl: "https://prewarm-cashu.example",
      body: { model: "cheap", messages: [] },
      bearer: "cashuBbootstrap",
      options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex], prewarm: {} },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(confidentialPrewarmSnapshot()).toEqual([]);
  });
});

describe("session release guards", () => {
  const opts = () =>
    ({
      baseUrl: "http://127.0.0.1:8010",
      offer: { v: 2, notary_pubkey: "00".repeat(32), chat: VENICE_CHAT, suffix_keys: chatSuffixKeys(VENICE_CHAT) },
      auth: "sk-x",
      model: "m",
      maxTokens: 10,
      bodyLength: 100,
      prover: {},
    }) as never;

  it("a closed session never opens or arms", async () => {
    const realWs = (globalThis as any).WebSocket;
    let dialed = 0;
    (globalThis as any).WebSocket = class {
      constructor() {
        dialed++;
      }
      close() {}
    };
    try {
      const s = new ConfidentialSession(opts());
      s.close();
      await expect(s.open()).rejects.toThrow(/closed/);
      await expect(s.arm()).rejects.toThrow(/closed/);
      expect(dialed).toBe(0);
    } finally {
      (globalThis as any).WebSocket = realWs;
    }
  });

  it("checks the pinned suffix before it releases the credential record", async () => {
    const s = new ConfidentialSession(opts()) as any;
    s.prepared = true;
    s.ready = {};
    const sent: unknown[] = [];
    s.sendText = (m: unknown) => sent.push(m);
    await expect(s.finish(new Uint8Array(100).fill(0x78))).rejects.toThrow(/pinned suffix/);
    expect(s.bodyReleased).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("receipt model", () => {
  const usage = { prompt_tokens: 9, completion_tokens: 1 };
  const check = (receiptModel: string, reported: string) =>
    verifyReceipt({
      receipt: { sid: "s", model: receiptModel, usage: { model: reported, usage }, cost_msats: 10 } as never,
      ownUsage: { model: reported, usage },
      pinnedModel: "cheap",
      priceEntry: { in: 1000, out: 1000 },
    }).usageMatch;

  it("accepts the pinned model or the provider's spelling, nothing else", () => {
    expect(check("cheap", "cheap")).toBe(true);
    // The provider reports another id for the pinned model: the node signs the pinned one.
    expect(check("cheap", "Cheap-2026")).toBe(true);
    expect(check("Cheap-2026", "Cheap-2026")).toBe(true);
    expect(check("dear", "Cheap-2026")).toBe(false);
  });
});

describe("offer pins", () => {
  it("refuses an unsigned offer whenever node keys are pinned, even with allowUnpinned", () => {
    const policy = { allowUnpinned: true, trustedHosts: ["*.venice.ai"] };
    expect(() => verifyConfidentialOffer(offer(false) as never, { ...policy, pinnedPubkeys: [pubHex] })).toThrow(
      OfferUnpinnedError,
    );
    expect(() => verifyConfidentialOffer(offer(false) as never, { ...policy, pinnedPubkey: pubHex })).toThrow(
      OfferUnpinnedError,
    );
    expect(() => verifyConfidentialOffer(offer(false) as never, policy)).not.toThrow();
  });
});
