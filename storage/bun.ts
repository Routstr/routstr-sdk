// Bun storage entrypoint.
// Bun SQLite-backed drivers live here so @routstr/sdk/storage remains browser-safe.

export * from "./index";
export { createBunSqliteDriver } from "./drivers/bunSqlite";
export {
  createBunSqliteUsageTrackingDriver as createBunSqliteUsageTrackingDriverWithDatabase,
  type BunSqliteUsageTrackingDriverOptions,
} from "./usageTracking/bunSqlite";

import type { StorageDriver } from "./types";
import type { SdkLogger } from "../core/types";
import { createBunSqliteDriver as createBunSqliteDriverInternal } from "./drivers/bunSqlite";
import {
  createBunSqliteUsageTrackingDriver as createBunSqliteUsageTrackingDriverInternal,
  type BunSqliteUsageTrackingDriverOptions,
} from "./usageTracking/bunSqlite";

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
