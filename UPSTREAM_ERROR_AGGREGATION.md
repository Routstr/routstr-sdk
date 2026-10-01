# Exhausted upstream requests

Upstream 400/422 rejections now use normal payment recovery/refund and failover,
without applying a provider cooldown. Ordinary node failover excludes all nodes
already attempted within that request. Caller-pinned selectors remain pinned;
auto-pinned selectors retain their existing route-aware traversal.

If every eligible attempt fails, the SDK returns JSON by default:

```json
{"error":{"type":"all_providers_failed","message":"Unsupported option; Invalid schema","errors":[{"status":400,"type":"upstream_error","message":"Unsupported option","providers":["https://a/","https://b/"]},{"status":422,"message":"Invalid schema","providers":["https://c/"]}]}}
```

Entries are deduplicated by status, type, code, and message (not request ID or
provider). Diagnostic fields only are retained: raw error bodies, refund proofs,
and wallet credentials are not part of the aggregate. Provider identity is the
SDK-selected node URL, not an arbitrary upstream response field.

The HTTP status is the final attempt's status; a final network failure uses 502
and a diagnostic entry with status -1. Infrastructure errors (5xx/424/429) are
also aggregated. A successful retry returns its normal response with no error
history. Existing typed wallet/payment failures and pinned 404 behavior remain
unchanged; recovery failures may still throw before exhaustion when the existing
financial safeguards require it.

This deliberately replaces verbatim upstream error bodies at exhaustion with an
SDK-generated envelope. Consumers may read `error.errors` for all distinct
failures; `error.message` remains a summary for existing chat consumers.
