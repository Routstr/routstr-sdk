/**
 * Provider outage reporting for one `fetchModels` pass.
 *
 * A refresh runs on a fixed cadence against a mostly stable provider set, so
 * the same unreachable nodes would otherwise re-print a raw warning every
 * ~21 minutes. This module diffs a pass against the previous pass and returns
 * the lines to emit: raw warnings only for transitions (newly failed, or
 * failing for a different reason), one bounded summary per pass, and the full
 * per-provider detail at `debug`.
 *
 * Pure (previous state in, next state and lines out), so it is testable
 * without a `ModelManager` or a `DiscoveryAdapter`.
 */

/** A provider's failure in one fetch pass, normalized for a one-line summary. */
export interface ProviderFailure {
  /** Short label in parentheses after the host: `530`, `timeout`, `connect`. */
  detail: string;
  /** Untouched error text, kept for the raw per-provider line. */
  message: string;
  /** Reads as "down" (retryable upstream) rather than "unreachable". */
  isDown: boolean;
  /** Consecutive failed passes, so a long outage can be aged in one line. */
  passesFailed: number;
}

/** Classified failure before it has been compared against the previous pass. */
export type ProviderFailureInfo = Omit<ProviderFailure, "passesFailed">;

/** One provider's slot in a pass: no `failure` means it answered. */
export interface ProviderOutcome {
  base: string;
  failure?: ProviderFailureInfo;
}

/** One line to emit, in the order it should be emitted. */
export interface PassLogLine {
  level: "warn" | "info" | "debug";
  message: string;
}

/** The lines to log and the failure state to carry into the next pass. */
export interface ProviderOutageReport {
  lines: PassLogLine[];
  failures: Map<string, ProviderFailure>;
}

/** Hosts named inline in a pass summary before it collapses to "+N more". */
export const SUMMARY_PROVIDER_LIMIT = 6;

export function isProviderDownError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("429")) return true;
  if (msg.includes("502")) return true;
  if (msg.includes("503")) return true;
  if (msg.includes("504")) return true;
  const cause = error.cause as { code?: string } | undefined;
  return cause?.code === "ENOTFOUND";
}

/**
 * Bucket a provider fetch error so passes can be summarized in one line rather
 * than by message. The buckets are the ones an operator acts on differently: an
 * HTTP status means the node is up but rejecting, a timeout means it is slow,
 * `connect` means it is not listening.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureInfo {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = /Failed to fetch models:\s*(\d+)/.exec(message);
  const isDown = isProviderDownError(error);

  const detail =
    status?.[1] ??
    (/timed? ?out|timeout|abort/.test(lower)
      ? "timeout"
      : /unable to connect|connection refused|typo/.test(lower)
        ? "connect"
        : isDown
          ? "down"
          : "error");
  return { detail, message, isDown };
}

/**
 * Diff one fetch pass against the previous pass's failures.
 *
 * A provider that newly fails (or starts failing differently) gets its own
 * warning, so anything alertable stays greppable; one that is merely still down
 * only advances a counter and is reported at `debug`. A provider is "recovered"
 * only when it was actually retried this pass: one dropped from the provider
 * set was never checked, and one served from cache was not re-validated.
 */
export function diffProviderOutage(
  previous: ReadonlyMap<string, ProviderFailure>,
  outcomes: ProviderOutcome[],
  freshlyFetched: ReadonlySet<string>,
  total: number,
  elapsedMs: number
): ProviderOutageReport {
  const lines: PassLogLine[] = [];
  const failures = new Map<string, ProviderFailure>();
  let newlyFailed = 0;

  for (const { base, failure } of outcomes) {
    if (!failure) continue;
    const before = previous.get(base);
    const passesFailed = (before?.passesFailed ?? 0) + 1;
    failures.set(base, { ...failure, passesFailed });

    if (!before || before.message !== failure.message) {
      newlyFailed++;
      lines.push({
        level: "warn",
        message: failure.isDown
          ? `Provider ${base} is down right now.`
          : `Provider ${base} unreachable: ${failure.message}`,
      });
    } else {
      lines.push({
        level: "debug",
        message:
          `Provider ${base} still unreachable ` +
          `(${passesFailed} consecutive failed pass(es)): ${failure.message}`,
      });
    }
  }

  // Only a provider we actually hit over the network this pass can be declared
  // recovered: one dropped from the provider set was never checked, and one
  // served from cache was not re-validated. A failed fetch never writes a
  // freshness stamp, so a previously-failed provider is always retried while it
  // remains in the set.
  const retried = new Set([...freshlyFetched, ...failures.keys()]);
  const recovered = [...previous.keys()].filter(
    (base) => !failures.has(base) && retried.has(base)
  );

  if (failures.size === 0 && recovered.length === 0) {
    lines.push({
      level: "debug",
      message: `Model refresh: all ${total} provider(s) ok in ${formatDuration(elapsedMs)}`,
    });
    return { lines, failures };
  }

  lines.push({
    level: "info",
    message: formatFetchSummary({
      total,
      ok: total - failures.size,
      failures,
      newlyFailed,
      recovered,
      elapsedMs,
    }),
  });
  return { lines, failures };
}

/**
 * One bounded line: counts first, then at most `SUMMARY_PROVIDER_LIMIT` named
 * hosts, so a wide outage cannot produce a flood of lines or an arbitrarily
 * long one.
 */
function formatFetchSummary(input: {
  total: number;
  ok: number;
  failures: Map<string, ProviderFailure>;
  newlyFailed: number;
  recovered: string[];
  elapsedMs: number;
}): string {
  const { total, ok, failures, newlyFailed, recovered, elapsedMs } = input;
  const parts = [`${ok}/${total} providers ok`];

  if (failures.size > 0) {
    parts.push(
      `${failures.size} unavailable ` +
        `(${newlyFailed} new, ${failures.size - newlyFailed} unchanged)`
    );
  }
  if (recovered.length > 0) {
    parts.push(`recovered: ${formatProviderList(recovered.map(providerHost))}`);
  }

  const down = Array.from(failures, ([base, failure]) =>
    `${providerHost(base)}(${failure.detail})`
  );
  const summary = `Model refresh: ${parts.join(", ")} in ${formatDuration(elapsedMs)}`;

  return down.length > 0 ? `${summary} — ${formatProviderList(down)}` : summary;
}

/**
 * Host-only provider label: the scheme and path are identical across the
 * routstr fleet, so the host is the shortest stable identifier in a log line.
 */
function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Join labels, naming at most `SUMMARY_PROVIDER_LIMIT` before "+N more". */
function formatProviderList(labels: string[]): string {
  const shown = labels.slice(0, SUMMARY_PROVIDER_LIMIT);
  const hidden = labels.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")}, +${hidden} more` : shown.join(", ");
}

function formatDuration(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}
