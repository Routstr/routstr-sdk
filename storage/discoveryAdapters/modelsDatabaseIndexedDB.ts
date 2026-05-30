/**
 * IndexedDB-backed models database (browser runtime)
 *
 * IndexedDB is asynchronous, while DiscoveryAdapter/ModelsDatabase accessors are
 * synchronous. This implementation hydrates an in-memory mirror during
 * migrate(), then synchronously updates that mirror and writes changes through
 * to IndexedDB in the background.
 */

import type { Model } from "../../core/types";
import type { StorageDriver } from "../types";
import { SDK_STORAGE_KEYS } from "../keys";
import type { ModelsDatabase } from "./modelsDatabase";

interface IndexedDBModelsDatabaseOptions {
  /** IndexedDB database name (default: "routstr-sdk-models") */
  dbName?: string;
  /** Object store name for model rows (default: "models") */
  storeName?: string;
  /** Object store name for provider timestamps (default: `${storeName}_timestamps`) */
  timestampsStoreName?: string;
  /** Legacy key-value StorageDriver for migration */
  legacyStorageDriver?: StorageDriver;
}

interface ModelRow {
  key: string;
  id: string;
  baseUrl: string;
  data: string;
}

interface TimestampRow {
  baseUrl: string;
  lastUpdate: number;
}

const DEFAULT_DB_NAME = "routstr-sdk-models";
const DEFAULT_STORE_NAME = "models";
const MIGRATION_MARKER_KEY = "models_indexeddb_migration_v1";

const isBrowser = typeof indexedDB !== "undefined";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const rowKey = (baseUrl: string, modelId: string): string =>
  `${encodeURIComponent(baseUrl)}|${encodeURIComponent(modelId)}`;

const parseModel = (raw: unknown): Model | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Model;
  } catch {
    return null;
  }
};

const openDatabase = (
  dbName: string,
  storeName: string,
  timestampsStoreName: string,
): Promise<IDBDatabase> => {
  if (!isBrowser) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, { keyPath: "key" });
        store.createIndex("baseUrl", "baseUrl", { unique: false });
        store.createIndex("id", "id", { unique: false });
      }

      if (!db.objectStoreNames.contains(timestampsStoreName)) {
        db.createObjectStore(timestampsStoreName, { keyPath: "baseUrl" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionComplete = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export type { IndexedDBModelsDatabaseOptions };

export const createModelsDatabaseIndexedDB = (
  options: IndexedDBModelsDatabaseOptions = {},
): ModelsDatabase => {
  const dbName = options.dbName || DEFAULT_DB_NAME;
  const storeName = options.storeName || DEFAULT_STORE_NAME;
  const timestampsStoreName =
    options.timestampsStoreName || `${storeName}_timestamps`;
  const legacyStorageDriver = options.legacyStorageDriver;

  let db: IDBDatabase | null = null;
  let initialized = false;
  let migrationPromise: Promise<void> | null = null;

  const modelsByBaseUrl = new Map<string, Model[]>();
  const timestampsByBaseUrl = new Map<string, number>();

  const assertInitialized = (): void => {
    if (!initialized || !db) {
      throw new Error(
        "IndexedDB ModelsDatabase is not initialized. Call await modelsDb.migrate() before using synchronous methods.",
      );
    }
  };

  const getDb = async (): Promise<IDBDatabase> => {
    if (!db) {
      db = await openDatabase(dbName, storeName, timestampsStoreName);
    }
    return db;
  };

  const hydrateMemory = async (): Promise<void> => {
    const database = await getDb();
    const tx = database.transaction(
      [storeName, timestampsStoreName],
      "readonly",
    );

    const modelRowsPromise = requestToPromise(
      tx.objectStore(storeName).getAll(),
    ) as Promise<ModelRow[]>;
    const timestampRowsPromise = requestToPromise(
      tx.objectStore(timestampsStoreName).getAll(),
    ) as Promise<TimestampRow[]>;

    const [modelRows, timestampRows] = await Promise.all([
      modelRowsPromise,
      timestampRowsPromise,
    ]);
    await transactionComplete(tx);

    modelsByBaseUrl.clear();
    timestampsByBaseUrl.clear();

    for (const row of modelRows) {
      const model = parseModel(row.data);
      if (!model) continue;
      const baseUrl = normalizeBaseUrl(row.baseUrl);
      const models = modelsByBaseUrl.get(baseUrl) || [];
      models.push(model);
      modelsByBaseUrl.set(baseUrl, models);
    }

    for (const row of timestampRows) {
      timestampsByBaseUrl.set(normalizeBaseUrl(row.baseUrl), row.lastUpdate);
    }
  };

  const persistProvider = async (
    baseUrl: string,
    models: Model[],
    cachedAt: number,
  ): Promise<void> => {
    const database = await getDb();
    const tx = database.transaction(
      [storeName, timestampsStoreName],
      "readwrite",
    );
    const modelStore = tx.objectStore(storeName);
    const timestampStore = tx.objectStore(timestampsStoreName);
    const baseUrlIndex = modelStore.index("baseUrl");
    const cursorRequest = baseUrlIndex.openCursor(IDBKeyRange.only(baseUrl));

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }

      for (const model of models) {
        modelStore.put({
          key: rowKey(baseUrl, model.id),
          id: model.id,
          baseUrl,
          data: JSON.stringify(model),
        } satisfies ModelRow);
      }
      timestampStore.put({
        baseUrl,
        lastUpdate: cachedAt,
      } satisfies TimestampRow);
    };

    await transactionComplete(tx);
  };

  const persistClearProvider = async (baseUrl: string): Promise<void> => {
    const database = await getDb();
    const tx = database.transaction(
      [storeName, timestampsStoreName],
      "readwrite",
    );
    const modelStore = tx.objectStore(storeName);
    const timestampStore = tx.objectStore(timestampsStoreName);
    const cursorRequest = modelStore
      .index("baseUrl")
      .openCursor(IDBKeyRange.only(baseUrl));

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      timestampStore.delete(baseUrl);
    };

    await transactionComplete(tx);
  };

  const persistClearAll = async (): Promise<void> => {
    const database = await getDb();
    const tx = database.transaction(
      [storeName, timestampsStoreName],
      "readwrite",
    );
    tx.objectStore(storeName).clear();
    tx.objectStore(timestampsStoreName).clear();
    await transactionComplete(tx);
  };

  const fireAndForget = (promise: Promise<void>): void => {
    void promise.catch((error) => {
      console.error("IndexedDB models persistence failed:", error);
    });
  };

  const ensureMigrated = async (): Promise<void> => {
    if (!legacyStorageDriver) return;

    const migrated = await legacyStorageDriver.getItem<boolean>(
      MIGRATION_MARKER_KEY,
      false,
    );
    if (migrated) return;

    const legacyModels = await legacyStorageDriver.getItem<
      Record<string, Model[]>
    >(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS, {});

    const legacyTimestamps = await legacyStorageDriver.getItem<
      Record<string, number>
    >(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE, {});

    for (const [baseUrl, models] of Object.entries(legacyModels)) {
      const normalized = normalizeBaseUrl(baseUrl);
      const cachedAt = legacyTimestamps[normalized] ?? Date.now();
      await persistProvider(normalized, models, cachedAt);
    }

    if (Object.keys(legacyModels).length > 0) {
      await legacyStorageDriver.removeItem(
        SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS,
      );
      await legacyStorageDriver.removeItem(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE);
    }

    await legacyStorageDriver.setItem(MIGRATION_MARKER_KEY, true);
  };

  return {
    async migrate(): Promise<void> {
      if (!migrationPromise) {
        migrationPromise = (async () => {
          await getDb();
          await ensureMigrated();
          await hydrateMemory();
          initialized = true;
        })();
      }
      await migrationPromise;
    },

    upsertProviderModels(
      baseUrl: string,
      models: Model[],
      cachedAt: number,
    ): void {
      assertInitialized();
      const normalized = normalizeBaseUrl(baseUrl);
      modelsByBaseUrl.set(normalized, models);
      timestampsByBaseUrl.set(normalized, cachedAt);
      fireAndForget(persistProvider(normalized, models, cachedAt));
    },

    getProviderModels(baseUrl: string): Model[] {
      assertInitialized();
      return [...(modelsByBaseUrl.get(normalizeBaseUrl(baseUrl)) || [])];
    },

    getAllModels(): Record<string, Model[]> {
      assertInitialized();
      const result: Record<string, Model[]> = {};
      for (const [baseUrl, models] of modelsByBaseUrl.entries()) {
        result[baseUrl] = [...models];
      }
      return result;
    },

    clearProvider(baseUrl: string): void {
      assertInitialized();
      const normalized = normalizeBaseUrl(baseUrl);
      modelsByBaseUrl.delete(normalized);
      timestampsByBaseUrl.delete(normalized);
      fireAndForget(persistClearProvider(normalized));
    },

    clearAll(): void {
      assertInitialized();
      modelsByBaseUrl.clear();
      timestampsByBaseUrl.clear();
      fireAndForget(persistClearAll());
    },

    deleteStale(maxAgeMs: number): number {
      assertInitialized();
      const cutoff = Date.now() - maxAgeMs;
      const stale = [...timestampsByBaseUrl.entries()]
        .filter(([, timestamp]) => timestamp < cutoff)
        .map(([baseUrl]) => baseUrl);

      for (const baseUrl of stale) {
        modelsByBaseUrl.delete(baseUrl);
        timestampsByBaseUrl.delete(baseUrl);
        fireAndForget(persistClearProvider(baseUrl));
      }

      return stale.length;
    },

    getProviderLastUpdate(baseUrl: string): number | null {
      assertInitialized();
      return timestampsByBaseUrl.get(normalizeBaseUrl(baseUrl)) ?? null;
    },

    setProviderLastUpdate(baseUrl: string, timestamp: number): void {
      assertInitialized();
      const normalized = normalizeBaseUrl(baseUrl);
      timestampsByBaseUrl.set(normalized, timestamp);
      const models = modelsByBaseUrl.get(normalized) || [];
      fireAndForget(persistProvider(normalized, models, timestamp));
    },

    setAllProviderLastUpdates(updates: Record<string, number>): void {
      assertInitialized();
      for (const [baseUrl, timestamp] of Object.entries(updates)) {
        const normalized = normalizeBaseUrl(baseUrl);
        timestampsByBaseUrl.set(normalized, timestamp);
        const models = modelsByBaseUrl.get(normalized) || [];
        fireAndForget(persistProvider(normalized, models, timestamp));
      }
    },
  };
};
