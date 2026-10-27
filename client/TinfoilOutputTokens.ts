/**
 * Tinfoil visible output-token cap (`X-Tinfoil-Max-Output-Tokens`).
 *
 * EHBP encrypts a Tinfoil request body end to end, so a routing proxy — and
 * the node that reserves against it — cannot read `max_tokens` /
 * `max_completion_tokens` / `max_output_tokens` out of the body. Until this
 * header existed, the node had to hold the *whole* `max_cost` envelope for a
 * sealed request, even when the caller asked for a 64-token answer.
 *
 * tinfoilsh/confidential-model-router#518 makes the cap visible: the header
 * travels outside the sealed body and the enclave *replaces* any body cap with
 * it, whether larger or smaller. That gives both ends of the connection the
 * same number — the enclave enforces it, and routstr-core can reserve against
 * it (see `features.ehbp_output_token_reservation` on `/v1/info`).
 *
 * Enclave semantics this module mirrors (from the merged PR):
 *
 * - Only exact generation endpoints act on the header:
 *   `/v1/chat/completions`, `/v1/responses` (and `/v1/completions`, which the
 *   deployed enclaves currently 404 — see `TINFOIL_OUTPUT_CAP_ENDPOINTS`).
 *   Every other path ignores it.
 * - Exactly ONE header value is allowed. The enclave parses it with Go's
 *   `strconv.ParseInt` (base 10, so it tolerates a `+` sign and leading zeros)
 *   and then requires a positive value, so zero, negatives, fractions,
 *   comma-lists, empty strings and duplicates are rejected with a 400 *by the
 *   enclave*. The SDK must never emit a second value for a header the caller
 *   already set.
 * - On a valid value the enclave deletes every body field it would otherwise
 *   read and writes its own cap field, so the body cap the SDK leaves behind
 *   can only ever agree with the header (it is deleted first).
 *
 * Two consequences drive the code below:
 *
 * 1. The cap we send must be the cap the caller *meant*. The enclave's engine
 *    prefers `max_completion_tokens` over `max_tokens` on chat, and ignores
 *    `max_output_tokens` there entirely; on `/v1/responses` only
 *    `max_output_tokens` is read. Deriving the header from the wrong field
 *    would either lengthen or truncate a response the caller had already
 *    bounded.
 * 2. A cap we cannot prove the engine would have honoured is not sent at all.
 *    A string `"64"`, a fractional/zero/negative value, or a field the
 *    endpoint ignores must leave the request exactly as it was before this
 *    feature — no new 400s and no silently narrowed output.
 */

/** The header the enclave enforces and routstr-core reserves against. */
export const TINFOIL_MAX_OUTPUT_TOKENS_HEADER = "X-Tinfoil-Max-Output-Tokens";

/**
 * Upper bound routstr-core accepts for the cap. A larger value still works at
 * the enclave (it parses an int64), but the node would decline to discount it,
 * so emitting it would only desynchronise the header from the reservation.
 * Such a cap is also indistinguishable from "no limit" in practice.
 */
export const TINFOIL_MAX_OUTPUT_TOKENS_LIMIT = 2_147_483_647;

/**
 * Generation endpoints the enclave applies the header to, and the body fields
 * it reads there in engine precedence order. The first field is the one the
 * enclave writes its cap into after deleting the rest.
 *
 * `/v1/completions` is deliberately absent: the merged router PR maps it, but
 * deployed enclaves answer 404 for it today, so the SDK neither emits nor
 * discounts a cap there (routstr-core keeps the full reserve on that path for
 * the same reason).
 */
const ENDPOINT_CAP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  chat: ["max_completion_tokens", "max_tokens"],
  responses: ["max_output_tokens"],
};

export type TinfoilOutputCapEndpoint = keyof typeof ENDPOINT_CAP_FIELDS;

/** Where the effective cap came from, for logging and tests. */
export type TinfoilOutputCapSource =
  /** The caller set the header itself; the enclave enforces it verbatim. */
  | "caller-header"
  /** Derived from the request body for the endpoint the enclave supports. */
  | "body"
  /** No usable cap: unsupported endpoint, no cap field, or an invalid one. */
  | "none";

export interface TinfoilOutputCapResolution {
  /** The endpoint the enclave would apply the header to, if any. */
  endpoint: TinfoilOutputCapEndpoint | null;
  /**
   * The cap the enclave will enforce for this request, when it is known.
   * This is the value the reservation must be priced against.
   */
  cap?: number;
  /**
   * Header value the SDK should add. Absent when the caller already supplied
   * the header (never emit a second value: duplicates are a 400) or when no
   * valid, endpoint-appropriate cap exists.
   */
  injectValue?: string;
  source: TinfoilOutputCapSource;
  /**
   * A caller-supplied header is present and does not parse. It is forwarded
   * unchanged so the enclave can return its own 400; the reservation cannot
   * be priced against it, so it stays at the full envelope.
   */
  callerHeaderInvalid: boolean;
}

/**
 * Strip the leading/trailing space and tab the enclave's `strings.TrimSpace`
 * removes. Core's own parser strips the same two characters, so a value it
 * would refuse to price (say `"\n16"`) is never priced here either — the
 * reservation must not quote a cap the node will not honour.
 */
function trimAsciiWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

/**
 * Parse a header value the way the enclave and routstr-core do: canonical
 * base-10 digits only (`^[1-9][0-9]*$`) after ASCII-whitespace trimming, no
 * sign, no separators, and within the range the node is willing to discount.
 *
 * Deliberately stricter than both `Number()` and the enclave: Go's
 * `strconv.ParseInt` accepts a leading `+` and leading zeros (`"+16"`, `"007"`),
 * but routstr-core quotes only canonical digits and an unquoted cap cannot
 * shrink the node's reservation, so accepting those here would let the SDK
 * price a cap the node refuses to honour. Nothing is lost: the SDK only ever
 * *emits* canonical values (`String(cap)`), so this affects only a caller's own
 * header, which is forwarded verbatim either way. `" 16 "` is accepted because
 * both the enclave and the node strip space/tab first.
 */
export function parseTinfoilOutputCapHeader(
  value: string
): number | undefined {
  const trimmed = trimAsciiWhitespace(value);
  // Core refuses to even parse a value longer than the bound's digits.
  if (trimmed.length > String(TINFOIL_MAX_OUTPUT_TOKENS_LIMIT).length) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  if (parsed > TINFOIL_MAX_OUTPUT_TOKENS_LIMIT) return undefined;
  return parsed;
}

/**
 * Map an SDK request path onto the generation endpoint the enclave keys on.
 *
 * Suffix-matched so a path-prefixed proxy (`/api/v1/chat/completions`) works,
 * and query strings / trailing slashes do not defeat the match. The enclave
 * matches its own exact table, so anything we do not emit for is a path where
 * the header would be ignored anyway.
 */
export function tinfoilOutputCapEndpoint(
  path?: string
): TinfoilOutputCapEndpoint | null {
  if (!path) return null;
  const normalized = path.split(/[?#]/)[0].replace(/\/+$/, "");
  if (/(^|\/)chat\/completions$/.test(normalized)) return "chat";
  if (/(^|\/)responses$/.test(normalized)) return "responses";
  return null;
}

/** A positive, integral body cap the engine would honour, or undefined. */
function validBodyCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > TINFOIL_MAX_OUTPUT_TOKENS_LIMIT) return undefined;
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A count that may legitimately exceed one, read loosely (`5` or `"5"`). */
function countAboveOne(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 1;
}

/**
 * Whether the request asks for more than one completion.
 *
 * The header's cap is applied per choice, not to the request total: a probe
 * confirmed the completion count for a single-choice request, and nothing
 * confirms that `n` choices are covered by one cap rather than `n` times it. A
 * sealed body hides `n` from the node, so quoting the cap would let the enclave
 * bill up to `n * cap` against a hold sized for `cap` — the one direction that
 * must never happen. Multi-choice requests therefore keep the old behaviour
 * entirely: no header derived from the body, and no cap quoted.
 */
export function tinfoilMultiChoiceRequest(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  return countAboveOne(body.n) || countAboveOne(body.best_of);
}

/**
 * The cap the enclave's engine reads out of the body for this endpoint.
 *
 * Precedence is the engine's own, not `Math.max` across fields:
 *
 * - chat: `max_completion_tokens` wins over `max_tokens`, and
 *   `max_output_tokens` is ignored even when it is the only cap present
 *   (probe-confirmed: chat honours `max_tokens` / `max_completion_tokens`,
 *   not `max_output_tokens`).
 * - responses: `max_output_tokens` only.
 *
 * `null`/`undefined` means "not set" and the search continues with the next
 * field, which is how a JSON client clears a default. Any other present value
 * must be a positive integer: if it is not (`"64"`, `0`, `1.5`, `-1`) the
 * endpoint has no usable cap at all and the search stops — falling through to
 * the next field would reinterpret the request, and whichever value the engine
 * ends up seeing is not one the SDK can predict or price.
 */
export function bodyOutputCap(
  endpoint: TinfoilOutputCapEndpoint,
  body: unknown
): number | undefined {
  if (!isPlainObject(body)) return undefined;
  for (const field of ENDPOINT_CAP_FIELDS[endpoint]) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    if (raw === null || raw === undefined) continue;
    return validBodyCap(raw);
  }
  return undefined;
}

/** Case-insensitive lookup for a header already present on the request. */
function findHeader(
  headers: Record<string, string> | undefined,
  name: string
): { name: string; value: string; count: number } | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  let found: { name: string; value: string; count: number } | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (found) {
      found.count += 1;
      continue;
    }
    found = { name: key, value: String(value), count: 1 };
  }
  return found;
}

/**
 * Work out the cap this request will actually be held to, before it is sealed.
 *
 * The caller's header outranks the body — that is the enclave's rule, so it is
 * also the reservation's rule. A caller header that does not parse is reported
 * rather than replaced: forwarding it lets the enclave return the 400 it would
 * have returned anyway, and the caller's intent is never silently rewritten.
 */
export function resolveTinfoilOutputCap(options: {
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): TinfoilOutputCapResolution {
  const endpoint = tinfoilOutputCapEndpoint(options.path);
  // A `Connection` nomination strips the header before the enclave sees it, so
  // no cap can be quoted from it. Interval: the node's own sanitizer refuses
  // the quote too (core does), but the full reserve is the same outcome here.
  if (capHeaderNominatedInConnection(options.headers)) {
    return { endpoint, source: "none", callerHeaderInvalid: false };
  }
  const existing = findHeader(options.headers, TINFOIL_MAX_OUTPUT_TOKENS_HEADER);

  if (existing) {
    // An endpoint the enclave ignores the header on cannot be bounded by it,
    // so even a perfectly valid caller value (core only quotes `chat/completions`
    // and `responses`) must leave the reservation at the full envelope. The
    // header itself is still forwarded — the enclave owns the verdict.
    if (!endpoint) {
      return { endpoint: null, source: "none", callerHeaderInvalid: false };
    }
    // Multi-choice requests keep the full reserve even behind the caller's own
    // header: the cap may apply per choice, and the node cannot see `n` through
    // the sealed body.
    if (tinfoilMultiChoiceRequest(options.body)) {
      return { endpoint, source: "none", callerHeaderInvalid: false };
    }
    // Two values (e.g. the caller spelled the header twice in different case)
    // are rejected by the enclave; never add a third.
    const cap =
      existing.count === 1
        ? parseTinfoilOutputCapHeader(existing.value)
        : undefined;
    return cap === undefined
      ? {
          endpoint,
          source: "none",
          callerHeaderInvalid: true,
        }
      : {
          endpoint,
          cap,
          source: "caller-header",
          callerHeaderInvalid: false,
        };
  }

  if (!endpoint) {
    return { endpoint: null, source: "none", callerHeaderInvalid: false };
  }

  // No derived header for a multi-choice request: the enclave's cap is per
  // choice, so injecting one here would hand the node a quote that bounds only
  // one of the `n` completions it may bill for.
  if (tinfoilMultiChoiceRequest(options.body)) {
    return { endpoint, source: "none", callerHeaderInvalid: false };
  }

  const cap = bodyOutputCap(endpoint, options.body);
  if (cap === undefined) {
    return { endpoint, source: "none", callerHeaderInvalid: false };
  }

  return {
    endpoint,
    cap,
    injectValue: String(cap),
    source: "body",
    callerHeaderInvalid: false,
  };
}

/**
 * Attach the visible cap to the outgoing headers.
 *
 * Returns the input object untouched (`===`) when there is nothing to add, so
 * callers can rely on identity. An existing header — the caller's, or one a
 * previous attempt already added — is never duplicated: the enclave treats two
 * values as a 400.
 */
export function withTinfoilOutputCapHeader(
  headers: Record<string, string>,
  resolution: TinfoilOutputCapResolution
): Record<string, string> {
  if (findHeader(headers, TINFOIL_MAX_OUTPUT_TOKENS_HEADER)) return headers;
  if (resolution.injectValue === undefined) {
    // Nothing to derive, but a caller header may still need to survive the
    // SDK's header allowlist — handled by the caller, which copies it out of
    // the inbound headers explicitly.
    return headers;
  }
  return {
    ...headers,
    [TINFOIL_MAX_OUTPUT_TOKENS_HEADER]: resolution.injectValue,
  };
}

/**
 * Whether a hop is told to strip the cap header before it reaches the enclave.
 *
 * `Connection: X-Tinfoil-Max-Output-Tokens` nominates the field for removal at
 * the hop that honors `Connection`. A quote computed from a header the enclave
 * never receives is not a bound: the enclave would fall back to the body cap
 * (or no cap), while the node reserved against a smaller number it can no
 * longer enforce. The SDK therefore fails closed for such requests — no quote,
 * full envelope — and does not rely on the node's own sanitizer.
 */
export function capHeaderNominatedInConnection(
  headers: Record<string, string> | undefined
): boolean {
  if (!headers) return false;
  const wanted = TINFOIL_MAX_OUTPUT_TOKENS_HEADER.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of String(value).split(",")) {
      if (trimAsciiWhitespace(token).toLowerCase() === wanted) return true;
    }
  }
  return false;
}

/**
 * Carry a caller-supplied cap header onto the outbound request.
 *
 * The SDK rebuilds outbound headers from an allowlist and never spreads
 * caller headers (credentials must not leak upstream), so an explicitly
 * supplied cap has to be opted back in — like `anthropic-beta`. Original
 * spelling is preserved, and *every* matching entry is copied: if the caller
 * sent the header twice, the enclave must see two values and answer with its
 * own 400 rather than have the SDK quietly pick one for them.
 */
export function forwardCallerTinfoilOutputCapHeaders(
  inbound: Record<string, string> | undefined,
  outbound: Record<string, string>
): void {
  if (!inbound) return;
  const wanted = TINFOIL_MAX_OUTPUT_TOKENS_HEADER.toLowerCase();
  for (const [name, value] of Object.entries(inbound)) {
    if (name.toLowerCase() !== wanted) continue;
    outbound[name] = String(value);
  }
}
