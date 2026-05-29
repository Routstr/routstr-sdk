/**
 * SQLite-backed DiscoveryAdapter
 *
 * Stores model data in a normalized SQLite table (via ModelsDatabase)
 * and keeps the remaining small DiscoveryAdapter fields in the key-value
 * StorageDriver.  Migration from the old key-value models blob happens
 * automatically on first access.
 *
 * Usage:
 *   const adapter = await createSqliteDiscoveryAdapter({ modelsDb, kv });
 *   // adapter implements DiscoveryAdapter synchronously from here on
 */

import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, ProviderInfo } from "../../core/types";
import type { StorageDriver } from "../types";
import type { ModelsDatabase } from "./modelsDatabase";
import { SDK_STORAGE_KEYS } from "../keys";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SqliteDiscoveryAdapterOptions {
  /** SQLite-backed models store */
  modelsDb: ModelsDatabase;
  /** Key-value StorageDriver for small non-model fields */
  kv: StorageDriver;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

// ---------------------------------------------------------------------------
// Async factory — returns a fully-hydrated synchronous adapter
// ---------------------------------------------------------------------------

export const createSqliteDiscoveryAdapter = async (
  options: SqliteDiscoveryAdapterOptions,
): Promise<DiscoveryAdapter> => {
  const { modelsDb, kv } = options;

  // Migrate any legacy models data from the old key-value blob
  await modelsDb.migrate();

  // Hydrate the non-model fields from the key-value store once, so the
  // synchronous adapter getters can return immediately.
  const [
    rawMints,
    rawInfo,
    lastUsedModel,
    rawDisabled,
    rawBaseUrls,
    lastBaseUrlsUpdate,
    rawRoutstr21Models,
    lastRoutstr21ModelsUpdate,
  ] = await Promise.all([
    kv.getItem<Record<string, string[]>>(
      SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS,
      {},
    ),
    kv.getItem<Record<string, ProviderInfo>>(
      SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS,
      {},
    ),
    kv.getItem<string | null>(SDK_STORAGE_KEYS.LAST_USED_MODEL, null),
    kv.getItem<string[]>(SDK_STORAGE_KEYS.DISABLED_PROVIDERS, []),
    kv.getItem<string[]>(SDK_STORAGE_KEYS.BASE_URLS_LIST, []),
    kv.getItem<number | null>(SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE, null),
    kv.getItem<string[]>(SDK_STORAGE_KEYS.ROUTSTR21_MODELS, []),
    kv.getItem<number | null>(
      SDK_STORAGE_KEYS.LAST_ROUTSTR21_MODELS_UPDATE,
      null,
    ),
  ]);

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
  let _baseUrlsList: string[] = rawBaseUrls.map(normalizeBaseUrl);
  let _lastBaseUrlsUpdate: number | null = lastBaseUrlsUpdate;
  let _routstr21Models: string[] = rawRoutstr21Models;
  let _lastRoutstr21ModelsUpdate: number | null = lastRoutstr21ModelsUpdate;

  // ---- Build the adapter ----

  return {
    // -- Models (SQLite) --

    getCachedModels: () => modelsDb.getAllModels(),

    setCachedModels: (models: Record<string, Model[]>) => {
      const existing = modelsDb.getAllModels();
      const nextKeys = new Set(
        Object.keys(models).map((baseUrl) => normalizeBaseUrl(baseUrl)),
      );

      for (const baseUrl of Object.keys(existing)) {
        if (!nextKeys.has(normalizeBaseUrl(baseUrl))) {
          modelsDb.clearProvider(baseUrl);
        }
      }

      for (const [baseUrl, modelList] of Object.entries(models)) {
        const normalized = normalizeBaseUrl(baseUrl);
        const ts = modelsDb.getProviderLastUpdate(normalized) ?? Date.now();
        modelsDb.upsertProviderModels(normalized, modelList, ts);
      }
    },

    getProviderLastUpdate: (baseUrl: string) =>
      modelsDb.getProviderLastUpdate(normalizeBaseUrl(baseUrl)),

    setProviderLastUpdate: (baseUrl: string, timestamp: number) => {
      modelsDb.setProviderLastUpdate(normalizeBaseUrl(baseUrl), timestamp);
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
      void kv.setItem(SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS, normalized);
    },

    // -- Provider info (kv) --

    getCachedProviderInfo: () => info,

    setCachedProviderInfo: (value: Record<string, ProviderInfo>) => {
      const normalized: Record<string, ProviderInfo> = {};
      for (const [baseUrl, entry] of Object.entries(value)) {
        normalized[normalizeBaseUrl(baseUrl)] = entry;
      }
      info = normalized;
      void kv.setItem(SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS, normalized);
    },

    // -- Last used model (kv) --

    getLastUsedModel: () => _lastUsedModel,
    setLastUsedModel: (modelId: string) => {
      _lastUsedModel = modelId;
      void kv.setItem(SDK_STORAGE_KEYS.LAST_USED_MODEL, modelId);
    },

    // -- Disabled providers (kv) --

    getDisabledProviders: () => _disabledProviders,

    setDisabledProviders: (urls: string[]) => {
      const normalized = urls.map(normalizeBaseUrl);
      _disabledProviders = normalized;
      void kv.setItem(SDK_STORAGE_KEYS.DISABLED_PROVIDERS, normalized);
    },

    // -- Base URLs (kv) --

    getBaseUrlsList: () => _baseUrlsList,
    getBaseUrlsLastUpdate: () => _lastBaseUrlsUpdate,

    setBaseUrlsList: (urls: string[]) => {
      const normalized = urls.map(normalizeBaseUrl);
      _baseUrlsList = normalized;
      void kv.setItem(SDK_STORAGE_KEYS.BASE_URLS_LIST, normalized);
    },

    setBaseUrlsLastUpdate: (timestamp: number) => {
      _lastBaseUrlsUpdate = timestamp;
      void kv.setItem(SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE, timestamp);
    },

    // -- Routstr21 models (kv) --

    getRoutstr21Models: () => _routstr21Models,

    setRoutstr21Models: (models: string[]) => {
      _routstr21Models = models;
      void kv.setItem(SDK_STORAGE_KEYS.ROUTSTR21_MODELS, models);
    },

    getRoutstr21ModelsLastUpdate: () => _lastRoutstr21ModelsUpdate,

    setRoutstr21ModelsLastUpdate: (timestamp: number) => {
      _lastRoutstr21ModelsUpdate = timestamp;
      void kv.setItem(
        SDK_STORAGE_KEYS.LAST_ROUTSTR21_MODELS_UPDATE,
        timestamp,
      );
    },
  };
};
