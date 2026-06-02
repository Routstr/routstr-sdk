/**
 * Sharded DiscoveryAdapter
 *
 * Replaces the SQLite/IndexedDB ModelsDatabase layer with provider-scoped
 * sharding over the existing key-value StorageDriver.
 *
 * Instead of one giant blob:
 *   modelsFromAllProviders  →  Record<string, Model[]>
 *   lastModelsUpdate        →  Record<string, number>
 *
 * We use provider-scoped keys:
 *   models:provider:<encodedBaseUrl>           →  Model[]
 *   models:provider_timestamp:<encodedBaseUrl>  →  number
 *
 * All model data is hydrated into memory at creation time so the
 * synchronous DiscoveryAdapter contract is satisfied. Writes are
 * fire-and-forget via void driver.setItem(...).
 */

import type { DiscoveryAdapter } from "../discovery/interfaces";
import type { ProviderRegistry } from "../wallet/interfaces";
import type { Model, ProviderInfo, SdkLogger } from "../core/types";
import { consoleLogger } from "../core/types";
import type { StorageDriver } from "./types";
import { SDK_STORAGE_KEYS } from "./keys";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const MODEL_KEY_PREFIX = "models:provider:";
const MODEL_TS_KEY_PREFIX = "models:provider_timestamp:";
const PROVIDER_INDEX_KEY = "models:provider_index";
const MIGRATION_MARKER_KEY = "models_sharded_migration_v1";

const encodeBaseUrl = (baseUrl: string): string =>
  encodeURIComponent(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

const modelKey = (baseUrl: string): string =>
  `${MODEL_KEY_PREFIX}${encodeBaseUrl(baseUrl)}`;

const modelTsKey = (baseUrl: string): string =>
  `${MODEL_TS_KEY_PREFIX}${encodeBaseUrl(baseUrl)}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ShardedDiscoveryAdapterOptions {
  /** Key-value StorageDriver */
  driver: StorageDriver;
}

// ---------------------------------------------------------------------------
// Async factory — returns a fully-hydrated synchronous adapter
// ---------------------------------------------------------------------------

export const createShardedDiscoveryAdapter = async (
  options: ShardedDiscoveryAdapterOptions,
): Promise<DiscoveryAdapter> => {
  const { driver } = options;

  // ---- Migration from legacy key-value blob ----

  const legacyModels = await driver.getItem<
    Record<string, Model[]>
  >(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS, {});

  const legacyTimestamps = await driver.getItem<
    Record<string, number>
  >(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE, {});

  if (Object.keys(legacyModels).length > 0) {
    // Write each provider's models to a sharded key
    const migratedProviders: string[] = [];
    for (const [baseUrl, models] of Object.entries(legacyModels)) {
      const normalized = normalizeBaseUrl(baseUrl);
      await driver.setItem(modelKey(normalized), models);
      const ts = legacyTimestamps[normalized] ?? Date.now();
      await driver.setItem(modelTsKey(normalized), ts);
      migratedProviders.push(normalized);
    }

    // Update the index with migrated providers
    const existingIndex = await driver.getItem<string[]>(
      PROVIDER_INDEX_KEY,
      [],
    );
    const merged = [...new Set([...existingIndex, ...migratedProviders])];
    await driver.setItem(PROVIDER_INDEX_KEY, merged);

    // Clear legacy keys
    await driver.removeItem(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS);
    await driver.removeItem(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE);
  }

  await driver.setItem(MIGRATION_MARKER_KEY, true);

  // ---- Hydrate non-model fields once ----

  const [
    rawMints,
    rawInfo,
    lastUsedModel,
    rawDisabled,
    rawManuallyDisabled,
    rawBaseUrls,
    lastBaseUrlsUpdate,
    rawRoutstr21Models,
    lastRoutstr21ModelsUpdate,
  ] = await Promise.all([
    driver.getItem<Record<string, string[]>>(
      SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS,
      {},
    ),
    driver.getItem<Record<string, ProviderInfo>>(
      SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS,
      {},
    ),
    driver.getItem<string | null>(SDK_STORAGE_KEYS.LAST_USED_MODEL, null),
    driver.getItem<string[]>(SDK_STORAGE_KEYS.DISABLED_PROVIDERS, []),
    driver.getItem<string[]>(SDK_STORAGE_KEYS.MANUALLY_DISABLED_PROVIDERS, []),
    driver.getItem<string[]>(SDK_STORAGE_KEYS.BASE_URLS_LIST, []),
    driver.getItem<number | null>(SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE, null),
    driver.getItem<string[]>(SDK_STORAGE_KEYS.ROUTSTR21_MODELS, []),
    driver.getItem<number | null>(
      SDK_STORAGE_KEYS.LAST_ROUTSTR21_MODELS_UPDATE,
      null,
    ),
  ]);

  // ---- Hydrate model data from sharded keys ----

  const modelsByBaseUrl = new Map<string, Model[]>();
  const timestampsByBaseUrl = new Map<string, number>();

  // Read the provider index to know which sharded keys exist.
  // We also include providers from info/mints/baseUrls/disabled lists
  // and the legacy blob (just migrated) in case a provider has been
  // configured but hasn't had models cached yet, or the index is
  // missing during migration.
  const providerIndex = new Set<string>();
  const knownProviders = new Set<string>();
  for (const baseUrl of Object.keys(rawInfo)) {
    knownProviders.add(normalizeBaseUrl(baseUrl));
  }
  for (const baseUrl of Object.keys(rawMints)) {
    knownProviders.add(normalizeBaseUrl(baseUrl));
  }
  for (const baseUrl of rawBaseUrls) {
    knownProviders.add(normalizeBaseUrl(baseUrl));
  }
  for (const baseUrl of rawDisabled) {
    knownProviders.add(normalizeBaseUrl(baseUrl));
  }
  for (const baseUrl of Object.keys(legacyModels)) {
    knownProviders.add(normalizeBaseUrl(baseUrl));
  }
  const indexProviders = await driver.getItem<string[]>(
    PROVIDER_INDEX_KEY,
    [],
  );
  for (const baseUrl of indexProviders) {
    const normalized = normalizeBaseUrl(baseUrl);
    providerIndex.add(normalized);
    knownProviders.add(normalized);
  }

  // Read sharded model data for each known provider
  for (const baseUrl of knownProviders) {
    const normalized = normalizeBaseUrl(baseUrl);
    const models = await driver.getItem<Model[] | null>(
      modelKey(normalized),
      null,
    );
    const ts = await driver.getItem<number | null>(
      modelTsKey(normalized),
      null,
    );

    if (models !== null) {
      modelsByBaseUrl.set(normalized, models);
    }
    if (ts !== null) {
      timestampsByBaseUrl.set(normalized, ts);
    }
    if (models !== null || ts !== null) {
      providerIndex.add(normalized);
    }
  }

  // ---- Mutable state for non-model fields (kept in sync with kv) ----

  let mints: Record<string, string[]> = Object.fromEntries(
    Object.entries(rawMints).map(([baseUrl, mintList]) => [
      normalizeBaseUrl(baseUrl),
      mintList.map((mint) => (mint.endsWith("/") ? mint.slice(0, -1) : mint)),
    ]),
  );

  let info: Record<string, ProviderInfo> = Object.fromEntries(
    Object.entries(rawInfo).map(([baseUrl, entry]) => [
      normalizeBaseUrl(baseUrl),
      entry,
    ]),
  );

  let _lastUsedModel: string | null = lastUsedModel;
  let _disabledProviders: string[] = rawDisabled.map(normalizeBaseUrl);
  let _manuallyDisabledProviders: string[] = rawManuallyDisabled.map(normalizeBaseUrl);
  let _baseUrlsList: string[] = rawBaseUrls.map(normalizeBaseUrl);
  let _lastBaseUrlsUpdate: number | null = lastBaseUrlsUpdate;
  let _routstr21Models: string[] = rawRoutstr21Models;
  let _lastRoutstr21ModelsUpdate: number | null = lastRoutstr21ModelsUpdate;

  const persistProviderIndex = (): void => {
    void driver.setItem(PROVIDER_INDEX_KEY, [...providerIndex]);
  };

  // ---- Build the adapter ----

  return {
    // -- Models (sharded kv) --

    getCachedModels: (): Record<string, Model[]> => {
      const result: Record<string, Model[]> = {};
      for (const [baseUrl, models] of modelsByBaseUrl.entries()) {
        result[baseUrl] = models;
      }
      return result;
    },

    setCachedModels: (models: Record<string, Model[]>): void => {
      const nextKeys = new Set(
        Object.keys(models).map((baseUrl) => normalizeBaseUrl(baseUrl)),
      );

      // Remove providers with cached models that are no longer present.
      // Providers that only have timestamps are left alone so failed-fetch
      // backoff timestamps survive later model-cache writes.
      for (const baseUrl of [...modelsByBaseUrl.keys()]) {
        if (!nextKeys.has(normalizeBaseUrl(baseUrl))) {
          providerIndex.delete(baseUrl);
          modelsByBaseUrl.delete(baseUrl);
          timestampsByBaseUrl.delete(baseUrl);
          void driver.removeItem(modelKey(baseUrl));
          void driver.removeItem(modelTsKey(baseUrl));
        }
      }

      // Write new/updated providers
      for (const [baseUrl, modelList] of Object.entries(models)) {
        const normalized = normalizeBaseUrl(baseUrl);
        providerIndex.add(normalized);
        modelsByBaseUrl.set(normalized, modelList);
        const ts = timestampsByBaseUrl.get(normalized) ?? Date.now();
        timestampsByBaseUrl.set(normalized, ts);
        void driver.setItem(modelKey(normalized), modelList);
        void driver.setItem(modelTsKey(normalized), ts);
      }

      persistProviderIndex();
    },

    getProviderLastUpdate: (baseUrl: string): number | null => {
      return timestampsByBaseUrl.get(normalizeBaseUrl(baseUrl)) ?? null;
    },

    setProviderLastUpdate: (baseUrl: string, timestamp: number): void => {
      const normalized = normalizeBaseUrl(baseUrl);
      providerIndex.add(normalized);
      timestampsByBaseUrl.set(normalized, timestamp);
      void driver.setItem(modelTsKey(normalized), timestamp);
      persistProviderIndex();
    },

    // -- Mints (kv) --

    getCachedMints: () => mints,

    setCachedMints: (value: Record<string, string[]>) => {
      const normalized: Record<string, string[]> = {};
      for (const [baseUrl, mintList] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = mintList.map((mint) =>
          mint.endsWith("/") ? mint.slice(0, -1) : mint,
        );
      }
      mints = normalized;
      void driver.setItem(SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS, normalized);
    },

    // -- Provider info (kv) --

    getCachedProviderInfo: () => info,

    setCachedProviderInfo: (value: Record<string, ProviderInfo>) => {
      const normalized: Record<string, ProviderInfo> = {};
      for (const [baseUrl, entry] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = entry;
      }
      info = normalized;
      void driver.setItem(SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS, normalized);
    },

    // -- Last used model (kv) --

    getLastUsedModel: () => _lastUsedModel,
    setLastUsedModel: (modelId: string) => {
      _lastUsedModel = modelId;
      void driver.setItem(SDK_STORAGE_KEYS.LAST_USED_MODEL, modelId);
    },

    // -- Disabled providers (kv) --

    getDisabledProviders: () => {
      return [...new Set([..._disabledProviders, ..._manuallyDisabledProviders])];
    },

    setDisabledProviders: (urls: string[]) => {
      const normalized = urls.map(normalizeBaseUrl);
      _disabledProviders = normalized;
      void driver.setItem(SDK_STORAGE_KEYS.DISABLED_PROVIDERS, normalized);
    },

    // -- Manually disabled providers (kv) --

    getManuallyDisabledProviders: () => _manuallyDisabledProviders,

    setManuallyDisabledProviders: (urls: string[]) => {
      const normalized = urls.map(normalizeBaseUrl);
      _manuallyDisabledProviders = normalized;
      void driver.setItem(SDK_STORAGE_KEYS.MANUALLY_DISABLED_PROVIDERS, normalized);
    },

    // -- Base URLs (kv) --

    getBaseUrlsList: () => _baseUrlsList,
    getBaseUrlsLastUpdate: () => _lastBaseUrlsUpdate,

    setBaseUrlsList: (urls: string[]) => {
      const normalized = urls.map(normalizeBaseUrl);
      _baseUrlsList = normalized;
      void driver.setItem(SDK_STORAGE_KEYS.BASE_URLS_LIST, normalized);
    },

    setBaseUrlsLastUpdate: (timestamp: number) => {
      _lastBaseUrlsUpdate = timestamp;
      void driver.setItem(SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE, timestamp);
    },

    // -- Routstr21 models (kv) --

    getRoutstr21Models: () => _routstr21Models,

    setRoutstr21Models: (models: string[]) => {
      _routstr21Models = models;
      void driver.setItem(SDK_STORAGE_KEYS.ROUTSTR21_MODELS, models);
    },

    getRoutstr21ModelsLastUpdate: () => _lastRoutstr21ModelsUpdate,

    setRoutstr21ModelsLastUpdate: (timestamp: number) => {
      _lastRoutstr21ModelsUpdate = timestamp;
      void driver.setItem(
        SDK_STORAGE_KEYS.LAST_ROUTSTR21_MODELS_UPDATE,
        timestamp,
      );
    },
  };
};

export const createProviderRegistryFromDiscoveryAdapter = (
  adapter: DiscoveryAdapter,
  logger?: SdkLogger,
): ProviderRegistry => {
  const log = (logger ?? consoleLogger).child("ProviderRegistry");

  return {
    getModelsForProvider: (baseUrl: string): Model[] => {
      const normalized = normalizeBaseUrl(baseUrl);
      return adapter.getCachedModels()[normalized] || [];
    },

    getDisabledProviders: (): string[] => adapter.getDisabledProviders(),

    getProviderMints: (baseUrl: string): string[] => {
      const normalized = normalizeBaseUrl(baseUrl);
      return adapter.getCachedMints()[normalized] || [];
    },

    getProviderInfo: async (baseUrl: string): Promise<ProviderInfo | null> => {
      const normalized = normalizeBaseUrl(baseUrl);
      const cached = adapter.getCachedProviderInfo()[normalized];
      if (cached) return cached;

      try {
        const response = await fetch(`${normalized}v1/info`);
        if (!response.ok) {
          throw new Error(`Failed ${response.status}`);
        }
        const info = (await response.json()) as ProviderInfo;
        adapter.setCachedProviderInfo({
          ...adapter.getCachedProviderInfo(),
          [normalized]: info,
        });
        return info;
      } catch (error) {
        log.warn(`Failed to fetch provider info from ${normalized}:`, error);
        return null;
      }
    },

    getAllProvidersModels: (): Record<string, Model[]> =>
      adapter.getCachedModels(),
  };
};
