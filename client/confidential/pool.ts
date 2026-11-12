/**
 * The pool of confidential connections (PROTOCOL-V3.md §9).
 *
 * A connection costs one two-party handshake (the 2PC preprocessing, π_NK).
 * A framing-`"2"` connection then serves requests one at a time; a
 * framing-`"1.1"` connection serves one. The pool keeps what a process has,
 * by key (node, credential, `reuseScope`; §9.1):
 *
 * - **Open connections** (framing `"2"`). A request takes an idle live one of
 *   its key, otherwise an armed spare, otherwise it opens another (requests on
 *   one connection are sequential, so overlapping requests need a connection
 *   each), up to `maxConnectionsPerKey` and `maxConnections`; beyond that it
 *   waits for one to become free. A connection is kept after a settled 2xx
 *   request and after a refused request. It is closed `idleMarginMs` before
 *   the node's idle limit (the signed offer's `idle_timeout_s`, counted from
 *   the last settlement), after `maxRequestsPerConnection` requests (at most
 *   the offer's `h2.max_requests`), before the offer's `h2.max_lifetime_s`,
 *   and whenever it fails.
 * - **Armed spares** (pre-warm, §9.2; both framings). An armed connection has
 *   its deposit held and its 2PC preprocessing, key share and proof-channel
 *   correlations done; it is bound to the credential only, and the sidecar has
 *   no provider connection for it. Framing `"1.1"`: one spare per key while
 *   the key has traffic. Framing `"2"`: one spare per key while the key has
 *   traffic and every open connection of the key is busy, so a burst does not
 *   wait for a 2PC. A spare that is never used costs the connection deposit:
 *   keys are armed only after one of their requests settled, only for nodes
 *   whose deposit is at most `prewarm.maxDepositMsat`, and a spare is retired
 *   when its key had no request for `activityWindowMs` or it reaches
 *   `maxAgeMs` (the node ends an armed connection after 600 s).
 * - **Bad marks** (§2.3). A node whose framing-`"2"` connection failed to
 *   open is marked for 10 minutes; its requests use `"1.1"` meanwhile.
 *
 * A pooled connection is a cache, never a promise: it may be dead when a
 * request arrives. The transport then runs the request on a fresh one, as
 * long as nothing of it was released towards the provider.
 *
 * Linkability: the requests of one connection share a TLS connection to the
 * provider and a connection with the node, so both can tell they come from
 * one client. The key's scope is the caller's tool to separate what must not
 * be linked: a scope never shares a connection with another.
 */

import { createHash } from "node:crypto";
import { ConfidentialTimeoutError, ConnectionDepositError } from "./errors";
import type { ConfidentialConnection } from "./connection";
import type { ConfidentialFraming } from "./offer";

export interface Http2Options {
  /**
   * Which requests may share a framing-`"2"` connection (and so be linked to
   * each other by the provider and the node):
   * - `shared` (default): requests to one node with one credential and one
   *   `reuseScope`;
   * - `none`: every request opens its own connection, closed when it settles.
   * The node links requests by their credential in any mode; the provider
   * sees the node's key, and a connection tells it which requests belong to
   * one client.
   */
  reuse?: "shared" | "none";
  /** Connections per key (default 4): the most overlapping requests served without waiting. */
  maxConnectionsPerKey?: number;
  /** Connections in total (default 8). */
  maxConnections?: number;
  /**
   * Close an idle connection this long before the node would (default
   * 20 000 ms, and at most a quarter of the node's `idle_timeout_s`, so a
   * node with a short timeout still gets its connections reused).
   */
  idleMarginMs?: number;
  /** Close a connection idle this long (ms). Always clamped below the node's `idle_timeout_s`. */
  maxIdleMs?: number;
  /** Close a connection after this many requests (default: the offer's `h2.max_requests`). */
  maxRequestsPerConnection?: number;
  /** How long a request waits for a connection when the limits are reached (default 120 000 ms). */
  acquireTimeoutMs?: number;
  /** Info-level log sink (never receives secrets). Default: console.info. */
  log?: (message: string) => void;
  /** One call per settled request: where it ran and what it cost (measurements). */
  onRequest?: (stats: ConfidentialRequestStats) => void;
}

export interface PrewarmOptions {
  /** Default true (an options object opts in). */
  enabled?: boolean;
  /** A key with no request for this long is idle: no arms, armed spares closed (default 10 min). */
  activityWindowMs?: number;
  /** Armed spares in total across keys (default 4). */
  maxTotal?: number;
  /** Retire an armed spare older than this (from its setup; default 480 s, at least 60 s). */
  maxAgeMs?: number;
  /** After a failed arm, or a spare that died unused: wait this long, doubling up to `backoffMaxMs`. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * Arm only for nodes whose connection deposit (msat; what a spare that is
   * never used costs) is at most this. Default 5000; 0 never arms a node
   * that takes a deposit.
   */
  maxDepositMsat?: number;
  /** Info-level log sink (never receives secrets). Default: console.info. */
  log?: (message: string) => void;
}

export interface ConfidentialRequestStats {
  baseUrl: string;
  sid: string;
  /** The connection's framing. */
  http: ConfidentialFraming;
  /** The request's number on its connection. */
  n: number;
  /** `images` for an image request (absent: chat). */
  kind?: "images";
  /** What the request found: an open connection, an armed one, or nothing. */
  warm: "open" | "armed" | "cold";
  /** True when the connection was open before the request arrived. */
  reused: boolean;
  status: number;
  /** From the request's arrival to the first response byte, and to settlement (ms). */
  ttftMs?: number;
  totalMs: number;
  /** Arming and opening the connection, when this request did (ms). */
  connectMs?: number;
  /** Bytes client→node and node→client spent on the request (2PC, proofs, relay, control), arming excluded. */
  bytesSent: number;
  bytesRecv: number;
  /** The bytes of arming the connection (2PC preprocessing, key share, proof channel), unless it was open. */
  armBytesSent?: number;
  armBytesRecv?: number;
  /** The connection deposit this request's receipt returned (the connection's first settled request), msat. */
  depositReleasedMsat?: number;
}

export const HTTP2_DEFAULTS = {
  reuse: "shared" as const,
  maxConnectionsPerKey: 4,
  maxConnections: 8,
  idleMarginMs: 20_000,
  acquireTimeoutMs: 120_000,
};

export const PREWARM_DEFAULTS = {
  enabled: true,
  activityWindowMs: 10 * 60_000,
  maxTotal: 4,
  maxAgeMs: 480_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 10 * 60_000,
  maxDepositMsat: 5000,
  tickMs: 15_000,
};

/** The shortest `maxAgeMs` the pool accepts (each retired spare costs its 2PC traffic and the deposit). */
export const PREWARM_MIN_MAX_AGE_MS = 60_000;
/** How long a node's framing "2" stays marked bad after a failed open (§2.3). */
export const FRAMING_BAD_MS = 10 * 60_000;
/** Retire a connection this long before the offer's `h2.max_lifetime_s`. */
const LIFETIME_MARGIN_MS = 120_000;

/** What decides which requests may share a connection (§9.1). */
export interface PoolKeyInfo {
  baseUrl: string;
  bearer: string;
  /** A caller-chosen partition (requests with different scopes never share). */
  scope?: string;
}

/** The pool key: never the credential itself, only a hash of it. */
export function poolKey(info: PoolKeyInfo): string {
  const h = createHash("sha256");
  for (const part of [info.baseUrl.replace(/\/$/, ""), info.bearer, info.scope ?? ""]) {
    h.update(part);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 32);
}

/**
 * How long the pool keeps an idle connection (ms): below the node's idle
 * timeout (which the node counts from its last settlement or from
 * `head_written`) by the idle margin, and never longer than `maxIdleMs`.
 */
export function poolIdleMs(nodeIdleMs: number, options: Pick<Http2Options, "idleMarginMs" | "maxIdleMs"> = {}): number {
  const margin = Math.min(options.idleMarginMs ?? HTTP2_DEFAULTS.idleMarginMs, nodeIdleMs / 4);
  return Math.min(Math.max(nodeIdleMs - margin, 1000), options.maxIdleMs ?? Infinity);
}

type ConnLike = Pick<
  ConfidentialConnection,
  | "connect"
  | "arm"
  | "close"
  | "idle"
  | "armed"
  | "usable"
  | "requests"
  | "settled"
  | "tCreated"
  | "tOpen"
  | "tLastSettled"
  | "ended"
  | "sid"
  | "framing"
  | "maxRequests"
  | "nodeIdleMs"
  | "h2"
  | "depositMsat"
  | "failureReason"
> & { topUp?: () => void };

interface Entry<C extends ConnLike> {
  key: string;
  node: string;
  conn: C;
  /** `arming`/`armed`: a spare nobody claimed yet. */
  state: "arming" | "armed" | "connecting" | "busy" | "idle";
  /** Resolves when a spare's arm ended (either way). */
  armed?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
}

/** What the pool knows of a key's traffic. */
interface KeyState {
  node: string;
  lastRequest: number;
  /** Requests of the key that settled (a key is armed only after one). */
  settled: number;
  inFlight: number;
  backoffUntil: number;
  failures: number;
  /** How to open a spare for the key (from its latest request). */
  open?: (framing: ConfidentialFraming) => ConnLike;
  framing?: ConfidentialFraming;
  depositMsat: number;
}

export interface PoolLease<C extends ConnLike> {
  conn: C;
  /** True when the connection was open before this request. */
  reused: boolean;
  /** What the request found. */
  warm: "open" | "armed" | "cold";
  /** The request is over: the connection goes back to the pool, or is closed. `settled`: it settled a request. */
  release(settled?: boolean): void;
}

export class ConnectionPool<C extends ConnLike = ConfidentialConnection> {
  private entries: Entry<C>[] = [];
  private waiters: (() => void)[] = [];
  private keys = new Map<string, KeyState>();
  private bad = new Map<string, number>();
  private http2: Http2Options;
  private prewarm: PrewarmOptions | undefined;
  private tick?: ReturnType<typeof setInterval>;
  /** Deposits of spares retired unused (msat), for the log and tests. */
  unusedDepositMsats = 0;

  constructor(http2: Http2Options = {}, prewarm?: PrewarmOptions) {
    this.http2 = http2;
    this.prewarm = prewarm;
  }

  configure(http2: Http2Options = {}, prewarm?: PrewarmOptions): void {
    this.http2 = http2;
    this.prewarm = prewarm;
    if (!this.prewarmOn) this.closeSpares("pre-warming is off");
  }

  private get prewarmOn(): boolean {
    return this.prewarm !== undefined && this.prewarm.enabled !== false;
  }

  private log(message: string): void {
    (this.http2.log ?? this.prewarm?.log ?? console.info)(`[confidential pool] ${message}`);
  }

  private opt<K extends keyof typeof HTTP2_DEFAULTS>(k: K): (typeof HTTP2_DEFAULTS)[K] {
    return (this.http2[k] ?? HTTP2_DEFAULTS[k]) as (typeof HTTP2_DEFAULTS)[K];
  }

  private pre<K extends keyof typeof PREWARM_DEFAULTS>(k: K): (typeof PREWARM_DEFAULTS)[K] {
    const v = (this.prewarm as Record<string, unknown> | undefined)?.[k];
    const d = PREWARM_DEFAULTS[k];
    if (typeof d === "number" && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) return d;
    if (k === "maxAgeMs") return Math.max(v as number, PREWARM_MIN_MAX_AGE_MS) as (typeof PREWARM_DEFAULTS)[K];
    return (v ?? d) as (typeof PREWARM_DEFAULTS)[K];
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private remove(entry: Entry<C>): void {
    if (entry.timer) clearTimeout(entry.timer);
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
    this.wake();
  }

  private retire(entry: Entry<C>, why: string): void {
    this.log(`closing sid=${entry.conn.sid.slice(0, 8)} after ${entry.conn.requests} request(s): ${why}`);
    this.remove(entry);
    entry.conn.close(why);
  }

  private isSpare(e: Entry<C>): boolean {
    return e.state === "arming" || e.state === "armed";
  }

  // --- bad marks (§2.3) -------------------------------------------------------------

  /** Framing "2" failed to open on `baseUrl`: use "1.1" there for 10 minutes. */
  markBad(baseUrl: string, why: string): void {
    const node = baseUrl.replace(/\/$/, "");
    this.bad.set(node, Date.now() + FRAMING_BAD_MS);
    this.log(`framing "2" marked bad for ${node} for ${FRAMING_BAD_MS / 60_000} min: ${why}`);
    for (const e of [...this.entries]) {
      if (e.node === node && e.conn.framing === "2" && this.isSpare(e)) this.retire(e, 'framing "2" is marked bad');
    }
  }

  isBad(baseUrl: string): boolean {
    const node = baseUrl.replace(/\/$/, "");
    const until = this.bad.get(node);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.bad.delete(node);
    return false;
  }

  // --- acquiring --------------------------------------------------------------------

  /**
   * A connection for one request of `key` with `framing`: an idle open one
   * (framing "2"), else an armed spare, else a new one (`open` builds it;
   * this connects it), else, at the limits, the next that becomes free.
   * Rejects if the connection cannot be opened.
   */
  async acquire(
    key: string,
    framing: ConfidentialFraming,
    open: (framing: ConfidentialFraming) => C,
    signal?: AbortSignal,
  ): Promise<PoolLease<C>> {
    const deadline = Date.now() + this.opt("acquireTimeoutMs");
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      // Dead connections first (one may have ended without our noticing yet).
      for (const e of [...this.entries]) {
        if ((e.state === "idle" && !e.conn.idle) || (e.state === "armed" && !e.conn.armed)) this.remove(e);
      }
      const mineOf = (e: Entry<C>) => e.key === key && e.conn.framing === framing;
      if (framing === "2") {
        const idle = this.entries.find((e) => mineOf(e) && e.state === "idle");
        if (idle) {
          if (idle.timer) clearTimeout(idle.timer);
          idle.timer = undefined;
          idle.state = "busy";
          return this.lease(idle, "open");
        }
      }
      // An armed spare, or one whose arm is still running (the wait is shorter than a cold open).
      const spare =
        this.entries.find((e) => mineOf(e) && e.state === "armed") ??
        this.entries.find((e) => mineOf(e) && e.state === "arming");
      if (spare) {
        const wasArmed = spare.state === "armed";
        spare.state = "connecting";
        try {
          await spare.conn.connect();
        } catch (error) {
          this.remove(spare);
          if (signal?.aborted) throw signal.reason ?? error;
          this.log(`armed sid=${spare.conn.sid.slice(0, 8)} failed when claimed (${errorText(error)})`);
          this.backoff(key);
          // A framing-"2" open that failed is the caller's to judge (fallback,
          // §2.3); a "1.1" spare only failed to arm: open one for the request.
          if (framing === "2") throw error;
          continue;
        }
        spare.state = "busy";
        return this.lease(spare, wasArmed ? "armed" : "cold");
      }
      const mine = this.entries.filter((e) => e.key === key && !this.isSpare(e)).length;
      if (mine < this.opt("maxConnectionsPerKey")) {
        if (this.entries.length >= this.opt("maxConnections")) {
          // Make room: a spare of another key, else the idle connection that waited longest.
          const victim =
            this.entries.find((e) => e.state === "armed" && e.key !== key) ??
            this.entries
              .filter((e) => e.state === "idle")
              .sort((a, b) => a.conn.tLastSettled - b.conn.tLastSettled)[0];
          if (victim) this.retire(victim, "making room for another key");
        }
        if (this.entries.length < this.opt("maxConnections")) {
          const entry: Entry<C> = { key, node: "", conn: open(framing), state: "connecting" };
          this.track(entry);
          try {
            await entry.conn.connect();
          } catch (error) {
            this.remove(entry);
            throw error;
          }
          entry.state = "busy";
          return this.lease(entry, "cold");
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new ConfidentialTimeoutError("timeout waiting for a free confidential connection");
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(left, 1000));
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  private track(entry: Entry<C>): void {
    this.entries.push(entry);
    void entry.conn.ended.then((e) => {
      if (!this.entries.includes(entry)) return;
      if (entry.state === "idle") this.log(`sid=${entry.conn.sid.slice(0, 8)} ended while idle: ${e.message}`);
      if (entry.state === "armed") {
        // A spare that died unused: its deposit may be gone; do not arm again at once.
        this.log(`armed sid=${entry.conn.sid.slice(0, 8)} ended unused: ${e.message}`);
        this.unusedDepositMsats += entry.conn.depositMsat;
        this.backoff(entry.key);
      }
      this.remove(entry);
    });
  }

  private lease(entry: Entry<C>, warm: "open" | "armed" | "cold"): PoolLease<C> {
    let released = false;
    return {
      conn: entry.conn,
      reused: warm === "open",
      warm,
      release: (settled = false) => {
        if (released) return;
        released = true;
        this.release(entry, settled);
      },
    };
  }

  private release(entry: Entry<C>, settled: boolean): void {
    const k = this.keys.get(entry.key);
    if (k && settled) {
      k.settled++;
      k.failures = 0;
    }
    if (this.entries.includes(entry)) this.park(entry);
    this.replenish();
  }

  /** A connection whose request is over: idle again, an armed spare again, or closed. */
  private park(entry: Entry<C>): void {
    const conn = entry.conn;
    const now = Date.now();
    if (!conn.idle) return this.retireQuietly(entry);
    if (conn.armed) {
      // Its request was refused before the handshake: still armed, still a spare.
      if (!this.prewarmOn) return this.retire(entry, "the request was refused");
      entry.state = "armed";
      this.startTick();
      this.wake();
      return;
    }
    if (this.http2.reuse === "none") return this.retire(entry, "reuse is off");
    const maxRequests = Math.min(this.http2.maxRequestsPerConnection ?? Infinity, conn.maxRequests);
    if (conn.requests >= maxRequests) return this.retire(entry, "request limit reached");
    const lifetimeMs = (conn.h2?.max_lifetime_s ?? 3600) * 1000;
    const lifetimeLeft = conn.tOpen + lifetimeMs - Math.min(LIFETIME_MARGIN_MS, lifetimeMs / 4) - now;
    if (lifetimeLeft <= 0) return this.retire(entry, "connection lifetime reached");
    const idleFor = Math.min(poolIdleMs(conn.nodeIdleMs, this.http2), lifetimeLeft);
    const closeAt = conn.tLastSettled + idleFor;
    if (closeAt <= now) return this.retire(entry, "idle");
    entry.state = "idle";
    entry.timer = setTimeout(() => {
      if (entry.state === "idle") this.retire(entry, "idle");
    }, closeAt - now);
    (entry.timer as { unref?: () => void }).unref?.();
    // While it waits: correlations for the next request's proofs (§9.2).
    try {
      conn.topUp?.();
    } catch {
      /* a top-up is an optimisation */
    }
    this.wake();
  }

  /** A connection that already ended (an error, a non-2xx, GOAWAY, its one request): just forget it. */
  private retireQuietly(entry: Entry<C>): void {
    this.remove(entry);
    entry.conn.close("not reusable");
  }

  // --- pre-warm (§9.2) -----------------------------------------------------------------

  /**
   * A request of `key` arrived: remember the traffic and how to open a spare
   * for it. `prewarmable`: the credential is stable (never a one-off token).
   */
  noteRequest(
    key: string,
    info: { baseUrl: string; framing: ConfidentialFraming; depositMsat: number; prewarmable: boolean },
    open: (framing: ConfidentialFraming) => C,
  ): { done(): void } {
    let k = this.keys.get(key);
    if (!k) {
      k = { node: info.baseUrl.replace(/\/$/, ""), lastRequest: 0, settled: 0, inFlight: 0, backoffUntil: 0, failures: 0, depositMsat: 0 };
      this.keys.set(key, k);
    }
    k.lastRequest = Date.now();
    k.inFlight++;
    k.depositMsat = info.depositMsat;
    k.framing = info.framing;
    k.open = info.prewarmable ? open : undefined;
    let over = false;
    const state = k;
    return {
      done: () => {
        if (over) return;
        over = true;
        state.inFlight--;
        state.lastRequest = Date.now();
        this.replenish();
      },
    };
  }

  private backoff(key: string): void {
    const k = this.keys.get(key);
    if (!k) return;
    k.failures++;
    k.backoffUntil =
      Date.now() + Math.min(this.pre("backoffBaseMs") * 2 ** (k.failures - 1), this.pre("backoffMaxMs"));
  }

  private active(k: KeyState, now: number): boolean {
    return k.inFlight > 0 || now - k.lastRequest < this.pre("activityWindowMs");
  }

  /** Arm a spare where the rules ask for one (one arm at a time: preprocessing is bandwidth-heavy). */
  private replenish(): void {
    if (!this.prewarmOn) return;
    const now = Date.now();
    // Not while a cold request is in its own preprocessing, nor beside another arm.
    if (this.entries.some((e) => e.state === "arming" || e.state === "connecting")) return;
    if (this.entries.filter((e) => this.isSpare(e)).length >= this.pre("maxTotal")) return;
    const wanted = [...this.keys.entries()]
      .filter(([key, k]) => this.wantsSpare(key, k, now))
      .sort(([, a], [, b]) => b.lastRequest - a.lastRequest)[0];
    if (!wanted) return;
    const [key, k] = wanted;
    const framing = k.framing!;
    if (this.entries.length >= this.opt("maxConnections")) return;
    let conn: C;
    try {
      conn = k.open!(framing) as C;
    } catch (error) {
      // The deposit exceeds the maximum, the transport is not encrypted: nothing to arm.
      this.backoff(key);
      this.log(`not pre-warming key=${key.slice(0, 8)}: ${errorText(error)}`);
      return;
    }
    const entry: Entry<C> = { key, node: k.node, conn, state: "arming" };
    this.track(entry);
    this.startTick();
    const t0 = Date.now();
    entry.armed = conn.arm(true).then(
      () => {
        if (entry.state === "arming") {
          entry.state = "armed";
          this.log(`armed sid=${conn.sid.slice(0, 8)} http=${framing} key=${key.slice(0, 8)} in ${Date.now() - t0} ms`);
        }
        this.wake();
        this.replenish();
        return true;
      },
      (error) => {
        // Claimed meanwhile: the claimer sees the failure itself.
        if (entry.state === "arming") {
          this.remove(entry);
          // Too little balance for the deposit is not a failure of the node: retry later, no escalation.
          if (error instanceof ConnectionDepositError) {
            k.backoffUntil = Date.now() + this.pre("backoffBaseMs");
          } else this.backoff(key);
          this.log(`arming for key=${key.slice(0, 8)} failed: ${errorText(error)}`);
        }
        return false;
      },
    );
  }

  private wantsSpare(key: string, k: KeyState, now: number): boolean {
    if (!k.open || !k.framing || k.settled < 1 || !this.active(k, now) || now < k.backoffUntil) return false;
    if (k.depositMsat > this.pre("maxDepositMsat")) return false;
    if (k.framing === "2" && this.isBad(k.node)) return false;
    const mine = this.entries.filter((e) => e.key === key && e.conn.framing === k.framing);
    if (mine.some((e) => this.isSpare(e))) return false;
    if (k.framing === "2") {
      if (this.http2.reuse === "none") return true;
      // Only while every open connection of the key is busy (a burst would wait for a 2PC).
      if (mine.length === 0 || mine.some((e) => e.state === "idle")) return false;
      if (mine.filter((e) => !this.isSpare(e)).length >= this.opt("maxConnectionsPerKey")) return false;
    }
    return true;
  }

  private startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => this.housekeeping(), this.pre("tickMs"));
    (this.tick as { unref?: () => void }).unref?.();
  }

  /** Retire spares that are too old or whose key went quiet; forget quiet keys. */
  private housekeeping(): void {
    const now = Date.now();
    for (const e of [...this.entries]) {
      if (e.state !== "armed") continue;
      const k = this.keys.get(e.key);
      const old = now - e.conn.tCreated > this.pre("maxAgeMs");
      const quiet = !k || !this.active(k, now);
      // A framing-"2" spare is for a burst: once a connection of its key is idle it is not needed.
      if (old || quiet) this.retireSpare(e, old ? "max age" : "its key has no traffic");
    }
    for (const [key, k] of this.keys) {
      if (!this.active(k, now) && !this.entries.some((e) => e.key === key)) this.keys.delete(key);
    }
    if (!this.entries.some((e) => this.isSpare(e))) {
      if (this.tick) clearInterval(this.tick);
      this.tick = undefined;
    }
    this.replenish();
  }

  private retireSpare(entry: Entry<C>, why: string): void {
    this.unusedDepositMsats += entry.conn.depositMsat;
    this.log(
      `retiring armed sid=${entry.conn.sid.slice(0, 8)} unused (${why}); its deposit of ${entry.conn.depositMsat} msat is charged ` +
        `(${this.unusedDepositMsats} msat for unused spares so far)`,
    );
    this.remove(entry);
    entry.conn.close(`armed and unused: ${why}`);
  }

  private closeSpares(why: string): void {
    for (const e of [...this.entries]) if (this.isSpare(e)) this.retire(e, why);
  }

  /** Close every connection. */
  close(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    for (const e of [...this.entries]) {
      this.remove(e);
      e.conn.close("pool closed");
    }
    this.keys.clear();
  }

  /** Pool state, for status pages and tests (no credentials). */
  snapshot(): { key: string; sid: string; http: ConfidentialFraming; state: string; requests: number; openMs: number }[] {
    const now = Date.now();
    return this.entries.map((e) => ({
      key: e.key.slice(0, 8),
      sid: e.conn.sid.slice(0, 8),
      http: e.conn.framing,
      state: e.state,
      requests: e.conn.requests,
      openMs: e.conn.tOpen ? now - e.conn.tOpen : 0,
    }));
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
