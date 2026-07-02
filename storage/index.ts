import { localStorageDriver } from "./drivers/localStorage";
import { createMemoryDriver } from "./drivers/memory";
import { createIndexedDBDriver } from "./drivers/indexedDB";
import {
  createIndexedDBUsageTrackingDriver,
  createMemoryUsageTrackingDriver,
  type UsageTrackingDriver,
} from "./usageTracking";
import type { StorageDriver } from "./types";
import {
  createSdkStore,
  createStorageAdapterFromStore,
  type SdkStore,
} from "./store";
import type { DiscoveryAdapter } from "../discovery/interfaces";

export type { StorageDriver } from "./types";
export type { SdkStore } from "./store";
export type { DiscoveryAdapter } from "../discovery/interfaces";
export type { StorageAdapter, XCashuTokenEntry } from "../wallet/interfaces";
export type {
  AggregateUsageOptions,
  ListUsageTrackingOptions,
  UsageAggregateRow,
  UsageGroupBy,
  UsageTrackingDriver,
  UsageTrackingEntry,
} from "./usageTracking";
export { SDK_STORAGE_KEYS } from "./keys";
export {
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createStorageAdapterFromStore,
} from "./store";
export {
  localStorageDriver,
  createMemoryDriver,
  createIndexedDBDriver,
};
export {
  createIndexedDBUsageTrackingDriver,
  createMemoryUsageTrackingDriver,
} from "./usageTracking";
import {
  createShardedDiscoveryAdapter,
} from "./shardedDiscoveryAdapter";
export {
  createShardedDiscoveryAdapter,
} from "./shardedDiscoveryAdapter";
export type {
  ShardedDiscoveryAdapterOptions,
} from "./shardedDiscoveryAdapter";

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

let defaultDriver: StorageDriver | null = null;

export const getDefaultSdkDriver = (): StorageDriver => {
  if (defaultDriver) return defaultDriver;
  if (isBrowser()) {
    defaultDriver = localStorageDriver;
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
  defaultDiscoveryAdapter = await createShardedDiscoveryAdapter({ driver });
  return defaultDiscoveryAdapter;
};

export const getDefaultStorageAdapter = async () =>
  createStorageAdapterFromStore(await getDefaultSdkStore());
