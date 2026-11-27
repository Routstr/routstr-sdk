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
  /** The provider's certificate chain (one DER stand-in); `certs = false`: the client captures none. */
  const cert = new Uint8Array(64).fill(0x30);
  const state = { certs: true };
  return {
    cat,
    cert,
    state,
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
          if (state.certs) o.onRecvCertificates?.({ certificates: [{ internal: { rawData: cert.slice().buffer } }] });
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

import {
  ConfidentialConnection,
  depositProblems,
  missingLastFrameProblem,
  refusalMarksNodeFailure,
  type ConnectionRequestOptions,
} from "../../client/confidential/connection";
import { FLAG, FRAME, frame } from "../../client/confidential/h2";
import { canonicalSuffix } from "../../client/confidential/suffix";
import {
  ReceiptVerificationError,
  RequestRefusedError,
  SessionProtocolError,
  SessionRejectedError,
  StreamNotProcessedError,
} from "../../client/confidential/errors";
import { checkRefusalReceipt } from "../../client/confidential/receipt";
import { BOTH, NODE_PRIV, NODE_PUB, ONLY_11, v3OfferFields } from "./fixtures/v3";
import { VENICE_CHAT } from "./fixtures/chat";

const { cat } = tlsFake;
const enc = (s: string) => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sign = (json: string) => bytesToHex(schnorr.sign(sha256(utf8ToBytes(json)), NODE_PRIV));

const SID = "ab".repeat(32);
const CERT_CHAIN_HASH = createHash("sha256").update(tlsFake.cert).digest("hex");
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
  kind: "usage" | "error" | "refusal";
  status: number;
  /** A refusal's usage (`disclose_reset`). */
  refused?: Record<string, unknown>;
}

/** What the fake node does; every hook defaults to an honest node. */
interface Script {
  /** Refuse request n (the connection stays as it was). */
  refuse?: (n: number) => { status: number; reason: string } | undefined;
  /** Framing "2": the provider's records for request n on `stream` (each entry one record). */
  respond2?: (n: number, stream: number) => Uint8Array[];
  /** Framing "1.1": the provider's response bytes, one entry per record. */
  respond11?: () => string[];
  /** Framing "1.1": the provider answers the first body record with these records and closes (`upstream_closed_early`). */
  early11?: () => string[];
  /** The receipt's fields beyond the binding (sid, http, n, model, attestation_hash). */
  receipt?: (s: Settle, honest: Receipt) => Receipt;
  /** The provider's SETTINGS payload after the head. */
  settings?: Uint8Array;
  /** Framing "2": frames that follow the SETTINGS in the same record. */
  withSettings?: Uint8Array[];
  /** Framing "2": provider records sent when request n arrives, before `request_ok`. */
  beforeRequestOk?: (n: number, stream: number) => Uint8Array[];
  /** Framing "2": provider records sent (once) when a `release` does not cover every record yet. */
  partialRelease?: () => Uint8Array[];
  /** `request_ok.reserved_msats`, when the node announces one. */
  reservedMsats?: number;
  /** The `ready` the node sends, from the honest one. */
  ready?: (honest: Record<string, unknown>) => Record<string, unknown>;
  /** The attestation the node signs, from the honest one. */
  attestation?: (honest: Record<string, unknown>) => Record<string, unknown>;
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
  /** Every control message the client sent, parsed. */
  msgs: any[] = [];
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
  private closedEarly = false;
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
    this.msgs.push(m);
    switch (m.type) {
      case "setup":
        this.framing = m.http;
        const ready = { type: "ready", v: 3, http: m.http, sid: SID, pubkey: NODE_PUB, deposit_msat: DEPOSIT, armed: m.armed };
        this.text(this.script.ready ? this.script.ready(ready) : ready);
        return;
      case "release_head":
        this.headWritten = true;
        this.text({ type: "head_written" });
        if (this.framing === "2") this.record(cat(frame(FRAME.SETTINGS, 0, 0, this.script.settings ?? new Uint8Array(0)), ...(this.script.withSettings ?? [])));
        return;
      case "request": {
        const refused = this.script.refuse?.(m.n);
        if (refused) {
          this.text({ type: "request_refused", n: m.n, ...refused });
          return;
        }
        for (const c of this.script.beforeRequestOk?.(m.n, 2 * m.n + 1) ?? []) this.record(c);
        const suffix = canonicalSuffix(VENICE_CHAT, m.model, m.max_tokens);
        this.cur = { n: m.n, model: m.model, maxTokens: m.max_tokens, suffix, recs: [], released: false };
        this.text(
          this.framing === "2"
            ? { type: "request_ok", n: m.n, sid: SID, stream: 2 * m.n + 1, suffix, reserved_msats: this.script.reservedMsats }
            : { type: "request_ok", n: m.n, sid: SID, suffix, head_len: 100, reserved_msats: this.script.reservedMsats },
        );
        return;
      }
      case "ctl":
        this.ctlNext = true;
        return;
      case "release": {
        const cur = this.cur!;
        if (cur.released) return;
        if (m.upto < cur.recs.length) {
          // The released records are written: the interval starts.
          if (m.upto > 0) cur.sK ??= this.serverRecs.length;
          for (const c of this.script.partialRelease?.() ?? []) this.record(c);
          this.script.partialRelease = undefined;
          return;
        }
        cur.released = true;
        if (this.proven < this.seqs) {
          this.text({ type: "zk_params", proof: "pi_win", purpose: "records", first_seq: this.proven, count: this.seqs - this.proven, params: {} });
          this.proven = this.seqs;
        }
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
      case "disclose_reset": {
        // §12.8: from byte 0 of `record` to the refusing frame; nothing
        // written yet: the interval is fixed, empty, at the disclosure.
        const cur = this.cur!;
        const sK = cur.sK ?? this.serverRecs.length;
        const end = this.serverRecs.length;
        const sent = createHash("sha256");
        const written = cur.sK === undefined ? 0 : cur.recs.length;
        for (const r of cur.recs.slice(0, written)) sent.update(r);
        this.attest({
          sid: SID,
          http: "2",
          n: cur.n,
          stream: 2 * cur.n + 1,
          th_sh: TH_SH,
          th_sf: TH_SF,
          c_commit: hexOf(C_COMMIT),
          s_k: sK,
          server_records: end - sK,
          sha256_recv: this.hashRecs(sK, end),
          client_records: written,
          sha256_sent: sent.digest("hex"),
        });
        this.text({ type: "zk_params", proof: "pi_win", purpose: "refusal", n: cur.n, record: m.record, params: {} });
        const r = Buffer.from(m.r, "hex");
        const refused =
          r.length >= 13 && r[r.length - 13 + 3] === FRAME.RST_STREAM
            ? { refused: "rst_stream", error_code: 7, choices: [] }
            : { refused: "goaway", error_code: 0, last_stream_id: r.readUInt32BE(r.length - 8) & 0x7fffffff, choices: [] };
        this.sendReceipt({ n: cur.n, first: this.settledCount === 0, kind: "refusal", status: 0, refused });
        this.settledCount++;
        this.text({ type: "closed", reason: "error_settled" });
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
  private attest(honest: Record<string, unknown>): void {
    const withChain = { ...honest, cert_chain_hash: CERT_CHAIN_HASH };
    const a = this.script.attestation ? this.script.attestation(withChain) : withChain;
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
    } else if (s.kind === "refusal") {
      cost = fee;
      usage = s.refused;
    } else {
      cost = [401, 402, 403, 429, 503].includes(s.status) ? fee : ABANDON;
      usage = { error_status: s.status };
    }
    const honest: Receipt = { cost_msats: cost, usage };
    if (this.script.reservedMsats !== undefined) honest.reserved_msats = this.script.reservedMsats;
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
    if (this.framing === "2") {
      // As the sidecar: the request's records are proven once they are all in.
      const inner = rec.subarray(5, rec.length - 16);
      if (Buffer.from(inner.subarray(0, inner.length - 1)).toString().endsWith(cur.suffix)) {
        this.text({ type: "zk_params", proof: "pi_win", purpose: "records", first_seq: this.proven, count: this.seqs - this.proven, params: {} });
        this.proven = this.seqs;
      }
    }
    if (this.framing === "1.1" && this.script.early11) {
      // As the sidecar after an early close: attested at once, nothing more relayed.
      if (this.closedEarly) return;
      this.closedEarly = true;
      for (const r of this.script.early11()) this.record(enc(r));
      this.text({ type: "upstream_closed_early", n: 1, response_bytes: 100 });
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
      return;
    }
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
let wsSilent = false;
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
    // A node that accepts the connection and never answers the upgrade.
    if (!wsSilent) setTimeout(() => this.onopen?.(), 0);
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
function newConnection(framing: "2" | "1.1", script: Script = {}, timeouts: Record<string, number> = {}): ConfidentialConnection {
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
    timeouts: { probe: 0, errorBody: 10_000, closed: 200, ...timeouts },
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
  wsSilent = false;
  (globalThis as any).WebSocket = FakeWs;
  tlsFake.state.certs = true;
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

  it("REFUSED_STREAM: the provider did not process the request (RFC 9113 §8.7)", async () => {
    const conn = await connection("2", { respond2: (_n, s) => [rst(s, 7)] });
    const h = conn.request(chatRequest());
    await expect(h.done).rejects.toBeInstanceOf(StreamNotProcessedError);
  });

  it("GOAWAY below the request's stream: nothing is released, the request was not processed", async () => {
    // The provider goes away with last-stream-id 1 (the probe) while request 1 (stream 3) is opening.
    const goaway = frame(FRAME.GOAWAY, 0, 0, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]));
    const conn = await connection("2", { beforeRequestOk: () => [goaway] });
    const h = conn.request(chatRequest());
    await expect(h.done).rejects.toBeInstanceOf(StreamNotProcessedError);
    expect(h.bodyReleased).toBe(false);
    expect(node.log).not.toContain("release");
  });

  it("GOAWAY at or above the request's stream lets it finish", async () => {
    const goaway = frame(FRAME.GOAWAY, 0, 0, Uint8Array.from([0, 0, 0, 3, 0, 0, 0, 0]));
    const conn = await connection("2", { beforeRequestOk: () => [goaway] });
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(200);
    expect(conn.idle).toBe(false);
  });

  it("an error head before the body was released, then the provider's close: disclosed after the close and settled by its status", async () => {
    const setting = (v: number) => frame(FRAME.SETTINGS, 0, 0, Uint8Array.from([0, 4, v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
    const conn = await connection("2", {
      settings: setting(0).subarray(9),
      partialRelease: () => {
        setTimeout(() => node.text({ type: "upstream_closed_early", n: 1, response_bytes: 30 }), 0);
        return [headStatus(3, 429, true)];
      },
    });
    const h = conn.request(chatRequest());
    const r = await h.done;
    expect(r.status).toBe(429);
    expect(r.costMsats).toBe(FEE);
    expect(node.log).toContain("disclose_head");
  });

  it("SETTINGS_INITIAL_WINDOW_SIZE changes the open stream's window (RFC 9113 §6.9.2)", async () => {
    // The provider starts with a 100-byte stream window (the body does not fit) and raises it later.
    const setting = (v: number) => frame(FRAME.SETTINGS, 0, 0, Uint8Array.from([0, 4, v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
    const conn = await connection("2", {
      settings: setting(100).subarray(9),
      partialRelease: () => [setting(65535)],
    });
    (conn as any).timeouts.released = 3_000;
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(200);
    expect(node.log.filter((t) => t === "release")).toHaveLength(2);
  });

  it("REFUSED_STREAM after a WINDOW_UPDATE: the refusal is proven (disclose_reset) and settled at the fee due", async () => {
    const wu = (s: number) => frame(FRAME.WINDOW_UPDATE, 0, s, Uint8Array.from([0, 0, 1, 0]));
    const conn = await connection("2", { respond2: (_n, s) => [wu(s), rst(s, 7)] });
    const h = conn.request(chatRequest());
    const err = await h.done.catch((e) => e);
    expect(err).toBeInstanceOf(StreamNotProcessedError);
    expect(err.costMsats).toBe(FEE);
    expect(err.receipt?.usage).toEqual({ refused: "rst_stream", error_code: 7, choices: [] });
    const m = node.msgs.find((x) => x.type === "disclose_reset");
    // From byte 0 of the first record after the request was sent (the SETTINGS is record 0).
    expect(m).toMatchObject({ n: 1, record: 1, r: hexOf(cat(wu(3), rst(3, 7))) });
    expect(proofs.filter((p) => p !== "pi_nk")).toEqual(["pi_win", "pi_win"]);
    expect(conn.deposit).toEqual({ msat: DEPOSIT, outcome: "released", reason: "request_settled", signed: true });
  });

  it("GOAWAY(NO_ERROR) below the stream before the release: proven, nothing released", async () => {
    const goaway = frame(FRAME.GOAWAY, 0, 0, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]));
    const conn = await connection("2", { beforeRequestOk: () => [goaway] });
    const h = conn.request(chatRequest());
    const err = await h.done.catch((e) => e);
    expect(err).toBeInstanceOf(StreamNotProcessedError);
    expect(err.receipt?.usage).toEqual({ refused: "goaway", error_code: 0, last_stream_id: 1, choices: [] });
    expect(node.log).not.toContain("release");
    expect(node.msgs.find((x) => x.type === "disclose_reset")).toMatchObject({ record: 1, r: hexOf(goaway) });
  });

  it("GOAWAY(NO_ERROR) below the stream while an armed connection opens for the request: kept, disclosed from its record", async () => {
    // §5.4.1: a GOAWAY that reached the node shortly before `request_ok`
    // refuses the request. It arrives in the record of the provider's
    // SETTINGS, before the request's records start: R starts at that record.
    const goaway = frame(FRAME.GOAWAY, 0, 0, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]));
    const settings = frame(FRAME.SETTINGS, 0, 0, new Uint8Array(0));
    const conn = newConnection("2", { withSettings: [goaway] });
    await conn.arm();
    const err = await conn.request(chatRequest()).done.catch((e) => e);
    expect(err).toBeInstanceOf(StreamNotProcessedError);
    expect(err.receipt?.usage).toEqual({ refused: "goaway", error_code: 0, last_stream_id: 1, choices: [] });
    expect(node.log).not.toContain("release");
    expect(node.msgs.find((x) => x.type === "disclose_reset")).toMatchObject({ n: 1, record: 0, r: hexOf(cat(settings, goaway)) });
  });

  it("GOAWAY with an error code is not disclosed and does not count as not processed (the client's frames may have caused it)", async () => {
    const goaway = frame(FRAME.GOAWAY, 0, 0, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1]));
    const conn = await connection("2", { beforeRequestOk: () => [goaway] });
    const h = conn.request(chatRequest());
    const err = await h.done.catch((e) => e);
    expect(err).toBeInstanceOf(SessionRejectedError);
    expect(err).not.toBeInstanceOf(StreamNotProcessedError);
    expect(h.bodyReleased).toBe(false);
    expect(node.log).not.toContain("release");
    expect(node.log).not.toContain("disclose_reset");
  });

  it("GOAWAY with an error code after the release: the request fails, not as one the provider did not process", async () => {
    const goaway = frame(FRAME.GOAWAY, 0, 0, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 2]));
    const conn = await connection("2", { respond2: () => [goaway] });
    const h = conn.request(chatRequest());
    const err = await h.done.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StreamNotProcessedError);
    expect(h.bodyReleased).toBe(true);
    expect(node.log).not.toContain("disclose_reset");
  });

  it("REFUSED_STREAM after the release that cannot be disclosed: the request fails, not as one to run again", async () => {
    // Nine records between the request and the refusal: more than a disclosure may cover.
    const wu = (s: number) => frame(FRAME.WINDOW_UPDATE, 0, s, Uint8Array.from([0, 0, 1, 0]));
    const conn = await connection("2", { respond2: (_n, s) => [...Array.from({ length: 9 }, () => wu(0)), rst(s, 7)] });
    const h = conn.request(chatRequest());
    const err = await h.done.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StreamNotProcessedError);
    expect(err.message).toMatch(/not proven/);
    expect(h.bodyReleased).toBe(true);
    expect(node.log).not.toContain("disclose_reset");
  });

  it("a response head before REFUSED_STREAM: no refusal is disclosed, the request is not run again", async () => {
    const conn = await connection("2", { respond2: (_n, s) => [head200(s), rst(s, 7)] });
    const err = await conn.request(chatRequest()).done.catch((e) => e);
    expect(err).not.toBeInstanceOf(StreamNotProcessedError);
    expect(node.log).not.toContain("disclose_reset");
  });

  it("refuses a refusal receipt that charges more than the session fee due", async () => {
    const conn = await connection("2", {
      respond2: (_n, s) => [rst(s, 7)],
      receipt: (s, honest) => (s.kind === "refusal" ? { ...honest, cost_msats: ABANDON } : honest),
    });
    await expect(conn.request(chatRequest()).done).rejects.toBeInstanceOf(ReceiptVerificationError);
  });

  it("refuses a refusal receipt naming another refusal than the one seen", async () => {
    const conn = await connection("2", {
      respond2: (_n, s) => [rst(s, 7)],
      receipt: (s, honest) => (s.kind === "refusal" ? { ...honest, usage: { refused: "goaway", error_code: 0, last_stream_id: 1, choices: [] } } : honest),
    });
    await expect(conn.request(chatRequest()).done).rejects.toBeInstanceOf(ReceiptVerificationError);
  });

  it("refuses any receipt whose reserved_msats differs from request_ok's", async () => {
    const conn = await connection("2", {
      reservedMsats: 5000,
      receipt: (_s, honest) => ({ ...honest, reserved_msats: 6000 }),
    });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/announced 5000/);
  });

  it("accepts a receipt naming the announced reservation", async () => {
    const conn = await connection("2", { reservedMsats: 5000, receipt: (_s, honest) => ({ ...honest, reserved_msats: 5000 }) });
    expect((await conn.request(chatRequest()).done).status).toBe(200);
    conn.close();
  });

  it("refuses a receipt that does not name the reservation request_ok announced", async () => {
    const conn = await connection("2", {
      reservedMsats: 5000,
      receipt: (_s, honest) => {
        const { reserved_msats: _, ...rest } = honest;
        return rest;
      },
    });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/names no reservation, the node announced 5000/);
  });

  it("accepts a charge of exactly the announced reservation, refuses one msat more", async () => {
    // The usage and the session fee: what the first request of a connection costs.
    const cost = USAGE_MSAT + FEE;
    const at = await connection("2", { reservedMsats: cost });
    expect((await at.request(chatRequest()).done).receipt?.cost_msats).toBe(cost);
    at.close();
    const above = await connection("2", { reservedMsats: cost - 1 });
    const err = await above.request(chatRequest()).done.catch((e) => e);
    expect(err).toBeInstanceOf(ReceiptVerificationError);
    expect(err.message).toMatch(/more than the 514 msats the node announced/);
  });

  it("holds a refusal receipt and an error receipt to the announced reservation", async () => {
    // The session fee is due on both; the node announced less.
    const refused = await connection("2", { reservedMsats: FEE - 1, respond2: (_n, s) => [rst(s, 7)] });
    await expect(refused.request(chatRequest()).done).rejects.toThrow(/more than the 499 msats the node announced/);
    const failed = await connection("1.1", { reservedMsats: ABANDON - 1, respond11: () => ["HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\n{}"] });
    await expect(failed.request(chatRequest()).done).rejects.toThrow(/more than the 799 msats the node announced/);
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

  it("an error head before the body was complete, then the provider's close: disclosed after the close and settled by its status", async () => {
    const conn = await connection("1.1", { early11: () => ["HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\n\r\n{}"] });
    const r = await conn.request(chatRequest()).done;
    expect(r.status).toBe(429);
    expect(r.costMsats).toBe(FEE);
    expect(node.log).toContain("disclose_head");
    expect(proofs).not.toContain("pi_win");
  });

  it("an early close with no error head to disclose fails the request (the node settles an abandoned one)", async () => {
    const conn = await connection("1.1", { early11: () => [] });
    await expect(conn.request(chatRequest()).done).rejects.toBeInstanceOf(SessionRejectedError);
    expect(node.log).not.toContain("disclose_head");
    expect(node.log).not.toContain("disclose");
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

/** A deposit outcome as the node signs it: `cost_msats` is the deposit when charged, 0 when released. */
const withCost = (d: Record<string, unknown>) => ("cost_msats" in d ? d : { ...d, cost_msats: d.outcome === "charged" ? d.msat : 0 });

describe("the deposit outcome in the connection's last frame", () => {
  const lastFrame = (type: "closed" | "error", deposit: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const json = JSON.stringify({ sid: SID, ...withCost(deposit) });
    return JSON.stringify({ type, reason: "x", ...extra, deposit: JSON.parse(json), deposit_json: json, deposit_sig: sign(json) });
  };
  const fresh = (warnings: string[]) => {
    const conn = newConnection("2") as any;
    conn.sid = SID;
    conn.onWarning = (m: string) => warnings.push(m);
    return conn;
  };

  it("an outcome that agrees with the offer and the end is recorded quietly", () => {
    const warnings: string[] = [];
    const conn = fresh(warnings);
    conn.onText(lastFrame("closed", { msat: DEPOSIT, outcome: "charged", reason: "idle" }));
    expect(conn.deposit).toEqual({ msat: DEPOSIT, outcome: "charged", reason: "idle", signed: true });
    expect(warnings).toEqual([]);
  });

  it("is logged when it names another amount than the offer's deposit", () => {
    const warnings: string[] = [];
    fresh(warnings).onText(lastFrame("closed", { msat: DEPOSIT * 2, outcome: "charged", reason: "unused" }));
    expect(warnings.join("\n")).toMatch(/deposit of 2000 msat.*the signed offer's is 1000/);
  });

  it("is logged when the deposit is charged after a fault of the node or the provider", () => {
    for (const fault of ["node", "upstream"]) {
      const warnings: string[] = [];
      fresh(warnings).onText(lastFrame("error", { msat: DEPOSIT, outcome: "charged", reason: "unused" }, { fault }));
      expect(warnings.join("\n")).toMatch(new RegExp(`charged after a fault of the ${fault === "node" ? "node" : "provider"}`));
    }
  });

  it("is logged when a reason that releases the deposit comes with a charge", () => {
    const warnings: string[] = [];
    fresh(warnings).onText(lastFrame("closed", { msat: DEPOSIT, outcome: "charged", reason: "provider_closed" }));
    expect(warnings.join("\n")).toMatch(/provider_closed/);
  });

  it("a release, and a signed charge after the client left, are recorded quietly", () => {
    for (const [type, deposit, extra] of [
      ["closed", { msat: DEPOSIT, outcome: "released", reason: "provider_closed" }, { reason: "upstream_closed" }],
      ["error", { msat: DEPOSIT, outcome: "released", reason: "sidecar_failure" }, { fault: "node" }],
      ["closed", { msat: DEPOSIT, outcome: "charged", reason: "unused" }, { reason: "client_closed" }],
      ["error", { msat: DEPOSIT, outcome: "charged", reason: "unused" }, { status: 400 }],
    ] as const) {
      const warnings: string[] = [];
      const conn = fresh(warnings);
      conn.onText(lastFrame(type, deposit, extra));
      expect(conn.deposit).toMatchObject({ outcome: deposit.outcome, signed: true });
      expect(warnings, JSON.stringify(deposit)).toEqual([]);
    }
  });

  it("is logged when a charge carries no valid signature", () => {
    const frame = JSON.parse(lastFrame("closed", { msat: DEPOSIT, outcome: "charged", reason: "unused" }));
    for (const bad of [{ deposit_sig: "00".repeat(64) }, { deposit_sig: undefined }]) {
      const warnings: string[] = [];
      const conn = fresh(warnings);
      conn.onText(JSON.stringify({ ...frame, ...bad }));
      expect(conn.deposit).toMatchObject({ outcome: "charged", signed: false });
      expect(warnings.join("\n")).toMatch(/unsigned deposit outcome names charged without a valid signature/);
    }
    // A signature over another connection's outcome is none for this one.
    const warnings: string[] = [];
    const other = JSON.stringify({ sid: "cd".repeat(32), msat: DEPOSIT, outcome: "charged", reason: "unused" });
    fresh(warnings).onText(JSON.stringify({ type: "closed", reason: "x", deposit: JSON.parse(other), deposit_json: other, deposit_sig: sign(other) }));
    expect(warnings.join("\n")).toMatch(/charged without a valid signature/);
    // An unsigned release costs nothing: recorded as unsigned, not reported.
    const quiet: string[] = [];
    const released = JSON.parse(lastFrame("closed", { msat: DEPOSIT, outcome: "released", reason: "not_started" }));
    fresh(quiet).onText(JSON.stringify({ ...released, deposit_sig: "00".repeat(64) }));
    expect(quiet).toEqual([]);
  });

  it("is logged when the deposit is charged though the provider closed the idle connection", () => {
    const charged = { msat: DEPOSIT, outcome: "charged", reason: "unused" };
    const warnings: string[] = [];
    fresh(warnings).onText(lastFrame("closed", charged, { reason: "upstream_closed" }));
    expect(warnings.join("\n")).toMatch(/charged though the provider closed the idle connection \(§12\.10 row 5 releases it\)/);
    // Not after the client's own control frames, nor with a request of ours outstanding or accepted before.
    for (const [extra, state] of [
      [{ reason: "upstream_closed", after_client_frames: true }, {}],
      [{ reason: "upstream_closed" }, { cur: { n: 1 } }],
      [{ reason: "upstream_closed" }, { requests: 1 }],
      [{ reason: "idle" }, {}],
    ] as const) {
      const quiet: string[] = [];
      const conn = Object.assign(fresh(quiet), state);
      conn.onText(lastFrame("closed", charged, extra));
      expect(quiet, JSON.stringify([extra, state])).toEqual([]);
    }
  });

  it("is logged when the last frame carries no outcome for a deposit the setup reserved", () => {
    for (const frame of [
      { type: "closed", reason: "idle" },
      { type: "error", status: 500, reason: "x" },
      { type: "closed", reason: "idle", deposit: null },
      { type: "closed", reason: "idle", deposit: { msat: DEPOSIT, outcome: "kept" } },
      { type: "closed", reason: "idle", deposit: { msat: DEPOSIT, outcome: "released" }, deposit_json: "{" },
    ]) {
      const warnings: string[] = [];
      const conn = fresh(warnings);
      conn.onText(JSON.stringify(frame));
      expect(conn.deposit).toBeUndefined();
      expect(warnings, JSON.stringify(frame)).toHaveLength(1);
      expect(warnings[0]).toMatch(/the node's last frame carries no deposit outcome for a deposit of 1000 msat/);
    }
  });

  it("no outcome is expected once a receipt released the deposit, before ready, or without a deposit", () => {
    const released: string[] = [];
    const settled = fresh(released);
    settled.deposit = { msat: DEPOSIT, outcome: "released", reason: "request_settled", signed: true };
    settled.onText(JSON.stringify({ type: "closed", reason: "idle" }));
    expect(settled.deposit).toMatchObject({ outcome: "released", reason: "request_settled" });
    expect(released).toEqual([]);

    const early: string[] = [];
    const unready = newConnection("2") as any;
    unready.onWarning = (m: string) => early.push(m);
    unready.onText(JSON.stringify({ type: "error", status: 503, reason: "no session slot" }));
    expect(early).toEqual([]);

    const free: string[] = [];
    const none = fresh(free);
    none.depositMsat = 0;
    none.onText(JSON.stringify({ type: "closed", reason: "idle" }));
    expect(free).toEqual([]);
  });

  it("a whole connection: the first receipt releases the deposit and the end raises nothing", async () => {
    const warnings: string[] = [];
    const conn = await connection("1.1");
    (conn as any).onWarning = (m: string) => warnings.push(m);
    await conn.request(chatRequest()).done;
    expect(conn.deposit).toEqual({ msat: DEPOSIT, outcome: "released", reason: "request_settled", signed: true });
    expect(warnings).toEqual([]);
  });
});

describe("an eviction under slot pressure and the signed request outcome", () => {
  const signedFrame = (frame: Record<string, unknown>, deposit?: Record<string, unknown>, outcome?: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...frame };
    if (deposit) {
      const json = JSON.stringify({ sid: SID, ...withCost(deposit) });
      Object.assign(out, { deposit: JSON.parse(json), deposit_json: json, deposit_sig: sign(json) });
    }
    if (outcome) {
      const json = JSON.stringify({ v: 1, sid: SID, http: "2", balance_msats: 1, time: 1, ...outcome });
      Object.assign(out, { request_outcome: JSON.parse(json), request_outcome_json: json, request_outcome_sig: sign(json) });
    }
    return JSON.stringify(out);
  };
  const fresh = (warnings: string[], state: Record<string, unknown> = {}) => {
    const conn = newConnection("2") as any;
    conn.sid = SID;
    conn.onWarning = (m: string) => warnings.push(m);
    return Object.assign(conn, state);
  };
  const evicted = { type: "closed", reason: "evicted", unused: true };
  const chargedEvicted = { msat: DEPOSIT, outcome: "charged", reason: "evicted", evicted: { unused_at_address: 5 } };

  it("a signed charge for an unused connection closed for a newer setup is legitimate, also for a lone spare", () => {
    const warnings: string[] = [];
    const conn = fresh(warnings);
    conn.onText(signedFrame(evicted, chargedEvicted));
    expect(conn.deposit).toEqual({ msat: DEPOSIT, outcome: "charged", reason: "evicted", signed: true, evicted: { unusedAtAddress: 5 } });
    expect(conn.evictedUnused).toBe(true);
    expect(warnings).toEqual([]);
    const w2: string[] = [];
    const spare = fresh(w2);
    spare.onText(signedFrame(evicted, { ...chargedEvicted, evicted: { unused_at_address: 1 } }));
    expect(spare.deposit).toMatchObject({ outcome: "charged", reason: "evicted", evicted: { unusedAtAddress: 1 } });
    expect(w2).toEqual([]);
  });

  it("an older node's eviction fields are accepted", () => {
    const w1: string[] = [];
    fresh(w1).onText(signedFrame(evicted, { ...chargedEvicted, evicted: { unused_at_address: 5, charge_from: 5 } }));
    expect(w1).toEqual([]);
    const w2: string[] = [];
    const spare = fresh(w2);
    spare.onText(signedFrame(evicted, { msat: DEPOSIT, outcome: "released", reason: "evicted_released", evicted: { unused_at_address: 1, charge_from: 5 } }));
    expect(spare.deposit).toMatchObject({ outcome: "released", reason: "evicted_released" });
    expect(w2).toEqual([]);
  });

  it("an eviction charge without the count, with an accepted request, or before the signed age is logged", () => {
    const w2: string[] = [];
    fresh(w2).onText(signedFrame(evicted, { msat: DEPOSIT, outcome: "charged", reason: "evicted" }));
    expect(w2.join("\n")).toMatch(/without the signed count/);
    const w3: string[] = [];
    fresh(w3, { cur: { n: 1, accepted: true, released: false, first: true } }).onText(signedFrame(evicted, chargedEvicted));
    expect(w3.join("\n")).toMatch(/had accepted a request/);
    const w4: string[] = [];
    const young = fresh(w4, { tSetup: Date.now() - 5000 });
    young.offer = { ...young.offer, evict_unused_after_s: 60 };
    young.onText(signedFrame(evicted, chargedEvicted));
    expect(w4.join("\n")).toMatch(/before the signed offer's evict_unused_after_s of 60 s/);
    const w5: string[] = [];
    const old = fresh(w5, { tSetup: Date.now() - 61_000 });
    old.offer = { ...old.offer, evict_unused_after_s: 60 };
    old.onText(signedFrame(evicted, chargedEvicted));
    expect(w5).toEqual([]);
  });

  it("a settlement without a receipt is held to what the client disclosed", () => {
    // The deposit could not be released after the first settlement: the node
    // sends no receipt, and its outcome may cost only what our disclosure implies.
    const cur = { n: 1, accepted: true, released: true, first: true, reservedMsat: 9000, disclosed: true };
    const frame = { type: "error", status: 500, reason: "settlement failed", fault: "node" };
    const deposit = { msat: DEPOSIT, outcome: "released", reason: "node_failure" };
    const out = (cost: number) => ({ n: 1, outcome: "charged", reason: "settled_without_receipt", cost_msats: cost, reserved_msats: 9000 });
    const offer = (fresh([]) as any).offer;
    const fee = Number(offer.session_fee_msat ?? 0);
    expect(fee).toBeGreaterThan(0);
    for (const [disclosure, ok, bad] of [
      [{ kind: "refusal" }, fee, fee + 1],
      [{ kind: "error_head", status: 429 }, fee, fee + 1],
      [{ kind: "error_head", status: 502 }, 9000, 9001],
      [{ kind: "usage", usageMsat: 1000 }, 1000 + fee, 1001 + fee],
    ] as const) {
      const w1: string[] = [];
      fresh(w1, { framing: "2", cur: { ...cur, offer, disclosure } }).onText(signedFrame(frame, deposit, out(ok)));
      expect(w1, JSON.stringify(disclosure)).toEqual([]);
      const w2: string[] = [];
      fresh(w2, { framing: "2", cur: { ...cur, offer, disclosure } }).onText(signedFrame(frame, deposit, out(bad)));
      expect(w2.join("\n"), JSON.stringify(disclosure)).toMatch(/with reason "settled_without_receipt" \(at most/);
    }
  });

  it("a framing-1.1 request without a ClientHello may be evicted with it", () => {
    const deps = { msat: DEPOSIT, outcome: "charged", reason: "evicted", evicted: { unused_at_address: 1 } };
    const out = { n: 1, outcome: "released", reason: "evicted", cost_msats: 0, reserved_msats: 9000 };
    const w1: string[] = [];
    const c11 = fresh(w1, { framing: "1.1", helloSent: false, cur: { n: 1, accepted: true, released: false, first: true, reservedMsat: 9000 } });
    c11.onText(signedFrame(evicted, deps, { ...out, http: "1.1" }));
    expect(w1).toEqual([]);
    const w2: string[] = [];
    const sent = fresh(w2, { framing: "1.1", helloSent: true, cur: { n: 1, accepted: true, released: false, first: true, reservedMsat: 9000 } });
    sent.onText(signedFrame(evicted, deps, { ...out, http: "1.1" }));
    expect(w2.join("\n")).toMatch(/had accepted a request/);
  });

  it("is logged after a settled request, unsigned, or on another frame", () => {
    const w1: string[] = [];
    const settled = fresh(w1, { deposit: { msat: DEPOSIT, outcome: "released", reason: "request_settled", signed: true } });
    settled.onText(signedFrame(evicted, chargedEvicted));
    expect(w1.join("\n")).toMatch(/receipt of this connection released it/);
    const w2: string[] = [];
    const frame = JSON.parse(signedFrame(evicted, chargedEvicted));
    fresh(w2).onText(JSON.stringify({ ...frame, deposit_sig: "00".repeat(64) }));
    expect(w2.join("\n")).toMatch(/without a valid signature/);
    const w3: string[] = [];
    fresh(w3).onText(signedFrame({ type: "closed", reason: "idle" }, chargedEvicted));
    expect(w3.join("\n")).toMatch(/not `closed` `evicted`/);
    const w4: string[] = [];
    fresh(w4).onText(signedFrame({ type: "closed", reason: "evicted" }, { msat: DEPOSIT, outcome: "charged", reason: "unused" }));
    expect(w4.join("\n")).toMatch(/eviction of a used connection/);
  });

  it("checks the request outcome: missing, unsigned, above the reservation, another request", () => {
    // Request 1 settled (its receipt released the deposit); request 2 is open.
    const open = {
      cur: { n: 2, accepted: true, reservedMsat: 9000, released: true, first: false },
      deposit: { msat: DEPOSIT, outcome: "released", reason: "request_settled", signed: true },
    };
    const ok = { n: 2, outcome: "charged", reason: "request_received", cost_msats: 9000, reserved_msats: 9000 };
    const quiet: string[] = [];
    fresh(quiet, open).onText(signedFrame({ type: "error", reason: "x" }, undefined, ok));
    expect(quiet).toEqual([]);
    const cases: [Record<string, unknown> | undefined, RegExp][] = [
      [undefined, /no signed outcome for request 2/],
      [{ ...ok, cost_msats: 9001 }, /above the announced reservation/],
      [{ ...ok, n: 3 }, /names request 3/],
      [{ ...ok, reserved_msats: 9100 }, /request_ok announced 9000/],
    ];
    for (const [o, re] of cases) {
      const warnings: string[] = [];
      fresh(warnings, open).onText(signedFrame({ type: "error", reason: "x" }, undefined, o));
      expect(warnings.join("\n"), JSON.stringify(o)).toMatch(re);
    }
    const unsigned: string[] = [];
    const f = JSON.parse(signedFrame({ type: "error", reason: "x" }, undefined, ok));
    fresh(unsigned, open).onText(JSON.stringify({ ...f, request_outcome_sig: "00".repeat(64) }));
    expect(unsigned.join("\n")).toMatch(/without a valid signature/);
    // No request open, no outcome: nothing to say.
    const none: string[] = [];
    fresh(none, { deposit: open.deposit }).onText(JSON.stringify({ type: "closed", reason: "idle" }));
    expect(none).toEqual([]);
  });
});

describe("missingLastFrameProblem", () => {
  const base = { sid: "ab".repeat(32), depositMsat: 1000, releasedByReceipt: false };
  it("names what the node holds when its last frame never came", () => {
    expect(missingLastFrameProblem(base)).toMatch(/no signed outcome for the deposit of 1000 msat/);
    expect(missingLastFrameProblem({ ...base, releasedByReceipt: true, openAccepted: 3 })).toMatch(
      /no signed outcome for the reservation of request 3/,
    );
    expect(missingLastFrameProblem({ ...base, openAccepted: 1 })).toMatch(/deposit of 1000 msat and the reservation of request 1/);
  });
  it("is silent when nothing is held", () => {
    expect(missingLastFrameProblem({ ...base, releasedByReceipt: true })).toBeNull();
    expect(missingLastFrameProblem({ ...base, depositMsat: 0 })).toBeNull();
    expect(missingLastFrameProblem({ ...base, sid: "", openAccepted: 1 })).toBeNull();
  });
});

describe("the eviction of an unused connection", () => {
  const ctx = { sid: "ab".repeat(32), depositMsat: 1000, releasedByReceipt: false, requestOutstanding: false, requestAccepted: false };
  const frame = { type: "closed", reason: "evicted", unused: true };
  const out = { msat: 1000, outcome: "charged", reason: "evicted", cost_msats: 1000, evicted: { unused_at_address: 1 } } as const;
  it("is always charged, also for a lone spare", () => {
    expect(depositProblems(frame, out, true, ctx)).toEqual([]);
    expect(depositProblems(frame, out, true, { ...ctx, evictAfterS: 60, ageS: 60 })).toEqual([]);
  });
  it("is a deviation before the signed minimum age, or when the offer says never", () => {
    expect(depositProblems(frame, out, true, { ...ctx, evictAfterS: 60, ageS: 59 }).join()).toMatch(/before the signed offer/);
    expect(depositProblems(frame, out, true, { ...ctx, evictAfterS: 0, ageS: 900 }).join()).toMatch(/never evicted/);
  });
});

describe("depositProblems", () => {
  const ctx = { sid: SID, depositMsat: DEPOSIT, releasedByReceipt: false, requestOutstanding: false, requestAccepted: false };
  const charged = { msat: DEPOSIT, outcome: "charged", reason: "unused", cost_msats: DEPOSIT } as const;
  const released = { msat: DEPOSIT, outcome: "released", reason: "provider_closed", cost_msats: 0 } as const;

  it("honest outcomes have none", () => {
    expect(depositProblems({ type: "closed", reason: "upstream_closed" }, released, true, ctx)).toEqual([]);
    expect(depositProblems({ type: "closed", reason: "client_closed" }, charged, true, ctx)).toEqual([]);
    expect(depositProblems({ type: "closed", reason: "upstream_closed", after_client_frames: true }, charged, true, ctx)).toEqual([]);
    expect(depositProblems({ type: "closed", reason: "done" }, undefined, false, { ...ctx, releasedByReceipt: true })).toEqual([]);
    expect(depositProblems({ type: "error" }, undefined, false, { ...ctx, sid: "" })).toEqual([]);
    expect(depositProblems({ type: "closed" }, undefined, false, { ...ctx, depositMsat: 0 })).toEqual([]);
  });

  it("names each deviation", () => {
    expect(depositProblems({ type: "closed", reason: "idle" }, charged, false, ctx)).toEqual(["charged without a valid signature"]);
    expect(depositProblems({ type: "closed", reason: "upstream_closed" }, charged, true, ctx)).toEqual([
      "charged though the provider closed the idle connection (§12.10 row 5 releases it)",
    ]);
    expect(depositProblems({ type: "closed", reason: "upstream_closed" }, charged, true, { ...ctx, requestOutstanding: true })).toEqual([]);
    expect(depositProblems({ type: "closed", reason: "upstream_closed" }, charged, true, { ...ctx, requestAccepted: true })).toEqual([]);
    expect(depositProblems({ type: "closed", reason: "idle" }, undefined, false, ctx)).toEqual(["no deposit outcome for a deposit of 1000 msat"]);
    expect(depositProblems({ type: "closed", reason: "idle" }, charged, true, { ...ctx, releasedByReceipt: true })).toEqual([
      "charged, though a receipt of this connection released it",
    ]);
  });

  it("holds the cost to the outcome: the deposit when charged, nothing when released", () => {
    expect(depositProblems({ type: "closed", reason: "idle" }, { ...charged, cost_msats: DEPOSIT - 1 }, true, ctx).join()).toMatch(
      new RegExp(`charged at a cost of ${DEPOSIT - 1} msat, the deposit is ${DEPOSIT} msat`),
    );
    expect(depositProblems({ type: "closed", reason: "idle" }, { ...charged, cost_msats: undefined }, true, ctx).join()).toMatch(
      /charged at a cost of null msat/,
    );
    expect(depositProblems({ type: "closed", reason: "upstream_closed" }, { ...released, cost_msats: DEPOSIT }, true, ctx)).toEqual([
      `released at a cost of ${DEPOSIT} msat (a released deposit costs nothing)`,
    ]);
    expect(depositProblems({ type: "closed", reason: "upstream_closed" }, { ...released, cost_msats: undefined }, true, ctx).join()).toMatch(
      /released at a cost of null msat/,
    );
  });

  it("row 6: a charge after a 5xx refusal of the node's own with no request accepted after it", () => {
    const marked = { ...ctx, refused5xx: true };
    expect(depositProblems({ type: "closed", reason: "idle" }, charged, true, marked)).toEqual([
      "charged though the node refused a request with a 5xx and accepted none after it (released by §12.10 row 6)",
    ]);
    expect(depositProblems({ type: "closed", reason: "idle" }, { ...released, reason: "node_failure" }, true, marked)).toEqual([]);
    expect(depositProblems({ type: "closed", reason: "idle" }, charged, true, { ...ctx, refused5xx: false })).toEqual([]);
  });

  it("which refusals mark row 6: a 5xx of a request that named an API key, not a Cashu token, and not wallet_busy", () => {
    expect(refusalMarksNodeFailure({ status: 500, reason: "reservation failed" }, "sk-abc")).toBe(true);
    expect(refusalMarksNodeFailure({ status: 503, detail: { error: { type: "wallet_busy" } } }, "sk-abc")).toBe(false);
    expect(refusalMarksNodeFailure({ status: 500 }, "cashuBo2F0gaJhaUgA")).toBe(false);
    expect(refusalMarksNodeFailure({ status: 500 }, undefined)).toBe(false);
    expect(refusalMarksNodeFailure({ status: 402 }, "sk-abc")).toBe(false);
  });

  it("a connection tracks the row 6 mark: set by such a refusal, cleared by request_ok", () => {
    const conn = newConnection("2") as any;
    conn.cur = { n: 1, auth: "sk-abc" };
    conn.onText(JSON.stringify({ type: "request_refused", n: 1, status: 500, reason: "reservation failed" }));
    expect(conn.refused5xx).toBe(true);
    conn.onText(JSON.stringify({ type: "request_ok", n: 1 }));
    expect(conn.refused5xx).toBe(false);
    conn.onText(JSON.stringify({ type: "request_refused", n: 2, status: 503, reason: "busy", detail: { error: { type: "wallet_busy" } } }));
    expect(conn.refused5xx).toBe(false);
  });
});

describe("a kept connection holds nothing of what it waited for (finding 25)", () => {
  // Run with NODE_OPTIONS=--expose-gc to include it.
  it.runIf(typeof (globalThis as { gc?: unknown }).gc === "function")(
    "a control frame, a proof result and a sent record are released once their wait is over",
    async () => {
      const conn = await connection("2");
      const refs: WeakRef<object>[] = [];
      for (let i = 0; i < 20; i++) {
        await (async () => {
          const c = conn as any;
          const msg = { type: "x", pad: "y".repeat(1 << 16) };
          const p = c.wait(["x"], 1000);
          c.inbox.push("x", msg);
          refs.push(new WeakRef(msg));
          await p;
        })();
      }
      // A full request too: its frames, proofs and records were awaited the same way.
      await conn.request(chatRequest()).done;
      expect(conn.idle).toBe(true);
      for (let i = 0; i < 10 && refs.some((r) => r.deref()); i++) {
        await new Promise((r) => setTimeout(r, 0));
        (globalThis as unknown as { gc: () => void }).gc();
      }
      expect(refs.filter((r) => r.deref()).length).toBe(0);
      conn.close();
    },
  );

  it("leaves no failure waiter behind on a live connection", async () => {
    const conn = await connection("2");
    await conn.request(chatRequest()).done;
    await conn.request(chatRequest()).done;
    expect((conn as any).failWaiters.size).toBe(0);
    conn.close();
  });
});

describe("the deposit the setup reserved (ready.deposit_msat)", () => {
  for (const framing of ["2", "1.1"] as const) {
    const open = (conn: ConfidentialConnection) => (framing === "2" ? conn.connect() : conn.arm());

    it(`framing ${framing}: a ready without deposit_msat fails the connection before anything else is sent`, async () => {
      const conn = newConnection(framing, {
        ready: (r) => {
          const { deposit_msat: _, ...rest } = r;
          return rest;
        },
      });
      await expect(open(conn)).rejects.toThrow(/does not name the connection deposit of 1000 msat/);
      expect(node.log).toEqual(["setup"]);
    });

    it(`framing ${framing}: a ready naming another deposit fails the connection before anything else is sent`, async () => {
      for (const bad of [DEPOSIT + 1, 0, "1000", null]) {
        const conn = newConnection(framing, { ready: (r) => ({ ...r, deposit_msat: bad }) });
        await expect(open(conn)).rejects.toBeInstanceOf(SessionProtocolError);
        expect(node.log).toEqual(["setup"]);
      }
    });
  }
});

describe("a refusal receipt names the request's terms", () => {
  const refusal = { refused: "rst_stream", error_code: 7 } as const;
  const usage = { refused: "rst_stream", error_code: 7, choices: [] };
  const image = { model: "z", variant: "webp", count: 2 };
  const ok = { sid: SID, kind: "images", model: "z", variant: "webp", count: 2, usage, cost_msats: 0 };

  it("an image refusal receipt must carry the request's kind, model, variant and count", () => {
    expect(() => checkRefusalReceipt(ok as never, refusal as never, 0, 0, image)).not.toThrow();
    for (const wrong of [{ kind: "chat" }, { kind: undefined }, { model: "y" }, { variant: "1K-webp" }, { count: 1 }]) {
      expect(() => checkRefusalReceipt({ ...ok, ...wrong } as never, refusal as never, 0, 0, image)).toThrow(ReceiptVerificationError);
    }
  });

  it("the connection checks a refusal receipt against its image request", () => {
    const conn = newConnection("2") as any;
    const cur = {
      n: 1,
      first: false,
      model: "z",
      offer: conn.offer,
      opts: {},
      image: { variant: { id: "webp", msat_per_image: 12_000 }, count: 2 },
    };
    expect(() => conn.checkRefusal(cur, ok, refusal)).not.toThrow();
    expect(() => conn.checkRefusal(cur, { ...ok, count: 1 }, refusal)).toThrow(/count 1 is not 2/);
    expect(() => conn.checkRefusal(cur, { ...ok, variant: "png" }, refusal)).toThrow(/variant png is not webp/);
  });

  it("a chat refusal receipt naming another model is refused", async () => {
    const conn = await connection("2", {
      respond2: (_n, s) => [rst(s, 7)],
      receipt: (s, honest) => (s.kind === "refusal" ? { ...honest, model: "other" } : honest),
    });
    await expect(conn.request(chatRequest()).done).rejects.toThrow(/model other/);
  });
});

describe("the certificate chain an attestation names", () => {
  for (const framing of ["2", "1.1"] as const) {
    it(`framing ${framing}: an attestation is accepted when it names the chain the client received`, async () => {
      const conn = await connection(framing);
      expect((await conn.request(chatRequest()).done).status).toBe(200);
      conn.close();
    });

    it(`framing ${framing}: an attestation naming another chain, or none, is refused`, async () => {
      for (const attestation of [
        (a: Record<string, unknown>) => ({ ...a, cert_chain_hash: "00".repeat(32) }),
        (a: Record<string, unknown>) => {
          const { cert_chain_hash: _, ...rest } = a;
          return rest;
        },
      ]) {
        const conn = await connection(framing, { attestation });
        await expect(conn.request(chatRequest()).done).rejects.toThrow(/certificate chain/);
      }
    });

    it(`framing ${framing}: an attestation is refused when the client captured no certificate chain`, async () => {
      tlsFake.state.certs = false;
      const conn = await connection(framing);
      await expect(conn.request(chatRequest()).done).rejects.toThrow(/certificate chain/);
    });
  }
});

describe("the node's last frame never came", () => {
  const warned = (conn: ConfidentialConnection) => {
    const w: string[] = [];
    (conn as any).onWarning = (m: string) => w.push(m);
    return w;
  };
  it("is reported after a socket error or a malformed frame, not after the client's own close", async () => {
    for (const cause of ["error", "malformed", "client"] as const) {
      const conn = await connection("2");
      const w = warned(conn);
      const ws = node.ws as FakeWs;
      if (cause === "error") ws.onerror?.();
      else if (cause === "malformed") ws.onmessage?.({ data: "x" });
      else conn.close();
      ws.onclose?.({ reason: "" });
      await new Promise((r) => setTimeout(r, 5));
      if (cause === "client") expect(w.join("\n")).not.toMatch(/without the node's last frame/);
      else expect(w.join("\n"), cause).toMatch(/without the node's last frame: no signed outcome for the deposit/);
    }
  });
});

describe("the control websocket", () => {
  it("a node that never answers the upgrade fails the connection at the open deadline", async () => {
    wsSilent = true;
    for (const framing of ["1.1", "2"] as const) {
      const conn = newConnection(framing, {}, { socketOpen: 30 });
      const t0 = Date.now();
      await expect(framing === "2" ? conn.connect() : conn.arm()).rejects.toThrow(/control websocket to open/);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(conn.usable).toBe(false);
      // Nothing was sent: the setup (with the credential) never left the outbox.
      expect(node.log).toEqual([]);
    }
  });
});

describe("SETTINGS acknowledgements", () => {
  const SETTINGS = 0x4;
  const PING = 0x6;
  const acks = (conn: any) => {
    const sent: string[] = [];
    conn.sendCtl = (name: string) => {
      sent.push(name);
      return Promise.resolve(0);
    };
    return sent;
  };
  const settings = { type: SETTINGS, flags: 0, stream: 0, payload: new Uint8Array(0), off: 0 };
  it("the first waits for the next request, a later one goes at once while idle", () => {
    const conn = newConnection("2") as any;
    const sent = acks(conn);
    conn.onFrame(settings);
    expect(sent).toEqual([]);
    conn.onFrame(settings);
    expect(sent).toEqual(["settings_ack", "settings_ack"]);
    conn.onFrame(settings);
    expect(sent).toHaveLength(3);
  });
  it("inside a request it waits for body_released; a PING is answered at once", () => {
    const conn = newConnection("2") as any;
    const sent = acks(conn);
    conn.settingsAckSent = true;
    conn.requestOpen = true;
    conn.cur = { n: 1, stream: 3, released: false, releaseSent: true, accepted: true, first: true, dataLens: [] };
    conn.onFrame(settings);
    conn.onFrame({ type: PING, flags: 0, stream: 0, payload: new Uint8Array(8), off: 0 });
    expect(sent).toEqual(["ping_ack"]);
    conn.onText(JSON.stringify({ type: "body_released", n: 1 }));
    expect(sent).toEqual(["ping_ack", "settings_ack"]);
    conn.onFrame(settings);
    expect(sent).toEqual(["ping_ack", "settings_ack", "settings_ack"]);
  });
  it("a body_released for a request we have not released changes nothing", () => {
    const conn = newConnection("2") as any;
    const sent = acks(conn);
    conn.settingsAckSent = true;
    conn.requestOpen = true;
    conn.cur = { n: 1, stream: 3, released: false, releaseSent: false, accepted: true, first: true, dataLens: [] };
    conn.onFrame(settings);
    conn.onText(JSON.stringify({ type: "body_released", n: 1 }));
    // Still unreleased: the 5xx and request_outcome ceilings stay at the
    // abandon fee, and the held acknowledgement stays held.
    expect(conn.cur.released).toBe(false);
    expect(sent).toEqual([]);
    conn.cur.releaseSent = true;
    conn.onText(JSON.stringify({ type: "body_released", n: 1 }));
    expect(conn.cur.released).toBe(true);
    expect(sent).toEqual(["settings_ack"]);
  });
});
