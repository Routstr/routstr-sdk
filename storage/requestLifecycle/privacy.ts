import { CoreErrorType, CoreErrorCode } from "../../core/errorTypes";
// Do not save arbitrary error text: upstream messages often echo prompts, tokens,
// URLs with credentials, or raw provider envelopes. Keep useful structured codes.
const SAFE_CODE = /^[a-zA-Z0-9_.:-]{1,120}$/;
export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}
const DIAGNOSTICS = new Set<string>([
  ...Object.values(CoreErrorType),
  ...Object.values(CoreErrorCode),
  "unknown",
  "bad_request",
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "overloaded_error",
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "SyntaxError",
  "InsufficientBalanceError",
  "ProviderMintBalanceError",
  "ProviderError",
  "MintUnreachableError",
  "TokenOperationError",
  "FailoverError",
  "StreamingError",
  "ModelNotFoundError",
  "ProviderBootstrapError",
  "NoProvidersAvailableError",
  "TokenAlreadySpentError",
  "InvalidTokenError",
  "UntrustedMintError",
  "CashuRedemptionError",
  "TokenConsumedError",
  "CoreInternalError",
  "MintError",
  "MintDiscoveryError",
]);
/** Provider-controlled diagnostics are NOT identifiers: unknown strings may be credentials. */
export function safeDiagnosticCode(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && DIAGNOSTICS.has(value)
    ? value
    : "unknown";
}
const REASONS = new Set([
  "unknown",
  "preflight_funding",
  "provider_mint_balance",
  "provider_error",
  "same_provider_retry",
  "initial",
  "provider_failover",
  "mint_retry",
  "network",
  "response",
  "stream",
  "funding",
  "retry_limit",
  "failover_exhausted",
  "insufficient_balance",
  "mint_unreachable",
  "mint_rate_limited",
]);
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "[invalid-url]";
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return "[invalid-url]";
  }
}
export function safeModelPath(value: string): string {
  if (value.includes("=")) {
    const input = new URLSearchParams(value);
    const output = new URLSearchParams();
    const url = input.get("url");
    if (url) output.set("url", safeUrl(url));
    for (const key of ["model-id", "endpoint"]) {
      const code = safeCode(input.get(key));
      if (code) output.set(key, code);
    }
    return output.toString().slice(0, 512);
  }
  return value.includes("://")
    ? safeUrl(value)
    : (safeCode(value) ?? "[redacted-model-path]");
}
const EVENT_KEYS = new Set([
  "from",
  "to",
  "reason",
  "kind",
  "status",
  "httpStatus",
  "errorType",
  "errorCode",
  "failurePhase",
  "ordinal",
  "retryCount",
  "failoverCount",
  "outcome",
  "durationMs",
  "amount",
  "success",
  "phase",
  "modelId",
  "modelPath",
  "nodeRequestId",
  "upstreamResponseId",
]);
export function safeEventData(
  data?: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!EVENT_KEYS.has(key)) continue;
    if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean" ||
      value === null
    )
      result[key] = value as number | boolean | null;
    else if (typeof value === "string") {
      const safe =
        key === "from" || key === "to"
          ? safeUrl(value)
          : key === "modelPath"
            ? safeModelPath(value)
            : key === "errorType" || key === "errorCode"
              ? safeDiagnosticCode(value)
              : key === "reason"
                ? REASONS.has(value)
                  ? value
                  : "unknown"
                : safeCode(value);
      if (safe !== undefined) result[key] = safe;
    }
  }
  return result;
}
const FIELDS = new Set(
  `requestId ownerInstanceId callerRequestId method path requestedModelId stream mode clientId startedAt updatedAt endedAt durationMs outcome httpStatus finalBaseUrl finalAttemptId attemptCount retryCount failoverCount providerCount errorType errorCode errorMessage upstreamResponseId usageEntryId attemptId ordinal kind baseUrl modelId modelPath headersReceivedAt failurePhase nodeRequestId requestLogId eventId sequence timestamp type data`.split(
    " ",
  ),
);
export function sanitizeFields<T extends object>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input))
    if (FIELDS.has(key)) out[key] = value;
  if (typeof out.path === "string")
    out.path = out.path.split(/[?#]/)[0].slice(0, 512);
  if (typeof out.modelPath === "string")
    out.modelPath = safeModelPath(out.modelPath);
  for (const key of ["errorType", "errorCode"]) {
    if (key in out) out[key] = safeDiagnosticCode(out[key]);
  }
  // Even apparently harmless free text may contain a secret or a prompt.
  if (typeof out.errorMessage === "string")
    out.errorMessage = "Request failed; inspect structured error type/code";
  for (const key of ["baseUrl", "finalBaseUrl"])
    if (typeof out[key] === "string") out[key] = safeUrl(out[key] as string);
  return out as T;
}
