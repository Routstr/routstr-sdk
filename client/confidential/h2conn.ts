/**
 * An `http: 2` confidential connection (protocol v3, option A;
 * PROTOCOL-V3-DESIGN.md A, wire format in A.11). C side.
 *
 * One two-party TLS handshake, then the node writes the HTTP/2 connection
 * head (its SETTINGS, one probe request that puts the credential into the
 * HPACK table) in epoch 0. This client then sends chat requests on the same
 * TLS connection, one at a time, naming the credential by HPACK index. Per
 * request: `request` (the node reserves), one HTTP/2 frame per TLS record,
 * π_WIN over those records, `release`, the response, then the usage
 * disclosure (π_C3S) or the error head (π_WIN under `s_ap_0`), a per-request
 * attestation and a signed receipt.
 *
 * Ported from the reference client (`crypto/client/src/driver-h2.ts`). What
 * it verifies is verified here: the π_NK statement against the connection
 * head rebuilt from the signed offer, every π_WIN window against our own
 * records (the node chooses the windows; without this check the equality bit
 * would be an oracle on private plaintext), the π_C3S parameters, the
 * attestation's interval and hashes, and the receipt's signature, binding,
 * usage and cost.
 *
 * A connection is a cache, never a promise: it can die at any time (idle
 * limit, GOAWAY, the node, the network). `bodyReleased` of a request says
 * whether anything of it can have reached the provider; before that a caller
 * may run the request again on another connection.
 */

import { createHash, randomUUID } from "node:crypto";
import { concat, hex } from "./advice";
import { verifySchnorrSignature } from "./canonical";
import {
  ConfidentialError,
  ConfidentialTimeoutError,
  ConnectionDepositError,
  ProverMissingError,
  ReceiptVerificationError,
  ResponseVerificationError,
  SessionProtocolError,
  SessionRejectedError,
} from "./errors";
import {
  FLAG,
  FRAME,
  FrameReader,
  MAX_DATA_IN_RECORD,
  chatPath,
  checkH2Offer,
  checkPiNKParamsH2,
  checkPiWinParams,
  decodeBlock,
  frame,
  frameHeader,
  latin1,
  requestBlock,
  requestStream,
  splitBody,
  type RxFrame,
  type WinSource,
} from "./h2";
import { encryptedNodeTransport } from "./hosts";
import { offerAbandonFeeMsat, offerSessionFeeMsat, type ConfidentialH2Offer, type VerifiedOffer } from "./offer";
import { checkPiC3SParams, serverTailEpoch, type ServerPostRecord } from "./params";
import { CuProverBackend, isExecutable } from "./prover";
import { checkUpstreamErrorReceipt, parseSignedReceipt, verifyReceipt } from "./receipt";
import {
  countKeyUpdates,
  cryptoRandom,
  MAX_PENDING_TLS_BYTES,
  SID_RE,
  type ConfidentialReceipt,
  type TlsHandle,
} from "./session";
import { canonicalSuffix, effectiveModelFromText, validateChatSuffix, type UpstreamUsageEvent } from "./suffix";
import { makeTLSClient } from "./tls-fork/lib/index.js";
import { resolveTwoPcPath, TwoPcSession, type TwoPcApplicationSecrets } from "./twopc";
import { ProofChannel } from "./zkchan";

const H2_TIMEOUTS = {
  ready: 30_000,
  twoPcKeyShare: 120_000,
  handshake: 45_000,
  hsVerified: 30_000,
  cCommit: 60_000,
  headWritten: 30_000,
  /** The provider's SETTINGS after the connection head. */
  settings: 15_000,
  proofChannelReady: 120_000,
  proof: 60_000,
  requestOk: 30_000,
  /** From the request to its last record written to the provider (the windows may open in steps). */
  released: 180_000,
  /** Silence while the response streams. */
  responseIdle: 60_000,
  /** The rest of an error response's body (evidence only). */
  errorBody: 3_000,
  zkParams: 30_000,
  attestation: 60_000,
  receipt: 60_000,
};

/** Control frames of one kind the node may send ahead of the wait for them. */
const INBOX_MAX_PER_KEY = 16;
const INBOX_MAX = 256;
/** Response DATA bytes after which a connection is retired (its receive window is 2^31-1). */
const MAX_CONNECTION_DATA = 1 << 30;

export interface ConfidentialH2ConnectionOptions {
  /** Node HTTP(S) base. */
  baseUrl: string;
  /** A verified offer that lists `"2"` in `http`. */
  offer: VerifiedOffer;
  /** The client's bearer for this node: checked at setup, reserved on per request. */
  auth: string;
  prover: CuProverBackend;
  twoPcPath?: string;
  /** Injectable 2PC backend and proof channel (tests). */
  twoPcFactory?: () => TwoPcSession;
  proofChannelFactory?: () => ProofChannel;
  /** Node pubkey the ready frame must announce (default: the offer's). */
  expectedPubkey?: string;
  timeouts?: Partial<typeof H2_TIMEOUTS>;
  /** Largest DATA payload per record (default: the largest that fits one record). */
  chunk?: number;
  /** Dev only: a plain-http node that is neither loopback nor an onion service. */
  allowInsecureTransport?: boolean;
  /**
   * The largest connection deposit (msat) accepted from the offer
   * (`h2.connection_deposit_msat`); a larger one is refused before anything
   * is sent. Default `DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT`.
   */
  maxDepositMsat?: number;
  /** Structured event sink (never receives secrets). */
  onEvent?: (event: Record<string, unknown>) => void;
}

/** The largest connection deposit a client accepts unless told otherwise (100 sat). */
export const DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT = 100_000;

/** What became of a connection's deposit, as the node reported it. */
export interface H2DepositOutcome {
  msat: number;
  outcome: "released" | "charged";
  /** `request_settled`, or why a connection without a settled request kept or lost it. */
  reason: string;
  /** True when the report carried the node's signature (a receipt, or a signed last frame). */
  signed: boolean;
}

export interface H2RequestOptions {
  /**
   * The verified offer this request is priced by (default: the one the
   * connection was opened on). The node remembers a signed offer for a
   * limited time and re-signs it when its rates move, so a request on a kept
   * connection names the offer the caller verified last. Its connection-level
   * terms must be the connection's (`h2ConnectionTerms`).
   */
  offer?: VerifiedOffer;
  model: string;
  maxTokens: number;
  /** The whole JSON body; it must end with the canonical suffix. */
  body: Uint8Array;
  onResponseHead?: (head: { status: number; statusText: string; headers: Record<string, string> }) => void;
  onResponseBody?: (chunk: Uint8Array) => void;
}

/** Bytes between this client and the node, by channel. */
export interface H2Bytes {
  relaySent: number;
  relayRecv: number;
  controlSent: number;
  controlRecv: number;
  twoPcSent: number;
  twoPcRecv: number;
  zkSent: number;
  zkRecv: number;
}

export interface H2RequestResult {
  sid: string;
  /** The request's number on its connection (1, 2, …) and its stream. */
  n: number;
  stream: number;
  model: string;
  effectiveModel?: string;
  status: number;
  headers: Record<string, string>;
  /** The decrypted response body. */
  body: Uint8Array;
  receipt: ConfidentialReceipt;
  attestation: unknown;
  costMsats?: number;
  warnings?: string[];
  /** Milliseconds from the start of the request on this connection (`startedAt`, wall clock). */
  timings: { startedAt: number; releasedMs?: number; ttftMs?: number; totalMs: number; proofs: H2ProofTiming[] };
  /** Bytes between client and node spent on this request (the connection's setup is not included). */
  bytes: H2Bytes;
}

export interface H2ProofTiming {
  proof: string;
  purpose?: string;
  ms: number;
  innerMs?: number;
  bytesSent?: number;
  bytesRecv?: number;
  windows?: number;
  ctBytes?: number;
}

/** One request on a connection. */
export interface H2RequestHandle {
  readonly n: number;
  readonly sid: string;
  /** True once the request may have reached the provider: never run it again elsewhere. */
  readonly bodyReleased: boolean;
  /** True once the `request` frame (with the credential) went out. */
  readonly credentialSent: boolean;
  readonly done: Promise<H2RequestResult>;
  /** Abort an unfinished request (this ends the connection); a no-op once it settled. */
  close(): void;
}

/**
 * What of a signed offer an open connection depends on: the provider, the
 * node's key, the credential's shape, the request route, the chat suffix
 * rules and the `h2` block. Requests priced by another offer may use a
 * connection only when this is the same (rates and fees may differ).
 */
export function h2ConnectionTerms(offer: VerifiedOffer): string {
  return JSON.stringify([
    offer.v,
    offer.upstream_host,
    offer.notary_pubkey,
    offer.key_length,
    offer.key_alphabet ?? null,
    offer.head_template,
    offer.chat,
    offer.h2 ?? null,
  ]);
}

/** One record this client sent after the handshake. */
interface OutRec {
  wire: Uint8Array;
  plain: Uint8Array;
  pub: [number, number][];
}

/** The request in flight. */
interface Cur {
  n: number;
  stream: number;
  model: string;
  opts: H2RequestOptions;
  /** The offer the request is priced by. */
  offer: VerifiedOffer;
  tStart: number;
  /** Server application-data records decrypted when the request was sent. */
  recvAtSend: number;
  /** Stream offset of the first frame on the request's stream. */
  firstFrameOff?: number;
  seqs: number[];
  dataLens: number[];
  upto: number;
  streamCredit: number;
  /** `request_ok` arrived: the node reserved and the sidecar accepted. */
  accepted: boolean;
  /** We sent a `release`: from here the request may reach the provider. */
  releaseSent: boolean;
  /** `body_released`: every record of the request was written to the provider. */
  released: boolean;
  tReleased?: number;
  tFirstData?: number;
  tLastData: number;
  status?: number;
  headers?: Record<string, string>;
  head?: { off: number; raw: Uint8Array };
  parts: { off: number; data: Uint8Array }[];
  ended: boolean;
  reset?: number;
  proofs: H2ProofTiming[];
  settled: boolean;
}

type Waiter = { keys: string[]; res: (v: { key: string; msg: any }) => void };

/** Control frames by kind, with waits that can name several kinds and leave nothing behind. */
class Inbox {
  private queues = new Map<string, any[]>();
  private waiters: Waiter[] = [];
  private queued = 0;

  constructor(private readonly onOverflow: (key: string) => void) {}

  push(key: string, msg: any): void {
    const i = this.waiters.findIndex((w) => w.keys.includes(key));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      w!.res({ key, msg });
      return;
    }
    const q = this.queues.get(key) ?? [];
    if (q.length >= INBOX_MAX_PER_KEY || this.queued >= INBOX_MAX) {
      this.onOverflow(key);
      return;
    }
    q.push(msg);
    this.queued++;
    this.queues.set(key, q);
  }

  /** The next frame of any of `keys`; `cancel()` withdraws the wait. */
  take(keys: string[]): { promise: Promise<{ key: string; msg: any }>; cancel: () => void } {
    for (const key of keys) {
      const q = this.queues.get(key);
      if (q && q.length) {
        this.queued--;
        return { promise: Promise.resolve({ key, msg: q.shift() }), cancel: () => {} };
      }
    }
    let waiter!: Waiter;
    const promise = new Promise<{ key: string; msg: any }>((res) => {
      waiter = { keys, res };
      this.waiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      },
    };
  }
}

const u32 = (b: Uint8Array, i = 0) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

export class ConfidentialH2Connection {
  readonly uuid = randomUUID();
  readonly baseUrl: string;
  readonly offer: VerifiedOffer;
  readonly h2: ConfidentialH2Offer;
  /** The connection-level terms of the offer it was opened on (`h2ConnectionTerms`). */
  readonly terms: string;
  sid = "";
  /** When the connection was created, opened (`head_written` + SETTINGS) and last settled a request. */
  readonly tCreated = Date.now();
  tOpen = 0;
  tLastSettled = 0;
  /** Requests started on this connection. */
  requests = 0;
  /** Bytes spent to open the connection (2PC, proof channel setup, π_NK, handshake relay). */
  setupBytes?: H2Bytes;
  /** Phase times of the connection's setup (ms). */
  setupTimings: Record<string, number> = {};
  /**
   * The connection deposit: the amount the setup reserves (the offer's), and
   * its outcome once the node reported one (released by the first request's
   * receipt, or released/charged in the connection's last frame).
   */
  readonly depositMsat: number;
  deposit?: H2DepositOutcome;

  private readonly auth: string;
  private readonly prover: CuProverBackend;
  private readonly twoPcPath?: string;
  private readonly twoPcFactory?: () => TwoPcSession;
  private readonly proofChannelFactory?: () => ProofChannel;
  private readonly expectedPubkey: string;
  private readonly timeouts: typeof H2_TIMEOUTS;
  private readonly chunk: number;
  private readonly onEvent?: (event: Record<string, unknown>) => void;

  private ws?: WebSocket;
  private wsOpen = false;
  private outbox: (Uint8Array | string)[] = [];
  private inbox = new Inbox((key) =>
    this.fail(new SessionProtocolError(`node sent too many unanswered ${JSON.stringify(key).slice(0, 64)} frames`)),
  );
  private failure?: Error;
  private errRej!: (e: Error) => void;
  private readonly errP: Promise<never>;
  private endedRes!: (e: Error) => void;
  /** Resolves (never rejects) with the reason once the connection has ended. */
  readonly ended: Promise<Error> = new Promise<Error>((res) => (this.endedRes = res));
  private closedReason?: string;
  private connectStarted = false;
  private opened = false;
  private ready: any = null;

  private tls!: TlsHandle;
  private twoPc?: TwoPcSession;
  private zkChan?: ProofChannel;
  private ap?: TwoPcApplicationSecrets;
  private thSH?: Uint8Array;
  private thSF?: Uint8Array;
  private cCommitHex?: string;
  private certChainHash?: Uint8Array;
  private handshakeDone?: () => void;
  private flushChain: Promise<void> = Promise.resolve();
  private pendingTls = 0;

  // --- received records -----------------------------------------------------
  private serverPending: Uint8Array = new Uint8Array(0);
  /** Outer-type-23 server records received on the wire, and their payloads by index. */
  private wireRecords = 0;
  private serverRecords = new Map<number, Uint8Array>();
  /** Encrypted server records of the handshake flight (decrypted so far). */
  private hsCipher = 0;
  private postHandshake = false;
  private serverPost: ServerPostRecord[] = [];
  private curAbs = -1;
  /** Inner plaintext of post-handshake server records that may hold an error head, by index. */
  private plain = new Map<number, Uint8Array>();
  private readonly reader = new FrameReader();
  private dataBytes = 0;

  // --- sent records ---------------------------------------------------------
  private out = new Map<number, OutRec>();
  private nextSeq = 0;
  private lastSeq = -1;
  private pendingDesc?: { plain: Uint8Array; pub: [number, number][] };
  /** Everything sent to the node after `head_written`, in order. */
  private tx: Promise<void> = Promise.resolve();
  /** Proofs on the channel, one at a time. */
  private proofChain: Promise<unknown> = Promise.resolve();
  private unproven = new Set<number>();

  // --- HTTP/2 state -----------------------------------------------------------
  private gotSettings = false;
  private initialWindow = 65535;
  private connCredit = 65535;
  private unackedSettings = 0;
  private requestOpen = false;
  private goaway = false;
  private cur?: Cur;
  private kicks: (() => void)[] = [];

  private bytes = { relaySent: 0, relayRecv: 0, controlSent: 0, controlRecv: 0 };

  constructor(options: ConfidentialH2ConnectionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.offer = options.offer;
    if (options.offer.v !== 2) throw new SessionProtocolError(`unsupported protocol version v=${options.offer.v}`);
    if (!options.offer.h2) throw new SessionProtocolError("the signed offer serves no http: 2 sessions");
    // Held to the same limits as at verification (a caller may pass an offer
    // that did not go through verifyConfidentialOffer); the probe's API base
    // was checked there against the caller's trusted hosts.
    const probe = options.offer.h2.probe_path;
    this.h2 = checkH2Offer(options.offer, [probe.slice(0, Math.max(0, probe.length - "/models".length))]);
    try {
      validateChatSuffix(options.offer.chat, options.offer.suffix_keys);
    } catch (e) {
      throw new SessionProtocolError(`the signed offer's chat block is refused: ${(e as Error).message}`);
    }
    if (!options.allowInsecureTransport && !encryptedNodeTransport(this.baseUrl)) {
      throw new SessionProtocolError(
        `refusing plain http to ${this.baseUrl}: the node credential would travel unencrypted`,
      );
    }
    this.depositMsat = this.h2.connection_deposit_msat;
    const maxDeposit = options.maxDepositMsat ?? DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT;
    if (this.depositMsat > maxDeposit) {
      throw new ConnectionDepositError(
        `the node's connection deposit of ${this.depositMsat} msat exceeds the client's maximum of ${maxDeposit} msat`,
        this.depositMsat,
      );
    }
    this.terms = h2ConnectionTerms(options.offer);
    this.auth = options.auth;
    this.prover = options.prover;
    this.twoPcPath = options.twoPcPath;
    this.twoPcFactory = options.twoPcFactory;
    this.proofChannelFactory = options.proofChannelFactory;
    this.expectedPubkey = options.expectedPubkey ?? options.offer.notary_pubkey;
    this.timeouts = { ...H2_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.chunk = Math.max(1, Math.min(options.chunk ?? MAX_DATA_IN_RECORD, MAX_DATA_IN_RECORD));
    this.onEvent = options.onEvent;
    this.errP = new Promise<never>((_, rej) => (this.errRej = rej));
    this.errP.catch(() => {});
  }

  // --- state ------------------------------------------------------------------

  /** Open, healthy and able to take another request (none is in flight). */
  get idle(): boolean {
    return this.usable && !this.cur;
  }

  /** Open and healthy, with requests left. */
  get usable(): boolean {
    return (
      this.opened &&
      !this.failure &&
      !this.goaway &&
      this.requests < this.h2.max_requests &&
      this.dataBytes < MAX_CONNECTION_DATA &&
      !(this.twoPc?.failed ?? false) &&
      !(this.zkChan?.failed ?? false)
    );
  }

  get busy(): boolean {
    return this.cur !== undefined;
  }

  /** Why the connection ended, if it did. */
  get failureReason(): Error | undefined {
    return this.failure;
  }

  /** True once the setup carrying the node credential went out. */
  get credentialSent(): boolean {
    return this.connectStarted;
  }

  /** Bytes between client and node so far, by channel. */
  byteCounts(): H2Bytes {
    return {
      ...this.bytes,
      twoPcSent: this.twoPc?.bytesSent ?? 0,
      twoPcRecv: this.twoPc?.bytesRecv ?? 0,
      zkSent: this.zkChan?.bytesSent ?? 0,
      zkRecv: this.zkChan?.bytesRecv ?? 0,
    };
  }

  private event(ev: Record<string, unknown>): void {
    this.onEvent?.({ ...ev, sid: this.sid || undefined });
  }

  private kick(): void {
    const ks = this.kicks;
    this.kicks = [];
    for (const k of ks) k();
  }

  /** End the connection with `e`: everything waiting on it rejects. */
  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    this.errRej(e);
    this.endedRes(e);
    this.teardown();
    this.kick();
  }

  private teardown(): void {
    this.twoPc?.close();
    this.zkChan?.close();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /** Close the connection (the node releases what an unfinished request reserved, by its abort rules). */
  close(reason = "closed by the client"): void {
    this.fail(new SessionRejectedError(`connection closed: ${reason}`));
  }

  // --- wire ---------------------------------------------------------------------

  private wsBase(): string {
    return this.baseUrl.replace(/^http/, "ws");
  }

  private zkUrl(proof: string): string {
    const token = typeof this.ready?.zk_token === "string" ? `&zk_token=${encodeURIComponent(this.ready.zk_token)}` : "";
    return `${this.wsBase()}/v1/confidential/zk?proof=${encodeURIComponent(proof)}&session_id=${encodeURIComponent(this.sid)}${token}`;
  }

  private sendText(obj: unknown): void {
    const text = JSON.stringify(obj);
    this.bytes.controlSent += text.length;
    if (this.wsOpen && this.ws) this.ws.send(text);
    else this.outbox.push(text);
  }

  /** A text frame in order with the records (a `ctl` must directly precede its record). */
  private sendOrdered(obj: unknown): void {
    this.tx = this.tx.then(() => {
      if (!this.failure) this.sendText(obj);
    });
  }

  private sendBytes(b: Uint8Array): void {
    this.bytes.relaySent += b.length;
    if (this.wsOpen && this.ws) this.ws.send(b);
    else this.outbox.push(b);
  }

  private openSocket(): Promise<void> {
    const ws = new WebSocket(`${this.wsBase()}/v1/confidential/ws?session_id=${this.uuid}&v=2`);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    const opened = new Promise<void>((res) => {
      ws.onopen = () => {
        this.wsOpen = true;
        for (const b of this.outbox) ws.send(b);
        this.outbox.length = 0;
        res();
      };
    });
    ws.onerror = () => this.fail(new SessionRejectedError("control websocket error"));
    ws.onclose = (ev: CloseEvent) => {
      const reason = (ev as CloseEvent & { reason?: string })?.reason;
      this.fail(
        new SessionRejectedError(
          this.closedReason
            ? `connection closed by the node: ${this.closedReason}`
            : reason
              ? `connection closed: ${reason}`
              : "connection closed",
        ),
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      const d = ev.data as ArrayBuffer | string;
      if (typeof d === "string") {
        this.bytes.controlRecv += d.length;
        this.onText(d);
        return;
      }
      const bytes = new Uint8Array(d);
      this.bytes.relayRecv += bytes.length;
      if (this.pendingTls + bytes.length > MAX_PENDING_TLS_BYTES) {
        this.fail(new SessionProtocolError("node sent TLS bytes faster than they could be processed"));
        return;
      }
      this.pendingTls += bytes.length;
      this.trackServerRecords(bytes);
      this.flushChain = this.flushChain
        .then(() => this.tls.handleReceivedBytes(bytes))
        .catch((e) => {
          this.fail(
            e instanceof ConfidentialError
              ? e
              : new ResponseVerificationError(`TLS record failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        })
        .finally(() => {
          this.pendingTls -= bytes.length;
        });
    };
    return Promise.race([opened, this.errP]);
  }

  private onText(d: string): void {
    let m: any;
    try {
      m = JSON.parse(d);
    } catch {
      this.fail(new SessionProtocolError("non-JSON control frame"));
      return;
    }
    if (typeof m !== "object" || m === null || typeof m.type !== "string") {
      this.fail(new SessionProtocolError("control frame without a type"));
      return;
    }
    this.event({ ev: "frame", in: m.type });
    switch (m.type) {
      case "error": {
        this.noteDeposit(m);
        const type = (m.detail as { error?: { type?: unknown } } | undefined)?.error?.type;
        this.fail(
          type === "connection_deposit_unfunded"
            ? new ConnectionDepositError(
                `node rejected: ${String(m.reason ?? "the balance does not cover the connection deposit")}`,
                this.depositMsat,
                m.status,
                m.detail,
              )
            : new SessionRejectedError(`node rejected: ${String(m.reason ?? "unknown")}`, undefined, m.status, m.detail),
        );
        return;
      }
      case "closed":
        this.noteDeposit(m);
        // An orderly end with no request in flight; the socket closes next.
        this.closedReason = String(m.reason ?? "closed").slice(0, 64);
        this.goaway = true;
        this.kick();
        return;
      case "body_released":
        if (this.cur && m.n === this.cur.n) {
          this.cur.released = true;
          this.cur.tReleased = Date.now();
          this.kick();
        }
        return;
      case "zk_params": {
        const key = `zk_params:${String(m.proof)}:${String(m.purpose ?? "")}`;
        // Our own records: proven as the node asks, in order, whenever it asks.
        if (key === "zk_params:pi_win:records") {
          void this.proveRecords(m).catch((e) => this.fail(e instanceof Error ? e : new SessionProtocolError(String(e))));
          return;
        }
        this.inbox.push(key, m);
        return;
      }
      default:
        this.inbox.push(m.type, m);
    }
  }

  /**
   * The deposit's outcome in the connection's last frame (`closed` or
   * `error`): `deposit`, with the node's signature over `deposit_json`.
   */
  private noteDeposit(m: any): void {
    if (m.deposit === undefined || m.deposit === null) return;
    const json = typeof m.deposit_json === "string" ? m.deposit_json : JSON.stringify(m.deposit);
    let d: any;
    try {
      d = JSON.parse(json);
    } catch {
      return;
    }
    if (d === null || typeof d !== "object" || (d.outcome !== "released" && d.outcome !== "charged")) return;
    const pubkey = this.ready?.pubkey ?? this.expectedPubkey;
    const signed =
      typeof m.deposit_sig === "string" &&
      typeof pubkey === "string" &&
      verifySchnorrSignature(json, m.deposit_sig, pubkey) &&
      (d.sid === this.sid || (d.sid === null && !this.sid));
    this.deposit = { msat: Number(d.msat), outcome: d.outcome, reason: String(d.reason ?? "").slice(0, 64), signed };
    this.event({ ev: "h2_deposit", ...this.deposit });
  }

  /** The next control frame of one of `keys`, or the connection's failure, or a timeout. */
  private async wait(keys: string[], ms: number): Promise<{ key: string; msg: any }> {
    const t = this.inbox.take(keys);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        t.promise,
        this.errP,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new ConfidentialTimeoutError(`timeout waiting for ${keys.join("/")}`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      t.cancel();
    }
  }

  /**
   * Wait until `pred()` holds. `ms` is a deadline, or with `last` the longest
   * silence since `last()`.
   */
  private async until(pred: () => boolean, what: string, ms: number, last?: () => number): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      if (this.failure) throw this.failure;
      if (pred()) return;
      if (Date.now() - (last ? Math.max(last(), t0) : t0) > ms) {
        throw new ConfidentialTimeoutError(`timeout waiting for ${what}`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((res) => {
        this.kicks.push(res);
        timer = setTimeout(res, 100);
      });
      if (timer) clearTimeout(timer);
    }
  }

  /** Every received byte decrypted and parsed. */
  private async drained(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const c = this.flushChain;
      await c;
      if (c === this.flushChain) return;
    }
  }

  private trackServerRecords(bytes: Uint8Array): void {
    let buf = this.serverPending.length ? concat(this.serverPending, bytes) : bytes;
    while (buf.length >= 5) {
      const len = (buf[3]! << 8) | buf[4]!;
      if (buf.length < 5 + len) break;
      if (buf[0] === 0x17) this.serverRecords.set(this.wireRecords++, buf.slice(5, 5 + len));
      buf = buf.subarray(5 + len);
    }
    this.serverPending = buf.slice();
  }

  /** Server application-data records decrypted so far (handshake flight included). */
  private recvCount(): number {
    return this.hsCipher + this.serverPost.length;
  }

  // --- opening the connection ---------------------------------------------------

  /** Refuse to start when cu-prover or cu-2pc cannot be run (before the node sees a credential). */
  private checkBinaries(): void {
    const needed: Array<[string, string]> = [];
    if (typeof this.prover.path === "string") needed.push(["cu-prover", this.prover.path]);
    if (!this.twoPcFactory) needed.push(["cu-2pc", resolveTwoPcPath(this.twoPcPath, this.prover.path)]);
    for (const [name, path] of needed) {
      if (!isExecutable(path)) {
        throw new ProverMissingError(
          `${name} not found or not executable at ${path}`,
          name === "cu-2pc" ? "set CU_2PC_BIN or put cu-2pc next to cu-prover" : "set CU_PROVER_BIN or the proverPath option",
        );
      }
    }
  }

  /**
   * setup → ready → 2PC → handshake (ALPN h2) → π_NK on the connection head →
   * release_head → head_written → the provider's SETTINGS. The node checks
   * the credential and reserves the offer's connection deposit (released
   * with the first settled request); no request is reserved yet.
   */
  async connect(): Promise<void> {
    if (this.connectStarted) throw new SessionProtocolError("connect() called twice");
    this.connectStarted = true;
    try {
      await this.connectInner();
    } catch (e) {
      const err = e instanceof Error ? e : new SessionProtocolError(String(e));
      this.fail(err);
      throw this.failure ?? err;
    }
  }

  private async connectInner(): Promise<void> {
    const t0 = Date.now();
    this.checkBinaries();
    await this.openSocket();
    const setup: Record<string, unknown> = { type: "setup", http: 2, nonce_c: hex(cryptoRandom(32)), armed: false };
    if (this.offer.sig) setup.offer_sig = this.offer.sig;
    setup.auth = this.auth;
    this.sendText(setup);

    this.ready = (await this.wait(["ready"], this.timeouts.ready)).msg;
    if (this.expectedPubkey && this.ready.pubkey !== this.expectedPubkey) {
      throw new SessionProtocolError(
        `session pubkey ${String(this.ready.pubkey)} differs from the signed offer key ${this.expectedPubkey}`,
      );
    }
    if (typeof this.ready?.sid !== "string" || !SID_RE.test(this.ready.sid)) {
      throw new SessionProtocolError("node announced a malformed session id");
    }
    if (this.ready.v !== 2 || this.ready.http !== 2) {
      throw new SessionProtocolError("node did not start an http: 2 session");
    }
    // What the setup reserved must be the signed offer's deposit (a sidecar
    // without a node names none).
    if (this.ready.deposit_msat !== undefined && this.ready.deposit_msat !== this.depositMsat) {
      throw new SessionProtocolError(
        `node reserved a connection deposit of ${String(this.ready.deposit_msat)} msat, the signed offer's is ${this.depositMsat}`,
      );
    }
    this.sid = this.ready.sid;
    const tReady = Date.now();
    this.event({ ev: "h2_ready" });

    const twoPc = this.twoPcFactory?.() ?? new TwoPcSession({ binaryPath: this.twoPcPath, proverPath: this.prover.path });
    this.twoPc = twoPc;
    twoPc.start(this.zkUrl("twopc"));
    // π_WIN and π_C3S run once per request: the channel must repeat them.
    this.zkChan = this.proofChannelFactory?.() ?? new ProofChannel({ binaryPath: this.prover.path, multi: true });
    this.zkChan.start(this.zkUrl("zkchan"));
    const keyShare = await Promise.race([twoPc.keyShare(this.timeouts.twoPcKeyShare), this.errP]);
    const tKeyShare = Date.now();

    const handshakeP = new Promise<void>((res) => (this.handshakeDone = res));
    this.makeTls({
      keyShare,
      onServerHello: async (serverShare, thSH) => {
        this.thSH = thSH;
        return twoPc.handshake(serverShare, thSH);
      },
      onServerFinished: async (thSF) => {
        this.thSF = thSF;
        this.ap = await twoPc.application(thSF);
        return { serverAp0: this.ap.serverAp0, clientAp1: this.ap.clientAp1 };
      },
    });
    await this.tls.startHandshake();
    await Promise.race([handshakeP, this.errP, rejectAfter(this.timeouts.handshake, "handshake")]);
    if (!this.ap) throw new SessionProtocolError("handshake finished without 2PC application secrets");
    await this.wait(["hs_verified"], this.timeouts.hsVerified);
    const tHs = Date.now();

    // π_NK: the node's one epoch-0 record is the connection head of the
    // signed offer (its SETTINGS, its probe, the credential as the one table
    // entry), under the K_0 our 2PC anchored.
    const commit = (await this.wait(["c_commit"], this.timeouts.cCommit)).msg;
    for (const k of ["h1", "h2", "hk"] as const) {
      if (commit[k] !== undefined && commit[k] !== hex(this.ap[k])) {
        throw new SessionProtocolError(`c_commit: ${k} differs from our 2PC output`);
      }
    }
    checkPiNKParamsH2(commit.params, {
      host: this.offer.upstream_host,
      probePath: this.h2.probe_path,
      keyLength: this.offer.key_length,
      keyAlphabet: this.offer.key_alphabet,
      hk: this.ap.hk,
    });
    const pinkCommit = hex(Uint8Array.from((commit.params as { PiNK: { c_commit: number[] } }).PiNK.c_commit));
    if (commit.c_commit !== pinkCommit) {
      throw new SessionProtocolError("c_commit: the frame's commitment is not the one π_NK proves");
    }
    this.cCommitHex = pinkCommit;
    await this.proof("pi_nk", "verify", commit.params);
    const tNk = Date.now();

    // The node writes the head (epoch 0) and its KeyUpdate; we are keyed for
    // epoch 1. This reaches the provider, but it is the node's own probe: no
    // request of ours, nothing reserved.
    this.sendText({ type: "release_head" });
    await this.wait(["head_written"], this.timeouts.headWritten);
    const tHead = Date.now();
    await this.until(() => this.gotSettings, "the provider's SETTINGS", this.timeouts.settings);
    this.opened = true;
    this.tOpen = Date.now();
    this.tLastSettled = this.tOpen;
    this.setupBytes = this.byteCounts();
    this.setupTimings = {
      readyMs: tReady - t0,
      twoPcKeyShareMs: tKeyShare - tReady,
      handshakeMs: tHs - tKeyShare,
      piNkMs: tNk - tHs,
      headMs: tHead - tNk,
      settingsMs: this.tOpen - tHead,
      connectMs: this.tOpen - t0,
    };
    this.event({ ev: "h2_open", ...this.setupTimings });
  }

  private makeTls(external: {
    keyShare: Uint8Array;
    onServerHello(serverShare: Uint8Array, thSH: Uint8Array): Promise<{ clientHs: Uint8Array; serverHs: Uint8Array }>;
    onServerFinished(thSF: Uint8Array): Promise<{ serverAp0: Uint8Array; clientAp1: Uint8Array }>;
  }): void {
    this.tls = makeTLSClient({
      external,
      host: this.offer.upstream_host,
      verifyServerCertificate: true,
      cipherSuites: ["TLS_AES_128_GCM_SHA256"],
      supportedProtocolVersions: ["TLS1_3"],
      namedCurves: ["SECP256R1"],
      applicationLayerProtocols: ["h2"],
      write: (packet: { header: Uint8Array; content: Uint8Array }) => {
        const record = concat(packet.header, packet.content);
        const d = this.pendingDesc;
        if (d) {
          // One of our post-handshake records: kept with its plaintext and
          // its public ranges, for the π_WIN check and the attestation.
          this.pendingDesc = undefined;
          const seq = this.nextSeq++;
          this.out.set(seq, { wire: record, plain: d.plain, pub: d.pub });
          this.unproven.add(seq);
          this.lastSeq = seq;
        }
        this.sendBytes(record);
      },
      onRead: (rec: { content: Uint8Array }, ctx?: { type?: string; contentType?: string; plaintext?: Uint8Array }) => {
        if (ctx?.type !== "ciphertext") return;
        if (!this.postHandshake) {
          this.hsCipher++;
          return;
        }
        this.curAbs = this.hsCipher + this.serverPost.length;
        // Only a record that may hold the response head is kept in plaintext
        // (an error head is disclosed from it).
        const cur = this.cur;
        if (ctx.plaintext && cur && (cur.status === undefined || cur.status >= 400)) {
          this.plain.set(this.curAbs, ctx.plaintext);
        }
        this.serverPost.push({
          data: ctx.contentType === "APPLICATION_DATA",
          keyUpdates: ctx.contentType === "HANDSHAKE" ? countKeyUpdates(rec.content) : 0,
        });
      },
      onRecvCertificates: ({ certificates }: { certificates: { internal: { rawData: ArrayBuffer } }[] }) => {
        const h = createHash("sha256");
        for (const c of certificates) h.update(new Uint8Array(c.internal.rawData));
        this.certChainHash = new Uint8Array(h.digest());
      },
      onApplicationData: (rec: Uint8Array) => {
        try {
          for (const f of this.reader.push(rec, this.curAbs)) this.onFrame(f);
        } catch (e) {
          this.fail(
            e instanceof ConfidentialError
              ? e
              : new ResponseVerificationError(`malformed upstream HTTP/2: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
        this.kick();
      },
      onTlsEnd: () => {
        // The provider closed (or the node did): nothing more can be sent.
        this.goaway = true;
        this.kick();
      },
      onHandshake: () => {
        this.postHandshake = true;
        this.handshakeDone?.();
      },
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never) as unknown as TlsHandle;
  }

  /**
   * One proof, serialized with the connection's other proofs: on the proof
   * channel when it is usable, else (only while no proof has started on it)
   * on its own `/zk?proof=…` connection.
   */
  private proof(
    proof: "pi_nk" | "pi_win" | "pi_c3s",
    cmd: "prove" | "verify",
    params: unknown,
    witness?: unknown,
  ): Promise<H2ProofTiming> {
    const run = async (): Promise<H2ProofTiming> => {
      if (this.failure) throw this.failure;
      const t = Date.now();
      const ch = this.zkChan;
      if (ch && (ch.used || (await ch.ready(this.timeouts.proofChannelReady)))) {
        const m = await Promise.race([ch.run(cmd, proof, params, witness, this.timeouts.proof), this.errP]);
        return { proof, ms: Date.now() - t, innerMs: m.ms, bytesSent: m.bytes_sent, bytesRecv: m.bytes_recv };
      }
      this.event({ ev: "proof_channel_fallback", proof, err: String(ch?.failure?.message ?? "") });
      await this.prover.run(this.zkUrl(proof), { proof, role: cmd === "prove" ? "prover" : "verifier", params, witness });
      return { proof, ms: Date.now() - t };
    };
    const p = this.proofChain.then(run, run);
    this.proofChain = p.catch(() => {});
    return p;
  }

  // --- frames -------------------------------------------------------------------

  private onFrame(f: RxFrame): void {
    const cur = this.cur;
    if (cur && f.stream === cur.stream && cur.firstFrameOff === undefined) cur.firstFrameOff = f.off;
    switch (f.type) {
      case FRAME.SETTINGS:
        if (f.flags & FLAG.ACK) break;
        for (let i = 0; i + 6 <= f.payload.length; i += 6) {
          const id = (f.payload[i]! << 8) | f.payload[i + 1]!;
          if (id === 4) this.initialWindow = u32(f.payload, i + 2);
        }
        this.gotSettings = true;
        // Acknowledged with the next request's records (one π_WIN for both)
        // when none is open, else at once.
        if (this.requestOpen) void this.sendCtl("settings_ack", new Uint8Array(0));
        else this.unackedSettings++;
        break;
      case FRAME.PING:
        if (!(f.flags & FLAG.ACK)) void this.sendCtl("ping_ack", f.payload);
        break;
      case FRAME.WINDOW_UPDATE: {
        if (f.payload.length < 4) break;
        const inc = u32(f.payload) & 0x7fffffff;
        if (f.stream === 0) this.connCredit += inc;
        else if (cur && f.stream === cur.stream) cur.streamCredit += inc;
        this.updateRelease();
        break;
      }
      case FRAME.GOAWAY:
        this.goaway = true;
        this.event({ ev: "h2_goaway" });
        break;
      case FRAME.RST_STREAM:
        if (cur && f.stream === cur.stream && f.payload.length >= 4) cur.reset = u32(f.payload);
        break;
      case FRAME.HEADERS: {
        if (!cur || f.stream !== cur.stream) break; // the probe stream's answer, if any
        if (!(f.flags & FLAG.END_HEADERS) || f.flags & (FLAG.PADDED | FLAG.PRIORITY)) {
          throw new ResponseVerificationError("h2: a response HEADERS frame with CONTINUATION, padding or priority");
        }
        const fields = decodeBlock(f.payload);
        const status = fields.find(([n]) => n === ":status")?.[1];
        if (status !== undefined && (cur.status === undefined || cur.status < 200)) {
          cur.status = Number(status);
          cur.head = { off: f.off, raw: concat(frameHeader(f.payload.length, f.type, f.flags, f.stream), f.payload) };
          if (cur.status >= 200) {
            const headers: Record<string, string> = {};
            for (const [n, v] of fields) {
              if (n.startsWith(":")) continue;
              headers[n] = n in headers ? `${headers[n]}, ${v}` : v;
            }
            cur.headers = headers;
            cur.tLastData = Date.now();
            cur.opts.onResponseHead?.({ status: cur.status, statusText: "", headers });
          }
        }
        if (f.flags & FLAG.END_STREAM) this.streamEnded(cur);
        break;
      }
      case FRAME.DATA:
        if (!cur || f.stream !== cur.stream) break;
        if (f.flags & FLAG.PADDED) throw new ResponseVerificationError("h2: a padded DATA frame");
        cur.tLastData = Date.now();
        if (!cur.tFirstData) cur.tFirstData = cur.tLastData;
        this.dataBytes += f.payload.length;
        cur.parts.push({ off: f.off + 9, data: f.payload });
        if (f.payload.length) cur.opts.onResponseBody?.(f.payload);
        if (f.flags & FLAG.END_STREAM) this.streamEnded(cur);
        break;
      default:
        break;
    }
  }

  private streamEnded(cur: Cur): void {
    if (cur.ended) return;
    cur.ended = true;
    // An empty chunk tells a streaming caller the body is complete.
    cur.opts.onResponseBody?.(new Uint8Array(0));
  }

  // --- sending ------------------------------------------------------------------

  /** One record: `content` is one frame; the inner plaintext adds the type byte, no padding. */
  private sendRecord(content: Uint8Array, pub: [number, number][], ctl?: string): Promise<number> {
    const plain = concat(content, Uint8Array.from([0x17]));
    const p = this.tx.then(async () => {
      if (this.failure) throw this.failure;
      if (ctl) this.sendText({ type: "ctl", frame: ctl });
      this.pendingDesc = { plain, pub };
      await this.tls.writeInner(plain);
      return this.lastSeq;
    });
    this.tx = p.then(
      () => {},
      (e) => this.fail(e instanceof Error ? e : new SessionProtocolError(String(e))),
    );
    return p;
  }

  private sendCtl(name: "settings_ack" | "ping_ack", payload: Uint8Array): Promise<number> {
    const f = name === "settings_ack" ? frame(FRAME.SETTINGS, FLAG.ACK, 0) : frame(FRAME.PING, FLAG.ACK, 0, payload);
    // The frame header and the final type byte are public; a PING's opaque
    // payload is the provider's and stays out of the proof.
    const p = this.sendRecord(f, [[0, 9], [f.length, f.length + 1]], name);
    p.catch(() => {});
    return p;
  }

  /** Release as many of the request's records as the provider's windows allow (never before `request_ok`). */
  private updateRelease(): void {
    const cur = this.cur;
    if (!cur || !cur.accepted || cur.dataLens.length === 0) return;
    const credit = Math.min(cur.streamCredit, this.connCredit);
    let upto = 1;
    let sum = 0;
    for (const len of cur.dataLens) {
      if (sum + len > credit) break;
      sum += len;
      upto++;
    }
    if (upto > cur.upto) {
      cur.upto = upto;
      // From here the request may reach the provider.
      cur.releaseSent = true;
      this.sendOrdered({ type: "release", n: cur.n, upto });
    }
  }

  // --- proofs of our own records --------------------------------------------------

  private source(seq: number): WinSource | undefined {
    const r = this.out.get(seq);
    return r && { ct: r.wire.subarray(5, r.wire.length - 16), plain: r.plain, pub: r.pub };
  }

  /**
   * π_WIN over a batch of our records. The node chooses the windows, so each
   * is checked against the records themselves before anything is proven.
   */
  private async proveRecords(m: any): Promise<void> {
    const first = m.first_seq;
    const count = m.count;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 1 || count > 4096) {
      throw new SessionProtocolError("π_WIN: malformed batch");
    }
    const covered = Array.from({ length: count }, (_, i) => first + i);
    if (!this.ap) throw new SessionProtocolError("π_WIN before the handshake");
    const shape = checkPiWinParams(m.params, {
      anchor: this.ap.h1,
      lookup: (seq) => (seq >= first && seq < first + count && this.unproven.has(seq) ? this.source(seq) : undefined),
      covered,
    });
    const cur = this.cur;
    const t = await this.proof("pi_win", "prove", m.params, { Secret: Array.from(this.ap.clientAp1) });
    (cur ?? this.cur)?.proofs.push({ ...t, purpose: "records", ...shape });
    this.event({ ev: "pi_win_ok", first_seq: first, count, windows: shape.windows });
    for (const seq of covered) {
      this.unproven.delete(seq);
      // A request's records are kept until it settles (the attestation hashes them).
      if (!this.cur?.seqs.includes(seq)) this.out.delete(seq);
    }
    this.kick();
  }

  // --- one request ----------------------------------------------------------------

  /**
   * Start a request on this idle connection. Throws synchronously when the
   * connection cannot take one (nothing was sent then).
   */
  request(opts: H2RequestOptions): H2RequestHandle {
    if (!this.idle) {
      throw this.failure ?? new SessionRejectedError("the http: 2 connection is not idle");
    }
    const offer = opts.offer ?? this.offer;
    if (offer !== this.offer && h2ConnectionTerms(offer) !== this.terms) {
      throw new SessionProtocolError("the request's offer has other connection terms than this connection was opened on");
    }
    const suffix = new TextEncoder().encode(canonicalSuffix(this.offer.chat, opts.model, opts.maxTokens));
    const body = opts.body;
    if (body.length < suffix.length || !suffix.every((b, i) => body[body.length - suffix.length + i] === b)) {
      throw new SessionProtocolError("request body does not end with the pinned suffix");
    }
    const n = ++this.requests;
    const cur: Cur = {
      n,
      stream: requestStream(n),
      model: opts.model,
      opts,
      offer,
      tStart: Date.now(),
      recvAtSend: this.recvCount(),
      seqs: [],
      dataLens: [],
      upto: 0,
      streamCredit: this.initialWindow,
      accepted: false,
      releaseSent: false,
      released: false,
      tLastData: Date.now(),
      parts: [],
      ended: false,
      proofs: [],
      settled: false,
    };
    // An earlier request's records are no longer needed.
    for (const abs of this.serverRecords.keys()) {
      if (abs < cur.recvAtSend) this.serverRecords.delete(abs);
      else break;
    }
    this.plain.clear();
    this.cur = cur;
    let credentialSent = false;
    const done = this.runRequest(cur, suffix, () => (credentialSent = true)).then(
      (r) => {
        cur.settled = true;
        return r;
      },
      (e) => {
        // The prototype rule: any failure ends the connection.
        const err = e instanceof Error ? e : new SessionProtocolError(String(e));
        this.fail(err);
        throw this.failure ?? err;
      },
    );
    done.catch(() => {});
    const conn = this;
    return {
      n,
      sid: this.sid,
      get bodyReleased() {
        return cur.releaseSent;
      },
      get credentialSent() {
        return credentialSent;
      },
      done,
      close() {
        if (!cur.settled) conn.close("request aborted");
      },
    };
  }

  private async runRequest(cur: Cur, suffix: Uint8Array, onSent: () => void): Promise<H2RequestResult> {
    const { opts, n, stream } = cur;
    const bytes0 = this.byteCounts();
    const host = this.offer.upstream_host;
    const path = chatPath(this.offer.head_template);

    // The records of the request: HEADERS (public in full), then DATA frames
    // (header and type byte public; the last one also its tail, the suffix).
    type Plan = { content: Uint8Array; pub: [number, number][]; data: number };
    const plan: Plan[] = [];
    const headers = frame(FRAME.HEADERS, FLAG.END_HEADERS, stream, requestBlock(host, path));
    plan.push({ content: headers, pub: [[0, headers.length + 1]], data: -1 });
    const parts = splitBody(opts.body, suffix.length, this.chunk);
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const f = frame(FRAME.DATA, last ? FLAG.END_STREAM : 0, stream, part);
      plan.push({ content: f, pub: [[0, 9], [f.length - (last ? suffix.length : 0), f.length + 1]], data: part.length });
    });
    const bodyLen = opts.body.length;

    // `request` first, then the records: the node opens the request (and
    // reserves), and takes any SETTINGS acknowledgement and the records as
    // one π_WIN batch. The same rates and fees as a v2 setup accepts.
    this.requestOpen = true;
    const req: Record<string, unknown> = {
      type: "request",
      n,
      kind: "chat",
      model: opts.model,
      max_tokens: opts.maxTokens,
      body_len: bodyLen,
    };
    if (cur.offer.sig) req.offer_sig = cur.offer.sig;
    const fee = offerSessionFeeMsat(cur.offer);
    const abandonFee = offerAbandonFeeMsat(cur.offer);
    if (fee > 0) req.session_fee_msat = fee;
    if (abandonFee > 0) req.abandon_fee_msat = abandonFee;
    req.auth = this.auth;
    this.sendOrdered(req);
    onSent();
    while (this.unackedSettings > 0) {
      this.unackedSettings--;
      void this.sendCtl("settings_ack", new Uint8Array(0));
    }
    for (const p of plan) cur.seqs.push(await Promise.race([this.sendRecord(p.content, p.pub), this.errP]));
    cur.dataLens = plan.slice(1).map((p) => p.data);
    this.event({ ev: "h2_request_sent", n, records: plan.length, body_len: bodyLen });

    // Nothing is released before the node accepted the request: until then a
    // refusal (no funds, an expired offer) costs nothing and may be retried.
    const ok = (await this.wait(["request_ok"], this.timeouts.requestOk)).msg;
    if (ok.n !== n || ok.stream !== stream) throw new SessionProtocolError("request_ok names another request or stream");
    if (ok.suffix !== new TextDecoder().decode(suffix)) {
      throw new SessionProtocolError("node expects a different pinned suffix than ours");
    }
    cur.accepted = true;
    this.updateRelease();

    // Released (in steps, as the provider's window opens) or refused early.
    const errored = () => (cur.status ?? 0) >= 400;
    await this.until(() => cur.released || errored() || cur.reset !== undefined, `body_released for request ${n}`, this.timeouts.released);
    await this.until(
      () => cur.ended || cur.reset !== undefined || errored(),
      `the response to request ${n}`,
      this.timeouts.responseIdle,
      () => Math.max(cur.tLastData, cur.tReleased ?? 0),
    );
    if (cur.reset !== undefined) {
      throw new ResponseVerificationError(`the provider reset stream ${stream} (code ${cur.reset})`);
    }
    const status = cur.status ?? 0;
    let receipt: ConfidentialReceipt;
    let attestation: unknown;
    if (status >= 200 && status < 300) {
      ({ receipt, attestation } = await this.settleUsage(cur));
    } else if (status >= 400) {
      // The error body is short; give it a moment (it stays private), no more.
      await this.until(() => cur.ended, "the error body", this.timeouts.errorBody).catch((e) => {
        if (!(e instanceof ConfidentialTimeoutError)) throw e;
      });
      ({ receipt, attestation } = await this.settleErrorHead(cur, status));
      // Only a settled 2xx leaves a connection open: the node closes this one.
      this.goaway = true;
    } else {
      throw new ResponseVerificationError(`request ${n}: status ${status} is neither a success nor a disclosable error`);
    }
    const tEnd = Date.now();

    // The request is settled: its records and its part of the stream go.
    this.connCredit -= bodyLen;
    for (const seq of cur.seqs) this.out.delete(seq);
    this.reader.dropBefore(this.reader.total);
    this.plain.clear();
    this.cur = undefined;
    this.requestOpen = false;
    this.tLastSettled = tEnd;

    const responseBody = concat(...cur.parts.map((p) => p.data));
    const effectiveModel = status < 300 ? effectiveModelFromText(new TextDecoder().decode(responseBody)) : undefined;
    let warnings: string[] | undefined;
    if (effectiveModel !== undefined && effectiveModel !== opts.model) {
      warnings = [`the provider reports model ${JSON.stringify(effectiveModel)}, the request pinned ${opts.model}`];
    }
    const bytes1 = this.byteCounts();
    const delta = {} as H2Bytes;
    for (const k of Object.keys(bytes1) as (keyof H2Bytes)[]) delta[k] = bytes1[k] - bytes0[k];
    this.event({ ev: "h2_request_settled", n, status, total_ms: tEnd - cur.tStart });
    return {
      sid: this.sid,
      n,
      stream,
      model: opts.model,
      effectiveModel,
      status,
      headers: cur.headers ?? {},
      body: responseBody,
      receipt,
      attestation,
      costMsats: receipt.cost_msats,
      warnings,
      timings: {
        startedAt: cur.tStart,
        releasedMs: cur.tReleased ? cur.tReleased - cur.tStart : undefined,
        ttftMs: cur.tFirstData ? cur.tFirstData - cur.tStart : undefined,
        totalMs: tEnd - cur.tStart,
        proofs: cur.proofs,
      },
      bytes: delta,
    };
  }

  // --- disclosures ----------------------------------------------------------------

  /**
   * The usage disclosure of a finished stream (A.6, A.11): R runs from the
   * usage event (its DATA frame header, or the line feed before it inside a
   * frame) to the last server byte received.
   */
  private usageDisclosure(cur: Cur): {
    r: Uint8Array;
    tailLens: number[];
    serverRecords: number;
    ownUsage: UpstreamUsageEvent;
    first: number;
  } {
    const bad = (what: string): never => {
      throw new ResponseVerificationError(what);
    };
    if (!this.reader.atBoundary()) bad("the received stream does not end at a frame boundary");
    const text = latin1(concat(...cur.parts.map((p) => p.data)));
    const done = "data: [DONE]\n\n";
    if (!text.endsWith(done)) bad("the stream does not end with data: [DONE]");
    const before = text.slice(0, text.length - done.length);
    const at = before.lastIndexOf("\n\ndata: ", before.length - 3);
    const evStart = at >= 0 ? at + 2 : 0;
    if (!before.startsWith("data: ", evStart) || !before.endsWith("\n\n")) bad("no usage event before data: [DONE]");
    let ownUsage: UpstreamUsageEvent;
    try {
      const raw = before.slice(evStart + 6, before.length - 2);
      ownUsage = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
    } catch {
      return bad("the last event before data: [DONE] is not JSON");
    }
    const u = ownUsage?.usage;
    const choices = (ownUsage as { choices?: unknown } | null)?.choices;
    if (
      !Array.isArray(choices) ||
      choices.length !== 0 ||
      !Number.isSafeInteger(u?.prompt_tokens) ||
      !Number.isSafeInteger(u?.completion_tokens)
    ) {
      bad("the last event before data: [DONE] is not a usage event");
    }
    // Where the event starts in the received stream.
    let acc = 0;
    let start = -1;
    for (const p of cur.parts) {
      if (evStart < acc + p.data.length) {
        const within = evStart - acc;
        start = within === 0 ? p.off - 9 : p.off + within - 1;
        break;
      }
      acc += p.data.length;
    }
    if (start < 0) bad("usage event not found in the received frames");
    const r = this.reader.slice(start, this.reader.total);
    const first = this.reader.recordAt(start);
    const recs = this.reader.records.filter((x) => x.abs >= first.abs);
    for (let i = 1; i < recs.length; i++) {
      if (recs[i]!.abs !== recs[i - 1]!.abs + 1) bad("a record without response bytes sits inside the disclosed tail");
    }
    const serverRecords = this.recvCount();
    if (recs[recs.length - 1]!.abs !== serverRecords - 1) bad("a record without response bytes follows the disclosed tail");
    return { r, tailLens: recs.map((x) => x.content.length + 1).reverse(), serverRecords, ownUsage, first: first.abs };
  }

  private async settleUsage(cur: Cur): Promise<{ receipt: ConfidentialReceipt; attestation: unknown }> {
    const ap = this.ap!;
    for (let attempt = 0; ; attempt++) {
      await this.drained();
      if (this.failure) throw this.failure;
      const d = this.usageDisclosure(cur);
      const epoch = serverTailEpoch(this.serverPost, d.tailLens.length);
      const msg: Record<string, unknown> = {
        type: "disclose",
        n: cur.n,
        r: hex(d.r),
        tail_lens: d.tailLens,
        skip: 0,
        server_records: d.serverRecords,
      };
      if (epoch.keyUpdates > 0) {
        msg.key_updates = epoch.keyUpdates;
        msg.epoch_start = epoch.epochStart;
      }
      this.sendOrdered(msg);
      const next = await this.wait(["disclose_retry", "attestation"], this.timeouts.attestation);
      if (next.key === "disclose_retry") {
        // More server records reached the node than we had parsed: catch up.
        if (attempt >= 20) throw new SessionProtocolError("the node keeps asking for a newer disclosure");
        const want = next.msg.server_records;
        if (!Number.isSafeInteger(want)) throw new SessionProtocolError("disclose_retry without a record count");
        await this.until(() => this.recvCount() >= want, "the server records the node counts", 15_000);
        continue;
      }
      const att = await this.checkAttestation(next.msg, cur, d.serverRecords);
      const c3 = (await this.wait(["zk_params:pi_c3s:"], this.timeouts.zkParams)).msg;
      if (c3.n !== undefined && c3.n !== cur.n) throw new SessionProtocolError("π_C3S parameters are for another request");
      // The records the proof may name are the disclosed tail: indices
      // [first, serverRecords), with sequence numbers counted from the epoch's
      // first record.
      const tail: Uint8Array[] = [];
      for (let abs = d.first; abs < d.serverRecords; abs++) {
        const rec = this.serverRecords.get(abs);
        if (!rec) throw new SessionProtocolError("a disclosed record is no longer held");
        tail.push(rec);
      }
      checkPiC3SParams(c3.params, {
        h2: ap.h2,
        serverRecords: tail,
        r: d.r,
        skip: 0,
        keyUpdates: epoch.keyUpdates,
        epochBase: this.hsCipher + epoch.epochStart - d.first,
        trailing: 0,
        tailLens: d.tailLens,
      });
      const t = await this.proof("pi_c3s", "prove", c3.params, { Secret: Array.from(ap.serverAp0) });
      cur.proofs.push(t);
      const { receipt, receiptJson, sig } = await this.takeReceipt(cur, att.json);
      const checked = verifyReceipt({
        receipt,
        receiptJson,
        sig,
        pubkey: this.ready.pubkey,
        ownUsage: d.ownUsage,
        pinnedModel: cur.model,
        priceEntry: cur.offer.price_list[cur.model],
        sessionFeeMsat: offerSessionFeeMsat(cur.offer),
        abandonFeeMsat: offerAbandonFeeMsat(cur.offer),
      });
      if (!checked.usageMatch) throw new ReceiptVerificationError("receipt usage does not match our own plaintext");
      if (!checked.costWithinOffer) {
        throw new ReceiptVerificationError(
          `receipt cost ${receipt.cost_msats} msats exceeds the usage priced at the signed offer's rates` +
            ` plus its session fee (${offerSessionFeeMsat(cur.offer)} msats)`,
        );
      }
      return { receipt, attestation: att.a };
    }
  }

  /** The error head (A.7): the response HEADERS frame, which must start a record. */
  private async settleErrorHead(cur: Cur, status: number): Promise<{ receipt: ConfidentialReceipt; attestation: unknown }> {
    const ap = this.ap!;
    await this.drained();
    // Our own records must be proven first (one π_WIN at a time).
    await this.until(
      () => this.unproven.size === 0 && cur.proofs.some((p) => p.proof === "pi_win"),
      "our records to be proven",
      this.timeouts.proof,
    );
    const head = cur.head!;
    const rec = this.reader.recordAt(head.off);
    if (rec.start !== head.off) {
      throw new ResponseVerificationError("the error head does not start a server record: it cannot be disclosed");
    }
    const postIdx = rec.abs - this.hsCipher;
    let keyUpdates = 0;
    let epochStart = 0;
    for (let i = 0; i < postIdx; i++) {
      if (this.serverPost[i]!.keyUpdates > 0) {
        keyUpdates += this.serverPost[i]!.keyUpdates;
        epochStart = i + 1;
      }
    }
    const msg: Record<string, unknown> = { type: "disclose_head", n: cur.n, record: rec.abs, r: hex(head.raw) };
    if (keyUpdates > 0) {
      msg.key_updates = keyUpdates;
      msg.epoch_start = epochStart;
    }
    this.sendOrdered(msg);
    const att = await this.checkAttestation((await this.wait(["attestation"], this.timeouts.attestation)).msg, cur, undefined);
    const m = (await this.wait(["zk_params:pi_win:error_head"], this.timeouts.zkParams)).msg;
    // The windows may touch only the head's bytes and each record's final type byte.
    const chunks = new Map<number, number>();
    let left = head.raw.length;
    for (const x of this.reader.records.filter((x) => x.abs >= rec.abs)) {
      if (left <= 0) break;
      const take = Math.min(left, x.content.length);
      chunks.set(x.abs, take);
      left -= take;
    }
    const shape = checkPiWinParams(m.params, {
      anchor: ap.h2,
      keyUpdates,
      lookup: (seq) => {
        const abs = this.hsCipher + epochStart + seq;
        const take = chunks.get(abs);
        const plain = this.plain.get(abs);
        const wire = this.serverRecords.get(abs);
        if (take === undefined || !plain || !wire) return undefined;
        return { ct: wire.subarray(0, wire.length - 16), plain, pub: [[0, take], [plain.length - 1, plain.length]] };
      },
      covered: [...chunks.keys()].map((abs) => abs - this.hsCipher - epochStart),
    });
    const t = await this.proof("pi_win", "prove", m.params, { Secret: Array.from(ap.serverAp0) });
    cur.proofs.push({ ...t, purpose: "error_head", ...shape });
    const { receipt } = await this.takeReceipt(cur, att.json);
    const usageMatch = checkUpstreamErrorReceipt(receipt, status, offerSessionFeeMsat(cur.offer), {
      abandonFeeMsat: offerAbandonFeeMsat(cur.offer),
    });
    if (!usageMatch) throw new ReceiptVerificationError("error receipt does not match the disclosed status");
    return { receipt, attestation: att.a };
  }

  /**
   * The per-request attestation: signed by the node's key, naming this
   * connection, handshake and request, an interval that starts no earlier
   * than the request and no later than its response, and hashes we can
   * recompute from our own records. Returns the signed bytes.
   */
  private async checkAttestation(m: any, cur: Cur, upto: number | undefined): Promise<{ json: string; a: any }> {
    const json: string = typeof m.a_json === "string" ? m.a_json : JSON.stringify(m.a);
    if (!verifySchnorrSignature(json, m.sig, this.ready.pubkey)) {
      throw new ReceiptVerificationError("attestation signature invalid");
    }
    const bad = (what: string): never => {
      throw new ReceiptVerificationError(`attestation ${what}`);
    };
    let a: any;
    try {
      a = JSON.parse(json);
    } catch {
      return bad("is not valid JSON");
    }
    if (a === null || typeof a !== "object") bad("is not an object");
    if (a.sid !== this.sid || a.http !== 2 || a.n !== cur.n || a.stream !== cur.stream) {
      bad("names another session or request");
    }
    if (!this.thSH || !this.thSF || a.th_sh !== hex(this.thSH) || a.th_sf !== hex(this.thSF)) {
      bad("names a different TLS handshake");
    }
    if (!this.cCommitHex || a.c_commit !== this.cCommitHex) bad("names a different head-record commitment");
    if (this.certChainHash && a.cert_chain_hash !== hex(this.certChainHash)) bad("names a different certificate chain");
    const sK = a.s_k;
    const count = a.server_records;
    if (!Number.isSafeInteger(sK) || !Number.isSafeInteger(count) || sK < 0 || count < 0) bad("interval malformed");
    const firstAbs = cur.firstFrameOff === undefined ? undefined : this.reader.recordAt(cur.firstFrameOff).abs;
    if (sK < cur.recvAtSend || (firstAbs !== undefined && sK > firstAbs)) bad("interval does not start at our request");
    const end = sK + count;
    if (upto !== undefined && end !== upto) bad("interval does not end at our disclosure");
    await this.until(() => this.wireRecords >= end, "the records the attestation counts", 15_000);
    const h = createHash("sha256");
    for (let i = sK; i < end; i++) {
      const p = this.serverRecords.get(i);
      if (!p) return bad("covers records we no longer hold");
      h.update(Uint8Array.from([0x17, 0x03, 0x03, p.length >> 8, p.length & 0xff]));
      h.update(p);
    }
    if (a.sha256_recv !== h.digest("hex")) bad("hashes different upstream records than we received");
    const sent = a.client_records;
    if (!Number.isSafeInteger(sent) || sent < 0 || sent > cur.seqs.length || (cur.released && sent !== cur.seqs.length)) {
      bad("counts other request records than we sent");
    }
    const hs = createHash("sha256");
    for (const seq of cur.seqs.slice(0, sent)) hs.update(this.out.get(seq)!.wire);
    if (a.sha256_sent !== hs.digest("hex")) bad("hashes different request records than we sent");
    this.event({ ev: "attestation", n: cur.n, s_k: sK, server_records: count });
    return { json, a };
  }

  /** The request's node-signed receipt: bound to this connection, request and attestation. */
  private async takeReceipt(
    cur: Cur,
    attJson: string,
  ): Promise<{ receipt: ConfidentialReceipt; receiptJson: string; sig?: string }> {
    const m = (await this.wait(["receipt"], this.timeouts.receipt)).msg as {
      receipt?: unknown;
      receipt_json?: string;
      sig?: string;
    };
    // The signed bytes are the receipt, never the (unsigned) envelope beside them.
    const receiptJson = typeof m.receipt_json === "string" ? m.receipt_json : JSON.stringify(m.receipt);
    const receipt = parseSignedReceipt({
      receiptJson,
      sig: m.sig,
      pubkey: this.ready.pubkey,
      sid: this.sid,
      attestationJson: attJson,
    });
    if (receipt.http !== 2 || receipt.n !== cur.n) {
      throw new ReceiptVerificationError(`receipt is for request ${String(receipt.n)}, not http 2 request ${cur.n}`);
    }
    // The connection's first settled request returns the deposit: its
    // (signed) receipt says so, once, with the offer's amount.
    const back = receipt.deposit_released_msat;
    if (back !== undefined) {
      if (back !== this.depositMsat || this.depositMsat === 0 || this.deposit !== undefined) {
        throw new ReceiptVerificationError(
          `receipt ${cur.n} releases a connection deposit of ${String(back)} msat (the offer's is ${this.depositMsat})`,
        );
      }
      this.deposit = { msat: this.depositMsat, outcome: "released", reason: "request_settled", signed: true };
      this.event({ ev: "h2_deposit", ...this.deposit, n: cur.n });
    }
    return { receipt, receiptJson, sig: m.sig };
  }
}

function rejectAfter(ms: number, what: string): Promise<never> {
  return new Promise((_, rej) => {
    const t = setTimeout(() => rej(new ConfidentialTimeoutError(`timeout waiting for ${what}`)), ms);
    (t as { unref?: () => void }).unref?.();
  });
}
