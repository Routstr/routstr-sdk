# Storage Refactoring Plan

## Problem Summary

Two architectural problems make the `storage/` directory hard to maintain and
extend:

1. **God Object in `store.ts` (890 lines)** — Zustand state shape, 30+ setters,
   hydration, and three adapter factories all crammed into one file.

2. **N×M file multiplication** — Every new storage *concern* (kv, usage
   tracking, model cache) requires a separate implementation for every storage
   *backend* (SQLite, Bun SQLite, IndexedDB, memory). Adding a 3rd concern
   means +4 files — not +1.

---

## Current State

```
storage/                             3,198 lines total
├── store.ts                      890  ← God Object
├── shardedDiscoveryAdapter.ts    408  ← Duplicate DiscoveryAdapter impl
├── index.ts                      127  ← Singleton soup + barrel
├── types.ts                       60  ← Clean
├── keys.ts                        25  ← Clean
├── bun.ts / node.ts               —   Platform entrypoints
│
├── drivers/      (5 files)       431  ← Clean abstractions ✅
│   ├── bunSqlite.ts                60
│   ├── sqlite.ts                  111
│   ├── indexedDB.ts               141
│   ├── localStorage.ts             85
│   └── memory.ts                   34
│
└── usageTracking/ (8 files)    1,100  ← Clean but duplicates SQL logic ❌
    ├── bunSqlite.ts               299  ← 60% identical to sqlite.ts
    ├── sqlite.ts                  349  ← 60% identical to bunSqlite.ts
    ├── indexedDB.ts               263  ← matchesFilters dup w/ memory.ts
    ├── memory.ts                  106  ← matchesFilters dup w/ indexedDB
    ├── aggregate.ts               214
    ├── interfaces.ts               70
    ├── index.ts                    13
    └── types.ts                    28
```

### How we got here

Each new feature was bolted onto the monolith. When the model-cache blob
(`modelsFromAllProviders` as one giant JSON key) didn't scale with many
providers, a parallel sharded implementation was built that bypasses the store
entirely — creating two competing `DiscoveryAdapter` implementations.

The `usageTracking/` SQL drivers were written independently instead of sharing
a common SQL layer, so `buildWhereClause`, `ADDED_COLUMNS`, `mapRow`, and
`appendOne` are copy-pasted between `bunSqlite.ts` and `sqlite.ts`.

---

## Quantified Duplication

### Across `usageTracking/bunSqlite.ts` and `usageTracking/sqlite.ts` (60% identical)

| Block                 | Lines | Status                         |
|-----------------------|-------|--------------------------------|
| `buildWhereClause`    | 33    | Character-for-character copy   |
| `ADDED_COLUMNS`       | 14    | Identical                      |
| `mapRow`              | 27    | Identical                      |
| `appendOne` INSERT    | 40    | Identical 22-column statement  |
| `ensureMigrated`      | 25    | Identical                      |
| `normalizeBaseUrl`    | 3     | 6th copy across codebase       |

### Across `usageTracking/indexedDB.ts` and `usageTracking/memory.ts`

| Block              | Lines | Status                         |
|--------------------|-------|--------------------------------|
| `matchesFilters`   | 27    | Character-for-character copy   |
| `normalizeBaseUrl` | 3     | 4th and 5th copies             |

### In `store.ts`

| Issue                              | ~Lines saved | How                          |
|------------------------------------|-------------|------------------------------|
| normalize→persist→set in 30 setters | ~60         | Single `persist` helper      |
| Hydration normalization per field   | ~50         | Shared normalizer + spread   |
| Three adapter factories interleaved | ~300        | Separate files (structural)  |

### Total pure deletion: ~274 lines (9% of current 3,198)

The real win isn't line count — it's that adding a 3rd concern goes from
+4 files (~400 lines) to +1 file (~80 lines).

---

## Target Architecture

```
storage/
├── index.ts                     ← Barrel re-exports
├── types.ts                     ← StorageDriver, DatabaseBackend
├── keys.ts                      ← Unchanged
├── helpers.ts                   ← normalizeBaseUrl, normalizeMint (single source)
├── bun.ts / node.ts             ← Rewired platform entrypoints
│
├── backends/                    ← One per DB engine — opens ONE connection
│   ├── sqlite.ts                ←   Creates ALL tables, returns shared handle
│   ├── bunSqlite.ts             ←   Same for Bun
│   ├── indexedDB.ts             ←   Same (one DB, multiple object stores)
│   ├── localstorage.ts          ←   Trivial kv wrapper
│   └── memory.ts               ←   Map-based (kv + usage)
│
├── concerns/                    ← One per storage domain
│   ├── kvStore.ts               ←   get/set/remove via backend
│   ├── usageTracking.ts         ←   append/list/aggregate via backend
│   └── modelCache.ts            ←   Sharded model cache via backend
│
├── store/                       ← Zustand reactivity layer
│   ├── index.ts                 ←   createSdkStore (combines slices)
│   ├── state.ts                 ←   SdkStorageState type
│   ├── hydration.ts             ←   hydrateStoreFromDriver
│   └── slices/
│       ├── auth.slice.ts        ←   apiKeys, childKeys, clientIds
│       ├── provider.slice.ts    ←   baseUrls, disabled, info, mints
│       ├── failure.slice.ts     ←   failedProviders, lastFailed, cooldown
│       ├── xcashu.slice.ts      ←   xcashu tokens
│       └── payments.slice.ts    ←   cachedReceiveTokens
│
├── adapters/                    ← External interface adapters
│   ├── discovery.ts             ←   createDiscoveryAdapterFromStore
│   ├── storage.ts               ←   createStorageAdapterFromStore
│   └── providerRegistry.ts      ←   createProviderRegistry / FromDiscoveryAdapter
│
└── REFACTORING_PLAN.md          ←   This document
```

### Key design principle

One backend opens **one database connection**, runs **one migration**, and
returns a handle shared by all concerns. The caller never wires up connections
manually — they get a single object with all concerns pre-wired.

```ts
// Before (today): two connections, manual wiring
const kvDriver = createSqliteDriver({ dbPath: "./routstr.db" });
const utDriver = createSqliteUsageTrackingDriver({ dbPath: "./routstr.db" });
const store = createSdkStore({ driver: kvDriver });
// ... more manual wiring

// After: one connection, everything pre-wired
import { createDatabase } from "@routstr/sdk/storage/node";
const db = createDatabase({ backend: "sqlite", dbPath: "./routstr.db" });

db.kv.set("key", value);
db.usageTracking.append(entry);
db.close();
```

---

## Phased Execution Plan

### Phase 1: Extract shared helpers (low risk, high impact)

**Goal:** Delete ~140 lines of duplicated utility code.

1. Create `storage/helpers.ts` with `normalizeBaseUrl` and `normalizeMint`.
2. Create `storage/usageTracking/shared.ts` with `buildWhereClause`,
   `ADDED_COLUMNS`, `mapRow`, `appendOne` factory.
3. Rewire `usageTracking/bunSqlite.ts` and `usageTracking/sqlite.ts` to import
   from `shared.ts`.
4. Create `storage/usageTracking/filters.ts` with `matchesFilters`.
5. Rewire `usageTracking/indexedDB.ts` and `usageTracking/memory.ts` to import
   from `filters.ts`.
6. Run existing tests to verify no behavioral change.

**Files touched:** 6 (all changes internal to `storage/`).
**Net deletion:** ~140 lines.

### Phase 2: Slice the Zustand store (medium risk)

**Goal:** Break `store.ts` from 890 lines into focused 40-100 line slices.

1. Create `storage/store/state.ts` — move `SdkStorageState` type from
   `types.ts`.
2. Create `storage/store/slices/` with per-domain slices. Each slice:
   - Defines its subset of state
   - Defines its setters (normalize → persist → setState)
   - Takes `driver` as constructor parameter
3. Create `storage/store/hydration.ts` — consolidate all hydration into one
   function that calls driver once per field.
4. Create `storage/store/index.ts` — `createSdkStore(driver)` that combines
   all slices.
5. Rewrite `storage/store.ts` → re-export from `store/index.ts` for backward
   compatibility.
6. Run tests.

**Files touched:** ~8 new, 2 modified.
**Net deletion:** ~110 lines (boilerplate consolidation).

### Phase 3: Extract adapters (low risk)

**Goal:** Move adapter factories out of `store.ts`.

1. Create `storage/adapters/discovery.ts` — `createDiscoveryAdapterFromStore`.
2. Create `storage/adapters/storage.ts` — `createStorageAdapterFromStore`.
3. Create `storage/adapters/providerRegistry.ts` — `createProviderRegistryFromStore`
   and `createProviderRegistryFromDiscoveryAdapter`.
4. Update `storage/index.ts` exports.
5. Run tests.

**Files touched:** 3 new, 2 modified.
**Net deletion:** 0 lines (pure move, but enables future dedup).

### Phase 4: Unify the backend layer (medium risk)

**Goal:** One connection, one migration, one `DatabaseBackend` interface.

1. Define `DatabaseBackend` interface in `storage/types.ts`:
   ```ts
   interface DatabaseBackend {
     db: unknown;  // typed per backend
     close: () => void;
   }
   ```

2. Create `storage/backends/sqlite.ts`:
   - Opens one `better-sqlite3` connection
   - Runs one migration creating ALL tables (kv + usage_tracking + future)
   - Returns shared handle used by all concerns

3. Create `storage/backends/bunSqlite.ts` — same for Bun.
4. Create `storage/backends/indexedDB.ts` — same (one DB, multiple object stores).
5. Rewrite concerns (`kvStore.ts`, `usageTracking.ts`) to accept backend
   handle instead of opening their own connection.
6. Create `storage/index.ts` factory:
   ```ts
   export function createDatabase(opts: {
     backend: "sqlite" | "bun" | "indexeddb" | "memory",
     dbPath?: string,
   }): Database
   ```
7. Run tests.

**Files touched:** 5 new, 6 modified.
**Net deletion:** ~130 lines (removes second DB open per backend).
**Behavior change:** One SQLite connection instead of two. Migration happens
once, not per-concern.

### Phase 5: Consolidate DiscoveryAdapter (low risk, optional)

**Goal:** Single implementation instead of two.

1. Deprecate `createDiscoveryAdapterFromStore` (store-based).
2. Make `createShardedDiscoveryAdapter` the only implementation.
3. Provide a thin store-backed wrapper if scripts still need store reactivity.
4. Remove `createProviderRegistryFromStore` — use `createProviderRegistryFromDiscoveryAdapter`
   exclusively.

**Files touched:** 2 modified, 1 deleted.
**Net deletion:** ~150 lines (remove store-based adapter).

### Phase 6: Thin out `index.ts` (low risk)

**Goal:** `index.ts` is a pure barrel file.

1. Move singleton logic (`getDefaultSdkDriver`, `getDefaultSdkStore`, etc.) to
   `storage/singletons.ts`.
2. `index.ts` becomes re-exports only.

**Files touched:** 2 modified.

---

## Backward Compatibility

All existing imports must continue to work:

```ts
// These must work throughout and after the refactor
import { createSdkStore } from "@routstr/sdk/storage";
import { createSqliteDriver } from "@routstr/sdk/storage/node";
import { createBunSqliteDriver } from "@routstr/sdk/storage/bun";
import { createIndexedDBUsageTrackingDriver } from "@routstr/sdk/storage";
import type { SdkStore } from "@routstr/sdk/storage";
```

New constructors are added; old ones are maintained through the refactor and
deprecated afterward (not removed until a major version bump).

---

## Before / After Comparison

| Metric                  | Before          | After           |
|-------------------------|-----------------|-----------------|
| Total lines             | 3,198           | ~2,924 (-9%)    |
| Largest file            | 890 (store.ts)  | ~150 (any file) |
| Files                   | 16              | ~25             |
| SQLite connections      | 2 (per concern) | 1 (shared)      |
| Duplicated SQL blocks   | 5               | 0               |
| Files to add 3rd concern| 4               | 1               |
| Lines to add 3rd concern| ~400            | ~80             |

---

## Risks

- **Phase 4 (backend unification)** is the riskiest — it changes how database
  connections are opened. The IndexedDB cross-driver init logic
  (`sdk_storage` and `usage_tracking` stores creating each other's stores in
  `onupgradeneeded`) needs careful handling during the transition.
- **Phase 2 (store slicing)** requires Zustand slice combinators. All existing
  `store.getState().xxx` and `store.setState()` calls must work identically.
- The test suite (`__tests__/storageStore.test.ts`,
  `__tests__/shardedDiscoveryAdapter.test.ts`) must pass at every phase.
