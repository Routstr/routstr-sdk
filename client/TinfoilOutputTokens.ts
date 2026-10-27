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
 * - Exactly ONE header value is allowed. Zero, negative, fractional,
 *   comma-lists, empty strings and duplicates are rejected with a 400 *by the
 *   enclave*, so the SDK must never emit a second value for a header the
 *   caller already set.
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
 * Deliberately stricter than `Number()`: `" 16 "` is accepted, but `"+16"`,
 * `"16.0"`, `"1e3"` and `"16,32"` are not, because the enclave rejects them.
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
 * A field that is *present but unusable* (`null`, `"64"`, `0`, `1.5`) stops
 * the search instead of falling through: choosing the next field would
 * reinterpret the request, and the caller's own value is what the engine sees
 * when the SDK sends no header.
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
  const existing = findHeader(options.headers, TINFOIL_MAX_OUTPUT_TOKENS_HEADER);

  if (existing) {
    // An endpoint the enclave ignores the header on cannot be bounded by it,
    // so even a perfectly valid caller value (core only quotes `chat/completions`
    // and `responses`) must leave the reservation at the full envelope. The
    // header itself is still forwarded — the enclave owns the verdict.
    if (!endpoint) {
      return { endpoint: null, source: "none", callerHeaderInvalid: false };
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
