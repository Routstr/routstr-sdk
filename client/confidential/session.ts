/**
 * The confidential-upstream session driver (C side).
 *
 * C is the TLS 1.3 client of the upstream session through the node's WS relay
 * and holds the only copy of the application traffic secrets. It never sees the
 * credential record. The message flow (identical to the verified prototype):
 *
 *   setup → ready → TLS handshake → hs_secrets (c_hs/s_hs ONLY) → hs_verified
 *   → KU0 → c1_material → π_C1 → c_commit → π_N → ku1 → head_written
 *   → body → body_suffix → π_C2 → attestation → disclose → π_C3 → receipt
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
import { checkPiC1Params, checkPiC2Params, checkPiC3Params, type SessionValues } from "./params";
import { CuProverBackend } from "./prover";
import { parseSignedReceipt, verifyReceipt } from "./receipt";
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
import type { VerifiedOffer } from "./offer";

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
  /** The node's reservation for this session (the model's maximum cost). */
  reserved_msats?: number;
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
  piC1Ms?: number;
  recordKu1Ms?: number;
  claimToBodyMs?: number;
  upstreamTtftMs?: number;
  armMs?: number;
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
  private readonly prover: CuProverBackend;
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
  private ttft = 0;
  private prepared = false;
  private armed = false;
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
    this.errP.catch(() => {});
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
    return `${this.wsBase()}/v1/confidential/ws?session_id=${this.uuid}&v=${this.offer.v}`;
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

    this.tls = makeTLSClient({
      host: this.offer.upstream_host,
      verifyServerCertificate: true,
      cipherSuites: ["TLS_AES_128_GCM_SHA256"],
      supportedProtocolVersions: ["TLS1_3"],
      namedCurves: ["X25519"],
      applicationLayerProtocols: ["http/1.1"],
      write: (packet: { header: Uint8Array; content: Uint8Array }) => {
        const record = concat(packet.header, packet.content);
        if (this.epoch2) this.bodyRecords.push(record);
        this.sendBytes(record);
      },
      onRead: () => {},
      onApplicationData: (rec: Uint8Array) => {
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
      onHandshake: () => this.handshakeDone?.(),
      logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never) as unknown as TlsHandle;

    return this.wsReady;
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

  /** setup → ready → TLS handshake → hs_verified → KU0. Leaves the session armed. */
  async arm(): Promise<void> {
    await assertX25519Support();
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
    setup.auth = this.auth;
    this.sendText(setup);

    this.ready = await this.waitT("ready", this.timeouts.ready);
    this.sid = this.ready.sid;
    this.tReady = Date.now();
    this.event({ ev: "ready", sid: this.sid, head_len: this.ready.head_len });

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

  /** Phase 1, safe to run while arming: π_C1 advice + proof + π_N verification. */
  async prepareProofs(): Promise<void> {
    if (this.prepared) return;
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

    // Epoch 1: the client's KeyUpdate is seq 1 (seq 0 is the node's record).
    this.tls.skipSendSequence(1);
    const ku1 = await this.tls.updateTrafficKeysSilently(false);
    this.tRecordStart = Date.now();
    this.sendText({ type: "ku1", record: hex(concat(ku1.header, ku1.content)) });
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
    checkPiC2Params(c2params.params, {
      session: this.sessionValues!,
      seq: this.bodyRecords.length - 1,
      record: this.bodyRecords[this.bodyRecords.length - 1] ?? new Uint8Array(0),
      suffix: suffixBytes,
    });
    const c2Promise = this.prover
      .run(this.zkUrl("pi_c2"), {
        proof: "pi_c2",
        role: "prover",
        params: c2params.params,
        witness: { Hs: Array.from(this.hs!) },
      })
      .then(
        () => this.event({ ev: "pi_c2_ok" }),
        // Handle now (no unhandled rejection while we wait for attestation);
        // the failure is re-raised below before π_C3.
        (e: unknown) => this.event({ ev: "pi_c2_fail", err: String(e) }),
      );

    const attMsg = await Promise.race([
      this.bus.wait("attestation"),
      this.errP,
      timeout(this.timeouts.attestation, "attestation"),
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
    this.sendText({ type: "disclose", r: hex(r), tail_lens: tailLens, skip });

    const c3 = await this.waitT("zk_params", this.timeouts.zkParams);
    checkPiC3Params(c3.params, {
      session: this.sessionValues!,
      serverRecords: this.serverRecords,
      r,
      skip,
    });
    await this.prover.run(this.zkUrl("pi_c3"), {
      proof: "pi_c3",
      role: "prover",
      params: c3.params,
      witness: { Hs: Array.from(this.hs!) },
    });
    this.event({ ev: "pi_c3_ok" });

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
        attestationJson: att.a_json,
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
      const unbilled = httpEarly.status === 503 || (httpEarly.status >= 400 && httpEarly.status < 500);
      if (unbilled && (receipt.cost_msats ?? 0) !== 0) {
        throw new ReceiptVerificationError(`node charged ${receipt.cost_msats} msats for an unbilled upstream error`);
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
      });
      usageMatch = checked.usageMatch;
      if (!checked.costWithinOffer) {
        throw new ReceiptVerificationError(
          `receipt cost ${receipt.cost_msats} msats exceeds the usage priced at the signed offer's rates`,
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
      readyMs: this.tReady ? this.tReady - tClaim : undefined,
      handshakeMs: this.tHs ? this.tHs - this.tReady : undefined,
      ku0Ms: this.tKu0 ? this.tKu0 - this.tHs : undefined,
      piC1Ms: this.tC1Sent ? this.tProofsReady - this.tC1Sent : undefined,
      recordKu1Ms: this.tRecordStart ? this.tHeadWritten - this.tRecordStart : undefined,
      claimToBodyMs: this.tBodyWrite ? this.tBodyWrite - tClaim : undefined,
      upstreamTtftMs: this.tBodyWrite ? ttftAbs - this.tBodyWrite : undefined,
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
      proofs: ["pi_c1", "pi_n", "pi_c2", "pi_c3"],
    };
    this.persist(result);
    return result;
  }

  /** Cold path: open → arm → proofs → finish. */
  async run(body: Uint8Array): Promise<ConfidentialSessionResult> {
    const tClaim = Date.now();
    await this.open();
    await this.arm();
    await this.prepareProofs();
    const result = await this.finish(body, tClaim);
    return result;
  }

  /** Abort an armed-but-unclaimed session; the node releases its reservation. */
  discard(): void {
    this.close();
  }

  close(): void {
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
