# Routstr SDK

This SDK lives under `sdk/` and exposes a framework-agnostic surface for Routstr API interactions. It separates business logic from UI and provides core types, discovery, client orchestration, wallet abstractions, and storage defaults.

## Entry Points

- `sdk/index.ts` exports core types, discovery, wallet interfaces, client, storage, utils.

## Core Modules

- Discovery: `ModelManager`, `MintDiscovery` in `sdk/discovery/`
  - Provider bootstrap, models cache, mint discovery, provider info cache
- Client: `RoutstrClient`, `ProviderManager`, `StreamProcessor` in `sdk/client/`
  - Main request flow, failover, streaming parsing
- Wallet: `CashuSpender`, `BalanceManager` in `sdk/wallet/`
  - Cashu spend/retry, refund handling

## Interfaces (app provides)

- `WalletAdapter`, `StorageAdapter`, `ProviderRegistry`, `StreamingCallbacks` in `sdk/wallet/interfaces.ts`
- `DiscoveryAdapter` in `sdk/discovery/interfaces.ts`

## Storage Defaults

- `sdk/storage/index.ts` exposes:
  - `getDefaultSdkDriver()` (localStorage -> sqlite -> memory)
  - `getDefaultSdkStore()`
  - `getDefaultUsageTrackingDriver()`
  - `getDefaultDiscoveryAdapter()`
  - `getDefaultStorageAdapter()`
  - `getDefaultProviderRegistry()`

Usage tracking is now stored separately from the Zustand-backed SDK state:

- browser: IndexedDB usage-tracking object store
- node: SQLite usage-tracking table
- bun/ephemeral: in-memory usage-tracking driver

The usage tracking driver also exposes `migrate()` so apps can proactively move legacy blob data into the new backend during startup instead of waiting for the first append/read operation.

## Minimal Usage

```ts
import {
  ModelManager,
  MintDiscovery,
  RoutstrClient,
  getDefaultDiscoveryAdapter,
  getDefaultProviderRegistry,
  getDefaultStorageAdapter,
} from "@/sdk";

const discovery = getDefaultDiscoveryAdapter();
const providerRegistry = getDefaultProviderRegistry();
const storageAdapter = getDefaultStorageAdapter();

const modelManager = await ModelManager.init(discovery, {}, { torMode: false });
const baseUrls = discovery.getBaseUrlsList();
const mintDiscovery = new MintDiscovery(discovery);
await mintDiscovery.discoverMints(baseUrls);

const client = new RoutstrClient(
  walletAdapter,
  storageAdapter,
  providerRegistry,
  "min"
);
await client.fetchAIResponse(fetchOptions, streamingCallbacks);
```

## Client Modes

The `RoutstrClient` supports two modes via the constructor `mode` parameter (defaults to `"xcashu"` if unspecified):

- `"xcashu"` — Default mode. Uses standard Cashu token spending with refunds.
- `"apikeys"` — Uses API key authentication instead of Cashu tokens; no token spending or refund flow.

```ts
const client = new RoutstrClient(
  walletAdapter,
  storageAdapter,
  providerRegistry,
  "min", // alertLevel
  "xcashu" // mode (optional, defaults to "xcashu")
);

const currentMode = client.getMode(); // Returns the active mode
```

## Tests

SDK unit tests live in `sdk/__tests__` and are run with Vitest.

- `sdk/__tests__/storageStore.test.ts` covers baseUrl normalization and token storage behaviors.
- `sdk/__tests__/providerManagerPricing.test.ts` covers provider price ranking and model id normalization.
- `sdk/__tests__/cashuSpender.test.ts` covers validation, token reuse, and insufficient balance handling.
- `sdk/__tests__/balanceManager.test.ts` covers refund/top-up validation and early returns.

Run:

```bash
npm run test:sdk
```

## Credential persistence and recovery

With the built-in storage adapter, API-key requests wait for credential writes
before using either a new or reused key. Top-ups persist their outgoing token
before POSTing. `flush()` waits for **all** tracked credential categories (API
keys, child keys, xcashu tokens, cached receive tokens); a failure in any category
can therefore block payment. Failed writes are retried from current memory on a
later flush. Drivers must apply writes in submission order.

SQLite, Bun SQLite, localStorage and IndexedDB report critical credential-write
failures instead of silently discarding them. Noncritical cache writes remain
best-effort where supported. In SSR/server environments, select a server storage
driver: credential writes using unavailable localStorage now reject. A memory
store is not durable across process restarts.

Wallet adapters can accept `sendToken`'s optional fourth argument, `persistToken`.
They must await it **before relinquishing their own recoverable copy**, and retain
that copy if it rejects. Existing adapters ignoring this argument retain a crash
window between wallet send and SDK persistence; invoking the callback only after
irreversibly sending does not close that window. Custom storage adapters without
`flush()` likewise do not provide the persistence barrier.

Failed top-ups remain in `xcashuTokens`, not also in `cachedReceiveTokens`.
Initialization removes legacy cached-receive duplicates in memory when their
original tokens already have xcashu records, then schedules a tracked cleanup
write. A failed cleanup does not stop startup: a subsequent `flush()` retries
the hydrated value, and payments remain blocked until persistence succeeds.

The xcashu list currently holds provider IOUs, temporary wallet handover copies,
and top-up tokens. Refund sweeps treat these entries through the same recovery
path; there is no token-purpose field yet. **API-key mode does not automatically
sweep this list.** Applications must call `refundXcashuTokens` or use
`scripts/refund-all.ts --xcashu`; default script mode handles cached receive tokens
and API keys. Do not run recovery sweeps concurrently with active payments.
Alternate-mint top-up retries require successful recovery of the first token.

### Nostr model ID mapping snapshots

Model aliases are resolved using signed kind `38426` events with the `d` tag
`model-id-mappings`, published by `routstrModelsPubkey` (falling back to
`routstrPubkey`). Content is a complete snapshot:

```json
{"mappings":{"provider-native-id":"canonical-model-id"}}
```

An empty snapshot clears mappings. Invalid snapshots are ignored; bundled
mappings are used until a valid snapshot is available. Both built-in discovery
adapters persist the accepted signed event through `StorageDriver`, even without
SQLite event persistence, and restore its mapping projection on startup. Older
relay events cannot replace it. Changing the configured author discards the old
projection and queries the newly configured author.

**Custom adapter migration:** `DiscoveryAdapter` now requires
`getModelIdMappings`, `setModelIdMappings` (accepting `null` to clear the projection),
`getModelIdMappingsEvent`, and `setModelIdMappingsEvent`. Persist the signed event
and retain the parsed projection for synchronous routing. Missing methods produce
an explicit initialization error rather than silently retaining static mappings.
### Explicit Lightning provider payments

`LightningPayments` is exported from the root and wallet entrypoints. It does not
pay invoices or change the default Cashu routing/top-up behavior:

```ts
const lightning = new LightningPayments();
const invoice = await lightning.createInvoice({
  baseUrl: providerUrl, amountSats: 100, purpose: "topup", apiKey: "sk-...",
});
// Persist invoice.invoice_id and invoice.bolt11 securely BEFORE external payment.
const status = await lightning.getInvoiceStatus(providerUrl, invoice.invoice_id);
if (status.status === "paid") {
  await lightning.acceptPaidInvoice(providerUrl, status, storageAdapter);
}
const refund = await lightning.refundToLightning(providerUrl, "sk-...", "alice@example.com");
```

Use `purpose: "create"` without an API key for first-time funding. Use
`recoverInvoice(providerUrl, bolt11)` to recover a lost status response. Status
and recovery credentials can reveal the new API key; treat them as secrets.
`acceptPaidInvoice` refuses to overwrite a different local provider key and
refreshes the actual millisat balance instead of adding invoice value locally.
`refreshKeyBalance` refreshes an existing key after a confirmed payout.

These operations require canonical `sk-` keys (not Cashu bootstrap tokens) for
top-up/refund and do not retry mutating requests or follow redirects. Unsupported
v2 endpoints fail explicitly. Persist pending operations in the application and
coordinate with active requests/refunds/top-ups. An ambiguous payout must remain
recoverable; do not delete the credential or assume a timeout means funds did not
move. Refund results preserve provider claim IDs/statuses; `LightningPaymentError`
preserves the HTTP status and structured detail for reconciliation. The returned
refund amount is gross debited balance, not necessarily net Lightning proceeds.
