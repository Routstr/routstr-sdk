/**
 * The confidential-upstream session driver (C side).
 *
 * C is the TLS 1.3 client of the upstream session through the node's WS relay
 * and holds the only copy of the application traffic secrets. It never sees the
 * credential record. The message flow (protocol v2, the two-party handshake,
 * docs/TWOPC-DESIGN.md; protocol v1 is retired):
 *
 *   setup → ready(v=2)
 *       → cu-2pc key share P = P_C + P_N → TLS handshake with the external key
 *       schedule (P-256; c_hs/s_hs, then s_ap_0/c_ap_1 from the 2PC; no local
 *       ECDHE, HS or MS) → hs_verified → c_commit → π_NK (we verify)
 *       → release_head (the node writes epoch 0: credential + KeyUpdate under
 *       K_0, which we never learn) → head_written → body in epoch 1
 *       → body_suffix → π_C2S → attestation → disclose → π_C3S → receipt
 *
 * Everything the reference client verifies is verified here: the π_NK statement
 * against the locally rebuilt one, the π_C2S/π_C3S parameters against our
 * own records (the node never makes us prove anything about other plaintext),
 * the canonical suffix equality, the response GCM tags (by the TLS fork
 * natively), the attestation and receipt Schnorr signatures, the receipt's
 * binding to this session and attestation, and its usage and cost against our
 * own plaintext and the signed offer's rates. Any failure rejects `finish()`.
 *
 * Fail-closed: every unexpected frame/state raises a typed ConfidentialError.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { verifySchnorrSignature } from "./canonical";
import { encryptedNodeTransport } from "./hosts";
import {
  ConfidentialTimeoutError,
  ReceiptVerificationError,
  ResponseVerificationError,
  SessionProtocolError,
  ProverMissingError,
  SessionRejectedError,
} from "./errors";
import { concat, hex, sha256 } from "./advice";
import {
  checkPiC2SParams,
  checkPiC3SParams,
  checkPiNKParams,
  serverTailEpoch,
  type ServerPostRecord,
} from "./params";
import { CuProverBackend, isExecutable } from "./prover";
import { resolveTwoPcPath, TwoPcSession, type TwoPcApplicationSecrets, type TwoPcTiming } from "./twopc";
import { ProofChannel } from "./zkchan";
import {
  checkAttestationBinding,
  checkUpstreamErrorReceipt,
  parseSignedReceipt,
  verifyFlatReceipt,
  verifyReceipt,
} from "./receipt";
import {
  canonicalSuffix,
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
import {
  offerAbandonFeeMsat,
  offerSessionFeeMsat,
  imageCountKey,
  imagesOfferProblem,
  offerSupportsImages,
  renderImageSuffix,
  type ConfidentialImageVariant,
  type VerifiedOffer,
} from "./offer";

setCryptoImplementation(webcryptoCrypto);

/** The fork-patched TLS client surface we use (the shipped .d.ts predates the patches). */
interface TlsHandle {
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
  /** c_commit wait + π_NK verification. */
  piNkMs?: number;
  /** release_head → head_written (the node writes the credential record). */
  headWriteMs?: number;
  claimToBodyMs?: number;
  upstreamTtftMs?: number;
  armMs?: number;
  /** Preprocessing + joint key share, phase A (handshake secrets), phase B (application secrets). */
  twoPcKeyShareMs?: number;
  twoPcPhaseAMs?: number;
  twoPcPhaseBMs?: number;
  /** Per-step 2PC timings and traffic as reported by cu-2pc. */
  twoPcSteps?: TwoPcTiming[];
  /** Per-proof wall time, path (`zkchan` or `per-proof`) and traffic. */
  proofs?: Record<string, { via: string; ms: number; innerMs?: number; bytesSent?: number; bytesRecv?: number }>;
  /** Proof channel open → both correlation chains preprocessed. */
  proofChannelReadyMs?: number;
  /** Proof channel setup steps (hello, preprocess) as reported by cu-prover. */
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
  /** Protocol version the session ran (always 2, the two-party handshake). */
  protocol: number;
  /**
   * An image session's response in the OpenAI shape
   * (`{created, data: [{b64_json}]}`), converted from the provider's shape;
   * absent for chat and for an upstream error.
   */
  image?: { created: number; data: { b64_json: string }[] };
  /**
   * Image sessions: what fell short in the accepted response (incomplete
   * body, fewer images than pinned, a provider echo naming other terms).
   * The charge was fixed at setup; these are reported, not thrown.
   */
  imageWarnings?: string[];
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
  /** The pinned completion cap (chat); unused for images. */
  maxTokens: number;
  /**
   * `images`: a flat-priced image generation session (no usage disclosure,
   * never armed ahead of a request). Default `chat`.
   */
  kind?: "chat" | "images";
  /** For `kind: "images"`: the offered variant id and the image count. */
  image?: { variant: string; count: number };
  /** Body length declared at setup (must equal the body passed to finish()). */
  bodyLength: number;
  /** Canonical suffix; defaults to canonicalSuffix(model, maxTokens). */
  suffix?: string;
  prover: CuProverBackend;
  /** Path to cu-2pc (default: CU_2PC_BIN/CU_2PC, then next to cu-prover, then PATH). */
  twoPcPath?: string;
  /** Injectable 2PC backend factory (tests). */
  twoPcFactory?: () => TwoPcSession;
  /**
   * Run π_NK/π_C2S/π_C3S over a pre-warmed proof channel (OT/VOLE set up
   * while arming). Default true; false forces the per-proof path.
   */
  proofChannel?: boolean;
  /** Injectable proof channel factory (tests). */
  proofChannelFactory?: () => ProofChannel;
  /** Node pubkey the ready frame must announce (defaults to offer.notary_pubkey). */
  expectedPubkey?: string;
  /** Timeouts (ms). */
  timeouts?: Partial<{
    ready: number;
    hsVerified: number;
    cCommit: number;
    headWritten: number;
    zkParams: number;
    attestation: number;
    receipt: number;
    twoPcKeyShare: number;
    /** The TLS handshake (both garbled-circuit phases). */
    handshakeV2: number;
    /** Wait for the proof channel's preprocessing before falling back. */
    proofChannelReady: number;
    /** One proof on the proof channel. */
    proof: number;
  }>;
  /**
   * Optional evidence directory (development only); writes
   * client.jsonl/response.txt/receipt.json. response.txt is the decrypted
   * response in plaintext.
   */
  runsDir?: string;
  /** Structured event sink (never logs secrets). */
  onEvent?: (event: Record<string, unknown>) => void;
  /**
   * @internal Accept an unsigned `usage` frame instead of a node-signed
   * receipt (a sidecar run without a node, for tests). Refused unless the
   * process sets `ROUTSTR_CONFIDENTIAL_INSECURE_TESTING=1`. Off: a receipt
   * must be signed.
   */
  allowUnsignedSettlement?: boolean;
  /**
   * Dev only: allow a plain-http node URL that is neither loopback nor an
   * onion service (the setup's credential then travels unencrypted).
   */
  allowInsecureTransport?: boolean;
  /**
   * Streaming hooks. The response is authenticated record by record by the
   * TLS stack (GCM tags under keys only we hold), so body bytes can be handed
   * out as they decrypt; π_C2S/π_C3S and settlement concern billing and finish
   * afterwards (their failure is reported by `finish()`/`run()`).
   */
  onResponseHead?: (head: { status: number; statusText: string; headers: Record<string, string> }) => void;
  onResponseBody?: (chunk: Uint8Array) => void;
}

const DEFAULT_TIMEOUTS = {
  ready: 30_000,
  hsVerified: 30_000,
  cCommit: 60_000,
  headWritten: 30_000,
  zkParams: 30_000,
  attestation: 60_000,
  receipt: 60_000,
  // Preprocessing (OT setup, garbled circuits) precedes the key share.
  twoPcKeyShare: 120_000,
  // The handshake includes both garbled-circuit phases.
  handshakeV2: 45_000,
  // The proof channel preprocesses alongside the 2PC (a few MB).
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
  readonly kind: "chat" | "images";
  /** The image session's terms from the signed offer (kind `images`). */
  private readonly imageTerms?: { variant: ConfidentialImageVariant; count: number };
  /** Protocol version, from the verified offer (2 = two-party handshake, the only one). */
  readonly protocol: 2;
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
  /** Each application-data record's length, for locating a disclosure's records. */
  private responseRecordLens: number[] = [];
  /** The response chunks joined (built once, when first needed). */
  private responseJoined?: Uint8Array;
  /**
   * Server application-data record payloads, in arrival order (π_C3S check):
   * only the last `KEPT_SERVER_RECORDS` (π_C3S covers at most 64 records at
   * the end), with `serverRecordsDropped` counting the ones let go.
   */
  private serverRecords: Uint8Array[] = [];
  private serverRecordsDropped = 0;
  /** Encrypted server records seen after the handshake (π_C3S key epoch). */
  private postHandshake = false;
  private serverPost: ServerPostRecord[] = [];
  private serverPending: Uint8Array = new Uint8Array(0);
  /** Every upstream byte and complete record received (checked against the attestation). */
  private readonly recvHash = createHash("sha256");
  private recvRecords = 0;
  /** The node's head-record commitment, from its c_commit frame. */
  private cCommitHex?: string;
  /** SHA-256 of the provider's certificate DERs as sent, concatenated. */
  private certChainHash?: Uint8Array;
  /** Our body records as written (π_C2S check). */
  private bodyEpoch = false;
  private bodyRecords: Uint8Array[] = [];
  private tlsEnded = false;
  private thSH?: Uint8Array;
  private thSF?: Uint8Array;
  sid = "";
  ready: any = null;

  private tStart = 0;
  private tReady = 0;
  private tHs = 0;
  private tCommitWait = 0;
  private tProofsReady = 0;
  private tRecordStart = 0;
  private tHeadWritten = 0;
  private tBodyWrite = 0;
  /** Last response record received (for the idle timeout while it streams). */
  private tLastData = 0;
  private ttft = 0;
  private prepared = false;
  private armed = false;
  /** Setup done and the joint key share is ready (no ClientHello sent yet). */
  private keyShareReady = false;
  private armStarted = false;
  private handshaken = false;
  /** Set just before release_head: from then on nothing may be retried. */
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
    this.kind = options.kind ?? "chat";
    if (this.kind === "images") {
      const images = options.offer.images;
      if (!offerSupportsImages(options.offer) || !images) {
        throw new SessionProtocolError("the signed offer serves no confidential image generation");
      }
      // Held to the same narrow shape as at verification (a caller may pass
      // an offer that did not go through verifyConfidentialOffer).
      const problem = imagesOfferProblem(images, options.offer.upstream_host);
      if (problem) throw new SessionProtocolError(`the signed offer's images block is refused: ${problem}`);
      const variant = images.price_list[options.model]?.find((v) => v.id === options.image?.variant);
      if (!variant) {
        throw new SessionProtocolError(`the signed offer has no variant ${options.image?.variant} for ${options.model}`);
      }
      const count = options.image?.count ?? 1;
      const maxCount = Math.min(images.max_count, variant.max_count ?? images.max_count);
      if (!Number.isSafeInteger(count) || count < 1 || count > maxCount) {
        throw new SessionProtocolError(`image count ${count} is outside 1..${maxCount}`);
      }
      this.imageTerms = { variant, count };
      this.suffix = renderImageSuffix(options.model, count, imageCountKey(images), images.fixed_pins, variant.pins);
      if (options.suffix !== undefined && options.suffix !== this.suffix) {
        throw new SessionProtocolError("image suffix differs from the one the signed offer defines");
      }
    } else {
      this.suffix = options.suffix ?? canonicalSuffix(options.model, options.maxTokens);
    }
    this.prover = options.prover;
    if (options.offer.v !== 2) {
      throw new SessionProtocolError(
        `unsupported protocol version v=${options.offer.v} (only v2 is supported; v1 is retired)`,
      );
    }
    this.protocol = 2;
    this.twoPcPath = options.twoPcPath;
    this.twoPcFactory = options.twoPcFactory;
    this.useProofChannel = options.proofChannel !== false;
    this.proofChannelFactory = options.proofChannelFactory;
    this.auth = options.auth;
    this.expectedPubkey = options.expectedPubkey ?? options.offer.notary_pubkey;
    // An image response is silent until the image is done: wait as long as
    // the offer says the provider may take.
    const idle =
      this.kind === "images" ? { attestation: Math.max(1, options.offer.images?.response_idle_s ?? 300) * 1000 } : {};
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...idle, ...(options.timeouts ?? {}) };
    this.runsDir = options.runsDir;
    this.onEvent = options.onEvent;
    if (!options.allowInsecureTransport && !encryptedNodeTransport(this.baseUrl)) {
      throw new SessionProtocolError(
        `refusing plain http to ${this.baseUrl}: the node credential would travel unencrypted`,
      );
    }
    if (options.allowUnsignedSettlement === true && !insecureTestingEnabled()) {
      throw new SessionProtocolError(
        "allowUnsignedSettlement is a test hook; set ROUTSTR_CONFIDENTIAL_INSECURE_TESTING=1 to use it",
      );
    }
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
   * or the 2PC process or its socket failed. A pooled armed session is
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
   * (release_head): after that a failure must never be retried on
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

  /** True while the session is armed (key share ready) and unclaimed. */
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

    // The TLS client is built once the 2PC has produced the joint key share (arm).
    return this.wsReady;
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
      applicationLayerProtocols: ["http/1.1"],
      write: (packet: { header: Uint8Array; content: Uint8Array }) => {
        const record = concat(packet.header, packet.content);
        if (this.bodyEpoch) this.bodyRecords.push(record);
        this.sendBytes(record);
      },
      // Server KeyUpdates (encrypted, so only we see them) move the response
      // to the next key epoch; π_C3S must derive that epoch's key and count
      // sequence numbers from its first record.
      onRead: (rec: { content: Uint8Array }, ctx?: { type?: string; contentType?: string }) => {
        if (!this.postHandshake || ctx?.type !== "ciphertext") return;
        this.serverPost.push({
          data: ctx.contentType === "APPLICATION_DATA",
          keyUpdates: ctx.contentType === "HANDSHAKE" ? countKeyUpdates(rec.content) : 0,
        });
      },
      onRecvCertificates: ({ certificates }: { certificates: { internal: { rawData: ArrayBuffer } }[] }) => {
        // Called after the fork validated the chain; recorded to check the
        // attestation's certificate hash.
        this.certChainHash = sha256(concat(...certificates.map((c) => new Uint8Array(c.internal.rawData))));
      },
      onApplicationData: (rec: Uint8Array) => {
        this.tLastData = Date.now();
        if (!this.ttft) this.ttft = Date.now();
        // A chunk list, joined once when the response is complete: appending
        // to one growing buffer copied the whole response per record.
        this.responseChunks.push(rec);
        this.responseRecordLens.push(rec.length);
        this.responseJoined = undefined;
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
    this.recvHash.update(bytes);
    let buf = concat(this.serverPending, bytes);
    while (buf.length >= 5) {
      const len = (buf[3]! << 8) | buf[4]!;
      if (buf.length < 5 + len) break;
      this.recvRecords += 1;
      if (buf[0] === 0x17) {
        this.serverRecords.push(buf.slice(5, 5 + len));
        if (this.serverRecords.length > 2 * KEPT_SERVER_RECORDS) {
          const drop = this.serverRecords.length - KEPT_SERVER_RECORDS;
          this.serverRecords.splice(0, drop);
          this.serverRecordsDropped += drop;
        }
      }
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
   * setup → ready → 2PC preprocessing + joint key share, and stop: the
   * ClientHello is only sent by claim() (the sidecar dials the provider when
   * it arrives), so an armed session can wait for a request (pre-warm).
   */
  async arm(): Promise<void> {
    if (this.armStarted) throw new SessionProtocolError("arm() called twice");
    this.armStarted = true;
    // Before setup: the node reserves funds (and may charge an abandon fee)
    // as soon as it accepts one, so a missing local binary must fail first.
    this.checkBinaries();
    await this.open();
    const nonceC = hex(cryptoRandom(32));
    const setup: Record<string, unknown> =
      this.kind === "images"
        ? {
            // Never armed: an image session runs only for a request at hand.
            type: "setup",
            kind: "images",
            nonce_c: nonceC,
            model: this.model,
            variant: this.imageTerms!.variant.id,
            count: this.imageTerms!.count,
            len: this.bodyLength,
          }
        : {
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
    // Everything the node signs is checked against this key; refuse a
    // session announced under another before anything reaches the provider.
    if (this.expectedPubkey && this.ready.pubkey !== this.expectedPubkey) {
      throw new SessionProtocolError(
        `session pubkey ${this.ready.pubkey} differs from the signed offer key ${this.expectedPubkey}`,
      );
    }
    this.sid = this.ready.sid;
    this.tReady = Date.now();
    this.event({ ev: "ready", sid: this.sid, head_len: this.ready.head_len, v: this.ready.v });
    return this.armTwoPc();
  }

  /** Refuse to start when cu-prover or cu-2pc cannot be run. */
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
   * The 2PC with the node (preprocessing, joint P-256 key share). The TLS
   * client is built with the 2PC hooks but the handshake does not start.
   */
  private async armTwoPc(): Promise<void> {
    if (this.ready.v !== 2) {
      throw new SessionProtocolError(`node started a v${this.ready.v ?? "?"} session for a v2 offer`);
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
   * Claim, step 1: the TLS handshake with no local ECDHE: the fork takes
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

  /**
   * Phase 1 (claim): the handshake, then π_NK: the node's head record under
   * K_0 is the published template.
   */
  async prepareProofs(): Promise<void> {
    if (this.prepared) return;
    if (!this.handshaken) await this.handshakeV2();
    if (!this.ap) throw new SessionProtocolError("prepareProofs before arm");
    this.tCommitWait = Date.now();
    const commit = await this.waitT("c_commit", this.timeouts.cCommit);
    // The relayed anchors, when present, must be the ones our own 2PC output.
    for (const k of ["h1", "h2", "hk"] as const) {
      if (commit[k] !== undefined && commit[k] !== hex(this.ap[k])) {
        throw new SessionProtocolError(`c_commit: ${k} differs from our 2PC output`);
      }
    }
    // Rebuilt from the *signed* offer, our body length and our hk.
    // An image request's head is the images template of the same signed offer.
    const headOffer =
      this.kind === "images" ? { ...this.offer, head_template: this.offer.images!.head_template } : this.offer;
    checkPiNKParams(commit.params, { offer: headOffer, hk: this.ap.hk, bodyLen: this.bodyLength, kind: this.kind });
    // The head-record commitment the attestation must name is the one π_NK
    // proves; the frame has to carry exactly it.
    const pinkCommit = hex(Uint8Array.from((commit.params as { PiNK: { c_commit: number[] } }).PiNK.c_commit));
    if (commit.c_commit !== pinkCommit) {
      throw new SessionProtocolError("c_commit: the frame's commitment is not the one π_NK proves");
    }
    this.cCommitHex = pinkCommit;
    await this.proofV2("pi_nk", "verify", commit.params);
    this.event({ ev: "pi_nk_ok" });
    this.tProofsReady = Date.now();
    this.prepared = true;
    this.armed = true;
  }

  /**
   * One proof, on the pre-warmed proof channel when it is usable, else
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

  /** Phase 2, request-bound: credential record, body, proofs, settle. */
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
    // An image suffix is the node's rendering of its own signed offer: the
    // relay must name it, so both sides are known to pin the same request.
    if (this.kind === "images" && this.ready.suffix === undefined) {
      throw new SessionProtocolError("the relay did not name the image suffix it pins");
    }

    this.released = true;
    // The node writes epoch 0 (credential record + KeyUpdate under K_0); we
    // are already keyed for epoch 1 (c_ap_1, seq 0).
    this.tRecordStart = Date.now();
    this.sendText({ type: "release_head" });
    await this.waitT("head_written", this.timeouts.headWritten);
    this.tHeadWritten = Date.now();
    this.event({ ev: "head_written" });

    this.tBodyWrite = Date.now();
    this.bodyEpoch = true;
    // The pinned suffix goes in its own final record: the node holds that
    // record until π_C2S verifies (the upstream cannot start without it), and a
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
    checkPiC2SParams(c2params.params, {
      h1: this.ap!.h1,
      seq: this.bodyRecords.length - 1,
      record: lastBody,
      suffix: suffixBytes,
    });
    const c2Promise = this.proofV2("pi_c2s", "prove", c2params.params, {
      Secret: Array.from(this.ap!.clientAp1),
    }).then(
        () => this.event({ ev: "pi_c2_ok" }),
        // Handle now (no unhandled rejection while we wait for attestation);
        // the failure is re-raised below before π_C3S.
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
    checkAttestationBinding(attJson, {
      sid: this.sid,
      thSH: this.thSH,
      thSF: this.thSF,
      cCommit: this.cCommitHex,
      certChainHash: this.certChainHash,
      serverRecords: this.recvRecords,
      recvSha256: new Uint8Array(this.recvHash.copy().digest()),
    });

    await this.settleFlush();
    // π_C2S must finish before π_C3S: the node refuses to settle without it,
    // and π_C2S is off the response critical path.
    await c2Promise;
    if (this.events.some((l) => l.includes('"pi_c2_fail"'))) {
      throw new SessionProtocolError("π_C2S failed; the node will not settle without it");
    }

    // An upstream HTTP error (e.g. 503 overloaded) has no usage event. Disclose
    // only the response head (status line and headers): π_C3S proves where it
    // sits, its status decides the charge, and the error body stays private.
    const responseBytes = this.responseBytes;
    const httpEarly = parseHttpResponse(responseBytes);
    const upstreamError = httpEarly.status >= 400;
    // An image request succeeded: its price was fixed at setup, so it needs no
    // disclosure and no proof; accepting settles it at that price. Only a 2xx
    // is a success: anything else that is not an error head to disclose (a
    // redirect, no parsable response) is never accepted.
    const outcome = this.kind === "images" ? imageOutcome(httpEarly.status) : undefined;
    if (outcome === "refuse") {
      throw new ResponseVerificationError(
        `image response has status ${httpEarly.status}: not accepted (only a 2xx is a success)`,
      );
    }
    const flat = outcome === "accept";
    let r: Uint8Array | undefined;
    if (flat) {
      this.sendText({ type: "accept" });
      this.twoPc?.close();
      this.zkChan?.close();
      this.event({ ev: "accept" });
    } else {
      r = await this.discloseAndProve(responseBytes, upstreamError);
    }

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
    if (flat) {
      const terms = this.imageTerms!;
      if (terminal.kind === "receipt") {
        verifyFlatReceipt(receipt, {
          model: this.model,
          variant: terms.variant.id,
          count: terms.count,
          msatPerImage: terms.variant.msat_per_image,
          sessionFeeMsat: offerSessionFeeMsat(this.offer),
          abandonFeeMsat: offerAbandonFeeMsat(this.offer),
        });
      } else if ((receipt.usage as unknown as { flat?: unknown } | undefined)?.flat !== true) {
        throw new ReceiptVerificationError("unsigned settlement is not flat");
      }
      usageMatch = true;
    } else if (upstreamError) {
      // The node saw the same error status; errors the provider answers before
      // doing any work (4xx, 503) cost at most the session fee (the node's 2PC
      // work), any other error at most the session's reservation.
      const terms = this.imageTerms;
      usageMatch = checkUpstreamErrorReceipt(receipt, httpEarly.status, offerSessionFeeMsat(this.offer), {
        abandonFeeMsat: offerAbandonFeeMsat(this.offer),
        image: terms
          ? { model: this.model, variant: terms.variant.id, count: terms.count, msatPerImage: terms.variant.msat_per_image }
          : undefined,
      });
    } else {
      const ownUsage = usageEventFromDisclosure(r!);
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

    const http = httpEarly;
    let image: ConfidentialSessionResult["image"];
    let imageWarnings: string[] | undefined;
    let effectiveModel: string | undefined;
    if (this.kind === "images") {
      // Accepted already (refusing would only cost the reservation): any
      // shortfall is reported, never thrown.
      if (flat) {
        const checked = checkImageResponse(http, this.offer.images!.response_shape, {
          model: this.model,
          count: this.imageTerms!.count,
          countKey: imageCountKey(this.offer.images!),
        });
        image = checked.image;
        imageWarnings = checked.warnings;
      }
    } else {
      effectiveModel = effectiveModelFromText(http.bodyText);
    }
    if (effectiveModel !== undefined && effectiveModel !== this.model) {
      throw new ResponseVerificationError(`effective model ${effectiveModel} != ${this.model}`);
    }

    this.finished = true;
    const tEnd = Date.now();
    const ttftAbs = this.ttft || tEnd;
    const timings: ConfidentialSessionTimings = {
      readyMs: this.tReady && this.tReady >= tClaim ? this.tReady - tClaim : undefined,
      handshakeMs: this.tHs ? this.tHs - this.tReady : undefined,
      piNkMs: this.tCommitWait ? this.tProofsReady - this.tCommitWait : undefined,
      headWriteMs: this.tRecordStart ? this.tHeadWritten - this.tRecordStart : undefined,
      claimToBodyMs: this.tBodyWrite ? this.tBodyWrite - tClaim : undefined,
      upstreamTtftMs: this.tBodyWrite ? ttftAbs - this.tBodyWrite : undefined,
      armMs: this.tArmed ? this.tArmed - this.tStart : undefined,
      twoPcKeyShareMs: this.tKeyShare ? this.tKeyShare - this.tReady : undefined,
      twoPcPhaseAMs: this.tPhaseA || undefined,
      twoPcPhaseBMs: this.tPhaseB || undefined,
      twoPcSteps: this.twoPc?.timings.slice(),
      proofs: { ...this.proofTimes },
      proofChannelReadyMs: this.zkChan?.tReady ? this.zkChan.tReady - this.zkChan.tStart : undefined,
      proofChannelSteps: this.zkChan?.timings.slice(),
      totalMs: tEnd - tClaim,
    };

    const result: ConfidentialSessionResult = {
      sid: this.sid,
      uuid: this.uuid,
      model: this.model,
      effectiveModel,
      http,
      responseText: image ? "" : http.bodyText,
      receipt,
      attestation: att.a,
      receiptSigOk,
      attestationSigOk: attOk,
      usageMatch,
      costMsats: receipt.cost_msats,
      ttftMs: ttftAbs - tClaim,
      totalMs: tEnd - tClaim,
      timings,
      proofs: flat ? ["twopc", "pi_nk", "pi_c2s"] : ["twopc", "pi_nk", "pi_c2s", "pi_c3s"],
      protocol: this.protocol,
      image,
      imageWarnings,
    };
    if (image) {
      // An image's text form is megabytes; build it only if someone reads it.
      let text: string | undefined;
      Object.defineProperty(result, "responseText", {
        enumerable: true,
        get: () => (text ??= JSON.stringify(image)),
      });
    }
    this.persist(result);
    return result;
  }

  /** The decrypted response, joined once from its records. */
  private get responseBytes(): Uint8Array {
    if (!this.responseJoined) {
      this.responseJoined = concat(...this.responseChunks);
      // The joined buffer replaces the records: a large response is held once.
      this.responseChunks = [this.responseJoined];
    }
    return this.responseJoined;
  }

  /**
   * Disclose R (the usage event, or for an upstream error only the response
   * head) and prove it with π_C3S over the final server records.
   */
  private async discloseAndProve(responseBytes: Uint8Array, upstreamError: boolean): Promise<Uint8Array> {
    let r: Uint8Array | undefined;
    let skip = 0;
    if (upstreamError) {
      const headEnd = indexOfCrlfCrlf(responseBytes);
      if (headEnd < 0) throw new ResponseVerificationError("upstream error response has no head");
      r = responseBytes.slice(0, headEnd + 4);
      skip = responseBytes.length - r.length;
    } else {
      r = extractUsageDisclosure(responseBytes) ?? undefined;
    }
    if (!r) throw new ResponseVerificationError("could not extract a valid usage disclosure R");
    const tailLens = disclosureTailLens(
      this.responseRecordLens,
      r.length + skip,
    );
    const epoch = serverTailEpoch(this.serverPost, tailLens.length);
    const disclose: Record<string, unknown> = {
      type: "disclose",
      r: hex(r),
      tail_lens: tailLens,
      skip,
      trailing: epoch.trailing,
    };
    if (epoch.keyUpdates > 0) {
      disclose.key_updates = epoch.keyUpdates;
      disclose.epoch_start = epoch.epochStart;
    }
    this.sendText(disclose);

    const c3 = await this.waitT("zk_params", this.timeouts.zkParams);
    // Wire index of sequence 0 of the covered records' epoch: the records
    // before the post-handshake ones are the encrypted server flight. Indices
    // are into the kept records, so the dropped ones are subtracted.
    const handshakeRecords = this.serverRecords.length + this.serverRecordsDropped - this.serverPost.length;
    checkPiC3SParams(c3.params, {
      h2: this.ap!.h2,
      serverRecords: this.serverRecords,
      r,
      skip,
      keyUpdates: epoch.keyUpdates,
      epochBase:
        handshakeRecords >= 0 ? handshakeRecords + epoch.epochStart - this.serverRecordsDropped : undefined,
      trailing: epoch.trailing,
      tailLens,
    });
    await this.proofV2("pi_c3s", "prove", c3.params, { Secret: Array.from(this.ap!.serverAp0) });
    this.twoPc?.close();
    this.zkChan?.close();
    this.event({ ev: "pi_c3s_ok" });
    return r;
  }

  /** Cold path: open → arm → claim (proofs → finish). */
  async run(body: Uint8Array): Promise<ConfidentialSessionResult> {
    const tClaim = Date.now();
    await this.open();
    await this.arm();
    return this.claim(body, tClaim);
  }

  /**
   * Serve one request on this session. For an armed session this runs
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

/**
 * What an image session does with the provider's status: accept a 2xx (the
 * flat price), disclose an error head (4xx/5xx), and refuse anything else
 * (a redirect, an unparsed status) without settling it as a success.
 */
export function imageOutcome(status: number): "accept" | "disclose" | "refuse" {
  if (status >= 200 && status < 300) return "accept";
  if (status >= 400) return "disclose";
  return "refuse";
}

/** The process opted into the insecure test hooks explicitly. */
function insecureTestingEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING === "1";
}

function indexOfCrlfCrlf(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

/** KeyUpdate messages (type 24) in a decrypted handshake record. */
function countKeyUpdates(content: Uint8Array): number {
  let n = 0;
  let i = 0;
  while (i + 4 <= content.length) {
    if (content[i] === 24) n++;
    i += 4 + ((content[i + 1]! << 16) | (content[i + 2]! << 8) | content[i + 3]!);
  }
  return n;
}

/**
 * Server application records kept for π_C3S: it covers at most 64 records at
 * the end of the response, plus the ones that may trail them.
 */
const KEPT_SERVER_RECORDS = 128;

/**
 * An accepted image response in the OpenAI shape, from the provider's own
 * shape, with every shortfall named: an incomplete body, fewer images than
 * pinned, or a provider echo (`request`) naming another model or count.
 * The charge was fixed at setup, so none of these throws.
 */
export function checkImageResponse(
  http: ParsedHttpResponse,
  shape: "venice" | "openai",
  want: { model: string; count: number; countKey: string },
): { image: { created: number; data: { b64_json: string }[] }; warnings: string[] } {
  const warnings: string[] = [];
  if (!http.complete) warnings.push("the image response body is incomplete");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(http.bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    else warnings.push("the image response is not a JSON object");
  } catch {
    warnings.push("the image response is not JSON");
  }
  const created = typeof body.created === "number" ? body.created : Math.floor(Date.now() / 1000);
  let data: { b64_json: string }[] = [];
  if (shape === "venice") {
    const images = Array.isArray(body.images) ? body.images : [];
    data = images.filter((i): i is string => typeof i === "string").map((b64_json) => ({ b64_json }));
  } else {
    const raw = Array.isArray(body.data) ? body.data : [];
    data = raw
      .filter((d): d is { b64_json: string } => !!d && typeof (d as { b64_json?: unknown }).b64_json === "string")
      .map((d) => ({ b64_json: d.b64_json }));
  }
  if (data.length !== want.count) warnings.push(`the provider returned ${data.length} of ${want.count} images`);
  const echo = body.request;
  if (echo && typeof echo === "object" && !Array.isArray(echo)) {
    const e = echo as Record<string, unknown>;
    if (e.model !== undefined && e.model !== want.model) {
      warnings.push(`the provider echoes model ${String(e.model)}, not ${want.model}`);
    }
    const n = e[want.countKey];
    if (n !== undefined && n !== want.count) warnings.push(`the provider echoes ${want.countKey}=${String(n)}, not ${want.count}`);
  }
  return { image: { created, data }, warnings };
}
