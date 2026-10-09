/**
 * Trusted-upstream-hostname matcher with wildcard support.
 *
 * This is the check that stops a node from advertising a confidential offer for
 * a host the operator does not trust: when confidential upstream is enabled, a
 * session may only start if the offer's `upstream_host` matches the configured
 * trusted list. An empty list means "no confidential sessions" (fail-closed).
 *
 * Syntax (all comparisons are case-insensitive and trailing-dot normalized):
 *
 *   - `api.venice.ai`      exact hostname
 *   - `*.example.com`      `*` matches **exactly one** label: `a.example.com`
 *                          matches, `a.b.example.com` does not. `example.com`
 *                          itself does NOT match `*.example.com`.
 *   - `**.example.com`     `**` matches **one or more** labels, so both
 *                          `a.example.com` and `a.b.example.com` match (but not
 *                          `example.com`). `**` must occupy a whole label.
 *
 * Deliberately rejected (throw at construction):
 *   - the empty pattern, and whitespace-only patterns;
 *   - a bare `*` or `**` (match-everything would defeat the check);
 *   - patterns with empty labels (`..`, `a..b`), a leading/trailing `.` left
 *     after normalization, or any `/`, `:`, `@`, `*` inside a label other than
 *     a whole-label `*`/`**` (so `api.*.com`, `*foo.com`, `foo.*` are invalid).
 *
 * The matcher is intentionally the only implementation: routstrd imports it
 * from the SDK and unit-tests it there (see routstrd tests) so node and daemon
 * cannot drift.
 */

export class InvalidHostPatternError extends Error {
  constructor(pattern: string, reason: string) {
    super(`invalid trusted host pattern ${JSON.stringify(pattern)}: ${reason}`);
    this.name = "InvalidHostPatternError";
  }
}

/** Lowercase and strip exactly one trailing dot ("example.com." → "example.com"). */
export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function isPlainLabel(label: string): boolean {
  return label.length > 0 && label !== "*" && label !== "**";
}

function validateLabelChars(label: string, pattern: string): void {
  if (/[/:@\s]/.test(label)) {
    throw new InvalidHostPatternError(pattern, `label ${JSON.stringify(label)} contains a reserved character`);
  }
  if (label.includes("*")) {
    throw new InvalidHostPatternError(
      pattern,
      `wildcard must occupy a whole label (offending label ${JSON.stringify(label)})`,
    );
  }
}

/**
 * Parse + validate a trusted-host pattern into labels. Exported so config
 * validation can report a precise error at load time.
 */
export function parseTrustedHostPattern(pattern: string): string[] {
  if (typeof pattern !== "string") {
    throw new InvalidHostPatternError(String(pattern), "not a string");
  }
  const raw = pattern.trim();
  if (!raw) throw new InvalidHostPatternError(pattern, "empty pattern");
  const normalized = normalizeHostname(raw);
  if (!normalized) throw new InvalidHostPatternError(pattern, "empty after normalization");
  if (/[/:@\s]/.test(normalized)) {
    throw new InvalidHostPatternError(pattern, "contains a reserved character (/, :, @ or whitespace)");
  }
  const labels = normalized.split(".");
  for (const label of labels) {
    if (label.length === 0) {
      throw new InvalidHostPatternError(pattern, "empty label");
    }
    if (label === "*" || label === "**") continue;
    validateLabelChars(label, pattern);
  }
  // A bare wildcard matches everything and would defeat the trust check.
  if (labels.length === 1 && (labels[0] === "*" || labels[0] === "**")) {
    throw new InvalidHostPatternError(pattern, "bare wildcard matches every host");
  }
  return labels;
}

/**
 * Match an already-normalized hostname against parsed pattern labels.
 * `**` consumes one or more labels; `*` consumes exactly one.
 */
function matchLabels(hostLabels: string[], patLabels: string[]): boolean {
  let hi = 0;
  let pi = 0;
  while (pi < patLabels.length) {
    const pat = patLabels[pi]!;
    if (pat === "**") {
      // One or more labels; try every split that lets the rest match.
      const remainingPatterns = patLabels.length - pi - 1;
      const minConsume = 1;
      const maxConsume = hostLabels.length - hi - remainingPatterns;
      if (maxConsume < minConsume) return false;
      for (let take = minConsume; take <= maxConsume; take++) {
        if (matchLabels(hostLabels.slice(hi + take), patLabels.slice(pi + 1))) return true;
      }
      return false;
    }
    const host = hostLabels[hi];
    if (host === undefined) return false;
    if (pat !== "*" && pat !== host) return false;
    hi++;
    pi++;
  }
  return hi === hostLabels.length;
}

/** Match one normalized hostname against one pattern. */
export function matchHostname(host: string, pattern: string): boolean {
  const h = normalizeHostname(host);
  if (!h) return false;
  const patLabels = parseTrustedHostPattern(pattern);
  return matchLabels(h.split("."), patLabels);
}

/**
 * Compiled, validated trusted-host list. Construct once from config; call
 * `matches` per offer. `patterns` preserves the operator's original strings;
 * `normalized` is the parsed form.
 */
export class TrustedHostMatcher {
  readonly patterns: readonly string[];
  private readonly parsed: ReadonlyArray<readonly string[]>;

  constructor(patterns: readonly string[]) {
    const parsed: string[][] = [];
    for (const pattern of patterns) {
      parsed.push(parseTrustedHostPattern(pattern));
    }
    this.patterns = [...patterns];
    this.parsed = parsed;
  }

  /** True when the list is empty (no confidential session may start). */
  get isEmpty(): boolean {
    return this.parsed.length === 0;
  }

  matches(host: string): boolean {
    const h = normalizeHostname(host);
    if (!h) return false;
    const labels = h.split(".");
    return this.parsed.some((p) => matchLabels(labels, p as string[]));
  }

  /** Reason string for logs/tests, never includes secrets. */
  describe(host: string): string {
    const h = normalizeHostname(host);
    if (this.isEmpty) return `no trusted hosts configured; rejecting ${JSON.stringify(h)}`;
    const hit = this.patterns.find((p) => matchHostname(h, p));
    return hit
      ? `${JSON.stringify(h)} matched pattern ${JSON.stringify(hit)}`
      : `${JSON.stringify(h)} matched none of [${this.patterns.join(", ")}]`;
  }
}

/** Convenience: does host match any pattern in the list? */
export function isTrustedHost(host: string, patterns: readonly string[]): boolean {
  return new TrustedHostMatcher(patterns).matches(host);
}
