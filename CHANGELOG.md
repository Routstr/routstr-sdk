# Changelog

## Unreleased

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
