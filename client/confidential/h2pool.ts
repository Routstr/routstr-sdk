/**
 * The pool of `http: 2` confidential connections (protocol v3, option A).
 *
 * A connection costs one two-party handshake (the 2PC preprocessing, π_NK)
 * and then serves requests one at a time. The pool keeps the connections a
 * process has open, by reuse key:
 *
 * - A request takes an idle live connection of its key when there is one,
 *   otherwise it opens another (requests on one connection are sequential, so
 *   overlapping requests need a connection each), up to `maxConnectionsPerKey`
 *   and `maxConnections`; beyond that it waits for one to become idle.
 * - A connection is kept after a settled 2xx request ("pre-warming" for
 *   `http: 2` is exactly this: nothing is opened speculatively). It is closed
 *   `idleMarginMs` before the node's idle limit (the signed offer's
 *   `h2.idle_timeout_s`, counted from the last settlement), after
 *   `maxRequestsPerConnection` requests (at most the offer's
 *   `h2.max_requests`), before the node's connection lifetime, and whenever it
 *   fails. The node closes a connection after any error, abort or non-2xx
 *   response.
 * - A pooled connection is a cache, never a promise: it may be dead when a
 *   request arrives. The transport then runs the request on a fresh one, as
 *   long as nothing of it was released towards the provider.
 *
 * Linkability: the requests of one connection share a TLS connection to the
 * provider and a session with the node, so both can tell they come from one
 * client. `reuse` sets what may share a connection (`Http2Options.reuse`).
 */

import { createHash } from "node:crypto";
import { ConfidentialTimeoutError } from "./errors";
import type { ConfidentialH2Connection } from "./h2conn";

export interface Http2Options {
  /**
   * Use `http: 2` sessions with nodes whose signed offer lists them. Default
   * true; false keeps every request on the v2 flow (one session per request).
   */
  enabled?: boolean;
  /**
   * Which requests may share a connection (and so be linked to each other by
   * the provider and the node):
   * - `credential` (default): requests to one node with one credential;
   * - `model`: as above, and only requests for the same model;
   * - `none`: every request opens its own connection, closed when it settles
   *   (no linking, and no saving: the v2 flow with pre-warming is faster).
   * The node links requests by their credential in any mode; the provider
   * sees the node's key, and a connection tells it which requests belong to
   * one client.
   */
  reuse?: "credential" | "model" | "none";
  /** Open connections per reuse key (default 4): the most overlapping requests served without waiting. */
  maxConnectionsPerKey?: number;
  /** Open connections in total (default 8). */
  maxConnections?: number;
  /**
   * Close an idle connection this long before the node would (default
   * 20 000 ms, and at most a quarter of the node's `h2.idle_timeout_s`, so a
   * node with a short timeout still gets its connections reused).
   */
  idleMarginMs?: number;
  /**
   * Close a connection idle this long (ms). Always clamped below the node's
   * `h2.idle_timeout_s`: the node closes an idle connection at that time.
   */
  maxIdleMs?: number;
  /**
   * The largest connection deposit (msat) to accept from a node's offer
   * (`h2.connection_deposit_msat`; default 100 000). The node reserves it
   * when a connection opens and releases it with the connection's first
   * settled request; a connection that ends without one loses it. A node
   * asking for more is not used over `http: 2` (its requests run the v2 flow).
   */
  maxConnectionDepositMsat?: number;
  /** Close a connection after this many requests (default: the offer's `h2.max_requests`). */
  maxRequestsPerConnection?: number;
  /** How long a request waits for a connection when the limits are reached (default 120 000 ms). */
  acquireTimeoutMs?: number;
  /** Info-level log sink (never receives secrets). Default: console.info. */
  log?: (message: string) => void;
  /** One call per settled request: where it ran and what it cost (measurements). */
  onRequest?: (stats: Http2RequestStats) => void;
}

export interface Http2RequestStats {
  baseUrl: string;
  sid: string;
  /** The request's number on its connection. */
  n: number;
  /** True when the connection was open before the request arrived. */
  reused: boolean;
  status: number;
  /** From the request's arrival to the first response byte, and to settlement (ms). */
  ttftMs?: number;
  totalMs: number;
  /** Opening the connection, when this request did (ms). */
  connectMs?: number;
  /** Bytes client→node and node→client spent on the request (2PC, proofs, relay, control). */
  bytesSent: number;
  bytesRecv: number;
  /** The same for opening the connection, when this request did. */
  connectBytesSent?: number;
  connectBytesRecv?: number;
  /** The connection deposit this request's receipt returned (the connection's first settled request), msat. */
  depositReleasedMsat?: number;
}

export const HTTP2_DEFAULTS = {
  enabled: true,
  reuse: "credential" as const,
  maxConnectionsPerKey: 4,
  maxConnections: 8,
  idleMarginMs: 20_000,
  acquireTimeoutMs: 120_000,
};

/** The node ends a connection this long after it opened (at its next settlement). */
const NODE_CONNECTION_LIFETIME_MS = 3_600_000;
/** Retire a connection this long before that. */
const LIFETIME_MARGIN_MS = 120_000;

/** What decides which requests may share a connection. */
export interface Http2KeyInfo {
  baseUrl: string;
  bearer: string;
  model: string;
  /**
   * The connection-level terms of the offer (`h2ConnectionTerms`): a request
   * priced by a newer offer reuses a connection only when these are the same.
   */
  terms?: string;
  /** A caller-chosen partition (requests with different scopes never share). */
  scope?: string;
}

/** The reuse key: never the credential itself, only a hash of it. */
export function http2PoolKey(info: Http2KeyInfo, reuse: Http2Options["reuse"]): string {
  const h = createHash("sha256");
  for (const part of [info.baseUrl.replace(/\/$/, ""), info.bearer, info.terms ?? "", info.scope ?? ""]) {
    h.update(part);
    h.update("\0");
  }
  if (reuse === "model") h.update(info.model);
  return h.digest("hex").slice(0, 32);
}

/**
 * How long the pool keeps an idle connection (ms): below the node's idle
 * timeout (the signed offer's `h2.idle_timeout_s`, which the node counts
 * from its last settlement or from `head_written`) by the idle margin, and
 * never longer than `maxIdleMs`.
 */
export function http2IdleMs(
  h2: { idle_secs: number; idle_timeout_s?: number },
  options: Pick<Http2Options, "idleMarginMs" | "maxIdleMs"> = {},
): number {
  const nodeMs = Math.min(h2.idle_timeout_s ?? h2.idle_secs, h2.idle_secs) * 1000;
  const margin = Math.min(options.idleMarginMs ?? HTTP2_DEFAULTS.idleMarginMs, nodeMs / 4);
  return Math.min(Math.max(nodeMs - margin, 1000), options.maxIdleMs ?? Infinity);
}

type ConnLike = Pick<
  ConfidentialH2Connection,
  "connect" | "close" | "idle" | "usable" | "requests" | "tOpen" | "tLastSettled" | "ended" | "sid" | "h2" | "failureReason"
>;

interface Entry<C extends ConnLike> {
  key: string;
  conn: C;
  state: "connecting" | "busy" | "idle";
  timer?: ReturnType<typeof setTimeout>;
}

export interface Http2Lease<C extends ConnLike> {
  conn: C;
  /** True when the connection was open before this request. */
  reused: boolean;
  /** The request is over: the connection goes back to the pool, or is closed. */
  release(): void;
}

export class Http2Pool<C extends ConnLike = ConfidentialH2Connection> {
  private entries: Entry<C>[] = [];
  private waiters: (() => void)[] = [];
  private options: Http2Options;

  constructor(options: Http2Options = {}) {
    this.options = options;
  }

  configure(options: Http2Options = {}): void {
    this.options = options;
  }

  private log(message: string): void {
    (this.options.log ?? console.info)(`[confidential http2] ${message}`);
  }

  private opt<K extends keyof typeof HTTP2_DEFAULTS>(k: K): (typeof HTTP2_DEFAULTS)[K] {
    return (this.options[k] ?? HTTP2_DEFAULTS[k]) as (typeof HTTP2_DEFAULTS)[K];
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

  /**
   * A connection for one request of `key`: an idle live one, else a new one
   * (`open` builds it; this connects it), else, at the limits, the next that
   * becomes free. Rejects if the new connection cannot be opened.
   */
  async acquire(key: string, open: () => C, signal?: AbortSignal): Promise<Http2Lease<C>> {
    const deadline = Date.now() + this.opt("acquireTimeoutMs");
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      // Dead connections first (one may have ended without our noticing yet).
      for (const e of [...this.entries]) {
        if (e.state === "idle" && !e.conn.idle) this.remove(e);
      }
      const idle = this.entries.find((e) => e.key === key && e.state === "idle");
      if (idle) {
        if (idle.timer) clearTimeout(idle.timer);
        idle.timer = undefined;
        idle.state = "busy";
        return this.lease(idle, true);
      }
      const mine = this.entries.filter((e) => e.key === key).length;
      if (mine < this.opt("maxConnectionsPerKey")) {
        if (this.entries.length >= this.opt("maxConnections")) {
          // Make room: the idle connection of another key that waited longest.
          const victim = this.entries
            .filter((e) => e.state === "idle")
            .sort((a, b) => a.conn.tLastSettled - b.conn.tLastSettled)[0];
          if (victim) this.retire(victim, "making room for another key");
        }
        if (this.entries.length < this.opt("maxConnections")) {
          const entry: Entry<C> = { key, conn: open(), state: "connecting" };
          this.entries.push(entry);
          void entry.conn.ended.then((e) => {
            if (this.entries.includes(entry)) {
              if (entry.state === "idle") this.log(`sid=${entry.conn.sid.slice(0, 8)} ended while idle: ${e.message}`);
              this.remove(entry);
            }
          });
          try {
            await entry.conn.connect();
          } catch (error) {
            this.remove(entry);
            throw error;
          }
          entry.state = "busy";
          return this.lease(entry, false);
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new ConfidentialTimeoutError("timeout waiting for a free http: 2 connection");
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(left, 1000));
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  private lease(entry: Entry<C>, reused: boolean): Http2Lease<C> {
    let released = false;
    return {
      conn: entry.conn,
      reused,
      release: () => {
        if (released) return;
        released = true;
        this.release(entry);
      },
    };
  }

  private release(entry: Entry<C>): void {
    if (!this.entries.includes(entry)) return;
    const conn = entry.conn;
    const now = Date.now();
    const maxRequests = Math.min(this.options.maxRequestsPerConnection ?? Infinity, conn.h2.max_requests);
    if (!conn.idle) return this.retireQuietly(entry);
    if (this.options.reuse === "none") return this.retire(entry, "reuse is off");
    if (conn.requests >= maxRequests) return this.retire(entry, "request limit reached");
    const lifetimeLeft = conn.tOpen + NODE_CONNECTION_LIFETIME_MS - LIFETIME_MARGIN_MS - now;
    if (lifetimeLeft <= 0) return this.retire(entry, "connection lifetime reached");
    const idleFor = Math.min(http2IdleMs(conn.h2, this.options), lifetimeLeft);
    const closeAt = conn.tLastSettled + idleFor;
    if (closeAt <= now) return this.retire(entry, "idle");
    entry.state = "idle";
    entry.timer = setTimeout(() => {
      if (entry.state === "idle") this.retire(entry, "idle");
    }, closeAt - now);
    (entry.timer as { unref?: () => void }).unref?.();
    this.wake();
  }

  /** A connection that already ended (an error, a non-2xx, GOAWAY): just forget it. */
  private retireQuietly(entry: Entry<C>): void {
    this.remove(entry);
    entry.conn.close("not reusable");
  }

  /** Close every connection. */
  close(): void {
    for (const e of [...this.entries]) {
      this.remove(e);
      e.conn.close("pool closed");
    }
  }

  /** Pool state, for status pages and tests (no credentials). */
  snapshot(): { key: string; sid: string; state: string; requests: number; openMs: number }[] {
    const now = Date.now();
    return this.entries.map((e) => ({
      key: e.key.slice(0, 8),
      sid: e.conn.sid.slice(0, 8),
      state: e.state,
      requests: e.conn.requests,
      openMs: e.conn.tOpen ? now - e.conn.tOpen : 0,
    }));
  }
}
