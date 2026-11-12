/**
 * A confidential connection (PROTOCOL-V3.md), client side.
 *
 * One object for both framings. `setup` → the two-party preprocessing and the
 * joint key share (ARMED: the node holds the connection deposit, no provider
 * connection exists) → the handshake, π_NK over the connection head the node
 * writes in epoch 0, `head_written` (READY) → requests `(sid, n)`.
 *
 * - Framing `"2"` (HTTP/2): the head names no request (the node's SETTINGS
 *   and one probe that puts the credential into the HPACK table); requests
 *   follow one at a time, naming the credential by index. One HTTP/2 frame per
 *   TLS record, π_WIN over the records, `release` as the provider's windows
 *   open, the response, then the usage disclosure (π_C3S), `accept` (images)
 *   or the error head (π_WIN under `s_ap_0`).
 * - Framing `"1.1"`: the head is the request head of request 1, so `request`
 *   1 goes before the ClientHello; the body follows under `c_ap_1` with the
 *   canonical suffix alone in the final record, which the node holds until
 *   π_WIN (one window, the whole record) verifies. The provider closes after
 *   its response, the node attests, and the client discloses the usage event
 *   or the error head (π_C3S), or accepts an image response.
 *
 * Ported from the reference client (`crypto/client/src/driver*.ts`). What it
 * verifies is verified here: the π_NK statement against the head rebuilt from
 * the signed offer, every π_WIN window against our own records (the node
 * chooses the windows; without this check the equality bit would be an oracle
 * on private plaintext), the π_C3S parameters, the attestation, and the
 * receipt's signature, binding (`sid`, `http`, `n`), usage, cost and deposit.
 *
 * A connection is a cache, never a promise: it can die at any time (idle
 * limit, GOAWAY, the node, the network). `bodyReleased` of a request says
 * whether anything of it can have reached the provider; before that a caller
 * may run the request again on another connection. A refused request
 * (`request_refused`) leaves the connection as it was.
 */

import { createHash, randomUUID } from "node:crypto";
import { concat, hex } from "./advice";
import { padBody, type PadBucket } from "./suffix";
import { verifySchnorrSignature } from "./canonical";
import {
  ConfidentialError,
  ConfidentialTimeoutError,
  ConnectionDepositError,
  ReceiptVerificationError,
  RequestRefusedError,
  ResponseVerificationError,
  SessionProtocolError,
  SessionRejectedError,
  TwoPcVersionMismatchError,
  UpgradeRequiredError,
} from "./errors";
import {
  FLAG,
  FRAME,
  FrameReader,
  MAX_DATA_IN_RECORD,
  chatPath,
  checkH2Offer,
  checkPiNKParamsH2,
  checkPiWinFinalRecord,
  checkPiWinParams,
  decodeBlock,
  errorHeadPrefixProblem,
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
import {
  CONFIDENTIAL_VERSION,
  imageCountKey,
  imagesOfferProblem,
  offerAbandonFeeMsat,
  offerConnectionDepositMsat,
  offerFramings,
  offerIdleTimeoutS,
  offerSessionFeeMsat,
  offerSupportsImages,
  renderImageSuffix,
  type ConfidentialFraming,
  type ConfidentialH2Offer,
  type ConfidentialImageVariant,
  type VerifiedOffer,
} from "./offer";
import { checkPiC3SParams, checkPiNKParams, serverTailEpoch, type ServerPostRecord } from "./params";
import { CuProverBackend } from "./prover";
import { checkUpstreamErrorReceipt, parseSignedReceipt, verifyFlatReceipt, verifyReceipt } from "./receipt";
import {
  countKeyUpdates,
  cryptoRandom,
  KEPT_SERVER_RECORDS,
  MAX_PENDING_TLS_BYTES,
  SID_RE,
  type ConfidentialReceipt,
  type TlsHandle,
} from "./wire";
import {
  canonicalSuffix,
  disclosureTailLens,
  effectiveModelFromText,
  extractUsageDisclosure,
  IncrementalHttpResponse,
  usageEventFromDisclosure,
  validateChatSuffix,
  type UpstreamUsageEvent,
} from "./suffix";
import { makeTLSClient } from "./tls-fork/lib/index.js";
import { requireHelperBinaries, TwoPcSession, type TwoPcApplicationSecrets } from "./twopc";
import { ProofChannel } from "./zkchan";

const TIMEOUTS = {
  ready: 30_000,
  /** The sidecar allows 180 s of preprocessing. */
  twoPcKeyShare: 175_000,
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
  /** The connection's `closed` frame after its last settlement (framing "1.1"; it carries nothing we need). */
  closed: 2_000,
  /**
   * Framing "2", before the first request: how long after `head_written` to
   * wait for the provider's answer to the node's probe (stream 1), so that
   * its frames lie before the first request's interval (§5.4 suggests up to
   * 2 s). The probe is reset in the same record that carries it, and the
   * provider this was measured with (Venice, 2026-11) never answers it, so
   * the default only covers a provider that answers at once; the time since
   * `head_written` (the wait for SETTINGS) counts towards it.
   */
  probe: 300,
};

/** Control frames of one kind the node may send ahead of the wait for them. */
const INBOX_MAX_PER_KEY = 16;
const INBOX_MAX = 256;
/** Response DATA bytes after which a connection is retired (its receive window is 2^31-1). */
const MAX_CONNECTION_DATA = 1 << 30;

export interface ConfidentialConnectionOptions {
  /** Node HTTP(S) base. */
  baseUrl: string;
  /** A verified offer that lists `framing` in `http`. */
  offer: VerifiedOffer;
  /** The framing towards the provider (default: the offer's first). */
  framing?: ConfidentialFraming;
  /** The client's bearer for this node: the setup's credential (the deposit); each request names its own. */
  auth: string;
  prover: CuProverBackend;
  twoPcPath?: string;
  /** Injectable 2PC backend and proof channel (tests). */
  twoPcFactory?: () => TwoPcSession;
  proofChannelFactory?: () => ProofChannel;
  /** Node pubkey the ready frame must announce (default: the offer's). */
  expectedPubkey?: string;
  timeouts?: Partial<typeof TIMEOUTS>;
  /** Largest DATA payload per record (default: the largest that fits one record). */
  chunk?: number;
  /** Dev only: a plain-http node that is neither loopback nor an onion service. */
  allowInsecureTransport?: boolean;
  /**
   * The largest connection deposit (msat) accepted from the offer
   * (`connection_deposit_msat`); a larger one is refused before anything
   * is sent. Default `DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT`.
   */
  maxDepositMsat?: number;
  /** Structured event sink (never receives secrets). */
  onEvent?: (event: Record<string, unknown>) => void;
}

/** The largest connection deposit a client accepts unless told otherwise (100 sat). */
export const DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT = 100_000;

/** What became of a connection's deposit, as the node reported it. */
export interface DepositOutcome {
  msat: number;
  outcome: "released" | "charged";
  /** `request_settled`, or why a connection without a settled request kept or lost it. */
  reason: string;
  /** True when the report carried the node's signature (a receipt, or a signed last frame). */
  signed: boolean;
}

export interface ConnectionRequestOptions {
  /**
   * The verified offer this request is priced by (default: the one the
   * connection was opened on). The node remembers a signed offer for a
   * limited time and re-signs it when its rates move, so a request on a kept
   * connection names the offer the caller verified last. Its connection-level
   * terms must be the connection's (`connectionTerms`).
   */
  offer?: VerifiedOffer;
  /** The credential the request is reserved and settled on (default: the connection's). */
  auth?: string;
  model: string;
  /** The pinned completion cap of a chat request (unused for an image request). */
  maxTokens: number;
  /**
   * An image request (PROTOCOL-V3.md §3.5, §12.4): the offered variant id and
   * the image count. The body then ends with the image suffix of the signed
   * offer, a 2xx is settled by `accept` at the signed price per image, and
   * the result's body is the provider's JSON as received.
   */
  image?: { variant: string; count: number };
  /** The whole JSON body; it must end with the canonical suffix. */
  body: Uint8Array;
  /**
   * Optional body-size bucket (`paddedBodyLength`; off when absent): the body
   * is padded with JSON whitespace before the suffix to the bucket.
   */
  padBucket?: PadBucket;
  onResponseHead?: (head: { status: number; statusText: string; headers: Record<string, string> }) => void;
  onResponseBody?: (chunk: Uint8Array) => void;
}

/** Bytes between this client and the node, by channel. */
export interface ConnectionBytes {
  relaySent: number;
  relayRecv: number;
  controlSent: number;
  controlRecv: number;
  twoPcSent: number;
  twoPcRecv: number;
  zkSent: number;
  zkRecv: number;
}

export interface ConnectionRequestResult {
  sid: string;
  http: ConfidentialFraming;
  /** The request's number on its connection (1, 2, …) and, in framing "2", its stream. */
  n: number;
  stream?: number;
  model: string;
  effectiveModel?: string;
  status: number;
  headers: Record<string, string>;
  /** The decrypted response body (empty for an accepted image response: see `bodyChunks`). */
  body: Uint8Array;
  /**
   * An accepted image response: its body in the pieces it arrived in, held
   * once. The caller takes them out as it decodes them (megabytes).
   */
  bodyChunks?: Uint8Array[];
  receipt: ConfidentialReceipt;
  attestation: unknown;
  costMsats?: number;
  warnings?: string[];
  /** Milliseconds from the start of the request on this connection (`startedAt`, wall clock). */
  timings: { startedAt: number; releasedMs?: number; ttftMs?: number; totalMs: number; proofs: ProofTiming[] };
  /** Bytes between client and node spent on this request (the connection's setup is not included). */
  bytes: ConnectionBytes;
}

export interface ProofTiming {
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
export interface ConnectionRequestHandle {
  /** The request's number on the connection (the last accepted request + 1). */
  readonly n: number;
  readonly sid: string;
  /** True once the request may have reached the provider: never run it again elsewhere. */
  readonly bodyReleased: boolean;
  /** True once the `request` frame (with the credential) went out. */
  readonly credentialSent: boolean;
  readonly done: Promise<ConnectionRequestResult>;
  /** Abort an unfinished request (this ends the connection); a no-op once it settled or was refused. */
  close(): void;
}

/**
 * The connection-level fields of a signed offer (§12.1): a request that names
 * an offer in which one of them differs from the offer of the `setup` is
 * refused by the node with `offer_changed`. Rates and fees may differ. The
 * client adds what it holds the node's frames to (its key, the key's shape).
 */
export function connectionTerms(offer: VerifiedOffer): string {
  const images = offer.images
    ? Object.fromEntries(Object.entries(offer.images).filter(([k]) => k !== "price_list"))
    : null;
  return JSON.stringify([
    offer.v,
    offer.twopc ?? null,
    offer.upstream_host,
    offer.notary_pubkey,
    offer.key_length,
    offer.key_alphabet ?? null,
    offer.head_template,
    offer.chat,
    offer.h2 ?? null,
    offerConnectionDepositMsat(offer),
    offer.idle_timeout_s ?? null,
    images,
  ]);
}

/** Where a connection is in its life (§3). */
export type ConnectionPhase = "new" | "opening" | "armed" | "connecting" | "ready" | "closed";

/** One record this client sent after the handshake. */
interface OutRec {
  wire: Uint8Array;
  plain: Uint8Array;
  pub: [number, number][];
}

/** The request in flight. */
interface Cur {
  n: number;
  /** Framing "2": the request's stream (0 in framing "1.1"). */
  stream: number;
  /** The credential the request is reserved on. */
  auth: string;
  /** True for the connection's first settlement: the session fee is due and the deposit comes back. */
  first: boolean;
  model: string;
  opts: ConnectionRequestOptions;
  /** The offer the request is priced by. */
  offer: VerifiedOffer;
  /** An image request's terms from that offer. */
  image?: { variant: ConfidentialImageVariant; count: number };
  tStart: number;
  /** When the connection was ready for the request (after a claim's handshake). */
  tOpened?: number;
  /** An accepted image response: running hashes of its records, one per candidate interval start. */
  roll?: { from: number; next: number; h: ReturnType<typeof createHash> }[];
  /** Server application-data records decrypted when the request was sent. */
  recvAtSend: number;
  /** Stream offset of the first frame on the request's stream, and the server record that holds it. */
  firstFrameOff?: number;
  firstFrameAbs?: number;
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
  proofs: ProofTiming[];
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

export class ConfidentialConnection {
  readonly uuid = randomUUID();
  readonly baseUrl: string;
  readonly offer: VerifiedOffer;
  readonly framing: ConfidentialFraming;
  /** The offer's checked `h2` block (framing "2"). */
  readonly h2?: ConfidentialH2Offer;
  /** Requests this connection may carry (framing "1.1": one). */
  readonly maxRequests: number;
  /** How long the node keeps the connection with no request in flight (ms). */
  readonly nodeIdleMs: number;
  /** The connection-level terms of the offer it was opened on (`connectionTerms`). */
  readonly terms: string;
  sid = "";
  /**
   * When the connection was created, armed (key share done), opened (framing
   * "2": `head_written` + SETTINGS; "1.1": armed) and last settled a request.
   */
  readonly tCreated = Date.now();
  tArmed = 0;
  tOpen = 0;
  tLastSettled = 0;
  /** Requests the node accepted on this connection (`request_ok`): the next one is `requests + 1`. */
  requests = 0;
  /** Requests settled on this connection. */
  settled = 0;
  /** True when the setup asked for an armed connection (pre-warm). */
  prewarmed = false;
  /** Bytes spent to arm the connection (2PC preprocessing, key share, proof channel setup). */
  armBytes?: ConnectionBytes;
  /** Framing "2": bytes spent to open the connection (arming, handshake relay, π_NK). */
  setupBytes?: ConnectionBytes;
  /** Phase times of the connection's setup (ms). */
  setupTimings: Record<string, number> = {};
  /**
   * The connection deposit: the amount the setup reserves (the offer's), and
   * its outcome once the node reported one (released by the first request's
   * receipt, or released/charged in the connection's last frame).
   */
  readonly depositMsat: number;
  deposit?: DepositOutcome;

  private readonly auth: string;
  private readonly prover: CuProverBackend;
  private readonly twoPcPath?: string;
  private readonly twoPcFactory?: () => TwoPcSession;
  private readonly proofChannelFactory?: () => ProofChannel;
  private readonly expectedPubkey: string;
  private readonly timeouts: typeof TIMEOUTS;
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
  private phaseNow: ConnectionPhase = "new";
  private armP?: Promise<void>;
  private connectP?: Promise<void>;
  private keyShare?: Uint8Array;
  private tSetup = 0;
  private tReady = 0;

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
  /** When the last upstream bytes arrived (a response that streams resets the silence timers). */
  private tLastWire = 0;

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

  // --- framing "1.1" ----------------------------------------------------------
  /** True while the request body is written: those records are the body records. */
  private bodyEpoch = false;
  private bodyRecords: Uint8Array[] = [];
  /** Every upstream byte and record received (the attestation hashes and counts them). */
  private readonly recvHash = createHash("sha256");
  private recvRecords = 0;
  /** Type-23 records let go (only the last ones are needed for π_C3S). */
  private serverRecordsDropped = 0;
  private incremental = new IncrementalHttpResponse();
  private headEmitted = false;
  /** The decrypted response as it arrived (not kept for an accepted image response), and each record's length. */
  private rawChunks: Uint8Array[] = [];
  private rawLens: number[] = [];
  private rawTotal = 0;
  private tlsEnded = false;

  // --- HTTP/2 state -----------------------------------------------------------
  /** `SETTINGS_HEADER_TABLE_SIZE` of the provider's SETTINGS so far (null: never sent). */
  private tableSize: number | null = null;
  private settingsSeenSent = false;
  /** The provider answered the node's probe (a frame on stream 1). */
  private probeAnswered = false;
  private tHeadWritten = 0;
  private gotSettings = false;
  private initialWindow = 65535;
  private connCredit = 65535;
  private unackedSettings = 0;
  private requestOpen = false;
  private goaway = false;
  private cur?: Cur;
  private kicks: (() => void)[] = [];

  private bytes = { relaySent: 0, relayRecv: 0, controlSent: 0, controlRecv: 0 };

  constructor(options: ConfidentialConnectionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.offer = options.offer;
    if (options.offer.v !== CONFIDENTIAL_VERSION) {
      throw new SessionProtocolError(`unsupported protocol version v=${options.offer.v}`);
    }
    const offered = offerFramings(options.offer);
    this.framing = options.framing ?? offered[0] ?? "1.1";
    if (!offered.includes(this.framing)) {
      throw new SessionProtocolError(`the signed offer does not serve framing "${this.framing}"`);
    }
    if (this.framing === "2") {
      if (!options.offer.h2) throw new SessionProtocolError('the signed offer has no h2 block for framing "2"');
      // Held to the same limits as at verification (a caller may pass an offer
      // that did not go through verifyConfidentialOffer); the probe's API base
      // was checked there against the caller's trusted hosts.
      const probe = options.offer.h2.probe_path;
      this.h2 = checkH2Offer(options.offer, [probe.slice(0, Math.max(0, probe.length - "/models".length))]);
    }
    this.maxRequests = this.h2 ? this.h2.max_requests : 1;
    this.nodeIdleMs = offerIdleTimeoutS(options.offer) * 1000;
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
    this.depositMsat = offerConnectionDepositMsat(options.offer);
    const maxDeposit = options.maxDepositMsat ?? DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT;
    if (this.depositMsat > maxDeposit) {
      throw new ConnectionDepositError(
        `the node's connection deposit of ${this.depositMsat} msat exceeds the client's maximum of ${maxDeposit} msat`,
        this.depositMsat,
      );
    }
    this.terms = connectionTerms(options.offer);
    this.auth = options.auth;
    this.prover = options.prover;
    this.twoPcPath = options.twoPcPath;
    this.twoPcFactory = options.twoPcFactory;
    this.proofChannelFactory = options.proofChannelFactory;
    this.expectedPubkey = options.expectedPubkey ?? options.offer.notary_pubkey;
    this.timeouts = { ...TIMEOUTS, ...(options.timeouts ?? {}) };
    this.chunk = Math.max(1, Math.min(options.chunk ?? MAX_DATA_IN_RECORD, MAX_DATA_IN_RECORD));
    this.onEvent = options.onEvent;
    this.errP = new Promise<never>((_, rej) => (this.errRej = rej));
    this.errP.catch(() => {});
  }

  // --- state ------------------------------------------------------------------

  /** Where the connection is in its life. */
  get phase(): ConnectionPhase {
    return this.failure ? "closed" : this.phaseNow;
  }

  /** Able to take a request now: armed or open, healthy, none in flight. */
  get idle(): boolean {
    return this.usable && !this.cur;
  }

  /** Armed (the key share is done, no provider connection yet) and healthy. */
  get armed(): boolean {
    return this.phase === "armed" && this.usable;
  }

  /** Armed or open, healthy, with requests left. */
  get usable(): boolean {
    return (
      (this.phaseNow === "armed" || this.phaseNow === "ready") &&
      !this.failure &&
      !this.goaway &&
      this.requests < this.maxRequests &&
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
  byteCounts(): ConnectionBytes {
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
    this.phaseNow = "closed";
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

  /**
   * Close the connection. The node releases what an unfinished request
   * reserved by its abort rules (§12.10); a connection that never settled a
   * request loses its deposit.
   */
  close(reason = "closed by the client"): void {
    this.fail(new SessionRejectedError(`connection closed: ${reason}`));
  }

  // --- wire ---------------------------------------------------------------------

  private wsBase(): string {
    return this.baseUrl.replace(/^http/, "ws");
  }

  private zkUrl(proof: string): string {
    const token = typeof this.ready?.zk_token === "string" ? `&zk_token=${encodeURIComponent(this.ready.zk_token)}` : "";
    const sid = encodeURIComponent(this.sid);
    return `${this.wsBase()}/v1/confidential/zk?proof=${encodeURIComponent(proof)}&sid=${sid}&session_id=${sid}${token}`;
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
    const ws = new WebSocket(`${this.wsBase()}/v1/confidential/ws?session_id=${this.uuid}&v=${CONFIDENTIAL_VERSION}`);
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
      this.tLastWire = Date.now();
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
        this.fail(this.nodeError(m));
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
      case "upstream_closed_early":
        // The provider closed before the request was fully written; the `error` follows.
        this.event({ ev: "upstream_closed_early", n: m.n, response_bytes: m.response_bytes });
        return;
      case "zk_params": {
        const key = `zk_params:${String(m.proof)}:${String(m.purpose ?? "")}`;
        // Our own records: proven as the node asks, in order, whenever it asks.
        if (key === "zk_params:pi_win:records" && this.framing === "2") {
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

  /** The node's `error` frame as a typed error (§12.9: `status`, `code`, `fault`). */
  private nodeError(m: any): Error {
    const reason = typeof m.reason === "string" ? m.reason : JSON.stringify(m.reason ?? "unknown");
    const code = typeof m.code === "string" ? m.code.slice(0, 64) : undefined;
    const type = (m.detail as { error?: { type?: unknown } } | undefined)?.error?.type;
    if (m.status === 426 || code === "upgrade_required" || reason === "upgrade_required") {
      return new UpgradeRequiredError(
        `upgrade_required: the node speaks a newer routstr-confidential protocol` +
          `${Number.isSafeInteger(m.min_v) ? ` (v${m.min_v} or later)` : ""} than this client (v${CONFIDENTIAL_VERSION}); update the client`,
        Number.isSafeInteger(m.min_v) ? m.min_v : undefined,
        m.detail,
      );
    }
    if (code === "twopc_version_mismatch") {
      return new TwoPcVersionMismatchError(
        `twopc_version_mismatch: the node's sidecar runs another version of the two-party key schedule than cu-2pc (${reason.slice(0, 200)})`,
      );
    }
    if (type === "connection_deposit_unfunded") {
      return new ConnectionDepositError(`node rejected: ${reason.slice(0, 300)}`, this.depositMsat, m.status, m.detail);
    }
    const e = new SessionRejectedError(
      `node rejected: ${reason.slice(0, 300)}`,
      undefined,
      Number.isSafeInteger(m.status) ? m.status : undefined,
      m.detail,
    );
    e.nodeCode = code;
    if (m.fault === "upstream" || m.fault === "node") e.fault = m.fault;
    return e;
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
    this.event({ ev: "deposit", ...this.deposit });
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
    if (this.framing === "1.1") this.recvHash.update(bytes);
    let buf = this.serverPending.length ? concat(this.serverPending, bytes) : bytes;
    while (buf.length >= 5) {
      const len = (buf[3]! << 8) | buf[4]!;
      if (buf.length < 5 + len) break;
      this.recvRecords++;
      if (buf[0] === 0x17) {
        this.serverRecords.set(this.wireRecords++, buf.slice(5, 5 + len));
        // Framing "1.1": π_C3S covers only records at the end of the response.
        if (this.framing === "1.1" && this.serverRecords.size > 2 * KEPT_SERVER_RECORDS) {
          for (const abs of this.serverRecords.keys()) {
            if (this.serverRecords.size <= KEPT_SERVER_RECORDS) break;
            this.serverRecords.delete(abs);
            this.serverRecordsDropped++;
          }
        }
      }
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
    requireHelperBinaries({
      proverPath: typeof this.prover.path === "string" ? this.prover.path : undefined,
      twoPcPath: this.twoPcPath,
      twoPc: !this.twoPcFactory,
    });
  }

  /**
   * `setup` → `ready` → the two-party preprocessing and the joint key share
   * (§3.1, §12.3). The node checks the credential and reserves the offer's
   * connection deposit; nothing names a request, and the sidecar has no
   * provider connection. With `prewarm` the setup says `armed: true` and the
   * proof channel's correlations are awaited too, so a later request finds
   * everything ready. Idempotent.
   */
  arm(prewarm = false): Promise<void> {
    // A connection the caller closed never dials.
    if (!this.armP && this.failure) return Promise.reject(this.failure);
    if (!this.armP) {
      this.connectStarted = true;
      this.prewarmed = prewarm;
      this.phaseNow = "opening";
      this.armP = this.armInner(prewarm).catch((e) => {
        const err = e instanceof Error ? e : new SessionProtocolError(String(e));
        this.fail(err);
        throw this.failure ?? err;
      });
      this.armP.catch(() => {});
    }
    return this.armP;
  }

  private async armInner(prewarm: boolean): Promise<void> {
    const t0 = Date.now();
    this.tSetup = t0;
    this.checkBinaries();
    await this.openSocket();
    const setup: Record<string, unknown> = {
      type: "setup",
      v: CONFIDENTIAL_VERSION,
      http: this.framing,
      nonce_c: hex(cryptoRandom(32)),
      armed: prewarm,
    };
    if (this.offer.sig) setup.offer_sig = this.offer.sig;
    setup.auth = this.auth;
    this.sendText(setup);

    this.ready = (await this.wait(["ready"], this.timeouts.ready)).msg;
    if (this.expectedPubkey && this.ready.pubkey !== this.expectedPubkey) {
      throw new SessionProtocolError(
        `connection pubkey ${String(this.ready.pubkey).slice(0, 80)} differs from the signed offer key ${this.expectedPubkey}`,
      );
    }
    if (typeof this.ready?.sid !== "string" || !SID_RE.test(this.ready.sid)) {
      throw new SessionProtocolError("node announced a malformed connection id");
    }
    if (this.ready.v !== CONFIDENTIAL_VERSION || this.ready.http !== this.framing) {
      throw new SessionProtocolError(`node did not open a v${CONFIDENTIAL_VERSION} connection with framing "${this.framing}"`);
    }
    if (this.ready.armed !== undefined && this.ready.armed !== prewarm) {
      throw new SessionProtocolError("ready names another armed state than the setup");
    }
    // What the setup reserved must be the signed offer's deposit (a sidecar
    // without a node names none).
    if (this.ready.deposit_msat !== undefined && this.ready.deposit_msat !== this.depositMsat) {
      throw new SessionProtocolError(
        `node reserved a connection deposit of ${String(this.ready.deposit_msat).slice(0, 32)} msat, the signed offer's is ${this.depositMsat}`,
      );
    }
    this.sid = this.ready.sid;
    this.tReady = Date.now();
    this.event({ ev: "ready", http: this.framing, armed: prewarm });

    const twoPc = this.twoPcFactory?.() ?? new TwoPcSession({ binaryPath: this.twoPcPath, proverPath: this.prover.path });
    this.twoPc = twoPc;
    twoPc.start(this.zkUrl("twopc"));
    // The proof channel's OT/VOLE setup runs alongside the 2PC preprocessing.
    this.zkChan = this.proofChannelFactory?.() ?? new ProofChannel({ binaryPath: this.prover.path });
    this.zkChan.start(this.zkUrl("zkchan"));
    this.keyShare = await Promise.race([twoPc.keyShare(this.timeouts.twoPcKeyShare), this.errP]);
    const tKeyShare = Date.now();
    this.setupTimings.readyMs = this.tReady - t0;
    this.setupTimings.twoPcKeyShareMs = tKeyShare - this.tReady;
    if (prewarm) {
      // Pre-warm: the proof channel's correlations are part of it. A channel
      // that does not come up is not fatal (the proofs then run one by one).
      await Promise.race([this.zkChan.ready(this.timeouts.proofChannelReady), this.errP]);
    }
    this.tArmed = Date.now();
    this.setupTimings.armMs = this.tArmed - t0;
    this.armBytes = this.byteCounts();
    this.phaseNow = "armed";
    if (this.framing === "1.1") {
      this.opened = true;
      this.tOpen = this.tLastSettled = this.tArmed;
    }
    this.event({ ev: "armed", http: this.framing, arm_ms: this.tArmed - t0 });
  }

  /**
   * Open the connection as far as it goes without a request. Framing `"2"`:
   * arm (unless it is armed), the handshake (ALPN `h2`), π_NK on the
   * connection head, `release_head`, `head_written`, the provider's SETTINGS
   * and `settings_seen`: READY. Framing `"1.1"`: armed is as far as it goes
   * (its head names request 1). Idempotent.
   */
  connect(): Promise<void> {
    if (!this.connectP) {
      this.connectP = (async () => {
        await this.arm(false);
        if (this.framing !== "2") return;
        try {
          await this.connectInner();
        } catch (e) {
          const err = e instanceof Error ? e : new SessionProtocolError(String(e));
          this.fail(err);
          throw this.failure ?? err;
        }
      })();
      this.connectP.catch(() => {});
    }
    return this.connectP;
  }

  /**
   * The handshake to `hs_verified` (§12.5): the ClientHello with exactly the
   * joint share; the key schedule runs on the 2PC channel; the node verifies
   * chain, hostname, CertificateVerify and both Finished.
   */
  private async handshake(): Promise<void> {
    const twoPc = this.twoPc!;
    const handshakeP = new Promise<void>((res) => (this.handshakeDone = res));
    this.makeTls({
      keyShare: this.keyShare!,
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
  }

  /**
   * `c_commit` and π_NK: the node's one epoch-0 record is the head of the
   * framing (rebuilt here from the signed offer) with a key of the offer's
   * alphabet, under the K_0 our 2PC anchored. Framing `"1.1"`: the head of
   * our request 1.
   */
  private async proveHead(req?: { kind: "chat" | "images"; bodyLen: number; headLen: number; headTemplate: string }): Promise<void> {
    const ap = this.ap!;
    const commit = (await this.wait(["c_commit"], this.timeouts.cCommit)).msg;
    for (const k of ["h1", "h2", "hk"] as const) {
      if (commit[k] !== undefined && commit[k] !== hex(ap[k])) {
        throw new SessionProtocolError(`c_commit: ${k} differs from our 2PC output`);
      }
    }
    const headLen = (commit.params as { PiNK?: { head_len?: unknown } } | null)?.PiNK?.head_len;
    if (this.framing === "2") {
      checkPiNKParamsH2(commit.params, {
        host: this.offer.upstream_host,
        probePath: this.h2!.probe_path,
        keyLength: this.offer.key_length,
        keyAlphabet: this.offer.key_alphabet,
        hk: ap.hk,
      });
      if (this.ready.head_len !== undefined && this.ready.head_len !== headLen) {
        throw new SessionProtocolError("ready names another head length than π_NK proves");
      }
    } else {
      checkPiNKParams(commit.params, {
        offer: { ...this.offer, head_template: req!.headTemplate },
        hk: ap.hk,
        bodyLen: req!.bodyLen,
        kind: req!.kind,
      });
      if (req!.headLen !== headLen) throw new SessionProtocolError("request_ok names another head length than π_NK proves");
    }
    const pinkCommit = hex(Uint8Array.from((commit.params as { PiNK: { c_commit: number[] } }).PiNK.c_commit));
    if (commit.c_commit !== pinkCommit) {
      throw new SessionProtocolError("c_commit: the frame's commitment is not the one π_NK proves");
    }
    this.cCommitHex = pinkCommit;
    await this.proof("pi_nk", "verify", commit.params);
  }

  private async connectInner(): Promise<void> {
    const t0 = Date.now();
    this.phaseNow = "connecting";
    await this.handshake();
    const tHs = Date.now();
    await this.proveHead();
    const tNk = Date.now();

    // The node writes the head (epoch 0) and its KeyUpdate; we are keyed for
    // epoch 1. This reaches the provider, but it is the node's own probe: no
    // request of ours, nothing reserved.
    this.sendText({ type: "release_head" });
    await this.wait(["head_written"], this.timeouts.headWritten);
    const tHead = (this.tHeadWritten = Date.now());
    await this.until(() => this.gotSettings, "the provider's SETTINGS", this.timeouts.settings);
    // §12.6: required before the first request; sent again when a later SETTINGS carries the parameter.
    this.sendSettingsSeen();
    this.opened = true;
    this.phaseNow = "ready";
    this.tOpen = Date.now();
    this.tLastSettled = this.tOpen;
    this.setupBytes = this.byteCounts();
    Object.assign(this.setupTimings, {
      handshakeMs: tHs - t0,
      piNkMs: tNk - tHs,
      headMs: tHead - tNk,
      settingsMs: this.tOpen - tHead,
      connectMs: this.tOpen - this.tSetup,
      claimMs: this.tOpen - t0,
    });
    this.event({ ev: "open", http: "2", ...this.setupTimings });
  }

  private sendSettingsSeen(): void {
    this.settingsSeenSent = true;
    this.sendOrdered({ type: "settings_seen", header_table_size: this.tableSize });
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
      applicationLayerProtocols: [this.framing === "2" ? "h2" : "http/1.1"],
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
        } else if (this.bodyEpoch) this.bodyRecords.push(record);
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
        if (this.framing === "2" && ctx.plaintext && cur && (cur.status === undefined || cur.status >= 400)) {
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
        if (this.framing === "1.1") {
          this.onResponseBytes(rec);
          this.kick();
          return;
        }
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
        this.tlsEnded = true;
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
  ): Promise<ProofTiming> {
    const run = async (): Promise<ProofTiming> => {
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
    if (cur && f.stream === cur.stream && cur.firstFrameOff === undefined) {
      cur.firstFrameOff = f.off;
      cur.firstFrameAbs = this.reader.recordAt(f.off).abs;
    }
    // The only other stream is the node's probe (stream 1, reset in the head).
    if (f.stream === 1) this.probeAnswered = true;
    switch (f.type) {
      case FRAME.SETTINGS: {
        if (f.flags & FLAG.ACK) break;
        let carried = false;
        for (let i = 0; i + 6 <= f.payload.length; i += 6) {
          const id = (f.payload[i]! << 8) | f.payload[i + 1]!;
          const v = u32(f.payload, i + 2);
          if (id === 4) this.initialWindow = v;
          if (id === 1) {
            this.tableSize = v;
            carried = true;
          }
        }
        this.gotSettings = true;
        if (carried && this.settingsSeenSent) this.sendSettingsSeen();
        // Acknowledged with the next request's records (one π_WIN for both)
        // when none is open, else at once.
        if (this.requestOpen) void this.sendCtl("settings_ack", new Uint8Array(0));
        else this.unackedSettings++;
        break;
      }
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
        this.event({ ev: "goaway" });
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
        // A successful image response is megabytes and is never disclosed:
        // neither its plaintext records nor its ciphertext need be kept beyond
        // the frame being read (the attestation's hash is computed as it arrives).
        if (cur.image && (cur.status ?? 0) >= 200 && (cur.status ?? 0) < 300 && cur.parts.length % 32 === 0) {
          this.reader.dropBefore(f.off);
          this.rollImageRecords(cur, this.reader.recordAt(f.off).abs);
        }
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
   * Start a request on this idle (armed or open) connection. Throws
   * synchronously when the connection cannot take one (nothing was sent
   * then). The handle's `done` rejects with `RequestRefusedError` when the
   * node refused the request: the connection is then as it was, and the next
   * request carries the same number.
   */
  request(requestOpts: ConnectionRequestOptions): ConnectionRequestHandle {
    let opts = requestOpts;
    if (!this.idle) {
      throw this.failure ?? new SessionRejectedError("the connection cannot take a request now");
    }
    const offer = opts.offer ?? this.offer;
    if (offer !== this.offer && connectionTerms(offer) !== this.terms) {
      throw new SessionProtocolError("the request's offer has other connection terms than this connection was opened on");
    }
    const image = opts.image ? this.imageTerms(offer, opts.model, opts.image) : undefined;
    const suffix = new TextEncoder().encode(
      image
        ? renderImageSuffix(opts.model, image.count, imageCountKey(offer.images!), offer.images!.fixed_pins, image.variant.pins)
        : canonicalSuffix(this.offer.chat, opts.model, opts.maxTokens),
    );
    const given = opts.body;
    if (given.length <= suffix.length || !suffix.every((b, i) => given[given.length - suffix.length + i] === b)) {
      throw new SessionProtocolError("request body does not end with the pinned suffix");
    }
    if (opts.padBucket !== undefined) opts = { ...opts, body: padBody(given, suffix.length, opts.padBucket) };
    const n = this.requests + 1;
    const cur: Cur = {
      n,
      stream: this.framing === "2" ? requestStream(n) : 0,
      auth: opts.auth ?? this.auth,
      first: this.settled === 0,
      model: opts.model,
      opts,
      offer,
      image,
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
    this.cur = cur;
    let credentialSent = false;
    let over = false;
    const run = this.framing === "2" ? this.runRequest(cur, suffix, () => (credentialSent = true)) : this.runRequest11(cur, suffix, () => (credentialSent = true));
    const done = run.then(
      (r) => {
        cur.settled = true;
        over = true;
        return r;
      },
      (e) => {
        const err = e instanceof Error ? e : new SessionProtocolError(String(e));
        // A refused request leaves the connection as it was (§12.4).
        if (err instanceof RequestRefusedError && !this.failure && this.cur === cur && !cur.accepted) {
          this.cur = undefined;
          over = true;
          this.tLastSettled = Math.max(this.tLastSettled, this.tOpen);
          this.event({ ev: "request_refused", n, status: err.status });
          this.kick();
          throw err;
        }
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
        return credentialSent || conn.credentialSent;
      },
      done,
      close() {
        if (!over) conn.close("request aborted");
      },
    };
  }

  /**
   * The terms of an image request from the signed offer it is priced by: the
   * connection serves images, the images block is one this client accepts,
   * the variant is offered for the model and the count is within its limit.
   */
  private imageTerms(
    offer: VerifiedOffer,
    model: string,
    want: { variant: string; count: number },
  ): { variant: ConfidentialImageVariant; count: number } {
    const images = offer.images;
    if ((this.h2 && !this.h2.kinds.includes("images")) || !offerSupportsImages(offer) || !images) {
      throw new SessionProtocolError(`the signed offer serves no image requests on framing "${this.framing}"`);
    }
    const problem = imagesOfferProblem(images, offer.upstream_host);
    if (problem) throw new SessionProtocolError(`the signed offer's images block is refused: ${problem}`);
    const variant = images.price_list[model]?.find((v) => v.id === want.variant);
    if (!variant) throw new SessionProtocolError(`the signed offer has no variant ${want.variant} for ${model}`);
    const maxCount = Math.min(images.max_count, variant.max_count ?? images.max_count);
    if (!Number.isSafeInteger(want.count) || want.count < 1 || want.count > maxCount) {
      throw new SessionProtocolError(`image count ${want.count} is outside 1..${maxCount}`);
    }
    return { variant, count: want.count };
  }

  /** The `request` message of §12.4 for `cur`. */
  private requestMessage(cur: Cur, bodyLen: number): Record<string, unknown> {
    const { opts, n } = cur;
    // An image request names the variant and the count: the node renders
    // the suffix from its own signed offer and echoes it in `request_ok`.
    const req: Record<string, unknown> = cur.image
      ? { type: "request", n, kind: "images", model: opts.model, variant: cur.image.variant.id, count: cur.image.count, body_len: bodyLen }
      : { type: "request", n, kind: "chat", model: opts.model, max_tokens: opts.maxTokens, body_len: bodyLen };
    if (cur.offer.sig) req.offer_sig = cur.offer.sig;
    // The fee fields echo the named offer's fees (409 `session_fee_not_accepted` otherwise).
    req.session_fee_msat = offerSessionFeeMsat(cur.offer);
    req.abandon_fee_msat = offerAbandonFeeMsat(cur.offer);
    req.auth = cur.auth;
    return req;
  }

  /**
   * Send `request` n and wait for its answer (§12.4). No record of the
   * request may be sent before this returns (framing "1.1": not even the
   * ClientHello). A refusal throws `RequestRefusedError`.
   */
  private async openRequest(cur: Cur, bodyLen: number, suffix: Uint8Array, onSent: () => void): Promise<any> {
    this.sendOrdered(this.requestMessage(cur, bodyLen));
    onSent();
    const { key, msg } = await this.wait(["request_ok", "request_refused"], this.timeouts.requestOk);
    if (key === "request_refused") {
      if (msg.n !== cur.n) throw new SessionProtocolError("request_refused names another request");
      const status = Number.isSafeInteger(msg.status) && msg.status >= 400 && msg.status <= 599 ? msg.status : 400;
      const reason = typeof msg.reason === "string" ? msg.reason : JSON.stringify(msg.reason ?? "refused");
      throw new RequestRefusedError(status, reason, msg.detail);
    }
    if (msg.n !== cur.n || (msg.sid !== undefined && msg.sid !== this.sid)) {
      throw new SessionProtocolError("request_ok names another connection or request");
    }
    if (msg.suffix !== new TextDecoder().decode(suffix)) {
      throw new SessionProtocolError("node expects a different pinned suffix than ours");
    }
    this.requests = cur.n;
    cur.accepted = true;
    return msg;
  }

  private async runRequest(cur: Cur, suffix: Uint8Array, onSent: () => void): Promise<ConnectionRequestResult> {
    const { opts, n, stream } = cur;
    // An armed connection is opened by its first request.
    await this.connect();
    cur.tOpened = Date.now();
    cur.recvAtSend = this.recvCount();
    cur.streamCredit = this.initialWindow;
    // An earlier request's records are no longer needed.
    for (const abs of this.serverRecords.keys()) {
      if (abs < cur.recvAtSend) this.serverRecords.delete(abs);
      else break;
    }
    this.plain.clear();
    if (this.requests === 0 && !this.probeAnswered) {
      // §5.4: the provider may still answer the node's probe; its frames must
      // lie before the first request's interval, or they may land in a tail.
      const until = this.tHeadWritten + this.timeouts.probe;
      await this.until(() => this.probeAnswered || Date.now() >= until, "the probe's answer", this.timeouts.probe + 1000);
      cur.recvAtSend = this.recvCount();
    }
    const bytes0 = this.byteCounts();
    const host = this.offer.upstream_host;
    // The route: the chat template's, or the images template's (both `POST <path> HTTP/1.1`).
    const path = chatPath(cur.image ? cur.offer.images!.head_template : this.offer.head_template);

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

    // `request`, then its answer; only then the records (§12.4). A refused
    // request leaves the connection READY and its number unused.
    const ok = await this.openRequest(cur, bodyLen, suffix, onSent);
    if (ok.stream !== stream) throw new SessionProtocolError("request_ok names another stream");
    // Any SETTINGS acknowledgement and the records go as one π_WIN batch.
    this.requestOpen = true;
    while (this.unackedSettings > 0) {
      this.unackedSettings--;
      void this.sendCtl("settings_ack", new Uint8Array(0));
    }
    for (const p of plan) cur.seqs.push(await Promise.race([this.sendRecord(p.content, p.pub), this.errP]));
    cur.dataLens = plan.slice(1).map((p) => p.data);
    this.event({ ev: "request_sent", n, records: plan.length, body_len: bodyLen });
    this.updateRelease();

    // Released (in steps, as the provider's window opens) or refused early.
    const errored = () => (cur.status ?? 0) >= 400;
    await this.until(() => cur.released || errored() || cur.reset !== undefined, `body_released for request ${n}`, this.timeouts.released);
    // An image response is silent until the image is done: wait as long as
    // the signed offer says the provider may take.
    const idleMs = cur.image
      ? Math.max(this.timeouts.responseIdle, Math.max(1, cur.offer.images?.response_idle_s ?? 300) * 1000)
      : this.timeouts.responseIdle;
    await this.until(
      () => cur.ended || cur.reset !== undefined || errored(),
      `the response to request ${n}`,
      idleMs,
      () => Math.max(cur.tLastData, cur.tReleased ?? 0),
    );
    if (cur.reset !== undefined) {
      throw new ResponseVerificationError(`the provider reset stream ${stream} (code ${cur.reset})`);
    }
    const status = cur.status ?? 0;
    let receipt: ConfidentialReceipt;
    let attestation: unknown;
    if (status >= 200 && status < 300 && cur.image) {
      ({ receipt, attestation } = await this.settleAccept(cur));
    } else if (status >= 200 && status < 300) {
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
    this.settled++;
    this.kick();

    // An accepted image response is handed on in the pieces it arrived in (held once).
    const accepted = cur.image !== undefined && status < 300;
    const responseBody = accepted ? new Uint8Array(0) : concat(...cur.parts.map((p) => p.data));
    const bodyChunks = accepted ? cur.parts.map((p) => p.data) : undefined;
    cur.parts = [];
    return this.result(cur, status, cur.headers ?? {}, responseBody, bodyChunks, receipt, attestation, bytes0, tEnd);
  }

  private result(
    cur: Cur,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array,
    bodyChunks: Uint8Array[] | undefined,
    receipt: ConfidentialReceipt,
    attestation: unknown,
    bytes0: ConnectionBytes,
    tEnd: number,
  ): ConnectionRequestResult {
    const effectiveModel =
      status < 300 && !cur.image ? effectiveModelFromText(new TextDecoder().decode(body)) : undefined;
    let warnings: string[] | undefined;
    if (effectiveModel !== undefined && effectiveModel !== cur.model) {
      warnings = [`the provider reports model ${JSON.stringify(effectiveModel)}, the request pinned ${cur.model}`];
    }
    const bytes1 = this.byteCounts();
    const delta = {} as ConnectionBytes;
    for (const k of Object.keys(bytes1) as (keyof ConnectionBytes)[]) delta[k] = bytes1[k] - bytes0[k];
    this.event({ ev: "request_settled", http: this.framing, n: cur.n, status, total_ms: tEnd - cur.tStart });
    return {
      sid: this.sid,
      http: this.framing,
      n: cur.n,
      stream: this.framing === "2" ? cur.stream : undefined,
      model: cur.model,
      effectiveModel,
      status,
      headers,
      body,
      bodyChunks,
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

  // --- framing "1.1": the connection's one request ------------------------------------

  /** Decrypted response bytes (framing "1.1"): parsed as they arrive, kept only while a disclosure may need them. */
  private onResponseBytes(rec: Uint8Array): void {
    const cur = this.cur;
    if (!cur) return;
    cur.tLastData = Date.now();
    if (!cur.tFirstData) cur.tFirstData = cur.tLastData;
    this.rawLens.push(rec.length);
    this.rawTotal += rec.length;
    try {
      const parts = this.incremental.push(rec);
      const head = this.incremental.head;
      if (head && !this.headEmitted) {
        this.headEmitted = true;
        cur.status = head.status;
        cur.headers = head.headers;
        cur.opts.onResponseHead?.(head);
      }
      // An accepted image response is megabytes and is never disclosed: only
      // its decoded body is kept, once. Anything else is kept as it arrived
      // (the usage tail, or the error head, is disclosed from it).
      const accepted = cur.image !== undefined && head !== undefined && head.status >= 200 && head.status < 300;
      if (accepted) this.rawChunks = [];
      else this.rawChunks.push(rec);
      for (const p of parts) {
        if (!p.length) continue;
        cur.parts.push({ off: 0, data: p });
        cur.opts.onResponseBody?.(p);
      }
      if (this.incremental.complete) this.streamEnded(cur);
    } catch (e) {
      this.fail(new ResponseVerificationError(`malformed upstream HTTP: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  /**
   * Framing "1.1" (§6, §12.4 to §12.8): `request` 1 before the ClientHello,
   * the handshake, π_NK over the request head, the body with the suffix alone
   * in the final record, π_WIN over that record, the response, the node's
   * attestation when the provider closes, then the disclosure or `accept`.
   */
  private async runRequest11(cur: Cur, suffix: Uint8Array, onSent: () => void): Promise<ConnectionRequestResult> {
    const { opts } = cur;
    await this.arm(false);
    cur.tOpened = Date.now();
    const bytes0 = this.armBytes ?? this.byteCounts();
    const body = opts.body;
    const ok = await this.openRequest(cur, body.length, suffix, onSent);
    if (!Number.isSafeInteger(ok.head_len) || ok.head_len <= 0) {
      throw new SessionProtocolError("request_ok names no head length");
    }
    this.phaseNow = "connecting";
    const t0 = Date.now();
    await this.handshake();
    const tHs = Date.now();
    await this.proveHead({
      kind: cur.image ? "images" : "chat",
      bodyLen: body.length,
      headLen: ok.head_len,
      headTemplate: cur.image ? cur.offer.images!.head_template : this.offer.head_template,
    });
    const tNk = Date.now();
    // The node writes epoch 0 (the request head with the credential, then a
    // KeyUpdate under K_0); we are keyed for epoch 1 (c_ap_1, seq 0).
    this.sendText({ type: "release_head" });
    await this.wait(["head_written"], this.timeouts.headWritten);
    this.tHeadWritten = Date.now();
    Object.assign(this.setupTimings, {
      handshakeMs: tHs - t0,
      piNkMs: tNk - tHs,
      headMs: this.tHeadWritten - tNk,
      connectMs: this.tHeadWritten - this.tSetup,
      claimMs: this.tHeadWritten - t0,
    });
    this.setupBytes = this.byteCounts();
    this.phaseNow = "ready";

    // The body under c_ap_1: the private part, then the suffix alone in the
    // final record, which the node holds until π_WIN verifies.
    this.bodyEpoch = true;
    await this.tls.write(body.subarray(0, body.length - suffix.length));
    await this.tls.write(suffix);
    this.bodyEpoch = false;
    const finalSeq = this.bodyRecords.length - 1;
    const finalRecord = this.bodyRecords[finalSeq];
    if (!finalRecord) throw new SessionProtocolError("no body record was written");
    this.event({ ev: "body_sent", len: body.length, records: this.bodyRecords.length });

    const zp = (await this.wait(["zk_params:pi_win:records"], this.timeouts.zkParams)).msg;
    const shape = checkPiWinFinalRecord(zp, { anchor: this.ap!.h1, seq: finalSeq, wire: finalRecord, suffix });
    // From here the request may reach the provider: never run it again elsewhere.
    cur.releaseSent = true;
    const tw = await this.proof("pi_win", "prove", zp.params, { Secret: Array.from(this.ap!.clientAp1) });
    cur.proofs.push({ ...tw, purpose: "records", ...shape });
    await this.until(() => cur.released, "body_released", this.timeouts.released);

    // The provider closes after its response; the node then attests on its
    // own. The wait lasts as long as the answer streams: only silence ends it.
    const idleMs = cur.image
      ? Math.max(this.timeouts.responseIdle, Math.max(1, cur.offer.images?.response_idle_s ?? 300) * 1000)
      : this.timeouts.responseIdle;
    let attMsg: any;
    for (;;) {
      const last = Math.max(cur.tLastData, cur.tReleased ?? 0, this.tLastWire);
      const left = last + idleMs + this.timeouts.attestation - Date.now();
      if (left <= 0) throw new ConfidentialTimeoutError("timeout waiting for the response and its attestation");
      try {
        attMsg = (await this.wait(["attestation"], Math.min(left, 5_000))).msg;
        break;
      } catch (e) {
        if (!(e instanceof ConfidentialTimeoutError)) throw e;
      }
    }
    const att = await this.checkAttestation11(attMsg);
    await this.drained();
    if (this.failure) throw this.failure;

    const status = cur.status ?? 0;
    let receipt: ConfidentialReceipt;
    if (status >= 200 && status < 300 && cur.image) {
      this.sendText({ type: "accept", n: 1 });
      ({ receipt } = await this.takeReceipt(cur, att.json));
      this.checkFlatReceipt(cur, receipt);
    } else if (status >= 200 && status < 300) {
      const raw = concat(...this.rawChunks);
      const r = extractUsageDisclosure(raw);
      if (!r) throw new ResponseVerificationError("could not extract a valid usage disclosure R");
      const ownUsage = usageEventFromDisclosure(r);
      if (!ownUsage) throw new ResponseVerificationError("could not parse our own usage event");
      await this.disclose11(cur, "disclose", r, 0);
      const got = await this.takeReceipt(cur, att.json);
      receipt = got.receipt;
      this.checkUsageReceipt(cur, got, ownUsage);
    } else if (status >= 400) {
      // No usage event: disclose only the head (status line and headers); the body stays private.
      const raw = concat(...this.rawChunks);
      const headEnd = indexOfCrlfCrlf(raw);
      if (headEnd < 0) throw new ResponseVerificationError("upstream error response has no head");
      if (!/^HTTP\/1\.[01] [45]\d\d/.test(latin1(raw.subarray(0, 16)))) {
        throw new ResponseVerificationError("an interim head precedes the error head: it cannot be disclosed");
      }
      const r = raw.slice(0, headEnd + 4);
      await this.disclose11(cur, "disclose_head", r, raw.length - r.length);
      ({ receipt } = await this.takeReceipt(cur, att.json));
      this.checkErrorReceipt(cur, receipt, status);
    } else {
      throw new ResponseVerificationError(`status ${status} is neither a success nor a disclosable error`);
    }
    const tEnd = Date.now();
    this.settled++;
    this.tLastSettled = tEnd;
    this.goaway = true;
    this.cur = undefined;
    // The connection's orderly end (`done`, or `error_settled`): it carries nothing we need.
    await this.until(() => this.closedReason !== undefined, "closed", this.timeouts.closed).catch(() => {});
    this.twoPc?.close();
    this.zkChan?.close();

    const accepted = cur.image !== undefined && status < 300;
    const chunks = cur.parts.map((p) => p.data);
    cur.parts = [];
    this.rawChunks = [];
    const responseBody = accepted ? new Uint8Array(0) : concat(...chunks);
    return this.result(cur, status, cur.headers ?? {}, responseBody, accepted ? chunks : undefined, receipt, att.a, bytes0, tEnd);
  }

  /** `disclose` (the usage tail) or `disclose_head` (the response head), then π_C3S over the last server records. */
  private async disclose11(cur: Cur, type: "disclose" | "disclose_head", r: Uint8Array, skip: number): Promise<void> {
    const ap = this.ap!;
    const tailLens = disclosureTailLens(this.rawLens, r.length + skip);
    const epoch = serverTailEpoch(this.serverPost, tailLens.length);
    const msg: Record<string, unknown> = { type, n: 1, r: hex(r), tail_lens: tailLens, skip, trailing: epoch.trailing };
    if (epoch.keyUpdates > 0) {
      msg.key_updates = epoch.keyUpdates;
      msg.epoch_start = epoch.epochStart;
    }
    this.sendText(msg);
    const purpose = type === "disclose_head" ? "error_head" : "";
    const c3 = (await this.wait([`zk_params:pi_c3s:${purpose}`], this.timeouts.zkParams)).msg;
    if (c3.n !== undefined && c3.n !== 1) throw new SessionProtocolError("π_C3S parameters name another request");
    // Indices are into the kept records, so the dropped ones are subtracted.
    const kept = [...this.serverRecords.values()];
    const handshakeRecords = this.wireRecords - this.serverPost.length;
    checkPiC3SParams(c3.params, {
      h2: ap.h2,
      serverRecords: kept,
      r,
      skip,
      keyUpdates: epoch.keyUpdates,
      epochBase: handshakeRecords >= 0 ? handshakeRecords + epoch.epochStart - this.serverRecordsDropped : undefined,
      trailing: epoch.trailing,
      tailLens,
    });
    const t = await this.proof("pi_c3s", "prove", c3.params, { Secret: Array.from(ap.serverAp0) });
    cur.proofs.push(purpose ? { ...t, purpose } : t);
  }

  /**
   * The attestation of a framing-"1.1" connection's one request: signed by
   * the node's key, naming this connection, framing, request and handshake,
   * the head-record commitment π_NK proved, and counts and a hash we can
   * recompute from our own records. Returns the signed bytes.
   */
  private async checkAttestation11(m: any): Promise<{ json: string; a: any }> {
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
    if (a.sid !== this.sid || a.http !== "1.1" || a.n !== 1 || (m.n !== undefined && m.n !== 1)) {
      bad("names another connection, framing or request");
    }
    if (!this.thSH || !this.thSF || a.th_sh !== hex(this.thSH) || a.th_sf !== hex(this.thSF)) {
      bad("names a different TLS handshake");
    }
    if (!this.cCommitHex || a.c_commit !== this.cCommitHex) bad("names a different head-record commitment");
    if (this.certChainHash && a.cert_chain_hash !== hex(this.certChainHash)) bad("names a different certificate chain");
    // Records may still be on their way to us when the attestation arrives.
    if (Number.isSafeInteger(a.server_records)) {
      await this.until(() => this.recvRecords >= a.server_records, "the records the attestation counts", 15_000).catch((e) => {
        if (!(e instanceof ConfidentialTimeoutError)) throw e;
      });
    }
    if (a.server_records !== this.recvRecords) {
      bad(`counts ${String(a.server_records).slice(0, 16)} upstream records, we received ${this.recvRecords}`);
    }
    if (a.sha256_recv !== this.recvHash.copy().digest("hex")) bad("hashes different upstream bytes than we received");
    if (a.client_records !== this.bodyRecords.length) {
      bad(`counts ${String(a.client_records).slice(0, 16)} body records, we sent ${this.bodyRecords.length}`);
    }
    this.event({ ev: "attestation", n: 1, server_records: a.server_records });
    return { json, a };
  }

  // --- disclosures ----------------------------------------------------------------

  /**
   * The usage disclosure of a finished stream (§5.4, §12.8): R runs from the
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
      const got = await this.takeReceipt(cur, att.json);
      this.checkUsageReceipt(cur, got, d.ownUsage);
      const receipt = got.receipt;
      return { receipt, attestation: att.a };
    }
  }

  /**
   * A successful image response (§5.4): the price was fixed by the request,
   * so nothing is disclosed and nothing proven. `accept` names the server
   * records received; the node closes the request's interval there, attests
   * it (checked as for chat: every record of the response is hashed) and
   * charges the signed price per image × count plus the session fee.
   */
  private async settleAccept(cur: Cur): Promise<{ receipt: ConfidentialReceipt; attestation: unknown }> {
    const terms = cur.image!;
    for (let attempt = 0; ; attempt++) {
      await this.drained();
      if (this.failure) throw this.failure;
      const serverRecords = this.recvCount();
      this.sendOrdered({ type: "accept", n: cur.n, server_records: serverRecords });
      const next = await this.wait(["accept_retry", "attestation"], this.timeouts.attestation);
      if (next.key === "accept_retry") {
        // More server records reached the node than we had parsed: catch up.
        if (attempt >= 20) throw new SessionProtocolError("the node keeps asking for a newer accept");
        const want = next.msg.server_records;
        if (!Number.isSafeInteger(want)) throw new SessionProtocolError("accept_retry without a record count");
        await this.until(() => this.recvCount() >= want, "the server records the node counts", 15_000);
        continue;
      }
      const att = await this.checkAttestation(next.msg, cur, serverRecords);
      const { receipt } = await this.takeReceipt(cur, att.json);
      this.checkFlatReceipt(cur, receipt);
      return { receipt, attestation: att.a };
    }
  }

  /** The error head (§5.4): the response HEADERS frame, which must start a record. */
  private async settleErrorHead(cur: Cur, status: number): Promise<{ receipt: ConfidentialReceipt; attestation: unknown }> {
    const ap = this.ap!;
    await this.drained();
    // Our own records must be proven first (one π_WIN at a time).
    await this.until(
      () => this.unproven.size === 0 && cur.proofs.some((p) => p.proof === "pi_win"),
      "our records to be proven",
      this.timeouts.proof,
    );
    // R runs from byte 0 of the record that holds the response HEADERS frame
    // to that frame's end (§5.4); the frames before it in the record are
    // disclosed too, so they may only be ones that carry nothing of ours.
    const frameHead = cur.head!;
    const rec = this.reader.recordAt(frameHead.off);
    const prefix = this.reader.slice(rec.start, frameHead.off);
    const problem = errorHeadPrefixProblem(prefix, cur.stream);
    if (problem) throw new ResponseVerificationError(`the error head cannot be disclosed: ${problem}`);
    const head = { off: rec.start, raw: concat(prefix, frameHead.raw) };
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
    this.checkErrorReceipt(cur, receipt, status);
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
    if (a.sid !== this.sid || a.http !== "2" || a.n !== cur.n || a.stream !== cur.stream || (m.n !== undefined && m.n !== cur.n)) {
      bad("names another connection, framing or request");
    }
    if (!this.thSH || !this.thSF || a.th_sh !== hex(this.thSH) || a.th_sf !== hex(this.thSF)) {
      bad("names a different TLS handshake");
    }
    if (!this.cCommitHex || a.c_commit !== this.cCommitHex) bad("names a different head-record commitment");
    if (this.certChainHash && a.cert_chain_hash !== hex(this.certChainHash)) bad("names a different certificate chain");
    const sK = a.s_k;
    const count = a.server_records;
    if (!Number.isSafeInteger(sK) || !Number.isSafeInteger(count) || sK < 0 || count < 0) bad("interval malformed");
    const firstAbs = cur.firstFrameAbs;
    if (sK < cur.recvAtSend || (firstAbs !== undefined && sK > firstAbs)) bad("interval does not start at our request");
    const end = sK + count;
    if (upto !== undefined && end !== upto) bad("interval does not end at our disclosure");
    await this.until(() => this.wireRecords >= end, "the records the attestation counts", 15_000);
    // An accepted image response was hashed as it arrived, from each start
    // the interval may have; anything else is hashed from the records held.
    const rolled = cur.roll?.find((r) => r.from === sK);
    let h = createHash("sha256");
    let from = sK;
    if (cur.roll) {
      if (!rolled) return bad("interval starts where we kept no hash");
      h = rolled.h;
      from = rolled.next;
    }
    for (let i = from; i < end; i++) {
      const p = this.serverRecords.get(i);
      if (!p) return bad("covers records we no longer hold");
      hashRecord(h, p);
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

  /**
   * An accepted image response in framing "2": hash the ciphertext records
   * below `upto` (all processed) into one running hash per start the
   * request's interval may have, and let them go. The interval starts between
   * the records received when the request was sent and the response's first
   * frame; with more candidates than a few the records are kept instead.
   */
  private rollImageRecords(cur: Cur, upto: number): void {
    if (cur.firstFrameAbs === undefined) return;
    if (!cur.roll) {
      const starts = cur.firstFrameAbs - cur.recvAtSend + 1;
      if (starts < 1 || starts > 4) return;
      cur.roll = [];
      for (let from = cur.recvAtSend; from <= cur.firstFrameAbs; from++) {
        cur.roll.push({ from, next: from, h: createHash("sha256") });
      }
    }
    for (const r of cur.roll) {
      for (; r.next < upto; r.next++) {
        const p = this.serverRecords.get(r.next);
        if (!p) return;
        hashRecord(r.h, p);
      }
    }
    for (const abs of this.serverRecords.keys()) {
      if (abs < upto) this.serverRecords.delete(abs);
      else break;
    }
  }

  /** The session fee still due on this connection for `cur` (§8.3: once, at the first settlement). */
  private feeDue(cur: Cur): number {
    return cur.first ? offerSessionFeeMsat(cur.offer) : 0;
  }

  /** A usage receipt: our own usage, the pinned model, a cost within the signed rates plus the fee still due. */
  private checkUsageReceipt(
    cur: Cur,
    got: { receipt: ConfidentialReceipt; receiptJson: string; sig?: string },
    ownUsage: UpstreamUsageEvent,
  ): void {
    const fee = this.feeDue(cur);
    const checked = verifyReceipt({
      receipt: got.receipt,
      receiptJson: got.receiptJson,
      sig: got.sig,
      pubkey: this.ready.pubkey,
      ownUsage,
      pinnedModel: cur.model,
      priceEntry: cur.offer.price_list[cur.model],
      sessionFeeMsat: fee,
      abandonFeeMsat: offerAbandonFeeMsat(cur.offer),
    });
    if (!checked.usageMatch) throw new ReceiptVerificationError("receipt usage does not match our own plaintext");
    if (!checked.costWithinOffer) {
      throw new ReceiptVerificationError(
        `receipt cost ${got.receipt.cost_msats} msats exceeds the usage priced at the signed offer's rates` +
          ` plus the session fee due on this connection (${fee} msats)`,
      );
    }
  }

  private checkFlatReceipt(cur: Cur, receipt: ConfidentialReceipt): void {
    const terms = cur.image!;
    verifyFlatReceipt(receipt, {
      model: cur.model,
      variant: terms.variant.id,
      count: terms.count,
      msatPerImage: terms.variant.msat_per_image,
      sessionFeeMsat: this.feeDue(cur),
      abandonFeeMsat: offerAbandonFeeMsat(cur.offer),
    });
  }

  private checkErrorReceipt(cur: Cur, receipt: ConfidentialReceipt, status: number): void {
    const usageMatch = checkUpstreamErrorReceipt(receipt, status, this.feeDue(cur), {
      abandonFeeMsat: offerAbandonFeeMsat(cur.offer),
      image: cur.image
        ? {
            model: cur.model,
            variant: cur.image.variant.id,
            count: cur.image.count,
            msatPerImage: cur.image.variant.msat_per_image,
          }
        : undefined,
    });
    if (!usageMatch) throw new ReceiptVerificationError("error receipt does not match the disclosed status");
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
    if (receipt.http !== this.framing || receipt.n !== cur.n) {
      throw new ReceiptVerificationError(
        `receipt is for http ${JSON.stringify(receipt.http ?? null).slice(0, 16)} request ${String(receipt.n).slice(0, 16)}, not "${this.framing}" request ${cur.n}`,
      );
    }
    // The connection's first settled request returns the deposit: its
    // (signed) receipt says so, once, with the offer's amount (§12.8, §12.10).
    const back = receipt.deposit_released_msat;
    if (back === undefined) {
      if (cur.first && this.depositMsat > 0) {
        throw new ReceiptVerificationError(
          `receipt ${cur.n} settles the connection's first request and does not release the deposit of ${this.depositMsat} msat`,
        );
      }
    } else {
      if (!cur.first || back !== this.depositMsat || this.deposit !== undefined) {
        throw new ReceiptVerificationError(
          `receipt ${cur.n} releases a connection deposit of ${String(back).slice(0, 32)} msat (the offer's is ${this.depositMsat}` +
            `${cur.first ? "" : "; it was released before"})`,
        );
      }
      this.deposit = { msat: this.depositMsat, outcome: "released", reason: "request_settled", signed: true };
      this.event({ ev: "deposit", ...this.deposit, n: cur.n });
    }
    return { receipt, receiptJson, sig: m.sig };
  }
}

/** One type-23 record into the attestation's hash: header ‖ payload. */
function hashRecord(h: ReturnType<typeof createHash>, payload: Uint8Array): void {
  h.update(Uint8Array.from([0x17, 0x03, 0x03, payload.length >> 8, payload.length & 0xff]));
  h.update(payload);
}

function indexOfCrlfCrlf(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

function rejectAfter(ms: number, what: string): Promise<never> {
  return new Promise((_, rej) => {
    const t = setTimeout(() => rej(new ConfidentialTimeoutError(`timeout waiting for ${what}`)), ms);
    (t as { unref?: () => void }).unref?.();
  });
}
