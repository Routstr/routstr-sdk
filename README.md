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

The `RoutstrClient` supports three modes via the constructor `mode` parameter (defaults to `"xcashu"` if unspecified):

- `"xcashu"` — Default mode. Uses standard Cashu token spending with refunds.
- `"lazyrefund"` — Defers refund processing to reduce mint load; may retain tokens longer before refunding.
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
