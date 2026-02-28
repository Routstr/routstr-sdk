import { localStorageDriver } from "./drivers/localStorage";
import { createMemoryDriver } from "./drivers/memory";
import { createSqliteDriver } from "./drivers/sqlite";
import { createIndexedDBDriver } from "./drivers/indexedDB";
import type { StorageDriver } from "./types";
import {
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
  type SdkStore,
} from "./store";

export type { StorageDriver } from "./types";
export type { SdkStore } from "./store";
export type { DiscoveryAdapter } from "../discovery/interfaces";
export type { StorageAdapter, ProviderRegistry } from "../wallet/interfaces";
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
  createIndexedDBDriver,
};

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

let defaultStorePromise: Promise<SdkStore> | null = null;

export const getDefaultSdkStore = (): Promise<SdkStore> => {
  if (!defaultStorePromise) {
    defaultStorePromise = createSdkStore({ driver: getDefaultSdkDriver() });
  }
  return defaultStorePromise;
};

export const getDefaultDiscoveryAdapter = async () =>
  createDiscoveryAdapterFromStore(await getDefaultSdkStore());

export const getDefaultStorageAdapter = async () =>
  createStorageAdapterFromStore(await getDefaultSdkStore());

export const getDefaultProviderRegistry = async () =>
  createProviderRegistryFromStore(await getDefaultSdkStore());
