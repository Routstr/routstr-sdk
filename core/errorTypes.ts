/**
 * Routstr-core error type taxonomy and parser.
 *
 * routstr-core (PR #578) emits a unified failure taxonomy across both
 * redemption paths (X-Cashu and Bearer token). The structured error
 * envelope carries a `type` field for broad classification and a `code`
 * field for finer granularity. The SDK parses these to classify failures
 * instead of treating all errors generically.
 *
 * Envelope formats vary by endpoint:
 *
 * - **X-Cashu header payments** (chat completions + Responses API):
 *   ```json
 *   { "error": { "type": "token_already_spent", "message": "...", "code": "cashu_token_already_spent" }, "request_id": "..." }
 *   ```
 *
 * - **Authorization: Bearer** (API key minting):
 *   ```json
 *   { "detail": { "error": { "type": "...", "code": "...", "message": "..." } } }
 *   ```
 *
 * - **POST /v1/wallet/topup** (plain string):
 *   ```json
 *   { "detail": "Cashu mint is unreachable" }
 *   ```
 */

/**
 * Error types emitted by routstr-core.
 *
 * Branch on `type` for broad classification. Use `code` for finer granularity.
 */
export const CoreErrorType = {
  /** Token has already been redeemed (400, not retryable) */
  TOKEN_ALREADY_SPENT: "token_already_spent",
  /** Token is malformed or cannot be decoded (400, not retryable) */
  INVALID_TOKEN: "invalid_token",
  /** Fee/melt failures from the mint (422, not retryable) */
  MINT_ERROR: "mint_error",
  /** Mint could not be reached — retryable with backoff (503) */
  MINT_UNREACHABLE: "mint_unreachable",
  /** Other expected wallet errors (400, not retryable) */
  CASHU_ERROR: "cashu_error",
  /** Token was spent but crediting failed (500, not retryable) */
  TOKEN_CONSUMED: "token_consumed",
  /** Unexpected server-side fault (500, maybe retryable) */
  API_ERROR: "api_error",
  /** Legacy / other payment errors */
  PAYMENT_ERROR: "payment_error",
} as const;

export type CoreErrorTypeValue =
  (typeof CoreErrorType)[keyof typeof CoreErrorType];

/**
 * Finer-grained error codes emitted by routstr-core.
 */
export const CoreErrorCode = {
  TOKEN_ALREADY_SPENT: "cashu_token_already_spent",
  INVALID_CASHU_TOKEN: "invalid_cashu_token",
  CASHU_TOKEN_SWAP_FEES_EXCEED_AMOUNT: "cashu_token_swap_fees_exceed_amount",
  CASHU_FOREIGN_MINT_SWAP_FAILED: "cashu_foreign_mint_swap_failed",
  CASHU_MINT_UNREACHABLE: "cashu_mint_unreachable",
  CASHU_TOKEN_REDEMPTION_FAILED: "cashu_token_redemption_failed",
  CASHU_TOKEN_ZERO_VALUE: "cashu_token_zero_value",
  CASHU_TOKEN_CONSUMED: "cashu_token_consumed",
  INTERNAL_ERROR: "internal_error",
  INVALID_API_KEY: "invalid_api_key",
} as const;

export type CoreErrorCodeValue =
  (typeof CoreErrorCode)[keyof typeof CoreErrorCode];

/**
 * Parsed structured error from a routstr-core response.
 */
export interface ParsedCoreError {
  /** The error type (e.g. `"token_already_spent"`) — branch on this */
  type?: string;
  /** Finer-grained code (e.g. `"cashu_token_already_spent"`) */
  code?: string;
  /** Human-readable message */
  message?: string;
  /** Additional details object from the error envelope */
  details?: Record<string, unknown>;
  /** HTTP status code from the response */
  status?: number;
  /** The request ID from headers or response body */
  requestId?: string;
  /** `true` when the body was plain text or unparseable (no structured fields) */
  raw: boolean;
}

/**
 * Parse a routstr-core error response body into a structured error.
 *
 * Handles all known envelope formats (X-Cashu, Bearer, plain-string detail).
 * Never throws — returns a `ParsedCoreError` with `raw: true` if the body
 * cannot be parsed as structured JSON.
 *
 * @param bodyText  Raw response body text (string or undefined)
 * @param status    HTTP status code from the response
 * @param requestId Request ID from response headers (optional, merged with body)
 */
export function parseCoreError(
  bodyText: string | undefined | null,
  status?: number,
  requestId?: string
): ParsedCoreError {
  const result: ParsedCoreError = { status, requestId, raw: true };

  if (!bodyText) {
    return result;
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    // Not JSON — treat the raw text as the message
    result.message = bodyText;
    return result;
  }

  if (typeof data !== "object" || data === null) {
    return result;
  }

  const obj = data as Record<string, unknown>;

  // Extract request_id from top level (X-Cashu envelope)
  if (obj.request_id && !result.requestId) {
    result.requestId = String(obj.request_id);
  }

  // Format 1: top-level `error` object (X-Cashu header payments)
  // { "error": { "type": "...", "message": "...", "code": "..." } }
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    result.type = typeof err.type === "string" ? err.type : undefined;
    result.code = typeof err.code === "string" ? err.code : undefined;
    result.message = typeof err.message === "string" ? err.message : undefined;
    result.details =
      typeof err.details === "object" && err.details !== null
        ? (err.details as Record<string, unknown>)
        : undefined;
    result.raw = false;
    return result;
  }

  // Format 2: `detail` wrapping an `error` object (Bearer token)
  // { "detail": { "error": { "type": "...", "code": "...", "message": "..." } } }
  if (
    obj.detail &&
    typeof obj.detail === "object" &&
    (obj.detail as Record<string, unknown>).error &&
    typeof (obj.detail as Record<string, unknown>).error === "object"
  ) {
    const err = (obj.detail as Record<string, unknown>).error as Record<
      string,
      unknown
    >;
    result.type = typeof err.type === "string" ? err.type : undefined;
    result.code = typeof err.code === "string" ? err.code : undefined;
    result.message = typeof err.message === "string" ? err.message : undefined;
    result.details =
      typeof err.details === "object" && err.details !== null
        ? (err.details as Record<string, unknown>)
        : undefined;
    result.raw = false;
    return result;
  }

  // Format 3: `detail` as a plain string (POST /v1/wallet/topup)
  // { "detail": "Cashu mint is unreachable" }
  if (typeof obj.detail === "string") {
    result.message = obj.detail;
    result.raw = false;
    return result;
  }

  // Format 4: `detail` is an object with type/code/message directly
  if (obj.detail && typeof obj.detail === "object") {
    const det = obj.detail as Record<string, unknown>;
    if (det.type || det.code || det.message) {
      result.type = typeof det.type === "string" ? det.type : undefined;
      result.code = typeof det.code === "string" ? det.code : undefined;
      result.message =
        typeof det.message === "string" ? det.message : undefined;
      result.raw = false;
      return result;
    }
  }

  // Fallback: extract whatever fields we can find
  if (typeof obj.message === "string") result.message = obj.message;
  if (typeof obj.type === "string") result.type = obj.type;
  if (typeof obj.code === "string") result.code = obj.code;

  return result;
}

/**
 * Check if a parsed core error matches a specific error type.
 */
export function isCoreErrorType(
  parsed: ParsedCoreError,
  type: CoreErrorTypeValue
): boolean {
  return parsed.type === type;
}

/**
 * Check if a parsed core error is retryable.
 *
 * Only `mint_unreachable` (503) means the same token will work again later.
 * Everything else is a permanent property of the token and must not be
 * blindly retried. `token_consumed` (500) means the token was already
 * spent — a retry would fail as `token_already_spent`.
 */
export function isRetryableCoreError(parsed: ParsedCoreError): boolean {
  return parsed.type === CoreErrorType.MINT_UNREACHABLE;
}

/**
 * Build a concise human-readable summary of a parsed core error,
 * preferring the structured `type`/`message` over raw text.
 */
export function summarizeCoreError(parsed: ParsedCoreError): string {
  if (parsed.type && parsed.message) {
    return `${parsed.type}: ${parsed.message}`;
  }
  if (parsed.type) {
    return parsed.type;
  }
  if (parsed.message) {
    return parsed.message;
  }
  if (parsed.status) {
    return `HTTP ${parsed.status}`;
  }
  return "Unknown error";
}
