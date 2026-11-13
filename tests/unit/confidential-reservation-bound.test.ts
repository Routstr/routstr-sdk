/**
 * What the client knows of a request's reservation before it releases
 * anything (`request_ok.reserved_msats`, the caller's ceiling), how that
 * bounds an error receipt, what a released request's errors carry so nothing
 * runs it twice, and what a connection erases when it ends.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { VENICE_CHAT } from "./fixtures/chat";
import { canonicalJson } from "../../client/confidential/canonical";
import { canonicalSuffix, chatSuffixKeys } from "../../client/confidential/suffix";
import { checkUpstreamErrorReceipt } from "../../client/confidential/receipt";
import { requestStream } from "../../client/confidential/h2";
import { ConfidentialConnection, type ConnectionRequestOptions } from "../../client/confidential/connection";
import {
  ConfidentialError,
  ProverError,
  ReceiptVerificationError,
  ReservationAboveCeilingError,
  SessionProtocolError,
  SessionRejectedError,
  confidentialFailoverError,
  mayHaveReachedProvider,
} from "../../client/confidential/errors";
import { closeConfidentialConnections, fetchConfidential, http2OpenFailure } from "../../client/confidential/transport";
import { makeTLSClient } from "../../client/confidential/tls-fork/lib/index.js";
import { ProviderManager } from "../../client/ProviderManager";
import {
  RoutstrClient,
  confidentialReservationCeilingMsats,
  confidentialReservationMsats,
  setConfidentialTransport,
} from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const priv = new Uint8Array(32).fill(7);
const pubHex = bytesToHex(schnorr.getPublicKey(priv));
const CHAT_HEAD =
  "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
  "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n";

function signedOffer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const o: Record<string, unknown> = {
    v: 3,
    twopc: "split-public-1",
    upstream_host: "api.venice.ai",
    notary_pubkey: pubHex,
    max_tokens_cap: 4096,
    key_length: 42,
    key_alphabet: "[A-Za-z0-9_-]",
    head_template: CHAT_HEAD,
    suffix_keys: chatSuffixKeys(VENICE_CHAT),
    chat: VENICE_CHAT,
    price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
    mints: ["https://mint.example/"],
    ...extra,
  };
  const payload = canonicalJson(o);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
  return { ...o, sig, sig_payload: payload };
}

const enc = (t: string) => new TextEncoder().encode(t);
const H2 = { http: ["2", "1.1"], h2: { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 100 } };

afterEach(() => {
  vi.restoreAllMocks();
  closeConfidentialConnections();
});

describe("error receipts for a status billed at the reservation", () => {
  const err = (status: number, extra: Record<string, unknown>) =>
    ({ sid: "s1", model: "m", usage: { error_status: status }, ...extra }) as never;

  it("never take the receipt's own reservation as the bound", () => {
    for (const status of [500, 502, 504]) {
      // A validly shaped receipt whose cost and reservation were both inflated.
      const inflated = err(status, { cost_msats: 9_000_000, reserved_msats: 9_000_000 });
      expect(() => checkUpstreamErrorReceipt(inflated, status, 0)).toThrow(/no reservation bound/);
      expect(() => checkUpstreamErrorReceipt(inflated, status, 0, { reservationMsat: 50_000 })).toThrow(
        /reservation bound \(50000 msats\)/,
      );
      // The node announced 50 000 and signs another reservation in the receipt.
      expect(() =>
        checkUpstreamErrorReceipt(inflated, status, 0, { reservationMsat: 50_000, reservationAnnounced: true }),
      ).toThrow(/announced 50000/);
    }
  });

  it("accept a charge at the exact bound, and the fee without any bound", () => {
    const at = err(500, { cost_msats: 50_000, reserved_msats: 50_000 });
    expect(checkUpstreamErrorReceipt(at, 500, 0, { reservationMsat: 50_000, reservationAnnounced: true })).toBe(true);
    expect(checkUpstreamErrorReceipt(at, 500, 0, { reservationMsat: 50_000 })).toBe(true);
    // The caller's ceiling is an upper bound, the node may reserve (and charge) less.
    expect(checkUpstreamErrorReceipt(at, 500, 0, { reservationMsat: 80_000 })).toBe(true);
    expect(() =>
      checkUpstreamErrorReceipt(err(500, { cost_msats: 50_001, reserved_msats: 50_001 }), 500, 0, { reservationMsat: 50_000 }),
    ).toThrow(ReceiptVerificationError);
    // At most the fee needs no reservation at all.
    expect(checkUpstreamErrorReceipt(err(502, { cost_msats: 2000 }), 502, 2000)).toBe(true);
    // A malformed bound is refused, not ignored.
    expect(() => checkUpstreamErrorReceipt(at, 500, 0, { reservationMsat: -1 })).toThrow(/not a valid amount/);
  });

  it("an image request keeps its own ceiling as the bound", () => {
    const image = { model: "z", variant: "webp", count: 2, msatPerImage: 12_000 };
    const ok = { kind: "images", model: "z", variant: "webp", count: 2 };
    expect(
      checkUpstreamErrorReceipt(err(500, { ...ok, cost_msats: 26_000, reserved_msats: 26_000 }), 500, 0, { abandonFeeMsat: 2000, image }),
    ).toBe(true);
    expect(() =>
      checkUpstreamErrorReceipt(err(500, { ...ok, cost_msats: 26_001, reserved_msats: 26_001 }), 500, 0, { abandonFeeMsat: 2000, image }),
    ).toThrow(/price × count/);
  });
});

describe("the reservation announced in request_ok", () => {
  const base = (framing: "2" | "1.1") =>
    signedOffer({ ...(framing === "2" ? H2 : {}), connection_deposit_msat: 2000 }) as never;

  /** A connection whose network side never runs: `sent` gets the control frames. */
  function conn(framing: "2" | "1.1") {
    const offer = base(framing);
    const c = new ConfidentialConnection({
      baseUrl: "http://127.0.0.1:8010",
      offer,
      framing,
      auth: "sk-x",
      prover: {} as never,
    }) as any;
    c.phaseNow = framing === "2" ? "ready" : "armed";
    const sent: any[] = [];
    c.sendText = (m: unknown) => sent.push(m);
    vi.spyOn(c, "connect").mockResolvedValue(undefined);
    vi.spyOn(c, "arm").mockResolvedValue(undefined);
    // Framing "2": the request's records; framing "1.1": the ClientHello.
    const records = vi.spyOn(c, "sendRecord").mockReturnValue(new Promise(() => {}));
    const hello = vi.spyOn(c, "handshake").mockReturnValue(new Promise(() => {}));
    return { c, sent, records, hello, offer };
  }

  function ask(c: any, opts: Partial<ConnectionRequestOptions> = {}) {
    const suffix = canonicalSuffix(VENICE_CHAT, "cheap", 100);
    const handle = c.request({ model: "cheap", maxTokens: 100, body: enc(`{"messages":[]${suffix}`), ...opts });
    handle.done.catch(() => {});
    return { handle, suffix };
  }

  async function answer(c: any, sent: any[], suffix: string, extra: Record<string, unknown>) {
    await vi.waitFor(() => expect(sent.some((m) => m.type === "request")).toBe(true));
    const framing = c.framing;
    c.onText(
      JSON.stringify({
        type: "request_ok",
        n: 1,
        suffix,
        ...(framing === "2" ? { stream: requestStream(1) } : { head_len: 200 }),
        ...extra,
      }),
    );
  }

  for (const framing of ["2", "1.1"] as const) {
    it(`framing ${framing}: above the caller's ceiling, nothing of the request is sent`, async () => {
      const { c, sent, records, hello } = conn(framing);
      const { handle, suffix } = ask(c, { maxReservationMsat: 40_000 });
      await answer(c, sent, suffix, { reserved_msats: 40_001 });
      const error = await handle.done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReservationAboveCeilingError);
      expect(error).toMatchObject({ code: "reservation_above_ceiling", reservedMsat: 40_001, ceilingMsat: 40_000 });
      expect(records).not.toHaveBeenCalled();
      expect(hello).not.toHaveBeenCalled();
      expect(sent.some((m) => m.type === "release" || m.type === "release_head")).toBe(false);
      expect(handle.bodyReleased).toBe(false);
      expect(c.phase).toBe("closed");
      // Before the release: another node may serve it; "1.1" on this node would be refused the same way.
      expect(confidentialFailoverError(error)).toBe(true);
      expect(http2OpenFailure(error)).toBe(false);
    });

    it(`framing ${framing}: at the ceiling, or from a node that announces none, the request goes on`, async () => {
      for (const extra of [{ reserved_msats: 40_000 }, {}]) {
        for (const ceiling of [40_000, undefined]) {
          const { c, sent, records, hello } = conn(framing);
          const { suffix } = ask(c, { maxReservationMsat: ceiling });
          await answer(c, sent, suffix, extra);
          await vi.waitFor(() => expect(framing === "2" ? records : hello).toHaveBeenCalled());
          expect(c.cur.reservedMsat).toBe((extra as { reserved_msats?: number }).reserved_msats);
          c.close();
        }
      }
    });
  }

  it("a malformed reservation is a protocol error", async () => {
    for (const bad of [-1, 1.5, "40000", null, 2 ** 60]) {
      const { c, sent, records } = conn("2");
      const { handle, suffix } = ask(c);
      await answer(c, sent, suffix, { reserved_msats: bad });
      await expect(handle.done).rejects.toThrow(SessionProtocolError);
      expect(records).not.toHaveBeenCalled();
    }
  });

  it("a ceiling that is not a whole number of msat is refused before anything is sent", () => {
    const { c, sent } = conn("2");
    expect(() => ask(c, { maxReservationMsat: Number.NaN })).toThrow(/maxReservationMsat/);
    expect(sent).toEqual([]);
  });

  it("bounds a 5xx receipt by the announced reservation, else the caller's ceiling, else only the fee", () => {
    const { c, offer } = conn("2");
    const cur = (opts: Record<string, unknown>, reservedMsat?: number) =>
      ({ n: 2, first: false, model: "cheap", offer, opts, reservedMsat }) as never;
    const receipt = (cost: number, reserved: number) =>
      ({ sid: "s", model: "cheap", usage: { error_status: 500 }, cost_msats: cost, reserved_msats: reserved }) as never;
    // Announced: the receipt must name exactly that, and cost no more.
    expect(() => c.checkErrorReceipt(cur({}, 30_000), receipt(30_000, 30_000), 500)).not.toThrow();
    expect(() => c.checkErrorReceipt(cur({}, 30_000), receipt(30_000, 31_000), 500)).toThrow(/announced 30000/);
    expect(() => c.checkErrorReceipt(cur({}, 30_000), receipt(31_000, 31_000), 500)).toThrow(ReceiptVerificationError);
    // An old node (no announcement): the caller's ceiling.
    expect(() => c.checkErrorReceipt(cur({ maxReservationMsat: 40_000 }), receipt(40_000, 40_000), 500)).not.toThrow();
    expect(() => c.checkErrorReceipt(cur({ maxReservationMsat: 40_000 }), receipt(40_001, 40_001), 500)).toThrow(
      /reservation bound/,
    );
    // Neither: fail closed above the fee.
    expect(() => c.checkErrorReceipt(cur({}), receipt(1, 1), 500)).toThrow(/no reservation bound/);
    expect(() => c.checkErrorReceipt(cur({}), receipt(0, 0), 500)).not.toThrow();
  });
});

describe("the reservation ceiling a client derives", () => {
  const model = (extra: Record<string, unknown> = {}) =>
    ({ id: "m", context_length: 8192, sats_pricing: { prompt: 0.001, completion: 0.002, max_cost: 20 }, ...extra }) as unknown as Model;
  const offer = (extra: Record<string, unknown> = {}) =>
    ({
      price_list: { m: { in: 1000, out: 2000 } },
      max_tokens_cap: 4096,
      session_fee_msat: 100,
      abandon_fee_msat: 300,
      reserve_margin_tokens: 16,
      connection_deposit_msat: 2000,
      ...extra,
    }) as never;

  it("is the node's formula, never below its floor (the deposit bounds min_request_msat)", () => {
    const mirror = confidentialReservationMsats(model(), 100, offer())!;
    // ceil((8192 × 1000 + 116 × 2000) / 1000) + 300
    expect(mirror).toBe(8192 + 232 + 300);
    expect(confidentialReservationCeilingMsats(model(), 100, offer())).toBe(mirror);
    // A tiny reservation: the node's floor may lift it up to the deposit.
    const tiny = offer({ price_list: { m: { in: 0.001, out: 0.001 } } });
    expect(confidentialReservationCeilingMsats(model(), 1, tiny)).toBe(2000 + 300);
  });

  it("is none where the client cannot bound what an honest node reserves", () => {
    // No deposit: the node's minimum reservation is unknown.
    expect(confidentialReservationCeilingMsats(model(), 100, offer({ connection_deposit_msat: 0 }))).toBeUndefined();
    // No context length: the node's fallback reads the model's sats price.
    expect(confidentialReservationCeilingMsats(model({ context_length: undefined }), 100, offer())).toBeUndefined();
    // The offer does not price the model, or there is no offer.
    expect(confidentialReservationCeilingMsats(model({ id: "other" }), 100, offer())).toBeUndefined();
    expect(confidentialReservationCeilingMsats(model(), 100, undefined)).toBeUndefined();
  });
});

describe("a connection's secrets when it ends", () => {
  const opts = () =>
    ({
      baseUrl: "http://127.0.0.1:8010",
      offer: { v: 3, notary_pubkey: "00".repeat(32), chat: VENICE_CHAT, suffix_keys: chatSuffixKeys(VENICE_CHAT) },
      auth: "sk-x",
      prover: {},
    }) as never;

  it("are zero-filled and dropped, and the TLS client erases its own", async () => {
    const c = new ConfidentialConnection(opts()) as any;
    const ap = {
      serverAp0: new Uint8Array(32).fill(1),
      clientAp1: new Uint8Array(32).fill(2),
      h1: new Uint8Array(32).fill(3),
      h2: new Uint8Array(32).fill(4),
      hk: new Uint8Array(32).fill(5),
    };
    c.ap = ap;
    const destroySecrets = vi.fn();
    c.tls = { destroySecrets };
    c.close("test");
    for (const v of Object.values(ap)) expect(v.every((b) => b === 0)).toBe(true);
    expect(c.ap).toBeUndefined();
    expect(destroySecrets).toHaveBeenCalledTimes(1);
  });

  it("anything still running gets the connection's failure, not a TypeError", async () => {
    const c = new ConfidentialConnection(opts()) as any;
    c.ap = { serverAp0: new Uint8Array(32), clientAp1: new Uint8Array(32), h1: new Uint8Array(32), h2: new Uint8Array(32), hk: new Uint8Array(32) };
    c.close("gone");
    expect(() => c.secrets()).toThrow(/connection closed: gone/);
    await expect(c.proveRecords({ first_seq: 0, count: 1, params: {} })).rejects.toBeInstanceOf(SessionRejectedError);
    await expect(c.settleErrorHead({ proofs: [], head: { off: 0, raw: new Uint8Array(0) } }, 500)).rejects.toThrow(
      /connection closed: gone/,
    );
  });

  it("the TLS fork's destroySecrets ends the client and drops its keys", () => {
    const tls = makeTLSClient({ host: "api.venice.ai", write: () => {}, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } } as never) as any;
    tls.destroySecrets();
    expect(tls.hasEnded()).toBe(true);
    expect(tls.getKeys()).toBeUndefined();
    expect(tls.isHandshakeDone()).toBe(false);
  });
});

// --- the transport and the client around the release ---------------------------------------

const MODEL = "m-1";
const A = "https://a.example/";
const C = "https://c.example/";
const MINT = "https://mint.example";
const SSE_HEAD = { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } };

const nodeOffer = () =>
  signedOffer({ price_list: { [MODEL]: { in: 1000, cached_in: 1000, out: 1000 } }, connection_deposit_msat: 2000 });

const realFetch = globalThis.fetch;
function mockNode() {
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith("/v1/wallet/refund")) return new Response(JSON.stringify({}), { status: 400 });
    return new Response(JSON.stringify(nodeOffer()), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stand-in for a connection's one request (as in confidential-release.test):
 * `steps` runs with a state (`released`, the response handlers) and returns
 * the outcome or throws.
 */
function fakeRun(steps: (s: any, opts: ConnectionRequestOptions) => Promise<unknown>) {
  let sids = 0;
  const open = async function (this: any) {
    if (this.failure) throw this.failure;
    if (this.phaseNow === "new") {
      this.sid = (++sids).toString(16).padStart(64, "0");
      this.phaseNow = this.framing === "2" ? "ready" : "armed";
      this.tOpen = this.tLastSettled = Date.now();
    }
  };
  vi.spyOn(ConfidentialConnection.prototype, "arm").mockImplementation(open);
  vi.spyOn(ConfidentialConnection.prototype, "connect").mockImplementation(open);
  return vi.spyOn(ConfidentialConnection.prototype, "request").mockImplementation(function (
    this: any,
    opts: ConnectionRequestOptions,
  ) {
    const conn = this;
    const s: any = { released: false, onResponseHead: opts.onResponseHead, onResponseBody: opts.onResponseBody };
    conn.cur = { n: 1 };
    const done = (async () => {
      try {
        const r: any = await steps(s, opts);
        conn.cur = undefined;
        conn.requests = 1;
        conn.settled = 1;
        conn.goaway = true;
        return {
          sid: conn.sid,
          http: conn.framing,
          n: 1,
          model: opts.model,
          status: r.status,
          headers: r.headers ?? {},
          body: new Uint8Array(0),
          receipt: {},
          attestation: {},
          timings: { startedAt: Date.now(), totalMs: 1, proofs: [] },
          bytes: { relaySent: 0, relayRecv: 0, controlSent: 0, controlRecv: 0, twoPcSent: 0, twoPcRecv: 0, zkSent: 0, zkRecv: 0 },
        };
      } catch (e) {
        conn.fail(e);
        throw e;
      }
    })();
    done.catch(() => {});
    return {
      n: 1,
      get sid() {
        return conn.sid;
      },
      get bodyReleased() {
        return s.released === true;
      },
      get credentialSent() {
        return true;
      },
      done,
      close() {
        conn.close("request aborted");
      },
    } as never;
  });
}

const OPTIONS = { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex] };

describe("errors after the release carry the transport's marker", () => {
  const call = (body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    fetchConfidential({
      baseUrl: `https://marker-${Math.random().toString(16).slice(2)}.example`,
      body: { model: MODEL, messages: [], ...body },
      bearer: "sk-x",
      options: OPTIONS,
      ...extra,
    });

  it("set (not enumerable) once released, whatever the node's close reason says; never before", async () => {
    mockNode();
    let release = true;
    fakeRun(async (s) => {
      s.released = release;
      throw new SessionRejectedError("connection closed: ECONNRESET");
    });
    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionRejectedError);
    expect(mayHaveReachedProvider(error)).toBe(true);
    expect(Object.keys(error as object)).not.toContain("mayHaveReachedProvider");
    expect(confidentialFailoverError(error)).toBe(false);

    release = false;
    const early = await call().catch((e: unknown) => e);
    expect(early).toBeInstanceOf(SessionRejectedError);
    expect(mayHaveReachedProvider(early)).toBe(false);
    expect(confidentialFailoverError(early)).toBe(true);
  });

  it("on a stream's later failure too (the settlement and the stream's error)", async () => {
    mockNode();
    fakeRun(async (s) => {
      s.released = true;
      s.onResponseHead?.(SSE_HEAD);
      s.onResponseBody?.(enc("data: hi\n\n"));
      throw new ReceiptVerificationError("bad receipt");
    });
    const res = await call({ stream: true });
    const streamError = await res.text().catch((e: unknown) => e);
    const settled = await (res as any).confidentialSettled.catch((e: unknown) => e);
    expect(mayHaveReachedProvider(streamError)).toBe(true);
    expect(mayHaveReachedProvider(settled)).toBe(true);
  });

  it("the caller's ceiling reaches the connection's request, computed from the offer it is priced by", async () => {
    mockNode();
    const seen: unknown[] = [];
    const ceiling = vi.fn((_offer: unknown, request: { model: string; maxTokens: number }) => 1000 + request.maxTokens);
    fakeRun(async (s, opts) => {
      seen.push(opts.maxReservationMsat);
      s.released = true;
      s.onResponseHead?.(SSE_HEAD);
      return SSE_HEAD;
    });
    await call({ max_tokens: 77 }, { maxReservationMsat: ceiling });
    expect(ceiling).toHaveBeenCalledTimes(1);
    expect((ceiling.mock.calls[0]![0] as { sig?: unknown }).sig).toBeDefined();
    expect(ceiling.mock.calls[0]![1]).toEqual({ model: MODEL, maxTokens: 77 });
    expect(seen).toEqual([1077]);
    await call({}, { maxReservationMsat: 5000 });
    expect(seen[1]).toBe(5000);
  });
});

describe("RoutstrClient around a confidential release", () => {
  const logger: SdkLogger = {
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    },
  };
  const cu = { v: 3, offer_url: "/v1/confidential/offer" };
  const entry = (completion: number): Model =>
    ({
      id: MODEL,
      name: MODEL,
      context_length: 4096,
      sats_pricing: { prompt: 1, completion, max_cost: 100, max_prompt_cost: 60, max_completion_cost: 40 },
      confidential_upstream: cu,
    }) as unknown as Model;

  function setup() {
    const models: Record<string, Model[]> = { [A]: [entry(1)], [C]: [entry(3)] };
    const registry = {
      getCachedModels: () => models,
      getModelIdMappings: () => ({}),
      getDisabledProviders: () => [],
      getCachedMints: () => ({}),
      getCachedProviderInfo: () => ({}),
    } as unknown as DiscoveryAdapter;
    const manager = new ProviderManager(registry, undefined, logger);
    const wallet = {
      getBalances: async () => ({ [MINT]: 100_000 }),
      getMintUnits: () => ({}),
      getActiveMintUrl: () => MINT,
      sendToken: async () => "cashu-test",
      receiveToken: async () => ({ success: false, message: "n/a" }),
    } as unknown as WalletAdapter;
    const storage = {
      getApiKey: () => null,
      removeApiKey: vi.fn(),
      getApiKeyDistribution: () => [],
    } as unknown as StorageAdapter;
    const client = new RoutstrClient(wallet, storage, registry, "max", "apikeys", { providerManager: manager, logger });
    vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
    const spent: string[] = [];
    vi.spyOn(client as any, "_spendToken").mockImplementation(async (...args: unknown[]) => {
      spent.push((args[0] as { baseUrl: string }).baseUrl);
      return { token: `sk-${spent.length}`, tokenBalance: 100_000, tokenBalanceUnit: "sat", tokenBalanceUnknown: false };
    });
    const bm = client.getBalanceManager();
    vi.spyOn(bm, "getTokenBalance").mockResolvedValue({ amount: 0, reserved: 0, unit: "msat", apiKey: "sk-1" });
    vi.spyOn(bm, "refundApiKey").mockResolvedValue({ success: true, message: "ok", amount: 0 } as any);
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
    // The real transport, on a stand-in connection; the qualifier hands back the node's offer.
    setConfidentialTransport(fetchConfidential, async () => nodeOffer());
    return { client, spent };
  }

  const route = (client: RoutstrClient) =>
    client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      baseUrl: A,
      mintUrl: MINT,
      modelId: MODEL,
      confidential: OPTIONS,
    });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("@routstr/sdk/confidentialTransport")];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("@routstr/sdk/confidentialQualifier")];
  });

  it("a released request whose node closes with 'ECONNRESET' runs once and is paid once", async () => {
    mockNode();
    const { client, spent } = setup();
    const run = fakeRun(async (s) => {
      s.released = true;
      throw new SessionRejectedError("connection closed: ECONNRESET");
    });
    await expect(route(client)).rejects.toThrow(/ECONNRESET/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(spent).toEqual([A]);
  });

  it("a connection that fails before the release still fails over, by its type", async () => {
    mockNode();
    const { client, spent } = setup();
    let calls = 0;
    const run = fakeRun(async (s) => {
      if (++calls === 1) throw new SessionRejectedError("connection closed: going away");
      s.released = true;
      s.onResponseHead?.(SSE_HEAD);
      s.onResponseBody?.(enc('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
      return SSE_HEAD;
    });
    const res = await route(client);
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(spent).toEqual([A, C]);
  });

  it("a node-chosen message does not pick failover: a local fault with 'ECONNRESET' in it stays", async () => {
    mockNode();
    const { client, spent } = setup();
    const run = fakeRun(async () => {
      throw new ProverError("cu-prover: ECONNRESET");
    });
    await expect(route(client)).rejects.toThrow(ProverError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(spent).toEqual([A]);
  });

  it("passes a ceiling from the node's own formula for the selected model", async () => {
    mockNode();
    const { client } = setup();
    const seen: unknown[] = [];
    fakeRun(async (s, opts) => {
      seen.push(opts.maxReservationMsat);
      s.released = true;
      s.onResponseHead?.(SSE_HEAD);
      s.onResponseBody?.(enc("data: [DONE]\n\n"));
      return SSE_HEAD;
    });
    const res = await route(client);
    expect(res.status).toBe(200);
    expect(seen).toEqual([confidentialReservationCeilingMsats(entry(1), 10, nodeOffer() as never)]);
    expect(typeof seen[0]).toBe("number");
  });

  it("a confidential error class is matched by code (any bundle)", () => {
    const foreign = Object.assign(new Error("connection closed: x"), { code: "session_rejected", name: "SessionRejectedError" });
    expect(confidentialFailoverError(foreign)).toBe(true);
    expect(confidentialFailoverError(new ConfidentialError("not_configured", "x"))).toBe(false);
    expect(confidentialFailoverError(new SessionRejectedError("refused", undefined, 402))).toBe(false);
    expect(confidentialFailoverError(new TypeError("Failed to fetch"))).toBe(false);
  });
});
