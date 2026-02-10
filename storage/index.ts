import { localStorageDriver } from "./drivers/localStorage";
import { createMemoryDriver } from "./drivers/memory";
import { createSqliteDriver } from "./drivers/sqlite";
import type { StorageDriver } from "./types";
import {
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
} from "./store";

export type { StorageDriver } from "./types";
export { SDK_STORAGE_KEYS } from "./keys";
export { createSdkStore } from "./store";
export { localStorageDriver, createMemoryDriver, createSqliteDriver };

const isBrowser = (): boolean =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

const isNode = (): boolean =>
  typeof process !== "undefined" && !!process.versions?.node;

let defaultDriver: StorageDriver | null = null;

export const getDefaultSdkDriver = (): StorageDriver => {
  if (defaultDriver) return defaultDriver;
  if (isBrowser()) {
    defaultDriver = localStorageDriver;
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

export const getDefaultSdkStore = () => {
  if (!defaultStore) {
    defaultStore = createSdkStore({ driver: getDefaultSdkDriver() });
  }
  return defaultStore;
};

export const getDefaultDiscoveryAdapter = () =>
  createDiscoveryAdapterFromStore(getDefaultSdkStore());

export const getDefaultStorageAdapter = () =>
  createStorageAdapterFromStore(getDefaultSdkStore());

export const getDefaultProviderRegistry = () =>
  createProviderRegistryFromStore(getDefaultSdkStore());
