# Browser-Safe Entrypoints Refactor

## Summary

This refactor fixes a bundling issue where browser apps importing `@routstr/sdk` could accidentally pull in Bun/Node-only SQLite modules through dynamic imports. In Next/Webpack, those dynamic imports were still statically analyzed, causing errors like:

```txt
UnhandledSchemeError: Reading from "bun:sqlite" is not handled by plugins
```

The SDK now has browser-safe default exports and explicit runtime-specific entrypoints for Node and Bun.

The browser build is regression-tested as a complete dependency bundle. The
Web SSE inspector is isolated from the Node `Transform` parser, and file-backed
audit logging is configured only by the Node/Bun entrypoints. Tinfoil's
capability-gated `zlib` fallback can be mapped to `@routstr/sdk/browser/zlib`.

## Root Cause

Before this change, the default SDK entrypoint eventually included code paths with dynamic imports such as:

```ts
await import("applesauce-sqlite/bun")
await import("applesauce-sqlite/better-sqlite3")
await import("better-sqlite3")
await import("bun:sqlite")
```

Even when those imports were only reachable at runtime under specific SQLite/persistent-storage conditions, bundlers like Webpack still saw them while building browser bundles. Webpack then followed the `applesauce-sqlite/bun` import chain to `bun:sqlite`, which is a Bun-only module scheme and cannot be resolved in a browser build.

## New Entrypoint Architecture

The package is now split into browser-safe and runtime-specific entrypoints:

```txt
@routstr/sdk
  Browser-safe default SDK exports only.

@routstr/sdk/browser
  Explicit browser-safe alias of the default browser-safe SDK surface.

@routstr/sdk/node
  Node-specific exports, including better-sqlite3-backed storage and persistent Nostr event storage.

@routstr/sdk/bun
  Bun-specific exports, including bun:sqlite-backed storage and persistent Nostr event storage.

@routstr/sdk/storage
  Browser-safe storage exports only.

@routstr/sdk/storage/node
  Node-specific SQLite storage exports.

@routstr/sdk/storage/bun
  Bun-specific SQLite storage exports.
```

## Files Added

### `browser.ts`

Explicit browser-safe entrypoint.

```ts
export * from "./index";
```

### `node.ts`

Node runtime entrypoint.

Exports the default SDK surface plus Node-only SQLite helpers:

- `createSqliteDriver`
- `createSqliteUsageTrackingDriver`
- `NodeModelManager`
- `ModelManager` alias pointing to `NodeModelManager`
- `createNodeModelManager`

This entrypoint is allowed to import:

- `better-sqlite3`
- `applesauce-sqlite/better-sqlite3`

### `bun.ts`

Bun runtime entrypoint.

Exports the default SDK surface plus Bun-only SQLite helpers:

- `createBunSqliteDriver`
- `createBunSqliteUsageTrackingDriver`
- `createDefaultBunSqliteDriver`
- `BunModelManager`
- `ModelManager` alias pointing to `BunModelManager`
- `createBunModelManager`

This entrypoint is allowed to import:

- `bun:sqlite`
- `applesauce-sqlite/bun`

### `storage/node.ts`

Node-specific storage entrypoint.

Exports browser-safe storage APIs plus:

- `createSqliteDriver`
- `createSqliteUsageTrackingDriver`

### `storage/bun.ts`

Bun-specific storage entrypoint.

Exports browser-safe storage APIs plus:

- `createBunSqliteDriver`
- `createBunSqliteUsageTrackingDriver`
- `createDefaultBunSqliteDriver`

### `storage/drivers/bunSqlite.ts`

Moved Bun-specific key-value SQLite storage driver out of `storage/drivers/sqlite.ts` so the Node SQLite driver no longer contains any `bun:sqlite` references.

## Files Changed

### `package.json`

Added package exports for the new entrypoints:

```json
{
  "./browser": {
    "types": "./dist/browser.d.mts",
    "import": "./dist/browser.mjs",
    "require": "./dist/browser.js"
  },
  "./node": {
    "types": "./dist/node.d.mts",
    "import": "./dist/node.mjs",
    "require": "./dist/node.js"
  },
  "./bun": {
    "types": "./dist/bun.d.mts",
    "import": "./dist/bun.mjs",
    "require": "./dist/bun.js"
  },
  "./storage/node": {
    "types": "./dist/storage/node.d.mts",
    "import": "./dist/storage/node.mjs",
    "require": "./dist/storage/node.js"
  },
  "./storage/bun": {
    "types": "./dist/storage/bun.d.mts",
    "import": "./dist/storage/bun.mjs",
    "require": "./dist/storage/bun.js"
  }
}
```

### `tsup.config.ts`

Added new build entries:

```ts
"browser.ts",
"node.ts",
"bun.ts",
"storage/node.ts",
"storage/bun.ts",
```

The SDK build now emits runtime-specific bundles separately from browser-safe bundles.

### `discovery/ModelManager.ts`

Removed direct runtime-specific SQLite imports from the browser-safe `ModelManager` implementation.

Before:

```ts
if (isBunRuntime()) {
  const { BunSqliteEventDatabase } = await import("applesauce-sqlite/bun");
  return new BunSqliteEventDatabase(this.eventStoreDbPath);
}

const { BetterSqlite3EventDatabase } = await import(
  "applesauce-sqlite/better-sqlite3"
);
return new BetterSqlite3EventDatabase(this.eventStoreDbPath);
```

After:

- Added `PersistentEventDatabase` export.
- Added `PersistentEventDatabaseFactory` export.
- Added `persistentEventDatabaseFactory?: PersistentEventDatabaseFactory` to `ModelManagerConfig`.
- `ModelManager` now requires an injected factory when `eventStoreDbPath` is used.

This keeps `ModelManager` itself browser-safe while allowing `@routstr/sdk/node` and `@routstr/sdk/bun` to provide preconfigured runtime-specific subclasses.

### `storage/index.ts`

Made the default storage entrypoint browser-safe.

Removed exports/imports for:

- `createSqliteDriver`
- `createBunSqliteDriver`
- `createSqliteUsageTrackingDriver`
- `createBunSqliteUsageTrackingDriver`

`getDefaultSdkDriver()` now chooses:

- `localStorageDriver` in browsers
- `createMemoryDriver()` outside browsers

`getDefaultUsageTrackingDriver()` now chooses:

- `createIndexedDBUsageTrackingDriver()` in browsers
- `createMemoryUsageTrackingDriver()` outside browsers

Node/Bun SQLite defaults are now available only from runtime-specific entrypoints.

### `storage/usageTracking/index.ts`

Made usage tracking default exports browser-safe.

Removed default exports for:

- `createSqliteUsageTrackingDriver`
- `createBunSqliteUsageTrackingDriver`

Those are now exported through:

- `@routstr/sdk/storage/node`
- `@routstr/sdk/storage/bun`
- `@routstr/sdk/node`
- `@routstr/sdk/bun`

### `storage/drivers/sqlite.ts`

Removed the Bun-specific driver from this Node-oriented SQLite file.

This file now only contains `better-sqlite3`-based Node SQLite storage logic.

## Runtime-Specific Model Managers

### Node

`@routstr/sdk/node` exports a `NodeModelManager` and aliases it as `ModelManager`.

It injects a persistent event database factory using:

```ts
import("applesauce-sqlite/better-sqlite3")
```

### Bun

`@routstr/sdk/bun` exports a `BunModelManager` and aliases it as `ModelManager`.

It injects a persistent event database factory using:

```ts
import("applesauce-sqlite/bun")
```

## Migration Notes

### Browser apps

Browser apps should continue importing from the default SDK:

```ts
import { ModelManager, MintDiscovery } from "@routstr/sdk";
```

or explicitly from:

```ts
import { ModelManager, MintDiscovery } from "@routstr/sdk/browser";
```

Both are browser-safe.

### Node SQLite storage

Before:

```ts
import { createSqliteDriver } from "@routstr/sdk/storage";
```

After:

```ts
import { createSqliteDriver } from "@routstr/sdk/storage/node";
```

or:

```ts
import { createSqliteDriver } from "@routstr/sdk/node";
```

### Bun SQLite storage

Use:

```ts
import { createBunSqliteDriver } from "@routstr/sdk/storage/bun";
```

or:

```ts
import { createBunSqliteDriver } from "@routstr/sdk/bun";
```

### Persistent Nostr event storage in Node

Use the Node runtime entrypoint:

```ts
import { ModelManager } from "@routstr/sdk/node";

const manager = new ModelManager(adapter, {
  eventStoreDbPath: "routstr.sqlite",
});
```

### Persistent Nostr event storage in Bun

Use the Bun runtime entrypoint:

```ts
import { ModelManager } from "@routstr/sdk/bun";

const manager = new ModelManager(adapter, {
  eventStoreDbPath: "routstr.sqlite",
});
```

### Custom persistent event database factory

The browser-safe `ModelManager` can still be used with persistent event storage if the caller injects a factory:

```ts
import { ModelManager } from "@routstr/sdk";

const manager = new ModelManager(adapter, {
  eventStoreDbPath: "custom.sqlite",
  persistentEventDatabaseFactory: async (dbPath) => {
    return createSomeEventDatabase(dbPath);
  },
});
```

## Verification Performed

Built the SDK successfully:

```sh
pnpm build
```

Verified these browser-safe bundles contain no references to `applesauce-sqlite`, `bun:sqlite`, or `better-sqlite3`:

```txt
dist/index.mjs
dist/browser.mjs
dist/storage/index.mjs
dist/discovery/index.mjs
```

Runtime-specific references now appear only in:

```txt
dist/node.mjs
dist/bun.mjs
dist/storage/node.mjs
dist/storage/bun.mjs
```

Also verified `routstr-chat` builds successfully against the rebuilt local SDK after removing its temporary Webpack workaround.

## Outcome

The SDK no longer leaks Bun/Node SQLite modules into browser bundles. Browser consumers can import `@routstr/sdk` safely without requiring app-level Webpack aliases, stubs, `IgnorePlugin`, `NormalModuleReplacementPlugin`, or `resolve.fallback` hacks for `bun:sqlite`.
