/**
 * `ConfidentialConnection.request` end to end against a small fake node, for
 * both framings: the `request` / `request_ok` / `request_refused` / `release` /
 * `body_released` / `disclose` / `disclose_head` state machine and the
 * per-connection money rules (the session fee once per connection, the
 * deposit released by the first settlement and only by it; PROTOCOL-V3.md
 * §8.3, §12.8, §12.10).
 *
 * The fake node speaks the control protocol and plays the provider: it feeds
 * the client TLS records whose "encryption" is the identity (a stand-in TLS
 * client), so the provider's frames reach the connection as decrypted
 * records. The 2PC, the proof channel and the proof-parameter checks (tested
 * on their own elsewhere) are stand-ins; the attestation and the receipts are
 * signed with the node's key and checked as on a real connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

const tlsFake = vi.hoisted(() => {
  const cat = (...parts: ArrayLike<number>[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  return {
    cat,
    /** A TLS client whose records carry their inner plaintext in the clear (plus a 16-byte "tag"). */
    makeTLSClient(o: any) {
      let pending = new Uint8Array(0);
      const emit = (inner: Uint8Array) => {
        const len = inner.length + 16;
        o.write({ header: Uint8Array.from([0x17, 3, 3, len >> 8, len & 0xff]), content: cat(inner, new Uint8Array(16)) });
      };
      return {
        async startHandshake() {
          o.write({ header: Uint8Array.from([0x16, 3, 1, 0, 4]), content: Uint8Array.from([1, 0, 0, 0]) });
          await o.external.onServerHello(new Uint8Array(65).fill(4), new Uint8Array(32).fill(0xa1));
          await o.external.onServerFinished(new Uint8Array(32).fill(0xa2));
          o.onHandshake();
        },
        async handleReceivedBytes(b: Uint8Array) {
          pending = cat(pending, b);
          while (pending.length >= 5) {
            const len = (pending[3]! << 8) | pending[4]!;
            if (pending.length < 5 + len) break;
            const inner = pending.slice(5, 5 + len - 16);
            pending = pending.slice(5 + len);
            const type = inner[inner.length - 1];
            const content = inner.slice(0, inner.length - 1);
            o.onRead({ content }, { type: "ciphertext", contentType: type === 0x17 ? "APPLICATION_DATA" : "HANDSHAKE", plaintext: inner });
            if (type === 0x17) o.onApplicationData(content);
          }
        },
        async write(data: Uint8Array) {
          emit(cat(data, [0x17]));
        },
        async writeInner(inner: Uint8Array) {
          emit(inner);
        },
      };
    },
  };
});

vi.mock("../../client/confidential/tls-fork/lib/index.js", () => ({ makeTLSClient: tlsFake.makeTLSClient }));
// The proof parameters are checked by their own tests (confidential-params,
// confidential-h2); here every statement the fake node names is accepted.
vi.mock("../../client/confidential/h2", async (orig) => ({
  ...(await orig<typeof import("../../client/confidential/h2")>()),
  checkPiNKParamsH2: () => {},
  checkPiWinParams: () => ({ windows: 1, ctBytes: 0 }),
  checkPiWinFinalRecord: () => ({ windows: 1, ctBytes: 0 }),
}));
vi.mock("../../client/confidential/params", async (orig) => ({
  ...(await orig<typeof import("../../client/confidential/params")>()),
  checkPiNKParams: () => {},
  checkPiC3SParams: () => {},
}));

import { ConfidentialConnection, type ConnectionRequestOptions } from "../../client/confidential/connection";
import { FLAG, FRAME, frame } from "../../client/confidential/h2";
import { canonicalSuffix } from "../../client/confidential/suffix";
import { ReceiptVerificationError, RequestRefusedError } from "../../client/confidential/errors";
import { BOTH, NODE_PRIV, NODE_PUB, ONLY_11, v3OfferFields } from "./fixtures/v3";
import { VENICE_CHAT } from "./fixtures/chat";

const { cat } = tlsFake;
const enc = (s: string) => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sign = (json: string) => bytesToHex(schnorr.sign(sha256(utf8ToBytes(json)), NODE_PRIV));

const SID = "ab".repeat(32);
const FEE = 500;
const ABANDON = 800;
const DEPOSIT = 1000;
const TH_SH = hexOf(new Uint8Array(32).fill(0xa1));
const TH_SF = hexOf(new Uint8Array(32).fill(0xa2));
const C_COMMIT = new Uint8Array(32).fill(0xcc);
const AP = {
  serverAp0: new Uint8Array(16).fill(1),
  clientAp1: new Uint8Array(16).fill(2),
  h1: new Uint8Array(32).fill(3),
  h2: new Uint8Array(32).fill(4),
  hk: new Uint8Array(32).fill(5),
};
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
/** The usage at the offer's rates (1000 msat per 1000 tokens each way). */
const USAGE_MSAT = 15;
const USAGE_EVENT = JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "cheap", choices: [], usage: USAGE });
const SSE_TEXT = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';

type Receipt = Record<string, unknown>;
interface Settle {
  n: number;
  /** The node's own count: no request settled on this connection before. */
  first: boolean;
  kind: "usage" | "error";
  status: number;
}

/** What the fake node does; every hook defaults to an honest node. */
interface Script {
  /** Refuse request n (the connection stays as it was). */
  refuse?: (n: number) => { status: number; reason: string } | undefined;
  /** Framing "2": the provider's records for request n on `stream` (each entry one record). */
  respond2?: (n: number, stream: number) => Uint8Array[];
  /** Framing "1.1": the provider's response bytes, one entry per record. */
  respond11?: () => string[];
  /** The receipt's fields beyond the binding (sid, http, n, model, attestation_hash). */
  receipt?: (s: Settle, honest: Receipt) => Receipt;
  /** The provider's SETTINGS payload after the head. */
  settings?: Uint8Array;
}

const head200 = (stream: number) => frame(FRAME.HEADERS, FLAG.END_HEADERS, stream, Uint8Array.from([0x88]));
/** `:status <code>` as a literal without indexing (name index 8). */
const headStatus = (stream: number, code: number, endStream: boolean) =>
  frame(FRAME.HEADERS, FLAG.END_HEADERS | (endStream ? FLAG.END_STREAM : 0), stream, cat([0x08, 3], enc(String(code))));
const rst = (stream: number, code: number) => frame(FRAME.RST_STREAM, 0, stream, Uint8Array.from([0, 0, 0, code]));
const chat2xx = (stream: number) => [
  head200(stream),
  frame(FRAME.DATA, 0, stream, enc(SSE_TEXT)),
  frame(FRAME.DATA, FLAG.END_STREAM, stream, enc(`data: ${USAGE_EVENT}\n\ndata: [DONE]\n\n`)),
];

class FakeNode {
  ws: any;
  framing: "2" | "1.1" = "2";
  /** Control frames the client sent, by type, in order. */
  log: string[] = [];
  errors: Error[] = [];
  private hello = false;
  private headWritten = false;
  private ctlNext = false;
  private seqs = 0;
  private proven = 0;
  /** Payloads of the server records sent (the client indexes them from 0). */
  private serverRecs: Uint8Array[] = [];
  private sentBytes = createHash("sha256");
  private settledCount = 0;
  private cur?: { n: number; model: string; maxTokens: number; suffix: string; recs: Uint8Array[]; sK?: number; released: boolean };

  constructor(readonly script: Script = {}) {}

  private later(f: () => void): void {
    setTimeout(f, 0);
  }

  text(obj: unknown): void {
    this.later(() => this.ws.onmessage?.({ data: JSON.stringify(obj) }));
  }

  /** One server record whose inner plaintext is `content` ‖ 0x17. */
  record(content: Uint8Array): void {
    const payload = cat(content, [0x17], new Uint8Array(16));
    const rec = cat([0x17, 3, 3, payload.length >> 8, payload.length & 0xff], payload);
    this.serverRecs.push(payload);
    this.sentBytes.update(rec);
    this.later(() => this.ws.onmessage?.({ data: rec.slice().buffer }));
  }

  private hashRecs(from: number, to: number): string {
    const h = createHash("sha256");
    for (let i = from; i < to; i++) {
      const p = this.serverRecs[i]!;
      h.update(Uint8Array.from([0x17, 3, 3, p.length >> 8, p.length & 0xff]));
      h.update(p);
    }
    return h.digest("hex");
  }

  fromClient(d: Uint8Array | string): void {
    if (typeof d !== "string") return this.binary(d);
    const m = JSON.parse(d);
    this.log.push(m.type);
    switch (m.type) {
      case "setup":
        this.framing = m.http;
        this.text({ type: "ready", v: 3, http: m.http, sid: SID, pubkey: NODE_PUB, deposit_msat: DEPOSIT, armed: m.armed });
        return;
      case "release_head":
        this.headWritten = true;
        this.text({ type: "head_written" });
        if (this.framing === "2") this.record(frame(FRAME.SETTINGS, 0, 0, this.script.settings ?? new Uint8Array(0)));
        return;
      case "request": {
        const refused = this.script.refuse?.(m.n);
        if (refused) {
          this.text({ type: "request_refused", n: m.n, ...refused });
          return;
        }
        const suffix = canonicalSuffix(VENICE_CHAT, m.model, m.max_tokens);
        this.cur = { n: m.n, model: m.model, maxTokens: m.max_tokens, suffix, recs: [], released: false };
        this.text(
          this.framing === "2"
            ? { type: "request_ok", n: m.n, sid: SID, stream: 2 * m.n + 1, suffix }
            : { type: "request_ok", n: m.n, sid: SID, suffix, head_len: 100 },
        );
        return;
      }
      case "ctl":
        this.ctlNext = true;
        return;
      case "release": {
        const cur = this.cur!;
        if (cur.released || m.upto < cur.recs.length) return;
        cur.released = true;
        this.text({ type: "zk_params", proof: "pi_win", purpose: "records", first_seq: this.proven, count: this.seqs - this.proven, params: {} });
        this.proven = this.seqs;
        this.text({ type: "body_released", n: cur.n });
        cur.sK = this.serverRecs.length;
        const stream = 2 * cur.n + 1;
        for (const c of (this.script.respond2 ?? ((_n, s) => chat2xx(s)))(cur.n, stream)) this.record(c);
        return;
      }
      case "disclose":
      case "disclose_head": {
        const cur = this.cur!;
        if (this.framing === "2") {
          const end = m.type === "disclose" ? m.server_records : this.serverRecs.length;
          const sent = createHash("sha256");
          for (const r of cur.recs) sent.update(r);
          this.attest({
            sid: SID,
            http: "2",
            n: cur.n,
            stream: 2 * cur.n + 1,
            th_sh: TH_SH,
            th_sf: TH_SF,
            c_commit: hexOf(C_COMMIT),
            s_k: cur.sK,
            server_records: end - cur.sK!,
            sha256_recv: this.hashRecs(cur.sK!, end),
            client_records: cur.recs.length,
            sha256_sent: sent.digest("hex"),
          });
          this.text(
            m.type === "disclose"
              ? { type: "zk_params", proof: "pi_c3s", purpose: "", n: cur.n, params: {} }
              : { type: "zk_params", proof: "pi_win", purpose: "error_head", n: cur.n, params: {} },
          );
        } else {
          this.text({ type: "zk_params", proof: "pi_c3s", purpose: m.type === "disclose" ? "" : "error_head", n: 1, params: {} });
        }
        const status = m.type === "disclose" ? 200 : this.errorStatus(m);
        this.sendReceipt({ n: cur.n, first: this.settledCount === 0, kind: m.type === "disclose" ? "usage" : "error", status });
        this.settledCount++;
        if (this.framing === "1.1" || m.type === "disclose_head") {
          this.text({ type: "closed", reason: m.type === "disclose" ? "done" : "error_settled" });
        }
        return;
      }
      default:
        return;
    }
  }

  private errorStatus(m: any): number {
    const r = Buffer.from(m.r, "hex").toString("latin1");
    const http11 = /^HTTP\/1\.[01] (\d{3})/.exec(r);
    if (http11) return Number(http11[1]);
    // Framing "2": the head is `:status` as a literal without indexing.
    return Number(r.slice(-3));
  }

  private lastAttJson = "";
  private attest(a: Record<string, unknown>): void {
    this.lastAttJson = JSON.stringify(a);
    this.text({ type: "attestation", n: a.n, a_json: this.lastAttJson, sig: sign(this.lastAttJson) });
  }

  private sendReceipt(s: Settle): void {
    const fee = s.first ? FEE : 0;
    let cost: number;
    let usage: unknown;
    if (s.kind === "usage") {
      cost = USAGE_MSAT + fee;
      usage = JSON.parse(USAGE_EVENT);
    } else {
      cost = [401, 402, 403, 429, 503].includes(s.status) ? fee : ABANDON;
      usage = { error_status: s.status };
    }
    const honest: Receipt = { cost_msats: cost, usage };
    if (s.first) honest.deposit_released_msat = DEPOSIT;
    const fields = this.script.receipt ? this.script.receipt(s, honest) : honest;
    const receipt = {
      sid: SID,
      http: this.framing,
      n: s.n,
      model: this.cur!.model,
      attestation_hash: bytesToHex(sha256(utf8ToBytes(this.lastAttJson))),
      ...fields,
    };
    const json = JSON.stringify(receipt);
    this.text({ type: "receipt", receipt_json: json, sig: sign(json) });
  }

  private binary(rec: Uint8Array): void {
    if (!this.hello) {
      // The ClientHello: the handshake "runs", the node verified it.
      this.hello = true;
      this.text({ type: "hs_verified" });
      this.text({
        type: "c_commit",
        c_commit: hexOf(C_COMMIT),
        params: { PiNK: { c_commit: Array.from(C_COMMIT), head_len: 100 } },
      });
      return;
    }
    if (!this.headWritten) return;
    const seq = this.seqs++;
    if (this.ctlNext) {
      this.ctlNext = false;
      return;
    }
    const cur = this.cur;
    if (!cur) return;
    cur.recs.push(rec);
    if (this.framing === "1.1") {
      const inner = rec.subarray(5, rec.length - 16);
      if (Buffer.from(inner.subarray(0, inner.length - 1)).toString() !== cur.suffix) return;
      // The final record (the suffix alone): π_WIN, released, the response, the attestation.
      this.text({ type: "zk_params", proof: "pi_win", purpose: "records", first_seq: seq, count: 1, params: {} });
      this.text({ type: "body_released", n: 1 });
      for (const r of (this.script.respond11 ?? (() => [HTTP11_OK]))()) this.record(enc(r));
      this.later(() => {
        this.attest({
          sid: SID,
          http: "1.1",
          n: 1,
          th_sh: TH_SH,
          th_sf: TH_SF,
          c_commit: hexOf(C_COMMIT),
          server_records: this.serverRecs.length,
          sha256_recv: this.sentBytes.copy().digest("hex"),
          client_records: cur.recs.length,
        });
      });
    }
  }
}

const SSE_11 = `${SSE_TEXT}data: ${USAGE_EVENT}\n\ndata: [DONE]\n\n`;
const HTTP11_OK =
  "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
  `${enc(SSE_11).length.toString(16)}\r\n${SSE_11}\r\n0\r\n\r\n`;

let node: FakeNode;
const realWs = (globalThis as any).WebSocket;

class FakeWs {
  binaryType = "";
  onopen?: () => void;
  onerror?: () => void;
  onclose?: (ev: unknown) => void;
  onmessage?: (ev: { data: unknown }) => void;
  private closed = false;
  constructor(readonly url: string) {
    node.ws = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d: Uint8Array | string): void {
    if (this.closed) return;
    try {
      node.fromClient(typeof d === "string" ? d : new Uint8Array(d));
    } catch (e) {
      // A bug in the fake node must not pass as the client's.
      node.errors.push(e as Error);
      throw e;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.({ reason: "" }), 0);
  }
}

const proofs: string[] = [];
function newConnection(framing: "2" | "1.1", script: Script = {}): ConfidentialConnection {
  node = new FakeNode(script);
  const offer = v3OfferFields({
    ...(framing === "2" ? BOTH : ONLY_11),
    session_fee_msat: FEE,
    abandon_fee_msat: ABANDON,
    connection_deposit_msat: DEPOSIT,
  });
  return new ConfidentialConnection({
    baseUrl: "http://127.0.0.1:1",
    offer: offer as never,
    framing,
    auth: "sk-test",
    prover: { run: async () => {} } as never,
    twoPcFactory: () =>
      ({
        start() {},
        async keyShare() {
          return new Uint8Array(65).fill(4);
        },
        async handshake() {
          return { clientHs: new Uint8Array(16), serverHs: new Uint8Array(16) };
        },
        async application() {
          return AP;
        },
        close() {},
        failed: false,
        bytesSent: 0,
        bytesRecv: 0,
      }) as never,
    proofChannelFactory: () =>
      ({
        start() {},
        used: true,
        failed: false,
        bytesSent: 0,
        bytesRecv: 0,
        async ready() {
          return true;
        },
        async run(_cmd: string, proof: string) {
          proofs.push(proof);
          return { ms: 0 };
        },
        async topup() {
          return undefined;
        },
        close() {},
      }) as never,
    timeouts: { probe: 0, errorBody: 10_000, closed: 200 },
  });
}

/** Framing "2": open (READY); "1.1": armed. As the pool hands a connection to a request. */
async function connection(framing: "2" | "1.1", script: Script = {}): Promise<ConfidentialConnection> {
  const conn = newConnection(framing, script);
  if (framing === "2") await conn.connect();
  else await conn.arm();
  return conn;
}

const MODEL = "cheap";
function chatRequest(maxTokens = 20): ConnectionRequestOptions {
  const suffix = canonicalSuffix(VENICE_CHAT, MODEL, maxTokens);
  return { model: MODEL, maxTokens, body: enc(`{"messages":[{"role":"user","content":"hi"}]${suffix}`) };
}

beforeEach(() => {
  (globalThis as any).WebSocket = FakeWs;
  proofs.length = 0;
});
afterEach(() => {
  (globalThis as any).WebSocket = realWs;
  expect(node.errors).toEqual([]);
});

describe("framing 2: requests on one connection", () => {
  it("request → request_ok → records → release → body_released → disclose → receipt, twice", async () => {
    const conn = await connection("2");
    const h1 = conn.request(chatRequest());
    const r1 = await h1.done;
    expect(r1.status).toBe(200);
    expect(r1.n).toBe(1);
    expect(r1.stream).toBe(3);
    expect(new TextDecoder().decode(r1.body)).toContain('"content":"hi"');
    expect(r1.costMsats).toBe(USAGE_MSAT + FEE);
    expect(h1.bodyReleased).toBe(true);
    expect(conn.deposit).toEqual({ msat: DEPOSIT, outcome: "released", reason: "request_settled", signed: true });
    expect(conn.idle).toBe(true);
    // The second request: no fee, no deposit.
    const r2 = await conn.request(chatRequest()).done;
    expect(r2.n).toBe(2);
    expect(r2.stream).toBe(5);
    expect(r2.costMsats).toBe(USAGE_MSAT);
    expect(node.log.filter((t) => ["request", "release", "disclose", "disclose_head"].includes(t))).toEqual([
      "request",
      "release",
      "disclose",
      "request",
      "release",
      "disclose",
    ]);
    expect(proofs.filter((p) => p !== "pi_nk")).toEqual(["pi_win", "pi_c3s", "pi_win", "pi_c3s"]);
    conn.close();
  });

  it("a refused request leaves the connection ready and its number unused", async () => {
    let refusals = 0;
    const conn = await connection("2", { refuse: () => (refusals++ === 0 ? { status: 402, reason: "balance" } : undefined) });
    const h = conn.request(chatRequest());
    await expect(h.done).rejects.toBeInstanceOf(RequestRefusedError);
    expect(h.bodyReleased).toBe(false);
    expect(conn.idle).toBe(true);
    const r = await conn.request(chatRequest()).done;
    expect(r.n).toBe(1);
    // The connection's first settlement is still the first: fee and deposit.
    expect(r.costMsats).toBe(USAGE_MSAT + FEE);
    expect(conn.deposit?.outcome).toBe("released");
    expect(node.log.filter((t) => t === "release")).toHaveLength(1);
    conn.close();
  });

  it("an error head is disclosed and settled at the session fee; the node then closes", async () => {
    const conn = await connection("2", { respond2: (_n, s) => [headStatus(s, 429, true)] });
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(429);
    expect(r.costMsats).toBe(FEE);
    expect(node.log).toContain("disclose_head");
    expect(conn.idle).toBe(false);
    conn.close();
  });

  it("an error head followed by RST_STREAM(NO_ERROR) in the same record is still disclosed (finding 18)", async () => {
    const conn = await connection("2", { respond2: (_n, s) => [cat(headStatus(s, 429, true), rst(s, 0))] });
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(429);
    expect(r.costMsats).toBe(FEE);
    expect(node.log.filter((t) => ["request", "release", "disclose_head"].includes(t))).toEqual(["request", "release", "disclose_head"]);
  });

  it("an error head without END_STREAM, then a reset: the error-body wait ends at the reset (finding 18)", async () => {
    const conn = await connection("2", { respond2: (_n, s) => [headStatus(s, 401, false), rst(s, 0)] });
    const t0 = Date.now();
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(401);
    // The error-body wait is 10 s in this test: the reset ended it.
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("a reset without an error head still fails the request", async () => {
    const conn = await connection("2", { respond2: (_n, s) => [rst(s, 2)] });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/reset stream 3/);
  });
});

describe("framing 2: the money rules of one connection", () => {
  it("refuses a session fee charged again on a later request", async () => {
    const conn = await connection("2", {
      receipt: (s, honest) => (s.n === 2 ? { ...honest, cost_msats: USAGE_MSAT + FEE } : honest),
    });
    await conn.request(chatRequest()).done;
    await expect(conn.request(chatRequest()).done).rejects.toBeInstanceOf(ReceiptVerificationError);
  });

  it("refuses a later error receipt that charges the session fee again", async () => {
    const conn = await connection("2", {
      respond2: (n, s) => (n === 1 ? chat2xx(s) : [headStatus(s, 429, true)]),
      receipt: (s, honest) => (s.n === 2 ? { ...honest, cost_msats: FEE } : honest),
    });
    await conn.request(chatRequest()).done;
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/more than the session fee/);
  });

  it("refuses a first receipt that does not release the deposit", async () => {
    const conn = await connection("2", {
      receipt: (s, honest) => {
        const { deposit_released_msat: _, ...rest } = honest;
        return rest;
      },
    });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/does not release the deposit/);
  });

  it("refuses a first receipt that releases another amount than the offer's deposit", async () => {
    const conn = await connection("2", { receipt: (_s, honest) => ({ ...honest, deposit_released_msat: DEPOSIT - 1 }) });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/releases a connection deposit/);
  });

  it("refuses a later receipt that releases the deposit again", async () => {
    const conn = await connection("2", {
      receipt: (s, honest) => (s.n === 2 ? { ...honest, deposit_released_msat: DEPOSIT } : honest),
    });
    await conn.request(chatRequest()).done;
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/releases a connection deposit/);
  });
});

describe("framing 1.1: the connection's one request", () => {
  it("request before the handshake, the body, π_WIN, body_released, disclose, receipt with fee and deposit", async () => {
    const conn = await connection("1.1");
    const h = conn.request(chatRequest());
    const r = await h.done;
    expect(r.status).toBe(200);
    expect(r.n).toBe(1);
    expect(r.costMsats).toBe(USAGE_MSAT + FEE);
    expect(conn.deposit?.outcome).toBe("released");
    const order = node.log.filter((t) => ["setup", "request", "release_head", "disclose", "disclose_head"].includes(t));
    expect(order).toEqual(["setup", "request", "release_head", "disclose"]);
    expect(proofs).toEqual(["pi_nk", "pi_win", "pi_c3s"]);
    // One request per connection.
    expect(conn.idle).toBe(false);
  });

  it("a refused request 1 leaves the connection armed for another request 1", async () => {
    let refusals = 0;
    const conn = await connection("1.1", { refuse: () => (refusals++ === 0 ? { status: 402, reason: "balance" } : undefined) });
    await expect(conn.request(chatRequest()).done).rejects.toBeInstanceOf(RequestRefusedError);
    expect(conn.armed).toBe(true);
    const r = await conn.request(chatRequest()).done;
    expect(r.n).toBe(1);
    expect(r.costMsats).toBe(USAGE_MSAT + FEE);
  });

  it("an error head is disclosed (π_C3S head mode) and settled at the session fee", async () => {
    const conn = await connection("1.1", { respond11: () => ["HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\n\r\n{}"] });
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(429);
    expect(r.costMsats).toBe(FEE);
    expect(node.log).toContain("disclose_head");
  });

  it("refuses a receipt without the deposit release", async () => {
    const conn = await connection("1.1", {
      receipt: (_s, honest) => {
        const { deposit_released_msat: _, ...rest } = honest;
        return rest;
      },
    });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/does not release the deposit/);
  });

  it("refuses a usage receipt above the usage plus the session fee", async () => {
    const conn = await connection("1.1", { receipt: (_s, honest) => ({ ...honest, cost_msats: USAGE_MSAT + FEE + 1 }) });
    await expect(conn.request(chatRequest()).done).rejects.toBeInstanceOf(ReceiptVerificationError);
  });
});
