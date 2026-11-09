# Changelog

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
