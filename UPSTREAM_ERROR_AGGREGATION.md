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
provider). Diagnostic fields only are retained: raw error bodies, refund proofs,
and wallet credentials are not part of the aggregate. Provider identity is the
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
public diagnostic entry. Request-specific provider authentication/quota entries
are now retained without accepting arbitrary response fields.

Aggregate headers are rebuilt rather than copied from the final node: only the
existing node request-ID correlation header is retained. Retry headers, cookies,
authorization and provider URL headers are not meaningful for the entire chain.
Known payment credentials, Cashu tokens, Bearer credentials, exact request input
strings (including completions `prompt` and Responses `instructions`) and URLs
in diagnostic fields are redacted. Matching uses original-text spans, merging
overlaps before inserting markers; a marker is never reprocessed. Inputs are
deduplicated. Complexity is capped at 512 literals/64 KiB of literal text,
4,096 visited input values, depth 32, 8,192 diagnostic characters and 4,096 spans;
exceeding a budget suppresses the diagnostic field instead of partially exposing
it. Each output field is also capped at 8,192 characters. Raw bodies are never copied;
this is not a guarantee against a malicious node paraphrasing input in its error.
Selected public provider URLs remain in the existing `providers` diagnostic list.

A successful retry returns its normal response with no error
history. Existing typed wallet/payment failures and pinned 404 behavior remain
unchanged; recovery failures may still throw before exhaustion when the existing
financial safeguards require it.

This deliberately replaces verbatim upstream error bodies at exhaustion with an
SDK-generated envelope. Consumers may read `error.errors` for all distinct
failures; `error.message` remains a summary for existing chat consumers.

This contract covers returned aggregate diagnostics only, not existing SDK debug
logs; raw upstream-body logging is outside this change.
