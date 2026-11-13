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
 * An entry may name the provider's API base after the host,
 * `api.venice.ai/api/v1`: the node's request heads must then use exactly
 * that base plus the endpoint (`/api/v1/chat/completions`). A bare host
 * allows the two common bases, `/v1` and `/api/v1` (`DEFAULT_API_BASES`).
 * A base is a canonical path: `/`-separated segments of `[A-Za-z0-9._~-]`,
 * no `.`/`..` or empty segment, no trailing slash.
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

/** The API bases a trusted host without an explicit one allows. */
export const DEFAULT_API_BASES: readonly string[] = ["/v1", "/api/v1"];

const CANONICAL_BASE = /^(\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)+$/;

/**
 * Split a trusted-host entry into its host pattern and optional API base
 * (`api.venice.ai/api/v1` → `api.venice.ai`, `/api/v1`).
 */
export function parseTrustedHostEntry(entry: string): { labels: string[]; base?: string } {
  if (typeof entry !== "string") throw new InvalidHostPatternError(String(entry), "not a string");
  const raw = entry.trim();
  const slash = raw.indexOf("/");
  if (slash < 0) return { labels: parseTrustedHostPattern(raw) };
  const base = raw.slice(slash);
  if (!CANONICAL_BASE.test(base)) {
    throw new InvalidHostPatternError(entry, `API base ${JSON.stringify(base)} is not a canonical path`);
  }
  return { labels: parseTrustedHostPattern(raw.slice(0, slash)), base };
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
  const patLabels = parseTrustedHostEntry(pattern).labels;
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
  private readonly bases: ReadonlyArray<string | undefined>;

  constructor(patterns: readonly string[]) {
    const parsed: string[][] = [];
    const bases: (string | undefined)[] = [];
    for (const pattern of patterns) {
      const entry = parseTrustedHostEntry(pattern);
      parsed.push(entry.labels);
      bases.push(entry.base);
    }
    this.patterns = [...patterns];
    this.parsed = parsed;
    this.bases = bases;
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

  /**
   * The API bases the entries matching `host` allow (an entry without a base
   * allows `DEFAULT_API_BASES`); empty when no entry matches.
   */
  apiBases(host: string): string[] {
    const h = normalizeHostname(host);
    if (!h) return [];
    const labels = h.split(".");
    const out = new Set<string>();
    this.parsed.forEach((p, i) => {
      if (!matchLabels(labels, p as string[])) return;
      for (const b of this.bases[i] !== undefined ? [this.bases[i]!] : DEFAULT_API_BASES) out.add(b);
    });
    return [...out];
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

/**
 * Whether the node URL keeps the session's traffic (and the credential in its
 * setup) encrypted or local: https, an onion service, or a loopback host.
 */
export function encryptedNodeTransport(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return (
    host.endsWith(".onion") ||
    host === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "[::1]"
  );
}
