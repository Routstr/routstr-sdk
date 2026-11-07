# Reservation-aware 402 recovery

After automatic funding fails with insufficient wallet balance, the SDK can wait
for its own in-process requests on the same provider/API key to settle rather
than immediately returning 402 or failing over. A fresh balance read must show
sufficient **available** balance before inference is retried. Gross balance
(available + reserved) only establishes whether waiting could help; actual
charges may leave too little to retry.

`routeRequests({ reservedBalanceWaitMs: 120_000, ... })` and
`client.routeRequest({ reservedBalanceWaitMs: 120_000, ... })` accept a total wait
budget in milliseconds. The default is 120 seconds; zero disables waiting.
The first wait starts one absolute deadline shared across reservation retries
and provider failover. The budget bounds settlement waits and their fresh
balance reads, not discovery, funding, inference, or the entire request.
Expiry preserves existing insufficient-balance/provider-failover behavior;
caller cancellation still produces `AbortError`.

A retry following an observed settlement does not consume the ordinary
same-provider retry allowance. A fresh sufficient balance without an observed
settlement still uses the ordinary allowance, preventing repeated inconsistent
402s from bypassing the retry cap.

Funding is intentionally attempted first: a funded wallet need not wait behind
long-running inference. Provider-mint shortfalls retain existing failover.
Inference coordination is module-local and keyed by provider URL (trailing
slashes removed) and API key, independently of wallet-adapter identity. It does
not coordinate separate processes or external users of the same key. Holds are
released after eager accounting, on errors, and on cancellation; a stalled
upstream cannot keep another request waiting beyond its configured deadline.
