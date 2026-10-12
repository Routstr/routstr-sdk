/**
 * The confidential-upstream session driver (C side).
 *
 * C is the TLS 1.3 client of the upstream session through the node's WS relay
 * and holds the only copy of the application traffic secrets. It never sees the
 * credential record. The message flow (identical to the verified prototype),
 * negotiated by the verified offer's `v`:
 *
 *   v1: setup → ready → TLS handshake → hs_secrets (c_hs/s_hs ONLY) → hs_verified
 *       → KU0 → c1_material → π_C1 → c_commit → π_N → ku1 → head_written
 *       → body → body_suffix → π_C2 → attestation → disclose → π_C3 → receipt
 *
 *   v2 (two-party handshake, docs/TWOPC-DESIGN.md): setup → ready(v=2)
 *       → cu-2pc key share P = P_C + P_N → TLS handshake with the external key
 *       schedule (P-256; c_hs/s_hs, then s_ap_0/c_ap_1 from the 2PC; no local
 *       ECDHE, HS or MS) → hs_verified → c_commit → π_NK (we verify)
 *       → release_head (the node writes epoch 0: credential + KeyUpdate under
 *       K_0, which we never learn) → head_written → body in epoch 1
 *       → body_suffix → π_C2S → attestation → disclose → π_C3S → receipt
 *
 * Everything the reference client verifies is verified here: the π_N statement
 * against the locally rebuilt one, the π_C1/π_C2/π_C3 parameters against our
 * own records (the node never makes us prove anything about other plaintext),
 * the canonical suffix equality, the response GCM tags (by the TLS fork
 * natively), the attestation and receipt Schnorr signatures, the receipt's
 * binding to this session and attestation, and its usage and cost against our
 * own plaintext and the signed offer's rates. Any failure rejects `finish()`.
 *
 * Fail-closed: every unexpected frame/state raises a typed ConfidentialError.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { verifySchnorrSignature } from "./canonical";
import {
  ConfidentialTimeoutError,
  ReceiptVerificationError,
  ResponseVerificationError,
  SessionProtocolError,
  SessionRejectedError,
} from "./errors";
import {
  concat,
  epoch1Material,
  hex,
  sha256,
  type Epoch1Material,
} from "./advice";
import {
  checkPiC1Params,
  checkPiC2Params,
  checkPiC2SParams,
  checkPiC3Params,
  checkPiC3SParams,
  checkPiNKParams,
  type SessionValues,
} from "./params";
import { CuProverBackend } from "./prover";
import { TwoPcSession, type TwoPcApplicationSecrets, type TwoPcTiming } from "./twopc";
import { ProofChannel } from "./zkchan";
import { checkAttestationBinding, feeOnlyChargeOk, parseSignedReceipt, verifyReceipt } from "./receipt";
import {
  canonicalSuffix,
  checkPiNParams,
  disclosureTailLens,
  effectiveModelFromText,
  extractUsageDisclosure,
  IncrementalHttpResponse,
  parseHttpResponse,
  usageEventFromDisclosure,
  type ParsedHttpResponse,
  type UpstreamUsageEvent,
} from "./suffix";
import { makeTLSClient } from "./tls-fork/lib/index.js";
import { setCryptoImplementation } from "./tls-fork/lib/crypto/index.js";
import { webcryptoCrypto } from "./tls-fork/lib/crypto/webcrypto.js";
import { offerAbandonFeeMsat, offerSessionFeeMsat, type VerifiedOffer } from "./offer";

setCryptoImplementation(webcryptoCrypto);

/** The fork-patched TLS client surface we use (the shipped .d.ts predates the patches). */
interface TlsHandle {
  getKeys():
    | { recordSendCount: number; clientSecret: Uint8Array; serverSecret: Uint8Array }
    | undefined;
  getHandshakeSecrets():
    | { masterSecret: Uint8Array; clientSecret: Uint8Array; serverSecret: Uint8Array }
    | undefined;
  getHandshakeMessages(): Uint8Array[];
  getTranscriptHashes(): { thSH?: Uint8Array; thSF?: Uint8Array };
  skipSendSequence(n: number): void;
  updateTrafficKeys(requestUpdateFromServer?: boolean): Promise<void>;
  updateTrafficKeysSilently(
    requestUpdateFromServer?: boolean,
  ): Promise<{ header: Uint8Array; content: Uint8Array }>;
  startHandshake(): Promise<void>;
  handleReceivedBytes(data: Uint8Array): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}

export interface ConfidentialReceipt {
  v?: number;
  sid: string;
  model: string;
  usage: UpstreamUsageEvent;
  /** Charged to the client's key from the verified usage. */
  cost_msats?: number;
  /** The node's reservation for this session (the model's maximum cost + fee). */
  reserved_msats?: number;
  /** The session fee of the frozen offer (msats), when the node charges one. */
  session_fee_msat?: number;
  /** The abandon fee of the frozen offer (msats), when the node charges one. */
  abandon_fee_msat?: number;
  /** The rate surcharge (percent) of the frozen offer, when set. */
  rate_surcharge_pct?: number;
  /** The key's balance after settlement (msats), when known. */
  balance_msats?: number | null;
  notary_pubkey?: string;
  attestation_hash?: string;
  time?: number;
  [k: string]: unknown;
}

export interface ConfidentialSessionTimings {
  readyMs?: number;
  handshakeMs?: number;
  ku0Ms?: number;
  /** v1: c1_material → π_C1 + π_N; v2: c_commit wait + π_NK verification. */
  piC1Ms?: number;
  recordKu1Ms?: number;
  claimToBodyMs?: number;
  upstreamTtftMs?: number;
  armMs?: number;
  /** v2: preprocessing + joint key share, phase A (handshake secrets), phase B (application secrets). */
  twoPcKeyShareMs?: number;
  twoPcPhaseAMs?: number;
  twoPcPhaseBMs?: number;
  /** v2: per-step 2PC timings and traffic as reported by cu-2pc. */
  twoPcSteps?: TwoPcTiming[];
  /** v2: per-proof wall time, path (`zkchan` or `per-proof`) and traffic. */
  proofs?: Record<string, { via: string; ms: number; innerMs?: number; bytesSent?: number; bytesRecv?: number }>;
  /** v2: proof channel open → both correlation chains preprocessed. */
  proofChannelReadyMs?: number;
  /** v2: proof channel setup steps (hello, preprocess) as reported by cu-prover. */
  proofChannelSteps?: TwoPcTiming[];
  totalMs: number;
}

export interface ConfidentialSessionResult {
  sid: string;
  uuid: string;
  model: string;
  effectiveModel?: string;
  /** Decrypted upstream HTTP response (status/headers/body). */
  http: ParsedHttpResponse;
  responseText: string;
  receipt: ConfidentialReceipt;
  attestation: unknown;
  receiptSigOk: boolean;
  attestationSigOk: boolean;
  usageMatch: boolean;
  costMsats?: number;
  ttftMs: number;
  totalMs: number;
  timings: ConfidentialSessionTimings;
  proofs: string[];
  /** Protocol version the session ran (1, or 2 = two-party handshake). */
  protocol: number;
}

export interface ConfidentialSessionOptions {
  /** Node HTTP(S) base, e.g. `http://127.0.0.1:8000`. */
  baseUrl: string;
  /** A verified offer (from `fetchConfidentialOffer`). */
  offer: VerifiedOffer;
  /**
   * The client's ordinary bearer for this node (an `sk-` key or a Cashu
   * token): the node reserves the model's maximum cost on it and settles the
   * verified usage, exactly like a normal request.
   */
  auth: string;
  model: string;
  maxTokens: number;
  /** Body length declared at setup (must equal the body passed to finish()). */
  bodyLength: number;
  /** Canonical suffix; defaults to canonicalSuffix(model, maxTokens). */
  suffix?: string;
  prover: CuProverBackend;
  /** v2: path to cu-2pc (default: CU_2PC_BIN/CU_2PC, then next to cu-prover, then PATH). */
  twoPcPath?: string;
  /** v2: injectable 2PC backend factory (tests). */
  twoPcFactory?: () => TwoPcSession;
  /**
   * v2: run π_NK/π_C2S/π_C3S over a pre-warmed proof channel (OT/VOLE set up
   * while arming). Default true; false forces the per-proof path.
   */
  proofChannel?: boolean;
  /** v2: injectable proof channel factory (tests). */
  proofChannelFactory?: () => ProofChannel;
  /** Node pubkey the ready frame must announce (defaults to offer.notary_pubkey). */
  expectedPubkey?: string;
  /** Timeouts (ms). */
  timeouts?: Partial<{
    ready: number;
    handshake: number;
    hsVerified: number;
    zkAck: number;
    cCommit: number;
    headWritten: number;
    zkParams: number;
    attestation: number;
    receipt: number;
    twoPcKeyShare: number;
    handshakeV2: number;
    /** v2: wait for the proof channel's preprocessing before falling back. */
    proofChannelReady: number;
    /** v2: one proof on the proof channel. */
    proof: number;
  }>;
  /** Optional evidence directory; writes client.jsonl/response.txt/receipt.json. */
  runsDir?: string;
  /** Structured event sink (never logs secrets). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Insecure test hook: only ever used by the prototype's loopback probes. */
  insecureNoProofs?: boolean;
  /**
   * Accept an unsigned `usage` frame instead of a node-signed receipt (a
   * sidecar run without a node, for tests). Off: a receipt must be signed.
   */
  allowUnsignedSettlement?: boolean;
  /**
   * Streaming hooks. The response is authenticated record by record by the
   * TLS stack (GCM tags under keys only we hold), so body bytes can be handed
   * out as they decrypt; π_C2/π_C3 and settlement concern billing and finish
   * afterwards (their failure is reported by `finish()`/`run()`).
   */
  onResponseHead?: (head: { status: number; statusText: string; headers: Record<string, string> }) => void;
  onResponseBody?: (chunk: Uint8Array) => void;
}

const DEFAULT_TIMEOUTS = {
  ready: 30_000,
  handshake: 15_000,
  hsVerified: 30_000,
  zkAck: 30_000,
  cCommit: 60_000,
  headWritten: 30_000,
  zkParams: 30_000,
  attestation: 60_000,
  receipt: 60_000,
  // v2: preprocessing (OT setup, garbled circuits) precedes the key share.
  twoPcKeyShare: 120_000,
  // v2: the handshake includes both garbled-circuit phases.
  handshakeV2: 45_000,
  // v2: the proof channel preprocesses alongside the 2PC (a few MB).
  proofChannelReady: 120_000,
  proof: 60_000,
};

class Bus {
  private pending = new Map<string, unknown[]>();
  private waiters = new Map<string, ((m: unknown) => void)[]>();

  emit(msg: { type: string }): void {
    const w = this.waiters.get(msg.type);
    if (w && w.length) w.shift()!(msg);
    else {
      const p = this.pending.get(msg.type) ?? [];
      p.push(msg);
      this.pending.set(msg.type, p);
    }
  }

  wait(type: string): Promise<unknown> {
    const p = this.pending.get(type);
    if (p && p.length) return Promise.resolve(p.shift());
    return new Promise((res) => {
      const w = this.waiters.get(type) ?? [];
      w.push(res);
      this.waiters.set(type, w);
    });
  }
}

/**
 * Rejects after `ms` without progress (`last()` = time of the last progress),
 * for waits that last as long as the provider streams.
 */
function idleTimeout(ms: number, what: string, last: () => number, stop: Promise<unknown>): Promise<never> {
  return new Promise((_, rej) => {
    const timer = setInterval(() => {
      if (Date.now() - last() > ms) {
        clearInterval(timer);
        rej(new ConfidentialTimeoutError(`timeout waiting for ${what} (no response data for ${Math.round(ms / 1000)} s)`));
      }
    }, 1000);
    stop.finally(() => clearInterval(timer)).catch(() => {});
  });
}

function timeout(ms: number, what: string): Promise<never> {
  return new Promise((_, rej) =>
    setTimeout(() => rej(new ConfidentialTimeoutError(`timeout waiting for ${what}`)), ms),
  );
}

let x25519Probe: Promise<void> | undefined;

/**
 * The TLS fork does X25519 through WebCrypto. Some runtimes (e.g. Bun < 1.4)
 * fail `deriveBits` for X25519, which otherwise surfaces as an opaque
 * handshake timeout 15 s later. Probe once and fail fast with a clear error.
 */
function assertX25519Support(): Promise<void> {
  x25519Probe ??= (async () => {
    try {
      const subtle = globalThis.crypto.subtle;
      const a = (await subtle.generateKey({ name: "X25519" } as never, false, [
        "deriveBits",
      ])) as CryptoKeyPair;
      const b = (await subtle.generateKey({ name: "X25519" } as never, false, [
        "deriveBits",
      ])) as CryptoKeyPair;
      await subtle.deriveBits({ name: "X25519", public: b.publicKey } as never, a.privateKey, 256);
    } catch (e) {
      throw new SessionProtocolError(
        `this runtime's WebCrypto lacks X25519 key agreement (${e instanceof Error ? e.message : e}); ` +
          "confidential sessions need Node >= 20 or Bun >= 1.4",
      );
    }
  })();
  return x25519Probe;
}

function cryptoRandom(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export class ConfidentialSession {
  readonly uuid = randomUUID();
  readonly baseUrl: string;
  readonly offer: VerifiedOffer;
  readonly model: string;
  readonly maxTokens: number;
  readonly bodyLength: number;
  readonly suffix: string;
  /** Protocol version, from the verified offer (1, or 2 = two-party handshake). */
  readonly protocol: 1 | 2;
  private readonly prover: CuProverBackend;
  private readonly twoPcPath?: string;
  private readonly twoPcFactory?: () => TwoPcSession;
  private twoPc?: TwoPcSession;
  private readonly useProofChannel: boolean;
  private readonly proofChannelFactory?: () => ProofChannel;
  private zkChan?: ProofChannel;
  private proofTimes: NonNullable<ConfidentialSessionTimings["proofs"]> = {};
  private ap?: TwoPcApplicationSecrets;
  private tKeyShare = 0;
  private tPhaseA = 0;
  private tPhaseB = 0;
  private readonly auth: string;
  private readonly expectedPubkey: string;
  private readonly timeouts: typeof DEFAULT_TIMEOUTS;
  private readonly runsDir?: string;
  private readonly onEvent?: (event: Record<string, unknown>) => void;
  private readonly insecure: boolean;
  private readonly allowUnsignedSettlement: boolean;
  private onResponseHead?: ConfidentialSessionOptions["onResponseHead"];
  private onResponseBody?: ConfidentialSessionOptions["onResponseBody"];
  private incremental = new IncrementalHttpResponse();
  private headEmitted = false;
  private completeSignaled = false;

  private ws?: WebSocket;
  private wsOpen = false;
  private wsReady: Promise<void>;
  private wsResolve!: () => void;
  private outbox: Uint8Array[] = [];
  private bus = new Bus();
  private errRej!: (e: Error) => void;
  private errP!: Promise<never>;
  private tls!: TlsHandle;
  private handshakeP!: Promise<void>;
  private handshakeDone!: () => void;
  private flushChain: Promise<void> = Promise.resolve();

  private responseChunks: Uint8Array[] = [];
  /** Server application-data record payloads, in arrival order (π_C3 check). */
  private serverRecords: Uint8Array[] = [];
  /** Encrypted server records seen after the handshake, and KeyUpdates among them. */
  private postHandshake = false;
  private serverPostRecords = 0;
  private serverKeyUpdates = 0;
  /** Post-handshake index of the first record of the current server key epoch. */
  private serverEpochStart = 0;
  private serverPending: Uint8Array = new Uint8Array(0);
  /** Our epoch-2 (body) records as written (π_C2 check). */
  private epoch2 = false;
  private bodyRecords: Uint8Array[] = [];
  private sessionValues?: SessionValues;
  private responseBytes: Uint8Array = new Uint8Array(0);
  private tlsEnded = false;
  private hs?: Uint8Array;
  private thSH?: Uint8Array;
  private thSF?: Uint8Array;
  private material?: Epoch1Material;
  sid = "";
  ready: any = null;

  private tStart = 0;
  private tReady = 0;
  private tHs = 0;
  private tKu0 = 0;
  private tC1Sent = 0;
  private tProofsReady = 0;
  private tRecordStart = 0;
  private tHeadWritten = 0;
  private tBodyWrite = 0;
  /** Last response record received (for the idle timeout while it streams). */
  private tLastData = 0;
  private ttft = 0;
  private prepared = false;
  private armed = false;
  /** v2: setup done and the joint key share is ready (no ClientHello sent yet). */
  private keyShareReady = false;
  private armStarted = false;
  private handshaken = false;
  /** Set just before release_head/ku1: from then on nothing may be retried. */
  private released = false;
  private failure?: Error;
  private tArmed = 0;
  private finished = false;
  private events: string[] = [];

  constructor(options: ConfidentialSessionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.offer = options.offer;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.bodyLength = options.bodyLength;
    this.suffix = options.suffix ?? canonicalSuffix(options.model, options.maxTokens);
    this.prover = options.prover;
    if (options.offer.v !== 1 && options.offer.v !== 2) {
      throw new SessionProtocolError(`unsupported protocol version v=${options.offer.v}`);
    }
    this.protocol = options.offer.v;
    this.twoPcPath = options.twoPcPath;
    this.twoPcFactory = options.twoPcFactory;
    this.useProofChannel = options.proofChannel !== false;
    this.proofChannelFactory = options.proofChannelFactory;
    this.auth = options.auth;
    this.expectedPubkey = options.expectedPubkey ?? options.offer.notary_pubkey;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.runsDir = options.runsDir;
    this.onEvent = options.onEvent;
    this.insecure = options.insecureNoProofs === true;
    this.allowUnsignedSettlement = options.allowUnsignedSettlement === true;
    this.onResponseHead = options.onResponseHead;
    this.onResponseBody = options.onResponseBody;
    this.tStart = Date.now();
    this.wsReady = new Promise<void>((r) => (this.wsResolve = r));
    this.errP = new Promise<never>((_, rej) => (this.errRej = rej));
    this.errP.catch((e: Error) => {
      this.failure ??= e;
    });
  }

  /**
   * False once the control socket closed or errored, the node sent an error,
   * or (v2) the 2PC process or its socket failed. A pooled armed session is
   * checked before it is claimed.
   */
  get healthy(): boolean {
    return !this.failure && !this.finished && !(this.twoPc?.failed ?? false);
  }

  /** The first failure seen by this session, if any. */
  get failureReason(): Error | undefined {
    return this.failure ?? this.twoPc?.failure;
  }

  /**
   * True once the session asked the node to write the credential record
   * (release_head / ku1): after that a failure must never be retried on
   * another session (the request may have reached the provider).
   */
  get bodyReleased(): boolean {
    return this.released;
  }

  /**
   * The abandon fee (msats) of the offer this session accepted at setup: what
   * the node charges if this session ends without being used.
   */
  get abandonFeeMsat(): number {
    return offerAbandonFeeMsat(this.offer);
  }

  /** v2: true while the session is armed (key share ready) and unclaimed. */
  get isArmed(): boolean {
    return this.keyShareReady && !this.handshaken;
  }

  /** Wall-clock time (ms) at which arm() completed, 0 before. */
  get armedAt(): number {
    return this.tArmed;
  }

  private event(ev: Record<string, unknown>): void {
    const line = JSON.stringify(ev);
    this.events.push(line);
    this.onEvent?.(ev);
  }

  private wsBase(): string {
    return this.baseUrl.replace(/^http/, "ws");
  }

  private controlUrl(): string {
    return `${this.wsBase()}/v1/confidential/ws?session_id=${this.uuid}&v=${this.protocol}`;
  }

  private zkUrl(proof: string): string {
    return `${this.wsBase()}/v1/confidential/zk?proof=${proof}&session_id=${this.sid}`;
  }

  /**
   * Attach streaming handlers after construction (an armed pool session is
   * created before the request that will claim it exists).
   */
  setResponseHandlers(
    onHead?: ConfidentialSessionOptions["onResponseHead"],
    onBody?: ConfidentialSessionOptions["onResponseBody"],
  ): void {
    this.onResponseHead = onHead;
    this.onResponseBody = onBody;
  }

  /** True once the whole upstream HTTP response has been decrypted. */
  get responseComplete(): boolean {
    return this.incremental.complete;
  }

  /** Open the control/relay websocket. Resolves when it is open. */
  async open(): Promise<void> {
    if (this.ws) return this.wsReady;
    const ws = new WebSocket(this.controlUrl());
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.wsOpen = true;
      for (const b of this.outbox) ws.send(b);
      this.outbox.length = 0;
      this.wsResolve();
    };
    ws.onerror = () => {
      this.errRej(new SessionRejectedError("control websocket error"));
    };
    ws.onclose = (ev: CloseEvent) => {
      const reason = (ev as CloseEvent & { reason?: string })?.reason;
      this.errRej(
        new SessionRejectedError(reason ? `connection closed: ${reason}` : "connection closed"),
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      const d = ev.data as ArrayBuffer | string;
      if (typeof d === "string") {
        let m: { type?: string; reason?: string };
        try {
          m = JSON.parse(d);
        } catch {
          this.errRej(new SessionProtocolError("non-JSON control frame"));
          return;
        }
        this.event({ ev: "frame", in: m.type });
        if (m.type === "error") {
          const e = m as { reason?: string; status?: number; detail?: unknown };
          this.errRej(
            new SessionRejectedError(`node rejected: ${e.reason ?? "unknown"}`, undefined, e.status, e.detail),
          );
        }
        this.bus.emit(m as { type: string });
        return;
      }
      const bytes = new Uint8Array(d);
      this.trackServerRecords(bytes);
      this.flushChain = this.flushChain
        .then(() => this.tls.handleReceivedBytes(bytes))
        .catch((e) => {
          this.errRej(
            e instanceof Error
              ? new ResponseVerificationError(`TLS record failed: ${e.message}`)
              : new ResponseVerificationError(String(e)),
          );
        });
    };

    // v1 runs its own X25519 handshake; v2 builds the TLS client once the
    // 2PC has produced the joint key share (armV2).
    if (this.protocol === 1) this.makeTls();
    return this.wsReady;
  }

  private makeTls(external?: {
    keyShare: Uint8Array;
    onServerHello(serverShare: Uint8Array, thSH: Uint8Array): Promise<{ clientHs: Uint8Array; serverHs: Uint8Array }>;
    onServerFinished(thSF: Uint8Array): Promise<{ serverAp0: Uint8Array; clientAp1: Uint8Array }>;
  }): void {
    this.tls = makeTLSClient({
      ...(external ? { external } : {}),
      host: this.offer.upstream_host,
      verifyServerCertificate: true,
      cipherSuites: ["TLS_AES_128_GCM_SHA256"],
      supportedProtocolVersions: ["TLS1_3"],
      namedCurves: external ? ["SECP256R1"] : ["X25519"],
      applicationLayerProtocols: ["http/1.1"],
      write: (packet: { header: Uint8Array; content: Uint8Array }) => {
        const record = concat(packet.header, packet.content);
        if (this.epoch2) this.bodyRecords.push(record);
        this.sendBytes(record);
      },
      // Server KeyUpdates (encrypted, so only we see them) move the response
      // to the next key epoch; π_C3S must derive that epoch's key and count
      // sequence numbers from its first record.
      onRead: (rec: { content: Uint8Array }, ctx?: { type?: string; contentType?: string }) => {
        if (!this.postHandshake || ctx?.type !== "ciphertext") return;
        const index = this.serverPostRecords++;
        if (ctx.contentType === "HANDSHAKE" && containsKeyUpdate(rec.content)) {
          this.serverKeyUpdates += 1;
          this.serverEpochStart = index + 1;
        }
      },
      onApplicationData: (rec: Uint8Array) => {
        this.tLastData = Date.now();
        if (!this.ttft) this.ttft = Date.now();
        this.responseChunks.push(rec);
        this.responseBytes = concat(this.responseBytes, rec);
        if (this.onResponseHead || this.onResponseBody) {
          try {
            const parts = this.incremental.push(rec);
            if (!this.headEmitted && this.incremental.head) {
              this.headEmitted = true;
              this.onResponseHead?.(this.incremental.head);
            }
            for (const p of parts) this.onResponseBody?.(p);
            // A terminal record may carry only the `0\r\n\r\n` terminator:
            // signal completion with an empty chunk so callers need not wait.
            if (parts.length === 0 && this.incremental.complete && !this.completeSignaled) {
              this.completeSignaled = true;
              this.onResponseBody?.(new Uint8Array(0));
            }
          } catch (e) {
            this.errRej(
              new ResponseVerificationError(`malformed upstream HTTP: ${e instanceof Error ? e.message : e}`),
            );
          }
        }
      },
      onTlsEnd: () => {
        this.tlsEnded = true;
      },
      onHandshake: () => {
        this.postHandshake = true;
        this.handshakeDone?.();
      },
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never) as unknown as TlsHandle;

  }

  private trackServerRecords(bytes: Uint8Array): void {
    let buf = concat(this.serverPending, bytes);
    while (buf.length >= 5) {
      const len = (buf[3]! << 8) | buf[4]!;
      if (buf.length < 5 + len) break;
      if (buf[0] === 0x17) this.serverRecords.push(buf.slice(5, 5 + len));
      buf = buf.subarray(5 + len);
    }
    this.serverPending = buf.slice();
  }

  private sendText(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }

  private sendBytes(b: Uint8Array): void {
    if (this.wsOpen && this.ws) this.ws.send(b);
    else this.outbox.push(b);
  }

  private waitT(type: string, ms: number): Promise<any> {
    return Promise.race([this.bus.wait(type), this.errP, timeout(ms, type)]);
  }

  /**
   * v1: setup → ready → TLS handshake → hs_verified → KU0.
   * v2: setup → ready → 2PC preprocessing + joint key share, and stop: the
   * ClientHello is only sent by claim() (the sidecar dials the provider when
   * it arrives), so an armed v2 session can wait for a request (pre-warm).
   */
  async arm(): Promise<void> {
    if (this.armStarted) throw new SessionProtocolError("arm() called twice");
    this.armStarted = true;
    if (this.protocol === 1) await assertX25519Support();
    await this.open();
    const nonceC = hex(cryptoRandom(32));
    const setup: Record<string, unknown> = {
      type: "setup",
      nonce_c: nonceC,
      model: this.model,
      max_tokens: this.maxTokens,
      len: this.bodyLength,
      armed: true,
    };
    // The node settles at the rates of exactly the offer we verified.
    if (this.offer.sig) setup.offer_sig = this.offer.sig;
    // Accept that offer's fees explicitly (the node refuses a setup that does
    // not, so a client unaware of fees is never charged one).
    const fee = offerSessionFeeMsat(this.offer);
    const abandonFee = offerAbandonFeeMsat(this.offer);
    if (fee > 0) setup.session_fee_msat = fee;
    if (abandonFee > 0) setup.abandon_fee_msat = abandonFee;
    setup.auth = this.auth;
    this.sendText(setup);

    this.ready = await this.waitT("ready", this.timeouts.ready);
    this.sid = this.ready.sid;
    this.tReady = Date.now();
    this.event({ ev: "ready", sid: this.sid, head_len: this.ready.head_len, v: this.ready.v ?? 1 });

    if (this.protocol === 2) return this.armV2();
    this.handshakeP = new Promise<void>((res) => (this.handshakeDone = res));
    await this.tls.startHandshake();
    await Promise.race([this.handshakeP, timeout(this.timeouts.handshake, "handshake")]);

    const hsKeys = this.tls.getHandshakeSecrets();
    if (!hsKeys) throw new SessionProtocolError("TLS fork did not expose handshake secrets");
    const msgs = this.tls.getHandshakeMessages();
    if (msgs.length < 2) throw new SessionProtocolError("TLS fork did not expose handshake messages");
    this.thSH = sha256(msgs[0]!, msgs[1]!);
    const finIdx = msgs.findIndex((m) => m[0] === 20);
    if (finIdx < 0) throw new SessionProtocolError("no server Finished in handshake messages");
    this.thSF = sha256(...msgs.slice(0, finIdx + 1));
    this.hs = new Uint8Array(hsKeys.masterSecret);
    this.sessionValues = {
      clientHs: new Uint8Array(hsKeys.clientSecret),
      serverHs: new Uint8Array(hsKeys.serverSecret),
      thSH: this.thSH,
      thSF: this.thSF,
    };

    // HS stays with the client: MS and every application secret derive from it.
    // Only the handshake traffic secrets are disclosed; the sidecar rejects HS.
    const hsFrame: Record<string, unknown> = {
      type: "hs_secrets",
      client_hs: hex(new Uint8Array(hsKeys.clientSecret)),
      server_hs: hex(new Uint8Array(hsKeys.serverSecret)),
    };
    if (this.insecure) hsFrame.hs = hex(this.hs);
    this.sendText(hsFrame);
    await this.waitT("hs_verified", this.timeouts.hsVerified);
    this.tHs = Date.now();
    this.event({ ev: "hs_verified" });

    // Epoch 0 → 1: the KeyUpdate is relayed to the upstream.
    await this.tls.updateTrafficKeys(false);
    this.tKu0 = Date.now();
    this.event({ ev: "ku0_sent" });
  }

  /**
   * v2 arm: the 2PC with the node (preprocessing, joint P-256 key share). The
   * TLS client is built with the 2PC hooks but the handshake does not start.
   */
  private async armV2(): Promise<void> {
    if (this.ready.v !== 2) {
      throw new SessionProtocolError(`node started a v${this.ready.v ?? 1} session for a v2 offer`);
    }
    const twoPc =
      this.twoPcFactory?.() ?? new TwoPcSession({ binaryPath: this.twoPcPath, proverPath: this.prover.path });
    this.twoPc = twoPc;
    twoPc.start(this.zkUrl("twopc"));
    if (this.useProofChannel) {
      // The proofs' OT/VOLE setup runs alongside the 2PC preprocessing; arm
      // does not wait for it (the first proof does).
      this.zkChan = this.proofChannelFactory?.() ?? new ProofChannel({ binaryPath: this.prover.path });
      this.zkChan.start(this.zkUrl("zkchan"));
    }
    const t0 = Date.now();
    const keyShare = await Promise.race([twoPc.keyShare(this.timeouts.twoPcKeyShare), this.errP]);
    this.tKeyShare = Date.now();
    this.event({ ev: "twopc_key_share", ms: this.tKeyShare - t0 });
    this.makeTls({
      keyShare,
      onServerHello: async (serverShare, thSH) => {
        this.thSH = thSH;
        const t = Date.now();
        const out = await twoPc.handshake(serverShare, thSH);
        this.tPhaseA = Date.now() - t;
        return out;
      },
      onServerFinished: async (thSF) => {
        this.thSF = thSF;
        const t = Date.now();
        this.ap = await twoPc.application(thSF);
        this.tPhaseB = Date.now() - t;
        return { serverAp0: this.ap.serverAp0, clientAp1: this.ap.clientAp1 };
      },
    });
    this.keyShareReady = true;
    this.tArmed = Date.now();
    this.event({ ev: "armed", ms: this.tArmed - this.tStart });
  }

  /**
   * v2 claim, step 1: the TLS handshake with no local ECDHE: the fork takes
   * c_hs/s_hs and then s_ap_0/c_ap_1 from the 2PC hooks. The node verifies
   * the handshake with c_hs/s_hs (its own 2PC output) and answers hs_verified.
   */
  private async handshakeV2(): Promise<void> {
    if (!this.keyShareReady) throw new SessionProtocolError("handshake before arm");
    if (this.failure) throw this.failure;
    const twoPcFailure = this.twoPc?.failure;
    if (twoPcFailure) throw twoPcFailure;
    this.handshaken = true;
    this.handshakeP = new Promise<void>((res) => (this.handshakeDone = res));
    await this.tls.startHandshake();
    await Promise.race([this.handshakeP, this.errP, timeout(this.timeouts.handshakeV2, "handshake")]);
    if (!this.ap) throw new SessionProtocolError("handshake finished without 2PC application secrets");
    await this.waitT("hs_verified", this.timeouts.hsVerified);
    this.tHs = Date.now();
    this.event({ ev: "hs_verified", twopc_phase_a_ms: this.tPhaseA, twopc_phase_b_ms: this.tPhaseB });
  }

  /** v2 phase 1: π_NK, the node's head record under K_0 is the published template. */
  private async prepareProofsV2(): Promise<void> {
    if (!this.handshaken) await this.handshakeV2();
    if (!this.ap) throw new SessionProtocolError("prepareProofs before arm");
    this.tC1Sent = Date.now();
    const commit = await this.waitT("c_commit", this.timeouts.cCommit);
    // The relayed anchors, when present, must be the ones our own 2PC output.
    for (const k of ["h1", "h2", "hk"] as const) {
      if (commit[k] !== undefined && commit[k] !== hex(this.ap[k])) {
        throw new SessionProtocolError(`c_commit: ${k} differs from our 2PC output`);
      }
    }
    // Rebuilt from the *signed* offer, our body length and our hk.
    checkPiNKParams(commit.params, { offer: this.offer, hk: this.ap.hk, bodyLen: this.bodyLength });
    await this.proofV2("pi_nk", "verify", commit.params);
    this.event({ ev: "pi_nk_ok" });
    this.tProofsReady = Date.now();
    this.prepared = true;
    this.armed = true;
  }

  /**
   * v2: one proof, on the pre-warmed proof channel when it is usable, else
   * on its own `/zk?proof=…` connection. The fallback is taken only while no
   * proof has started on the channel: after that a channel failure is a
   * failed proof (the node aborts the session), never retried elsewhere.
   */
  private async proofV2(
    proof: "pi_nk" | "pi_c2s" | "pi_c3s",
    cmd: "prove" | "verify",
    params: unknown,
    witness?: unknown,
  ): Promise<void> {
    const t = Date.now();
    const ch = this.zkChan;
    if (ch && (ch.used || (await ch.ready(this.timeouts.proofChannelReady)))) {
      const m = await ch.run(cmd, proof, params, witness, this.timeouts.proof);
      this.proofTimes[proof] = {
        via: "zkchan",
        ms: Date.now() - t,
        innerMs: m.ms,
        bytesSent: m.bytes_sent,
        bytesRecv: m.bytes_recv,
      };
      return;
    }
    if (ch) this.event({ ev: "proof_channel_fallback", proof, err: String(ch.failure?.message ?? "") });
    await this.prover.run(this.zkUrl(proof), {
      proof,
      role: cmd === "prove" ? "prover" : "verifier",
      params,
      witness,
    });
    this.proofTimes[proof] = { via: "per-proof", ms: Date.now() - t };
  }

  /** Phase 1, safe to run while arming: π_C1 advice + proof + π_N verification (v1), π_NK (v2). */
  async prepareProofs(): Promise<void> {
    if (this.prepared) return;
    if (this.protocol === 2) return this.prepareProofsV2();
    if (!this.hs || !this.thSH || !this.thSF) {
      throw new SessionProtocolError("prepareProofs before arm");
    }
    const mat = epoch1Material(this.hs, this.thSH, this.thSF, this.ready.head_len + 1);
    const cur = this.tls.getKeys();
    const cAp1 = new Uint8Array(cur!.clientSecret);
    if (hex(cAp1) !== hex(mat.cAp1)) {
      throw new SessionProtocolError(
        `fork/native key-schedule mismatch: ${hex(cAp1)} != ${hex(mat.cAp1)}`,
      );
    }
    this.material = mat;
    this.event({ ev: "advice_ok", s_len: mat.s.length });

    this.sendText({ type: "c1_material", s: hex(mat.s), h1: hex(mat.h1), t0: hex(mat.t0) });
    this.tC1Sent = Date.now();
    let commit: any;
    if (this.insecure) {
      commit = await this.waitT("c_commit", this.timeouts.cCommit);
      if (!commit.c_commit) throw new SessionProtocolError("insecure mode: no c_commit");
    } else {
      const ack = await this.waitT("zk_ack", this.timeouts.zkAck);
      if (ack.proof !== "pi_c1") throw new SessionProtocolError(`unexpected zk_ack for ${ack.proof}`);
      checkPiC1Params(ack.params, {
        session: this.sessionValues!,
        headLen: this.ready.head_len + 1,
        s: mat.s,
        h1: mat.h1,
        t0: mat.t0,
      });
      await this.prover.run(this.zkUrl("pi_c1"), {
        proof: "pi_c1",
        role: "prover",
        params: ack.params,
        witness: { Hs: Array.from(this.hs) },
      });
      this.event({ ev: "pi_c1_ok" });
      commit = await this.waitT("c_commit", this.timeouts.cCommit);
      // Rebuild the π_N statement from the *signed* offer, never from the
      // ready frame (that is the sidecar's unsigned offer relayed by the node).
      checkPiNParams(commit.params, { offer: this.offer }, mat.s, this.bodyLength);
      await this.prover.run(this.zkUrl("pi_n"), {
        proof: "pi_n",
        role: "verifier",
        params: commit.params,
      });
      this.event({ ev: "pi_n_ok" });
    }
    this.tProofsReady = Date.now();
    this.prepared = true;
    this.armed = true;
  }

  /** Phase 2, request-bound: KU1 + credential record, body, proofs, settle. */
  async finish(body: Uint8Array, tClaim = Date.now()): Promise<ConfidentialSessionResult> {
    if (!this.prepared) throw new SessionProtocolError("finish before prepareProofs");
    if (body.length !== this.bodyLength) {
      throw new SessionProtocolError(
        `body length ${body.length} != declared setup len ${this.bodyLength}`,
      );
    }
    if (this.ready.suffix !== undefined && this.ready.suffix !== this.suffix) {
      throw new SessionProtocolError("node expects a different pinned suffix than ours");
    }

    const v2 = this.protocol === 2;
    this.released = true;
    if (v2) {
      // The node writes epoch 0 (credential record + KeyUpdate under K_0); we
      // are already keyed for epoch 1 (c_ap_1, seq 0).
      this.tRecordStart = Date.now();
      this.sendText({ type: "release_head" });
    } else {
      // Epoch 1: the client's KeyUpdate is seq 1 (seq 0 is the node's record).
      this.tls.skipSendSequence(1);
      const ku1 = await this.tls.updateTrafficKeysSilently(false);
      this.tRecordStart = Date.now();
      this.sendText({ type: "ku1", record: hex(concat(ku1.header, ku1.content)) });
    }
    await this.waitT("head_written", this.timeouts.headWritten);
    this.tHeadWritten = Date.now();
    this.event({ ev: "head_written" });

    this.tBodyWrite = Date.now();
    this.epoch2 = true;
    // The pinned suffix goes in its own final record: the node holds that
    // record until π_C2 verifies (the upstream cannot start without it), and a
    // suffix split across two records could not be proven.
    const suffixBytes = new TextEncoder().encode(this.suffix);
    const tail = body.subarray(body.length - suffixBytes.length);
    if (!tail.every((b, i) => b === suffixBytes[i])) {
      throw new SessionProtocolError("request body does not end with the pinned suffix");
    }
    await this.tls.write(body.subarray(0, body.length - suffixBytes.length));
    await this.tls.write(suffixBytes);
    this.event({ ev: "body_sent", len: body.length });

    this.sendText({ type: "body_suffix", suffix: hex(new TextEncoder().encode(this.suffix)) });
    const c2params = await this.waitT("zk_params", this.timeouts.zkParams);
    const lastBody = this.bodyRecords[this.bodyRecords.length - 1] ?? new Uint8Array(0);
    if (v2) {
      checkPiC2SParams(c2params.params, {
        h1: this.ap!.h1,
        seq: this.bodyRecords.length - 1,
        record: lastBody,
        suffix: suffixBytes,
      });
    } else {
      checkPiC2Params(c2params.params, {
        session: this.sessionValues!,
        seq: this.bodyRecords.length - 1,
        record: lastBody,
        suffix: suffixBytes,
      });
    }
    const c2Name = v2 ? "pi_c2s" : "pi_c2";
    const c2Promise = (
      v2
        ? this.proofV2("pi_c2s", "prove", c2params.params, { Secret: Array.from(this.ap!.clientAp1) })
        : this.prover.run(this.zkUrl(c2Name), {
            proof: c2Name,
            role: "prover",
            params: c2params.params,
            witness: { Hs: Array.from(this.hs!) },
          })
    ).then(
        () => this.event({ ev: "pi_c2_ok" }),
        // Handle now (no unhandled rejection while we wait for attestation);
        // the failure is re-raised below before π_C3.
        (e: unknown) => this.event({ ev: "pi_c2_fail", err: String(e) }),
      );

    // The node attests after the provider closes the response, so this wait
    // lasts as long as the answer streams: time out only on silence.
    const attP = this.bus.wait("attestation");
    const attMsg = await Promise.race([
      attP,
      this.errP,
      idleTimeout(this.timeouts.attestation, "attestation", () => Math.max(this.tLastData, this.tBodyWrite), attP),
    ]);
    const att = attMsg as { a?: unknown; a_json?: string; sig?: string; sig_scheme?: string };
    if (this.expectedPubkey && this.ready.pubkey !== this.expectedPubkey) {
      throw new ReceiptVerificationError(
        `session pubkey ${this.ready.pubkey} differs from the signed offer key ${this.expectedPubkey}`,
      );
    }
    const attJson: string = att.a_json ?? JSON.stringify(att.a);
    const attOk = verifySchnorrSignature(attJson, att.sig, this.ready.pubkey);
    this.event({ ev: "attestation", sig_ok: attOk });
    if (!attOk) throw new ReceiptVerificationError("attestation signature invalid");
    checkAttestationBinding(attJson, { sid: this.sid, thSH: this.thSH, thSF: this.thSF });

    await this.settleFlush();
    // π_C2 must finish before π_C3: the node refuses to settle without it, and
    // π_C2 is off the response critical path.
    await c2Promise;
    if (this.events.some((l) => l.includes('"pi_c2_fail"'))) {
      throw new SessionProtocolError("π_C2 failed; the node will not settle without it");
    }

    // An upstream HTTP error (e.g. 503 overloaded) has no usage event. Disclose
    // only the response head (status line and headers): π_C3 proves where it
    // sits, its status decides the charge, and the error body stays private.
    const httpEarly = parseHttpResponse(this.responseBytes);
    const upstreamError = httpEarly.status >= 400;
    let r: Uint8Array | undefined;
    let skip = 0;
    if (upstreamError) {
      const headEnd = indexOfCrlfCrlf(this.responseBytes);
      if (headEnd < 0) throw new ResponseVerificationError("upstream error response has no head");
      r = this.responseBytes.slice(0, headEnd + 4);
      skip = this.responseBytes.length - r.length;
    } else {
      r = extractUsageDisclosure(this.responseBytes) ?? undefined;
    }
    if (!r) throw new ResponseVerificationError("could not extract a valid usage disclosure R");
    const tailLens = disclosureTailLens(
      this.responseChunks.map((c) => c.length),
      r.length + skip,
    );
    const disclose: Record<string, unknown> = { type: "disclose", r: hex(r), tail_lens: tailLens, skip };
    if (v2 && this.serverKeyUpdates > 0) {
      disclose.key_updates = this.serverKeyUpdates;
      disclose.epoch_start = this.serverEpochStart;
    }
    this.sendText(disclose);

    const c3 = await this.waitT("zk_params", this.timeouts.zkParams);
    if (v2) {
      // Wire index of sequence 0 of the covered records' epoch: the records
      // before the post-handshake ones are the encrypted server flight.
      const handshakeRecords = this.serverRecords.length - this.serverPostRecords;
      checkPiC3SParams(c3.params, {
        h2: this.ap!.h2,
        serverRecords: this.serverRecords,
        r,
        skip,
        keyUpdates: this.serverKeyUpdates,
        epochBase: handshakeRecords >= 0 ? handshakeRecords + this.serverEpochStart : undefined,
      });
    } else {
      checkPiC3Params(c3.params, {
        session: this.sessionValues!,
        serverRecords: this.serverRecords,
        r,
        skip,
      });
    }
    const c3Name = v2 ? "pi_c3s" : "pi_c3";
    if (v2) {
      await this.proofV2("pi_c3s", "prove", c3.params, { Secret: Array.from(this.ap!.serverAp0) });
    } else {
      await this.prover.run(this.zkUrl(c3Name), {
        proof: c3Name,
        role: "prover",
        params: c3.params,
        witness: { Hs: Array.from(this.hs!) },
      });
    }
    this.twoPc?.close();
    this.zkChan?.close();
    this.event({ ev: v2 ? "pi_c3s_ok" : "pi_c3_ok" });

    const terminal = await Promise.race([
      this.bus.wait("receipt").then((m) => ({ kind: "receipt" as const, m })),
      this.bus.wait("usage").then((m) => ({ kind: "usage" as const, m })),
      this.errP,
      timeout(this.timeouts.receipt, "receipt/usage"),
    ]);
    let receipt: ConfidentialReceipt;
    let receiptJson: string;
    let sigHex: string | undefined;
    if (terminal.kind === "receipt") {
      const m = terminal.m as { receipt: ConfidentialReceipt; receipt_json?: string; sig?: string };
      // The signed bytes are the receipt: every check below reads the parsed
      // signed payload, never the (unsigned) envelope beside it.
      receiptJson = m.receipt_json ?? JSON.stringify(m.receipt);
      sigHex = m.sig;
      receipt = parseSignedReceipt({
        receiptJson,
        sig: sigHex,
        pubkey: this.ready.pubkey,
        sid: this.sid,
        // The bytes whose signature and session binding were checked above.
        attestationJson: attJson,
      });
    } else {
      // Direct-sidecar node-settles deployment with no node to sign.
      if (!this.allowUnsignedSettlement) {
        throw new ReceiptVerificationError("unsigned settlement; a node-signed receipt is required");
      }
      const m = terminal.m as { model: string; usage: UpstreamUsageEvent };
      receipt = { sid: this.sid, model: m.model, usage: m.usage };
      receiptJson = JSON.stringify(receipt);
      sigHex = undefined;
    }
    const receiptSigOk = verifySchnorrSignature(receiptJson, sigHex, this.ready.pubkey);

    let usageMatch: boolean;
    if (upstreamError) {
      // The node saw the same error status; errors the provider answers before
      // doing any work (4xx, 503) must cost nothing.
      const ru = receipt.usage as unknown as { error_status?: number };
      usageMatch = ru?.error_status === httpEarly.status;
      // With a session fee, that fee (the node's 2PC work) is all it may charge.
      const unbilled = httpEarly.status === 503 || (httpEarly.status >= 400 && httpEarly.status < 500);
      const fee = offerSessionFeeMsat(this.offer);
      if (unbilled && !feeOnlyChargeOk(receipt.cost_msats, fee)) {
        throw new ReceiptVerificationError(
          `node charged ${receipt.cost_msats} msats for an unbilled upstream error (session fee ${fee} msats)`,
        );
      }
    } else {
      const ownUsage = usageEventFromDisclosure(r);
      if (!ownUsage) throw new ResponseVerificationError("could not parse our own usage event");
      const checked = verifyReceipt({
        receipt,
        receiptJson,
        sig: sigHex,
        pubkey: this.ready.pubkey,
        ownUsage,
        priceEntry: this.offer.price_list[this.model],
        sessionFeeMsat: offerSessionFeeMsat(this.offer),
        abandonFeeMsat: offerAbandonFeeMsat(this.offer),
      });
      usageMatch = checked.usageMatch;
      if (!checked.costWithinOffer) {
        throw new ReceiptVerificationError(
          `receipt cost ${receipt.cost_msats} msats exceeds the usage priced at the signed offer's rates` +
            ` plus its session fee (${offerSessionFeeMsat(this.offer)} msats)`,
        );
      }
    }
    if (!usageMatch) {
      throw new ReceiptVerificationError("receipt usage does not match our own plaintext");
    }

    const http = parseHttpResponse(this.responseBytes);
    const effectiveModel = effectiveModelFromText(http.bodyText);
    if (effectiveModel !== undefined && effectiveModel !== this.model) {
      throw new ResponseVerificationError(`effective model ${effectiveModel} != ${this.model}`);
    }

    this.finished = true;
    const tEnd = Date.now();
    const ttftAbs = this.ttft || tEnd;
    const timings: ConfidentialSessionTimings = {
      readyMs: this.tReady && this.tReady >= tClaim ? this.tReady - tClaim : undefined,
      handshakeMs: this.tHs ? this.tHs - this.tReady : undefined,
      ku0Ms: this.tKu0 ? this.tKu0 - this.tHs : undefined,
      piC1Ms: this.tC1Sent ? this.tProofsReady - this.tC1Sent : undefined,
      recordKu1Ms: this.tRecordStart ? this.tHeadWritten - this.tRecordStart : undefined,
      claimToBodyMs: this.tBodyWrite ? this.tBodyWrite - tClaim : undefined,
      upstreamTtftMs: this.tBodyWrite ? ttftAbs - this.tBodyWrite : undefined,
      armMs: this.tArmed ? this.tArmed - this.tStart : undefined,
      ...(v2
        ? {
            twoPcKeyShareMs: this.tKeyShare ? this.tKeyShare - this.tReady : undefined,
            twoPcPhaseAMs: this.tPhaseA || undefined,
            twoPcPhaseBMs: this.tPhaseB || undefined,
            twoPcSteps: this.twoPc?.timings.slice(),
            proofs: { ...this.proofTimes },
            proofChannelReadyMs: this.zkChan?.tReady ? this.zkChan.tReady - this.zkChan.tStart : undefined,
            proofChannelSteps: this.zkChan?.timings.slice(),
          }
        : {}),
      totalMs: tEnd - tClaim,
    };

    const result: ConfidentialSessionResult = {
      sid: this.sid,
      uuid: this.uuid,
      model: this.model,
      effectiveModel,
      http,
      responseText: http.bodyText,
      receipt,
      attestation: att.a,
      receiptSigOk,
      attestationSigOk: attOk,
      usageMatch,
      costMsats: receipt.cost_msats,
      ttftMs: ttftAbs - tClaim,
      totalMs: tEnd - tClaim,
      timings,
      proofs: v2 ? ["twopc", "pi_nk", "pi_c2s", "pi_c3s"] : ["pi_c1", "pi_n", "pi_c2", "pi_c3"],
      protocol: this.protocol,
    };
    this.persist(result);
    return result;
  }

  /** Cold path: open → arm → claim (proofs → finish). */
  async run(body: Uint8Array): Promise<ConfidentialSessionResult> {
    const tClaim = Date.now();
    await this.open();
    await this.arm();
    return this.claim(body, tClaim);
  }

  /**
   * Serve one request on this session. For an armed v2 session this runs
   * the handshake (2PC phases A and B), π_NK, the credential record, the
   * body and settlement; an unarmed session is armed first. `body` must be
   * exactly `bodyLength` bytes (see `padPinnedBody`).
   */
  async claim(body: Uint8Array, tClaim = Date.now()): Promise<ConfidentialSessionResult> {
    if (!this.armStarted) {
      await this.open();
      await this.arm();
    }
    await this.prepareProofs();
    return this.finish(body, tClaim);
  }

  /** Abort an armed-but-unclaimed session; the node releases its reservation. */
  discard(): void {
    this.close();
  }

  close(): void {
    this.twoPc?.close();
    this.zkChan?.close();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private async settleFlush(): Promise<void> {
    // Let every queued handleReceivedBytes finish so the last records (with
    // `data: [DONE]` and the terminal chunk) are decrypted.
    for (let i = 0; i < 200; i++) {
      const c = this.flushChain;
      await c;
      if (c === this.flushChain && this.tlsEnded) break;
      await new Promise((r2) => setTimeout(r2, 5));
    }
  }

  private persist(result: ConfidentialSessionResult): void {
    if (!this.runsDir) return;
    try {
      mkdirSync(this.runsDir, { recursive: true });
      const base = `${this.runsDir}/${this.sid || this.uuid}`;
      writeFileSync(`${base}.client.jsonl`, this.events.join("\n") + "\n", { mode: 0o600 });
      writeFileSync(`${base}.response.txt`, result.responseText, { mode: 0o600 });
      writeFileSync(`${base}.receipt.json`, JSON.stringify(result.receipt, null, 2), { mode: 0o600 });
    } catch {
      // Evidence writing must never break a session.
    }
  }
}

function indexOfCrlfCrlf(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

/** Whether a decrypted handshake record carries a KeyUpdate message (type 24). */
function containsKeyUpdate(content: Uint8Array): boolean {
  let i = 0;
  while (i + 4 <= content.length) {
    if (content[i] === 24) return true;
    i += 4 + ((content[i + 1]! << 16) | (content[i + 2]! << 8) | content[i + 3]!);
  }
  return false;
}
