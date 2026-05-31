// Node.js runtime entrypoint.
// Imports SQLite-backed modules that are intentionally excluded from the
// browser-safe default and @routstr/sdk/browser entrypoints.

export * from "./index";
export { createSqliteDriver, type SqliteDriverOptions } from "./storage/drivers/sqlite";
export {
  createSqliteUsageTrackingDriver,
  type SqliteUsageTrackingDriverOptions,
} from "./storage/usageTracking/sqlite";

import {
  ModelManager as BrowserSafeModelManager,
  type ModelManagerConfig,
} from "./discovery/ModelManager";
import type { DiscoveryAdapter } from "./discovery/interfaces";

const createNodePersistentEventDatabase = async (dbPath: string) => {
  const { BetterSqlite3EventDatabase } = await import(
    "applesauce-sqlite/better-sqlite3"
  );
  return new BetterSqlite3EventDatabase(dbPath);
};

export class NodeModelManager extends BrowserSafeModelManager {
  constructor(adapter: DiscoveryAdapter, config: ModelManagerConfig = {}) {
    super(adapter, {
      ...config,
      persistentEventDatabaseFactory:
        config.persistentEventDatabaseFactory ?? createNodePersistentEventDatabase,
    });
  }
}

export { NodeModelManager as ModelManager };

export const createNodeModelManager = (
  adapter: DiscoveryAdapter,
  config: ModelManagerConfig = {}
): NodeModelManager => new NodeModelManager(adapter, config);
