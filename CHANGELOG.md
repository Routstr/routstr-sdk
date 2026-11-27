# Changelog

## Unreleased

### Unresolved refunds quarantine their API key

- A refund that fails without a definitive answer (the 30 s timeout, a lost
  response, a network error, a 5xx, or an in-flight/stuck claim) now marks its
  API key as refund-pending. The node dispatches the payout before it answers,
  and it re-serves that token on a later refund request only while the key's
  balance is zero. Topping the key up made the next refund claim the new
  deposit instead, stranding the earlier payout until the node's sweep.
- While the marker is set, `topUp`/`ensureBalance` refuse to fund the key
  (`TopUpResult.refundPending`), a dead bootstrap key is not replaced with a
  fresh deposit, and the key is not removed. The scheduled refund sweep keeps
  retrying with the same credential; the quarantine lifts when the payout token
  is durably ours, or when the node proves nothing was dispatched (no balance,
  balance too small, in-flight requests, a swept refund).
- The marker is persisted on the key record (`refundPendingAt`) and survives a
  restart and the bootstrap-token → canonical-key promotion, which the node
  resolves to the same key row. Custom storage adapters without the new
  optional methods still get the guard within one process.
- A refund failure that leaves an unresolved claim no longer aborts the request
  with `ProviderError`; it fails over, since the key is preserved and the sweep
  will reclaim the payout.

## 0.5.2

### Provider session headers

- `routeRequest`/`routeRequests` now forward the caller's session and request
  correlation headers (`x-session-id`, `session-id`, `session_id`,
  `x-session-affinity`, `x-opencode-session`, `x-client-request-id`) to the
  selected provider, alongside the existing `anthropic-beta` pass-through.
  Names are matched case-insensitively and the values are kept on same-provider
  retries and provider failover, so prompt-cache affinity survives a re-send.
- Still not forwarded: `Authorization`, `x-api-key`, `X-Cashu`, cookies, and any
  header outside that allowlist. The SDK keeps attaching the selected provider's
  own payment credential. These identifiers are visible to the provider — send
  only what you intend it to see.
- A hint whose value cannot be sent as an HTTP header (non-Latin-1 characters,
  CR/LF/NUL, or empty) is dropped with a warning instead of failing the request.
  A CJK or emoji session id previously reached `fetch` and threw a `TypeError`
  that escaped failover.

### Caller system messages (PR #151)

- `fetchAIResponse` now sends the caller's `system` messages instead of
  dropping them, wherever they sit in `messageHistory`. The SDK's own notes
  from `onMessageAppend` ("Generation stopped.", "Uncaught Error: ...") are
  `system` messages too, so leave them out of the history you pass back.

### Anthropic usage tracking (PR #153)

- Fix `/v1/messages` usage tracking for raw Anthropic and Routstr-normalized
  responses. Count cache reads and writes once and keep streamed token totals
  consistent across usage deltas and terminal cost events. Billing is unchanged.

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

### Local identity precedence for discovery policy

- Add `identityPubkey` / `identitySigner` to `ModelManagerConfig`. When an
  identity is configured, signed events authored by it outrank the configured
  discovery author for `38427` (model-path whitelist). Precedence outranks
  newness, so an advertiser publishing later does not silently undo an explicit
  local choice; within each tier the existing newest-wins rule still applies.
  Unset by default, and with no identity the filters, cache keys and behaviour
  are unchanged.
- Add `setModelPathWhitelistFromIdentity`, `publishModelPathWhitelist`,
  `getLocalModelPathWhitelist` and `getIdentityPubkey`. Writing is local only;
  broadcasting is a separate explicit call. `setModelPathWhitelistFromIdentity({})`
  clears the local document and falls back to the configured author.
- Only the store read is widened. Relay queries stay author-scoped, so a local
  preference neither depends on relay availability nor gets published by setting
  it. An unknown author is still rejected, and stored events must verify.
- Kinds `38423` (curated models) and `38426` (model-id mappings) are **not**
  identity-widened: `identitySigner` only signs 38427, so no local document of
  those kinds can be written through the public API. The advertised version
  remains authoritative for both.
- Fix `compareConfigVersions` to use the same `created_at`-then-`id` ordering as
  the rest of discovery, so the version a reader selects is the version
  `publishModelPathWhitelist` broadcasts on a same-second tie.

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
