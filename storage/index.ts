import { localStorageDriver } from "./drivers/localStorage";
import { createMemoryDriver } from "./drivers/memory";
import {
  createSqliteDriver,
  createBunSqliteDriver,
} from "./drivers/sqlite";
import { createIndexedDBDriver } from "./drivers/indexedDB";
import {
  createIndexedDBUsageTrackingDriver,
  createMemoryUsageTrackingDriver,
  createSqliteUsageTrackingDriver,
  createBunSqliteUsageTrackingDriver,
  type UsageTrackingDriver,
} from "./usageTracking";
import type { StorageDriver } from "./types";
import {
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
  type SdkStore,
} from "./store";
import type { DiscoveryAdapter } from "../discovery/interfaces";

export type { StorageDriver } from "./types";
export type { SdkStore } from "./store";
export type { DiscoveryAdapter } from "../discovery/interfaces";
export type { StorageAdapter, ProviderRegistry, XCashuTokenEntry } from "../wallet/interfaces";
export type {
  UsageTrackingDriver,
  UsageTrackingEntry,
  ListUsageTrackingOptions,
} from "./usageTracking";
export { SDK_STORAGE_KEYS } from "./keys";
export {
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
} from "./store";
export {
  localStorageDriver,
  createMemoryDriver,
  createSqliteDriver,
  createBunSqliteDriver,
  createIndexedDBDriver,
};
export {
  createIndexedDBUsageTrackingDriver,
  createMemoryUsageTrackingDriver,
  createSqliteUsageTrackingDriver,
  createBunSqliteUsageTrackingDriver,
} from "./usageTracking";
import {
  createModelsDatabase,
  createSqliteDiscoveryAdapter,
} from "./discoveryAdapters";
export {
  createModelsDatabase,
  createModelsDatabaseBun,
  createSqliteDiscoveryAdapter,
} from "./discoveryAdapters";
export type { ModelsDatabase, SqliteDiscoveryAdapterOptions } from "./discoveryAdapters";

const isBrowser = (): boolean => {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.localStorage !== "undefined"
    );
  } catch {
    return false;
  }
};

const isNode = (): boolean => {
  try {
    return (
      typeof process !== "undefined" &&
      process.versions != null &&
      process.versions.node != null
    );
  } catch {
    return false;
  }
};

let defaultDriver: StorageDriver | null = null;

const isBun = (): boolean => {
  return typeof process.versions.bun !== "undefined";
};

export const getDefaultSdkDriver = (): StorageDriver => {
  if (defaultDriver) return defaultDriver;
  if (isBrowser()) {
    defaultDriver = localStorageDriver;
    return defaultDriver;
  }
  if (isBun()) {
    defaultDriver = createMemoryDriver();
    return defaultDriver;
  }
  if (isNode()) {
    defaultDriver = createSqliteDriver();
    return defaultDriver;
  }
  defaultDriver = createMemoryDriver();
  return defaultDriver;
};

let defaultStore: ReturnType<typeof createSdkStore> | null = null;
let defaultUsageTrackingDriver: UsageTrackingDriver | null = null;

export const getDefaultSdkStore = (): Promise<SdkStore> => {
  if (!defaultStore) {
    defaultStore = createSdkStore({ driver: getDefaultSdkDriver() });
  }
  return defaultStore.hydrate.then(() => defaultStore!.store);
};

export const getDefaultUsageTrackingDriver = (): UsageTrackingDriver => {
  if (defaultUsageTrackingDriver) return defaultUsageTrackingDriver;

  const storageDriver = getDefaultSdkDriver();

  if (isBrowser()) {
    defaultUsageTrackingDriver = createIndexedDBUsageTrackingDriver({
      legacyStorageDriver: storageDriver,
    });
    return defaultUsageTrackingDriver;
  }

  if (isBun()) {
    defaultUsageTrackingDriver = createBunSqliteUsageTrackingDriver();
    return defaultUsageTrackingDriver;
  }

  if (isNode()) {
    defaultUsageTrackingDriver = createSqliteUsageTrackingDriver({
      legacyStorageDriver: storageDriver,
    });
    return defaultUsageTrackingDriver;
  }

  defaultUsageTrackingDriver = createMemoryUsageTrackingDriver();
  return defaultUsageTrackingDriver;
};

/**
 * Allow setting a custom usage tracking driver (useful for routstrd to use proper DB path)
 */
export const setDefaultUsageTrackingDriver = (driver: UsageTrackingDriver): void => {
  defaultUsageTrackingDriver = driver;
};

let defaultDiscoveryAdapter: DiscoveryAdapter | null = null;

export const getDefaultDiscoveryAdapter = async (): Promise<DiscoveryAdapter> => {
  if (defaultDiscoveryAdapter) return defaultDiscoveryAdapter;

  const driver = getDefaultSdkDriver();

  // In Node, use SQLite-backed adapter for efficient model storage
  if (isNode() && !isBun()) {
    try {
      const modelsDb = createModelsDatabase({
        legacyStorageDriver: driver,
      });
      defaultDiscoveryAdapter = await createSqliteDiscoveryAdapter({ modelsDb, kv: driver });
      return defaultDiscoveryAdapter;
    } catch {
      // Fall back to store-based adapter if better-sqlite3 is unavailable
    }
  }

  const store = await getDefaultSdkStore();
  defaultDiscoveryAdapter = createDiscoveryAdapterFromStore(store);
  return defaultDiscoveryAdapter;
};

export const getDefaultStorageAdapter = async () =>
  createStorageAdapterFromStore(await getDefaultSdkStore());

export const getDefaultProviderRegistry = async () =>
  createProviderRegistryFromStore(await getDefaultSdkStore());
