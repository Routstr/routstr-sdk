# Changelog

## Unreleased

### Inference deadlines

- Bound the inference request itself, which previously had no local deadline:
  `fetch` was called with only the caller's abort signal, so a provider that
  accepted the connection and then stopped talking held the request until the
  runtime's own ~300 s network timeout. Nothing fired earlier, so the provider
  was never cooled down and no failover was attempted.
- Two budgets, because they cover different failures:
  - **Time to first byte** (`deadlines.ttfbMs`, default 180 s) bounds the wait
    for response headers. The default is measured: on production traffic the
    p99 is 33.5 s, but reasoning models legitimately emit nothing for up to
    ~260 s while thinking, so a shorter default would abort real answers.
  - **Inter-chunk idle** (`deadlines.idleMs`, default 180 s) bounds silence in a
    started stream, re-armed whenever a read begins. It is deliberately as
    generous as the headers budget: a provider may return `200` and then stay
    silent while a reasoning model thinks, and there is no failover left at that
    point, so the cost of too small a value is a truncated answer. A healthy stream that keeps
    emitting is never cut off, however long it runs, and a consumer that pauses
    (backpressure) is not mistaken for a stall.
- A response body that is not a stream gets `deadlines.bodyMs` (disabled by
  default) instead of the inter-chunk budget, since silence until the complete
  body is expected.
- Expiry before headers is reported as `InferenceTimeoutError`
  (`name: "TimeoutError"`, with the phase in the message) and takes the existing
  network-error path: the provider is cooled down and the request fails over.
- Expiry after headers cannot fail over — bytes already reached the caller and
  re-sending would duplicate the answer — so the stall is surfaced to the
  consumer and the same cooldown scope is recorded for the next request.
- Deadlines never change what a caller sees: a caller abort stays an
  `AbortError` and is never recorded as a provider fault. This includes a
  caller's own `AbortSignal.timeout`, whose rejection is also named
  `TimeoutError`: classification uses the local deadline flag, not the error
  name, so a caller's timeout never cools a healthy provider down.
- A stall after headers is scoped to the model (or pinned model path) instead of
  the whole provider: the node answered, so its other models stay usable. It is
  recorded as one failure, so `ProviderManager`'s existing two-strike policy
  still decides when a cooldown begins; this change records the fault and does
  not re-tune cooldown behaviour.
- The attempt's deadline is disposed before an error response is handed to
  failover, so an opt-in `bodyMs` budget cannot fire during the failover chain
  and be misread as a new provider stall.

## 0.5.1

### Exhausted upstream errors (PR #141 and follow-up)

- Classify exhausted chains from **all attempts**, including same-provider
  retries: validation-only 400/422 returns 400 if present, otherwise 422;
  uniform 5xx/424/429 preserves that status; mixed chains return 502. Existing
  image-capability 404 handling is unchanged.
- **Breaking change introduced by #141:** ordinary exhausted upstream errors now
  return an SDK JSON envelope (`error.type: "all_providers_failed"` and
  `error.errors[]`) rather than a verbatim final response or, for provider-account
  401/402/403, a thrown `FailoverError`. Code catching `FailoverError` for those
  provider-account failures must also inspect the returned response status and
  body. This includes untyped/provider-account 402 responses. Genuine local
  wallet failures retain their typed errors and recovery behavior.
- Fix node-local key failures incorrectly treated as provider-account failures:
  known node authentication codes and explicit error scope preserve the existing
  local `FailoverError`/financial-error semantics.
- Preserve diagnostic text for short chat replies and large requests, preserve
  documentation links and machine-readable `type`/`code`, and redact only
  credentials in messages using a separately tested pure helper.
- Preserve the earliest valid `retry-after` deadline when every attempt returned
  429. Other aggregate headers remain reconstructed rather than copied wholesale
  from the final node.

See [upstream error aggregation](UPSTREAM_ERROR_AGGREGATION.md) for the contract.

### Structured 402 payment requirements (PR #142)

- Parse canonical HTTP 402 envelopes from routstr-core: millisatoshi amounts
  (`requiredMsats`, `availableMsats`, `shortfallMsats`, `reservedMsats`), the
  `minimum_balance_required` code, `model`/`unit`, and the pricing audit trail.
  Legacy envelopes keep working.
- Add the `isPaymentRequiredError` type guard for a fully structured local
  shortfall, distinct from an upstream-provider 402.

### Request funding

- Gate request funding on cancellation before any financial work, so an already
  aborted caller never starts a top-up.
- Share an in-flight top-up between cancelled and live callers instead of
  abandoning it: cancelled callers are dropped from the batch, the top-up is
  re-sized for the remaining callers, and settlement still happens once.
- Coordinate automatic funding from fresh shared balances (PR #138) so
  concurrent requests do not each fund the same shortfall.
- Wait for a key's in-flight requests before failing a 402, and bound the
  reserved-balance wait with a revalidation of the available balance.
- Stop force-refunding once a mint can pay the top-up, and keep an unspent
  deposit token when its refund finds no key.
- Attribute stream cost independently of shared wallet balances, and deliver
  stream EOF before accounting settlement so a settled stream is not delayed by
  cost attribution.

### Client and discovery

- Fail over on a reset socket and retry the same provider once; socket retries
  are restricted to safe HTTP methods (PR #132).
- Preserve exhausted validation errors without masking upstream failures, and
  redact bounded original spans without rewriting existing markers.
- Preserve slash-qualified model-path route identifiers and budget model-path
  fields before serialization.
- Guard post-response credential promotion by token ownership (PR #144).
- Interpret legacy `retry-after` dates as GMT.
- Add opt-in local-network provider URL filtering via
  `ModelManagerConfig.filterLocalNetworkUrls` (off by default), with
  `includeProviderUrls` still taking precedence.
