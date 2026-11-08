# Exhausted upstream requests

Upstream 400/422 rejections now use normal payment recovery/refund and failover,
without applying a provider cooldown. Ordinary node failover excludes all nodes
already attempted within that request. Caller-pinned selectors and
caller-forced providers (`forcedProvider`) remain pinned — neither is ever
re-sent to a different node; auto-pinned selectors retain their existing
route-aware traversal.

If every eligible attempt fails, the SDK returns JSON by default:

```json
{"error":{"type":"all_providers_failed","message":"Unsupported option; Invalid schema","errors":[{"status":400,"type":"upstream_error","message":"Unsupported option","providers":["https://a/","https://b/"]},{"status":422,"message":"Invalid schema","providers":["https://c/"]}]}}
```

Entries are deduplicated by status, type, code, and message (not request ID or
provider). Diagnostic fields only are retained: raw error bodies and refund proofs
are not part of the aggregate; credentials in messages are redacted. Provider identity is the
SDK-selected node URL, not an arbitrary upstream response field.

The HTTP status describes the exhausted chain, not whichever node happened to
run last:

- only 400/422 validation rejections: 400 if any attempt returned 400, otherwise 422;
- only one infrastructure status (5xx, 424 or 429): preserve that status;
- only image-capability 404 rejections: retain the existing 404 behavior;
- mixed validation/infrastructure/auth/quota failures, heterogeneous infrastructure
  statuses, transport failures, or upstream account 401/402/403: 502.

This deliberately does not call a provider's account credentials/quota a caller
validation error. Typed wallet/redemption errors and their recovery still take
precedence; no blanket conversion of genuine wallet 402 errors is performed.
Every attempt's status participates, including failures not eligible for a
public diagnostic entry and retries on the same provider (for example 413
balance refreshes and mint recovery retries). Request-specific provider
authentication/quota entries are retained without accepting arbitrary response fields.

Aggregate headers are rebuilt rather than copied from the final node. The existing
node request-ID correlation header is retained. Only when **every attempt**
returned 429 is `retry-after` retained: the SDK uses the earliest valid deadline
seen across attempts and emits nonnegative, rounded-up delay-seconds. Numeric
HTTP delay-seconds and HTTP dates are supported; malformed values are ignored.
If no valid value was seen, or the chain is mixed, no `retry-after` is emitted.
Cookies, authorization, provider URL headers and per-node rate-limit budgets
are not copied.

Credential redaction lives in the pure helper `core/redact.ts`. Only diagnostic
**messages** are redacted for known payment credentials/refund tokens and Cashu
or Bearer credential patterns. Machine-readable `type` and `code` labels are
preserved verbatim. Request input is not collected or redacted: the diagnostic
is returned to the caller who supplied that input, and suppressing it destroys
useful validation errors. Short replies, large prompts, and long conversations
do not change the error message. Documentation links are also preserved, except
for credential values appearing inside them. Raw error bodies, proofs and
arbitrary response fields remain excluded from the aggregate.

This is not a sanitization contract for logs, shared dashboards, or untrusted
recipients. Applications forwarding diagnostics to those destinations must apply
their own data-handling policy; credential matching cannot defend against a
malicious node paraphrasing input or encoding secrets. Selected public provider
URLs remain in the existing `providers` diagnostic list.

Node-local 401/402/403 errors retain the existing typed-error/failover path.
`x-routstr-error-scope: node` identifies a local failure; `upstream` identifies a
provider-account failure. Without an explicit scope, known node codes
(`invalid_api_key`, `key_not_found`, `key_expired`, `unauthorized`, and
`send_token_failed`) and existing wallet error types identify local failures,
even when the broad type is `invalid_request_error`. Typed financial recovery
continues to take precedence over aggregate provider-account responses.

A successful retry returns its normal response with no error
history. Existing typed wallet/payment failures and pinned 404 behavior remain
unchanged; recovery failures may still throw before exhaustion when the existing
financial safeguards require it.

This deliberately replaces verbatim upstream error bodies at exhaustion with an
SDK-generated envelope. Consumers may read `error.errors` for all distinct
failures; `error.message` remains a summary for existing chat consumers.

This contract covers returned aggregate diagnostics only, not existing SDK debug
logs; raw upstream-body logging is outside this change.
