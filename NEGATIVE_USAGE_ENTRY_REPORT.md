# Negative Usage Entry — Diagnostic Report

## Symptom

Usage entries show a negative sats cost (e.g., `-1659.75 sats`) after a request that triggered **provider failover**. The negative value approximately equals the failover provider's token balance.

```
claude-opus-4.7  29 (21+8)  -1659.75 sats  routstr.otrta.me
```

---

## Root Cause: Stale `initialTokenBalance` across failover

### The flow (step by step)

1. **`_prepareRoutedRequest`** (RoutstrClient.ts ~line 230) calls `_spendToken` for the **first provider** (`llm.satsandsports.cash`). The token has an expired/invalid key, so `_spendToken` → `getTokenBalance` returns `balance = -1 msat`. This is stored as `tokenBalanceInSats = -0.001`.

2. **`_makeRequest`** sends the request. The provider returns **401**.

3. **`_handleErrorResponse`** (RoutstrClient.ts ~line 480) tries to recover/restore the token, fails, attempts a refund (balance is -1, refund fails), marks the provider as failed, then **invokes failover**:
   - Calls `this.providerManager.findNextBestProvider()` → gets `routstr.otrta.me`
   - Calls `this._spendToken()` again with the **new provider**, getting a fresh token with `balance = 1660 sat`
   - Recursively calls `this._makeRequest()` with the new token — **this returns a Response directly**

4. **Back in `_prepareRoutedRequest`**, the returned response has `.baseUrl = routstr.otrta.me` (set on the response object during the failover `_makeRequest` call), but `tokenBalanceInSats` is **still -0.001** — it was captured from the first `_spendToken` on line ~255 and never updated.

5. **`_handlePostResponseBalanceUpdate`** (RoutstrClient.ts ~line 640) runs in apikeys mode:
   ```ts
   satsSpent = initialTokenBalance - latestTokenBalance
            = (-0.001) - 1659.748
            = -1659.749   // ≈ -1659.75
   ```

---

## Contributing Factor: `getTokenBalance` uses `-1` as error sentinel

In `BalanceManager.getTokenBalance` (BalanceManager.ts ~line 483):

```ts
// When the provider returns a non-OK status:
return {
  amount: -1,        // ← hardcoded magic number for "failed to get balance"
  reserved: data.reserved ?? 0,
  unit: "msat",
  apiKey: data.api_key,
};
```

This `-1` (msat) is treated as a valid balance value and fed into arithmetic (`tokenBalanceInSats = -1/1000 = -0.001`). A special sentinel like this should not participate in subtraction-based satsSpent calculations.

---

## Conditions under which this bug triggers

| Condition | Required? |
|-----------|-----------|
| Provider failover occurs (first provider returns 4xx/5xx or network error) | **Yes** |
| The first provider's token has a balance that `_spendToken` reports as ≤ 0 or negative | **Yes** |
| Mode is `apikeys` (xcashu mode has the same structural issue but the arithmetic plays out differently) | **Almost always** |
| `_handleErrorResponse` DOES attempt failover (i.e., `findNextBestProvider` returns a provider) | **Yes** |
| The first provider's API key is invalid/expired (returns 401), causing `getTokenBalance` to return `-1` | **Common trigger** |

---

## Impact

1. **`routeRequest`**: `response.satsSpent` is set to the negative value. Callers that use this field see a negative cost.

2. **`fetchAIResponse`**: `callbacks.onLastMessageSatsUpdate(satsSpent, estimatedCosts)` is called with negative `satsSpent`. UIs rendering this show a negative spend.

3. **Usage tracking entry** (for apikeys mode): The `satsCost` in the entry itself comes from the SSE stream cost data (`...usage` spread), so the stored usage entry may actually be correct. The negative value affects the **return value** and **callbacks**, not the stored entry (in apikeys mode). In xcashu mode, the stored entry would also be negative since `entry.satsCost = satsSpent` is set explicitly.

---

## Fix direction

The core fix needs to update `initialTokenBalance` when failover happens. Options:

1. **In `_handleErrorResponse`**: Before retrying with the new provider, capture the new token's balance and feed it through so `_handlePostResponseBalanceUpdate` receives the correct value. This means either mutating the response object or returning additional metadata.

2. **In `_prepareRoutedRequest`**: After `_makeRequest` returns, check if the response's `.baseUrl` differs from the original `baseUrl`, and if so, re-derive `tokenBalanceInSats` from the response's `.token`.

3. **In `_handlePostResponseBalanceUpdate`**: Instead of relying on caller-provided `initialTokenBalance`, re-derive the balance for the actual token used from `getTokenBalance()` before computing `satsSpent`. However, this is tricky because the balance may have already changed by the time the post-response update runs.

4. **Fix `getTokenBalance`**: Don't return `-1` as a sentinel. Return `null` or throw, or use a separate flag to indicate "balance unknown", preventing it from being used in arithmetic.
