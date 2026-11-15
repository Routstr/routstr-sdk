/**
 * Client-side deadlines for inference requests.
 *
 * Discovery and metadata fetches were already bounded (see
 * `discovery/providerDeadline.ts`), but the inference request itself had no
 * local deadline at all: `fetch` was called with only the caller's abort
 * signal, so a provider that accepted the connection and then stopped talking
 * held the request until the runtime's own ~300 s network timeout. Nothing
 * fired earlier, so no cooldown was recorded and no failover was attempted.
 *
 * Two separate budgets are needed, because they protect against different
 * failures:
 *
 * - **Time to first byte.** A provider that never returns response headers is
 *   useless; failing over early is strictly better than waiting. This covers
 *   `fetch` up to the point where headers resolve.
 * - **Inter-chunk idle.** Once a streaming answer has started, a fixed overall
 *   deadline would truncate legitimate long generations. Instead, the clock is
 *   re-armed on every chunk: only an actual stall (silence) is fatal. A healthy
 *   stream that keeps emitting tokens is never cut off, however long it runs.
 *
 * A non-streaming body is different from an idle stream: silence until the
 * complete body arrives is expected, so it gets its own overall budget instead
 * of the inter-chunk one.
 *
 * Aborting the composed signal is enough to interrupt both phases: a pending
 * `fetch` rejects with the reason, and so does a pending `reader.read()` on an
 * already-started body (verified on Bun 1.4).
 */

/**
 * Response headers must arrive within this budget.
 *
 * Chosen from measured traffic, not intuition. Across 9 145 successful attempts
 * on a production routstrd, TTFB was p50 4.9 s / p99 33.5 s, but reasoning
 * models legitimately went far past that: 12 successful streaming requests
 * (`kimi-k3.1-pro`, `deepseek-v4.1-flash-1017`) took 60-259 s before their first
 * byte, because they emit nothing while thinking. A 60 s budget would have
 * aborted those real, paid-for answers.
 *
 * At 180 s the observed false-positive rate is 3 of 9 145 (0.03 %), while the
 * failure this bounds — a provider that accepts the connection and never
 * answers — is still cut well before the runtime's own ~300-360 s. Lower it for
 * a stricter node; raise it if your models think for longer.
 */
export const DEFAULT_TTFB_TIMEOUT_MS = 180_000;

/**
 * A started stream may stay silent this long between chunks before it is
 * treated as stalled.
 *
 * Only silence while a read is in progress counts (see `withProgress`), and a
 * provider may legitimately send its `200` headers and then emit nothing while
 * a reasoning model thinks — so this is deliberately generous. There is no
 * failover at this point (bytes already reached the caller), so the only cost
 * of a larger value is how long a genuinely stalled stream takes to surface as
 * an error; the cost of too small a value is truncating a paid-for answer.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

/**
 * Overall budget for a non-streaming body, measured from the headers. Disabled
 * by default: those responses are legitimately silent until complete, and the
 * runtime already bounds them.
 */
export const DEFAULT_BODY_TIMEOUT_MS = 0;

export type DeadlinePhase = "ttfb" | "idle" | "body";

/**
 * Raised when one of the local inference deadlines expires.
 *
 * `name` is `TimeoutError` so it classifies like a runtime timeout rather than
 * inventing a new error class for callers that switch on `error.name`.
 */
export class InferenceTimeoutError extends Error {
  readonly phase: DeadlinePhase;
  readonly timeoutMs: number;

  constructor(phase: DeadlinePhase, timeoutMs: number, baseUrl?: string) {
    const description =
      phase === "ttfb"
        ? "no response headers"
        : phase === "idle"
          ? "stream stalled"
          : "response body not completed";
    super(
      `Inference request timed out after ${timeoutMs}ms` +
        (baseUrl ? ` for ${baseUrl}` : "") +
        `: ${description}`
    );
    this.name = "TimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export function isInferenceTimeoutError(
  error: unknown
): error is InferenceTimeoutError {
  return error instanceof InferenceTimeoutError;
}

/** Per-request deadline configuration. Zero or negative disables a budget. */
export interface InferenceDeadlines {
  /** Response headers (time to first byte). Defaults to 60 s; 0 disables. */
  ttfbMs?: number;
  /** Silence allowed between stream chunks. Defaults to 120 s; 0 disables. */
  idleMs?: number;
  /** Overall budget for a non-streaming body. Disabled by default. */
  bodyMs?: number;
}

export interface DeadlineHandle {
  signal: AbortSignal;
  /** Why the composed signal aborted, if it did. */
  reason(): unknown;
  /** True when a local deadline (not the caller) ended this request. */
  timedOut(): boolean;
  /** Phase of the budget that expired, when `timedOut()` is true. */
  timedOutPhase(): DeadlinePhase | undefined;
  /** Arm the headers budget. */
  armTtfb(): void;
  /** Re-arm for a non-streaming body. */
  armBody(): void;
  /** Re-arm the inter-chunk budget; call when a read begins. */
  armIdle(): void;
  /** Pause the current budget without aborting; call when a read returns. */
  suspend(): void;
  /** True when a budget is active (non-zero), so callers can skip work. */
  hasBudget(phase: DeadlinePhase): boolean;
  /** Release the timer and the caller listener. Safe to call repeatedly. */
  dispose(): void;
}

const noop = () => {};

/**
 * Compose the caller's abort signal with the local inference budgets.
 *
 * The two remain distinguishable: the handle reports *why* it aborted, so a
 * local deadline can reach the failover path as a provider fault while a
 * caller abort stays an `AbortError` that must not be recorded as one.
 */
export function createDeadlineHandle(options: {
  signal?: AbortSignal;
  deadlines?: InferenceDeadlines;
  baseUrl?: string;
  /**
   * Whether the caller asked for a stream. A non-streaming request has no
   * first-byte boundary of its own (headers arrive with the finished answer),
   * so its initial budget is the body one rather than the short headers one.
   */
  streaming?: boolean;
}): DeadlineHandle {
  const configured = options.deadlines ?? {};
  const ttfbMs = configured.ttfbMs ?? DEFAULT_TTFB_TIMEOUT_MS;
  const idleMs = configured.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const bodyMs = configured.bodyMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const initialPhase: DeadlinePhase = options.streaming === false ? "body" : "ttfb";
  const active = (ms: number) => Number.isFinite(ms) && ms > 0;

  const controller = new AbortController();
  const caller = options.signal;
  let phase: DeadlinePhase = "ttfb";
  let timeoutMs = ttfbMs;
  let expiredPhase: DeadlinePhase | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const onCallerAbort = () => abort(caller?.reason);

  function abort(reason?: unknown): void {
    if (settled) return;
    settled = true;
    clear();
    controller.abort(reason ?? (expiredPhase ? new InferenceTimeoutError(expiredPhase, timeoutMs, options.baseUrl) : undefined));
  }

  const arm = (nextPhase: DeadlinePhase, nextTimeoutMs: number): void => {
    clear();
    phase = nextPhase;
    timeoutMs = nextTimeoutMs;
    if (settled || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      expiredPhase = phase;
      abort();
    }, timeoutMs);
  };

  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  arm(initialPhase, initialPhase === "body" ? bodyMs : ttfbMs);

  return {
    signal: controller.signal,
    reason: () => (controller.signal.aborted ? controller.signal.reason : undefined),
    timedOut: () => expiredPhase !== undefined,
    timedOutPhase: () => expiredPhase,
    armTtfb: () => arm("ttfb", ttfbMs),
    armBody: () => arm("body", bodyMs),
    armIdle: () => arm("idle", idleMs),
    suspend: clear,    hasBudget: (next: DeadlinePhase) =>
      active(next === "ttfb" ? ttfbMs : next === "idle" ? idleMs : bodyMs),
    dispose() {
      settled = true;
      clear();
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Observe reads on a response body, without altering the bytes or their chunk
 * boundaries. Cancelling the source is forwarded.
 *
 * The hooks fire around each read, which is the only window in which the
 * provider is actually being waited on: while the consumer is not reading, a
 * silent upstream is backpressure, not a stall. Bounding the wrong window would
 * abort a healthy stream whenever its reader paused.
 */
export function withProgress(
  body: ReadableStream<Uint8Array>,
  hooks: {
    /** A read is about to wait on the upstream. */
    onWaitStart?: () => void;
    /** The read returned (or threw); nothing is waiting any more. */
    onWaitEnd?: () => void;
    /** The read failed because a local deadline expired. */
    onStalled?: () => void;
  }
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      hooks.onWaitStart?.();
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        // A deadline abort surfaces as the signal's reason (a TimeoutError),
        // which is distinguishable from a caller cancel or a socket failure.
        if (!cancelled && (error as { name?: unknown })?.name === "TimeoutError") {
          hooks.onStalled?.();
        }
        controller.error(error);
      } finally {
        hooks.onWaitEnd?.();
      }
    },
    cancel(reason) {
      cancelled = true;
      void reader.cancel(reason).catch(noop);
    },
  });
}
