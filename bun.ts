// Bun runtime entrypoint.
// Imports Bun/SQLite-backed modules that are intentionally excluded from the
// browser-safe default and @routstr/sdk/browser entrypoints.

export * from "./index";
export { createBunSqliteDriver } from "./storage/drivers/bunSqlite";
export {
  createBunSqliteUsageTrackingDriver as createBunSqliteUsageTrackingDriverWithDatabase,
  type BunSqliteUsageTrackingDriverOptions,
} from "./storage/usageTracking/bunSqlite";

import {
  ModelManager as BrowserSafeModelManager,
  type ModelManagerConfig,
} from "./discovery/ModelManager";
import type { DiscoveryAdapter } from "./discovery/interfaces";
import type { StorageDriver } from "./storage/types";
import type { SdkLogger } from "./core/types";
import { createBunSqliteDriver as createBunSqliteDriverInternal } from "./storage/drivers/bunSqlite";
import {
  createBunSqliteUsageTrackingDriver as createBunSqliteUsageTrackingDriverInternal,
  type BunSqliteUsageTrackingDriverOptions,
} from "./storage/usageTracking/bunSqlite";

const createBunPersistentEventDatabase = async (dbPath: string) => {
  const { BunSqliteEventDatabase } = await import("applesauce-sqlite/bun");
  return new BunSqliteEventDatabase(dbPath);
};

export class BunModelManager extends BrowserSafeModelManager {
  constructor(adapter: DiscoveryAdapter, config: ModelManagerConfig = {}) {
    super(adapter, {
      ...config,
      persistentEventDatabaseFactory:
        config.persistentEventDatabaseFactory ?? createBunPersistentEventDatabase,
    });
  }
}

export { BunModelManager as ModelManager };

export const createBunModelManager = (
  adapter: DiscoveryAdapter,
  config: ModelManagerConfig = {}
): BunModelManager => new BunModelManager(adapter, config);

export async function createBunSqliteUsageTrackingDriver(
  options: Omit<BunSqliteUsageTrackingDriverOptions, "sqlite"> = {}
) {
  // @ts-ignore - bun:sqlite is only available at runtime in Bun environments
  const sqlite = await import("bun:sqlite");
  return createBunSqliteUsageTrackingDriverInternal({
    ...options,
    sqlite: { Database: sqlite.Database },
  });
}

export async function createDefaultBunSqliteDriver(
  dbPath = "routstr.sqlite",
  options?: { logger?: SdkLogger }
): Promise<StorageDriver> {
  return createBunSqliteDriverInternal(dbPath, options);
}
