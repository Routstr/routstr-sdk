import { SDK_STORAGE_KEYS } from "../keys";
import type { StorageDriver } from "../types";
import type { ListUsageTrackingOptions, UsageTrackingDriver } from "./interfaces";
import type { UsageTrackingEntry } from "./types";

export interface IndexedDBUsageTrackingDriverOptions {
  dbName?: string;
  storeName?: string;
  legacyStorageDriver?: StorageDriver;
}

const DEFAULT_DB_NAME = "routstr-sdk";
const DEFAULT_STORE_NAME = "usage_tracking";
const MIGRATION_MARKER_KEY = "usage_tracking_migration_v1";

const isBrowser = typeof indexedDB !== "undefined";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const openDatabase = (
  dbName: string,
  storeName: string
): Promise<IDBDatabase> => {
  if (!isBrowser) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("modelId", "modelId", { unique: false });
        store.createIndex("baseUrl", "baseUrl", { unique: false });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("client", "client", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const matchesFilters = (
  entry: UsageTrackingEntry,
  options: Omit<ListUsageTrackingOptions, "limit"> = {}
): boolean => {
  if (typeof options.before === "number" && entry.timestamp >= options.before) {
    return false;
  }
  if (typeof options.after === "number" && entry.timestamp <= options.after) {
    return false;
  }
  if (options.modelId && entry.modelId !== options.modelId) {
    return false;
  }
  if (options.baseUrl && normalizeBaseUrl(entry.baseUrl) !== normalizeBaseUrl(options.baseUrl)) {
    return false;
  }
  if (options.sessionId && entry.sessionId !== options.sessionId) {
    return false;
  }
  if (options.client && entry.client !== options.client) {
    return false;
  }
  return true;
};

export const createIndexedDBUsageTrackingDriver = (
  options: IndexedDBUsageTrackingDriverOptions = {}
): UsageTrackingDriver => {
  const dbName = options.dbName || DEFAULT_DB_NAME;
  const storeName = options.storeName || DEFAULT_STORE_NAME;
  const legacyStorageDriver = options.legacyStorageDriver;

  let dbPromise: Promise<IDBDatabase> | null = null;
  let migrationPromise: Promise<void> | null = null;

  const getDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openDatabase(dbName, storeName);
    }
    return dbPromise;
  };

  const putMany = async (entries: UsageTrackingEntry[]): Promise<void> => {
    if (entries.length === 0) return;
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const entry of entries) {
        store.put({ ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const ensureMigrated = async (): Promise<void> => {
    if (!legacyStorageDriver) return;
    if (!migrationPromise) {
      migrationPromise = (async () => {
        const migrated = await legacyStorageDriver.getItem<boolean>(
          MIGRATION_MARKER_KEY,
          false
        );
        if (migrated) return;

        const legacyEntries = await legacyStorageDriver.getItem<UsageTrackingEntry[]>(
          SDK_STORAGE_KEYS.USAGE_TRACKING,
          []
        );

        if (legacyEntries.length > 0) {
          await putMany(legacyEntries);
          await legacyStorageDriver.removeItem(SDK_STORAGE_KEYS.USAGE_TRACKING);
        }

        await legacyStorageDriver.setItem(MIGRATION_MARKER_KEY, true);
      })();
    }
    await migrationPromise;
  };

  return {
    async append(entry: UsageTrackingEntry): Promise<void> {
      await ensureMigrated();
      await putMany([entry]);
    },

    async appendMany(entries: UsageTrackingEntry[]): Promise<void> {
      await ensureMigrated();
      await putMany(entries);
    },

    async list(options: ListUsageTrackingOptions = {}): Promise<UsageTrackingEntry[]> {
      await ensureMigrated();
      const db = await getDb();
      return new Promise<UsageTrackingEntry[]>((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const index = store.index("timestamp");
        const direction: IDBCursorDirection = "prev";
        const request = index.openCursor(null, direction);
        const results: UsageTrackingEntry[] = [];
        const limit = options.limit;

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(results);
            return;
          }

          const value = cursor.value as UsageTrackingEntry;
          if (matchesFilters(value, options)) {
            results.push(value);
            if (typeof limit === "number" && results.length >= limit) {
              resolve(results);
              return;
            }
          }
          cursor.continue();
        };

        request.onerror = () => reject(request.error);
      });
    },

    async count(options: Omit<ListUsageTrackingOptions, "limit"> = {}): Promise<number> {
      const results = await this.list(options);
      return results.length;
    },

    async deleteOlderThan(timestamp: number): Promise<number> {
      await ensureMigrated();
      const db = await getDb();
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const index = store.index("timestamp");
        const range = IDBKeyRange.upperBound(timestamp, true);
        const request = index.openCursor(range);
        let deleted = 0;

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(deleted);
            return;
          }
          deleted += 1;
          cursor.delete();
          cursor.continue();
        };

        request.onerror = () => reject(request.error);
      });
    },

    async clear(): Promise<void> {
      await ensureMigrated();
      const db = await getDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
};
