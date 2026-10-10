/**
 * Traffic-driven pre-warming of protocol v2 confidential sessions.
 *
 * A v2 session spends most of a cold request in the 2PC preprocessing (~21 MB
 * each way, ~25 s on a home uplink). Everything after the joint key share is
 * fast, and the sidecar lets a session wait in that state ("armed": setup,
 * preprocessing and key share done, no ClientHello yet) for up to 600 s from
 * setup. This pool keeps a few armed sessions for keys that are seeing
 * traffic, so the next request skips the preprocessing.
 *
 * Policy (all knobs in `PrewarmOptions`):
 *
 * - Pool key: (node base URL, model, max_tokens, credential). max_tokens must
 *   match exactly (the pinned suffix carries it) and the credential is the one
 *   the node reserves on at setup.
 * - Traffic only. Nothing is armed at startup or for a key without a request
 *   in the last `activityWindowMs` (10 min). An idle pool has no timer.
 * - target(K) = 0 if K had no request in the activity window (and none is in
 *   flight); else 1, raised to 2 if K saw ≥ `burstCount` (3) requests in the
 *   last `burstWindowMs` (5 min), and to the peak number of overlapping
 *   requests seen in the window; capped at `maxPerKey` (3). The sum over all
 *   keys is capped at `maxTotal` (4); most recently active keys go first.
 * - Arms run one at a time (`maxConcurrentArms`, 1): preprocessing is
 *   bandwidth-heavy. None starts while a cold request is still in its own
 *   preprocessing, and replenishing happens off the request path (after a
 *   warm claim, at a response head, at completion, or on the tick).
 * - Body length: `len` is fixed at setup. A session armed for L serves any
 *   body ≤ L (padded with spaces before the pinned suffix). L = the largest
 *   pinned body among the last `historySize` (20) requests for K × `headroom`
 *   (1.25), rounded up to a power of two, ≥ `minBucket` (4 KiB), ≤
 *   `maxBucket` (8 MiB). A request larger than every armed L goes cold and
 *   raises L for later arms; armed sessions smaller than the new L are
 *   replaced.
 * - Retire: a session older than `maxAgeMs` (480 s from setup; the node and
 *   sidecar end a session 600 s after setup) is closed, and replaced only if
 *   K is still active. When K goes idle its armed sessions are closed at once
 *   (the node then releases their reservations; nothing is charged).
 * - Failures: a failed arm backs K off (`backoffBaseMs` doubling up to
 *   `backoffMaxMs`). A claimed session that fails before the credential
 *   record is released falls back to a cold session (the transport does
 *   this); never after.
 * - Funds: every armed session holds a reservation on the credential (a
 *   full-context prompt plus max_tokens at the offer rates). A key is armed
 *   only after one of its requests settled (the receipt reports the
 *   reservation R), and only while the credential's available balance (the
 *   node's balance minus every reservation, armed sessions included) is at
 *   least `fundsHeadroom` × R (default 2: the new arm plus one cold request).
 */

import { createHash } from "node:crypto";

export interface PrewarmOptions {
  /** Default true (an options object opts in). */
  enabled?: boolean;
  /** A key with no request for this long is idle: no arms, armed ones closed. */
  activityWindowMs?: number;
  /** Burst detection window and count (→ 2 armed). */
  burstWindowMs?: number;
  burstCount?: number;
  maxPerKey?: number;
  maxTotal?: number;
  /** Retire armed sessions older than this (from setup). */
  maxAgeMs?: number;
  /** Requests remembered per key (bucket choice). */
  historySize?: number;
  minBucket?: number;
  maxBucket?: number;
  headroom?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Housekeeping interval while any key has state. */
  tickMs?: number;
  /** Arm only if available balance ≥ fundsHeadroom × the key's reservation. */
  fundsHeadroom?: number;
  /** Concurrent arms across all keys. */
  maxConcurrentArms?: number;
  /** Info-level log sink (never receives secrets). Default: console.info. */
  log?: (message: string) => void;
}

export const PREWARM_DEFAULTS = {
  enabled: true,
  activityWindowMs: 10 * 60_000,
  burstWindowMs: 5 * 60_000,
  burstCount: 3,
  maxPerKey: 3,
  maxTotal: 4,
  maxAgeMs: 480_000,
  historySize: 20,
  minBucket: 4096,
  maxBucket: 8 << 20,
  headroom: 1.25,
  backoffBaseMs: 30_000,
  backoffMaxMs: 10 * 60_000,
  tickMs: 15_000,
  fundsHeadroom: 2,
  maxConcurrentArms: 1,
};

type Config = typeof PREWARM_DEFAULTS & { log: (message: string) => void };

/** Power-of-two body-length bucket for the given largest recent body. */
export function chooseBucket(
  maxLen: number,
  opts: { minBucket?: number; maxBucket?: number; headroom?: number } = {},
): number {
  const min = opts.minBucket ?? PREWARM_DEFAULTS.minBucket;
  const max = opts.maxBucket ?? PREWARM_DEFAULTS.maxBucket;
  const want = Math.ceil(Math.max(0, maxLen) * (opts.headroom ?? PREWARM_DEFAULTS.headroom));
  let b = min;
  while (b < want && b < max) b *= 2;
  return Math.min(b, max);
}

/**
 * Pad a pinned body (private JSON part + canonical suffix) to exactly
 * `length` bytes with ASCII spaces between the private part and the suffix.
 * JSON allows whitespace before the `,` that starts the suffix, so the result
 * parses to the same object, and the suffix still ends the body (it is still
 * written as its own final record).
 */
export function padPinnedBody(body: Uint8Array, length: number, suffix: string): Uint8Array {
  const s = new TextEncoder().encode(suffix);
  if (!endsWith(body, s)) throw new RangeError("body does not end with the pinned suffix");
  if (body.length > length) throw new RangeError(`body ${body.length} exceeds armed length ${length}`);
  if (body.length === length) return body;
  const out = new Uint8Array(length);
  const cut = body.length - s.length;
  out.set(body.subarray(0, cut), 0);
  out.fill(0x20, cut, length - s.length);
  out.set(s, length - s.length);
  return out;
}

export function endsWith(body: Uint8Array, tail: Uint8Array): boolean {
  if (tail.length > body.length) return false;
  const off = body.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (body[off + i] !== tail[i]) return false;
  return true;
}

/** What the pool needs from a session. */
export interface ArmedSessionLike {
  readonly bodyLength: number;
  readonly healthy: boolean;
  sid: string;
  close(): void;
}

export interface ArmHandle<S extends ArmedSessionLike> {
  /** Resolves once the session is armed (key share ready). */
  ready: Promise<S>;
  /** Close the session (armed or still arming). */
  cancel(): void;
}

export interface PoolKeyInfo {
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** The node credential (never logged; only hashed into the key). */
  bearer: string;
}

export interface PrewarmDeps<S extends ArmedSessionLike, C> {
  now?: () => number;
  /** Start arming a session for this key and body length. */
  arm(info: PoolKeyInfo, ctx: C, bodyLength: number): ArmHandle<S>;
  /** The credential's available balance on the node (msats), if known. */
  availableMsats?(info: PoolKeyInfo, ctx: C): Promise<number | undefined>;
  /** Housekeeping timer; return a cancel function. Default: unref'd setInterval. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Entry<S extends ArmedSessionLike> {
  id: number;
  bodyLength: number;
  startedAt: number;
  state: "arming" | "ready";
  taken: boolean;
  handle: ArmHandle<S>;
  session?: S;
}

interface RequestRecord {
  t: number;
  len: number;
  warm?: boolean;
  concurrency: number;
}

interface KeyState<S extends ArmedSessionLike, C> {
  key: string;
  info: PoolKeyInfo;
  ctx: C;
  label: string;
  history: RequestRecord[];
  inFlight: number;
  /** Cold requests still in their own preprocessing. */
  coldPrep: number;
  lastActivity: number;
  entries: Entry<S>[];
  reservationMsats?: number;
  failures: number;
  backoffUntil: number;
  fundsCheck?: Promise<void>;
  noted: Set<string>;
}

export interface Lease<S extends ArmedSessionLike> {
  /** Armed (already, or once the in-progress arm finishes). */
  session: Promise<S>;
  bodyLength: number;
  /** True if the session was already armed when taken. */
  ready: boolean;
}

export interface RequestTicket<S extends ArmedSessionLike> {
  /** Take an armed (or arming) session that fits this request, if any. */
  take(): Lease<S> | undefined;
  /** The request runs cold (its own preprocessing) until head(). */
  cold(): void;
  warm(): void;
  /** The response head arrived: preprocessing is over; replenish. */
  head(): void;
  /** The request ended (settled or failed). `reservedMsats` from the receipt. */
  end(reservedMsats?: number): void;
  /** Log a line about this request under the key's label (no secrets). */
  log(message: string): void;
}

export function poolKey(info: PoolKeyInfo): string {
  const cred = createHash("sha256").update(info.bearer).digest("hex").slice(0, 16);
  return `${info.baseUrl.replace(/\/$/, "")}|${info.model}|${info.maxTokens}|${cred}`;
}

export class PrewarmPool<S extends ArmedSessionLike, C = unknown> {
  private cfg: Config;
  private readonly deps: PrewarmDeps<S, C>;
  private readonly now: () => number;
  private readonly keys = new Map<string, KeyState<S, C>>();
  private nextId = 1;
  private cancelTimer?: () => void;
  private closed = false;

  constructor(options: PrewarmOptions, deps: PrewarmDeps<S, C>) {
    this.cfg = PrewarmPool.config(options);
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private static config(options: PrewarmOptions): Config {
    const defined = Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    ) as PrewarmOptions;
    return {
      ...PREWARM_DEFAULTS,
      log: (m: string) => console.info(m),
      ...defined,
    } as Config;
  }

  /** Update the policy (e.g. the caller's config changed). */
  configure(options: PrewarmOptions): void {
    this.cfg = PrewarmPool.config(options);
  }

  get enabled(): boolean {
    return this.cfg.enabled && !this.closed;
  }

  private log(msg: string): void {
    try {
      this.cfg.log(`[confidential-prewarm] ${msg}`);
    } catch {
      /* logging must never break a request */
    }
  }

  // ── observability (tests, status) ──────────────────────────────────────

  /** Armed (ready, untaken) and arming counts per key. */
  snapshot(): { key: string; label: string; ready: number; arming: number; lengths: number[]; target: number }[] {
    const now = this.now();
    return [...this.keys.values()].map((k) => ({
      key: k.key,
      label: k.label,
      ready: k.entries.filter((e) => e.state === "ready" && !e.taken).length,
      arming: k.entries.filter((e) => e.state === "arming" && !e.taken).length,
      lengths: k.entries.filter((e) => !e.taken).map((e) => e.bodyLength),
      target: this.target(k, now),
    }));
  }

  get totalPooled(): number {
    let n = 0;
    for (const k of this.keys.values()) n += k.entries.filter((e) => !e.taken).length;
    return n;
  }

  // ── policy ─────────────────────────────────────────────────────────────

  /** How many armed sessions key K should hold now. */
  target(k: KeyState<S, C>, now = this.now()): number {
    const recent = k.history.filter((r) => r.t > now - this.cfg.activityWindowMs);
    if (recent.length === 0 && k.inFlight === 0) return 0;
    let t = 1;
    const burst = k.history.filter((r) => r.t > now - this.cfg.burstWindowMs).length;
    if (burst >= this.cfg.burstCount) t = 2;
    for (const r of recent) t = Math.max(t, r.concurrency);
    return Math.min(t, this.cfg.maxPerKey);
  }

  /** Body length to arm new sessions for K with. */
  desiredLength(k: KeyState<S, C>): number {
    const lens = k.history.slice(-this.cfg.historySize).map((r) => r.len);
    return chooseBucket(lens.length ? Math.max(...lens) : 0, this.cfg);
  }

  // ── request path ───────────────────────────────────────────────────────

  /** Record a request for `info` with a pinned body of `bodyLength` bytes. */
  begin(info: PoolKeyInfo, ctx: C, bodyLength: number): RequestTicket<S> {
    const key = poolKey(info);
    const now = this.now();
    let k = this.keys.get(key);
    if (!k) {
      k = {
        key,
        info,
        ctx,
        label: `${info.model}@${hostOf(info.baseUrl)} max_tokens=${info.maxTokens}`,
        history: [],
        inFlight: 0,
        coldPrep: 0,
        lastActivity: now,
        entries: [],
        failures: 0,
        backoffUntil: 0,
        noted: new Set(),
      };
      this.keys.set(key, k);
    }
    k.info = info;
    k.ctx = ctx;
    k.inFlight += 1;
    k.lastActivity = now;
    const rec: RequestRecord = { t: now, len: bodyLength, concurrency: k.inFlight };
    k.history.push(rec);
    if (k.history.length > Math.max(this.cfg.historySize, 64)) k.history.shift();
    this.ensureTimer();
    const st = k;
    let coldMarked = false;
    let ended = false;
    const clearCold = () => {
      if (coldMarked) {
        coldMarked = false;
        st.coldPrep = Math.max(0, st.coldPrep - 1);
      }
    };
    return {
      take: () => {
        const lease = this.enabled ? this.take(st, bodyLength) : undefined;
        if (!lease && this.enabled && st.entries.some((e) => !e.taken && e.bodyLength < bodyLength)) {
          this.log(`${st.label}: body ${bodyLength} B exceeds every armed length; cold, later arms use ${this.desiredLength(st)} B`);
        }
        return lease;
      },
      cold: () => {
        rec.warm = false;
        if (!coldMarked) {
          coldMarked = true;
          st.coldPrep += 1;
        }
      },
      warm: () => {
        rec.warm = true;
        clearCold();
        // A warm claim uses little bandwidth: replenish now.
        this.reconcile();
      },
      head: () => {
        clearCold();
        this.reconcile();
      },
      log: (message: string) => this.log(`${st.label}: ${message}`),
      end: (reservedMsats?: number) => {
        if (ended) return;
        ended = true;
        clearCold();
        st.inFlight = Math.max(0, st.inFlight - 1);
        st.lastActivity = this.now();
        if (typeof reservedMsats === "number" && reservedMsats > 0) {
          st.reservationMsats = Math.max(st.reservationMsats ?? 0, reservedMsats);
        }
        this.reconcile();
      },
    };
  }

  private take(k: KeyState<S, C>, bodyLength: number): Lease<S> | undefined {
    const now = this.now();
    this.prune(k, now);
    const fits = (e: Entry<S>) =>
      !e.taken && e.bodyLength >= bodyLength && now - e.startedAt <= this.cfg.maxAgeMs;
    const byAge = (a: Entry<S>, b: Entry<S>) => a.startedAt - b.startedAt;
    const ready = k.entries.filter((e) => fits(e) && e.state === "ready" && e.session?.healthy).sort(byAge)[0];
    const pick = ready ?? k.entries.filter((e) => fits(e) && e.state === "arming").sort(byAge)[0];
    if (!pick) return undefined;
    pick.taken = true;
    this.log(
      `${k.label}: claim ${pick.state === "ready" ? "armed" : "arming"} session` +
        `${pick.session?.sid ? ` sid=${short(pick.session.sid)}` : ""} len=${pick.bodyLength} body=${bodyLength} ` +
        `age=${Math.round((now - pick.startedAt) / 1000)}s`,
    );
    const session = pick.handle.ready;
    // Taken entries leave the pool as soon as their arm settles.
    session.then(
      () => this.remove(k, pick),
      () => this.remove(k, pick),
    );
    return { session, bodyLength: pick.bodyLength, ready: pick.state === "ready" };
  }

  private remove(k: KeyState<S, C>, e: Entry<S>): void {
    const i = k.entries.indexOf(e);
    if (i >= 0) k.entries.splice(i, 1);
  }

  /** Drop dead untaken sessions. */
  private prune(k: KeyState<S, C>, now: number): void {
    for (const e of [...k.entries]) {
      if (e.taken) continue;
      if (e.state === "ready" && !e.session?.healthy) {
        this.log(`${k.label}: armed session sid=${short(e.session?.sid)} died; dropped`);
        this.retire(k, e, null);
      } else if (now - e.startedAt > this.cfg.maxAgeMs) {
        this.retire(k, e, `age ${Math.round((now - e.startedAt) / 1000)}s > ${Math.round(this.cfg.maxAgeMs / 1000)}s`);
      }
    }
  }

  private retire(k: KeyState<S, C>, e: Entry<S>, reason: string | null): void {
    this.remove(k, e);
    if (reason) {
      this.log(`${k.label}: retire ${e.state} session${e.session?.sid ? ` sid=${short(e.session.sid)}` : ""} len=${e.bodyLength} (${reason})`);
    }
    try {
      e.handle.cancel();
    } catch {
      /* ignore */
    }
  }

  // ── housekeeping ───────────────────────────────────────────────────────

  /** Bring every key to its target. Called on request events and the tick. */
  reconcile(): void {
    if (this.closed) return;
    const now = this.now();
    const keys = [...this.keys.values()].sort((a, b) => b.lastActivity - a.lastActivity);
    // Shrink first (idle keys, age, oversupply, undersized), then grow.
    for (const k of keys) {
      this.prune(k, now);
      const target = this.enabled ? this.target(k, now) : 0;
      const pooled = k.entries.filter((e) => !e.taken).sort((a, b) => a.startedAt - b.startedAt);
      if (target === 0 && pooled.length) {
        for (const e of pooled) this.retire(k, e, "key idle");
        continue;
      }
      const want = this.desiredLength(k);
      for (const e of pooled) {
        if (e.bodyLength < want && e.state === "ready") this.retire(k, e, `length ${e.bodyLength} < ${want}`);
      }
      const left = k.entries.filter((e) => !e.taken).sort((a, b) => a.startedAt - b.startedAt);
      for (let i = 0; i < left.length - target; i++) this.retire(k, left[i]!, `above target ${target}`);
    }
    let total = this.totalPooled;
    let arming = 0;
    for (const k of keys) arming += k.entries.filter((e) => e.state === "arming").length;
    const coldPrep = keys.some((k) => k.coldPrep > 0);
    for (const k of keys) {
      const target = this.enabled ? this.target(k, now) : 0;
      const pooled = k.entries.filter((e) => !e.taken).length;
      const keyArming = k.entries.some((e) => e.state === "arming");
      if (pooled >= target || keyArming) continue;
      if (total >= this.cfg.maxTotal || arming >= this.cfg.maxConcurrentArms || coldPrep) continue;
      if (now < k.backoffUntil) continue;
      if (k.reservationMsats === undefined) {
        this.note(k, "await-receipt", `${k.label}: waiting for a settled request before arming (reservation unknown)`);
        continue;
      }
      if (k.fundsCheck) continue;
      this.startArm(k, target, pooled);
      total += 1;
      arming += 1;
    }
    if (this.keys.size === 0) this.stopTimer();
    for (const k of keys) {
      if (k.inFlight === 0 && k.entries.length === 0 && this.target(k, now) === 0 && !k.fundsCheck) {
        this.keys.delete(k.key);
      }
    }
    if (this.keys.size === 0) this.stopTimer();
  }

  private note(k: KeyState<S, C>, tag: string, msg: string): void {
    if (k.noted.has(tag)) return;
    k.noted.add(tag);
    this.log(msg);
  }

  private startArm(k: KeyState<S, C>, target: number, pooled: number): void {
    const len = this.desiredLength(k);
    const reserve = k.reservationMsats!;
    // The entry exists from now on (so concurrent reconciles see an arm in
    // flight and a request may take it); its promise settles with the arm.
    let resolve!: (s: S) => void;
    let reject!: (e: Error) => void;
    const ready = new Promise<S>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    ready.catch(() => {});
    let real: ArmHandle<S> | undefined;
    let cancelled = false;
    const entry: Entry<S> = {
      id: this.nextId++,
      bodyLength: len,
      startedAt: this.now(),
      state: "arming",
      taken: false,
      handle: {
        ready,
        cancel: () => {
          cancelled = true;
          if (real) real.cancel();
          else reject(new Error("pre-warm cancelled"));
        },
      },
    };
    k.entries.push(entry);
    const funds = this.deps.availableMsats
      ? this.deps.availableMsats(k.info, k.ctx).catch(() => undefined)
      : Promise.resolve(Number.POSITIVE_INFINITY);
    k.fundsCheck = funds.then((available) => {
      k.fundsCheck = undefined;
      if (cancelled || this.closed) {
        reject(new Error("pre-warm cancelled"));
        return;
      }
      const need = this.cfg.fundsHeadroom * reserve;
      if (available === undefined || available < need) {
        this.remove(k, entry);
        reject(new Error("insufficient balance for a pre-warmed session"));
        this.backoff(
          k,
          `available balance ${available ?? "unknown"} msats < ${need} msats (${this.cfg.fundsHeadroom} × reservation)`,
        );
        return;
      }
      entry.startedAt = this.now();
      this.log(`${k.label}: arming session len=${len} (have ${pooled}, target ${target})`);
      try {
        real = this.deps.arm(k.info, k.ctx, len);
      } catch (e) {
        this.remove(k, entry);
        reject(e instanceof Error ? e : new Error(String(e)));
        this.backoff(k, errText(e));
        return;
      }
      real.ready.then(
        (session) => {
          entry.session = session;
          if (cancelled) {
            real!.cancel();
            reject(new Error("pre-warm cancelled"));
            return;
          }
          entry.state = "ready";
          k.failures = 0;
          k.noted.delete("await-receipt");
          this.log(
            `${k.label}: armed sid=${short(session.sid)} len=${len} in ${Math.round((this.now() - entry.startedAt) / 100) / 10}s` +
              (entry.taken ? " (already claimed)" : ""),
          );
          resolve(session);
          this.reconcile();
        },
        (e) => {
          const counts = !cancelled;
          this.remove(k, entry);
          reject(e instanceof Error ? e : new Error(String(e)));
          if (counts) this.backoff(k, errText(e));
          this.reconcile();
        },
      );
    });
  }

  private backoff(k: KeyState<S, C>, why: string): void {
    k.failures += 1;
    const ms = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (k.failures - 1));
    k.backoffUntil = this.now() + ms;
    this.log(`${k.label}: arm failed (${why}); backing off ${Math.round(ms / 1000)}s`);
  }

  private ensureTimer(): void {
    if (this.cancelTimer || this.closed) return;
    const schedule =
      this.deps.schedule ??
      ((fn: () => void, ms: number) => {
        const h = setInterval(fn, ms);
        (h as { unref?: () => void }).unref?.();
        return () => clearInterval(h);
      });
    this.cancelTimer = schedule(() => this.reconcile(), this.cfg.tickMs);
  }

  private stopTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** Close every pooled session and stop. */
  close(): void {
    this.closed = true;
    for (const k of this.keys.values()) {
      for (const e of [...k.entries]) if (!e.taken) this.retire(k, e, "pool closed");
    }
    this.keys.clear();
    this.stopTimer();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function short(sid: string | undefined): string {
  return sid ? sid.slice(0, 8) : "?";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
