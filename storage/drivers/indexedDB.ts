import type { StorageDriver } from "../types";

export interface IndexedDBDriverOptions {
  dbName?: string;
  storeName?: string;
}

const isBrowser = typeof indexedDB !== "undefined";

const openDatabase = (
  dbName: string,
  storeName: string
): Promise<IDBDatabase> => {
  if (!isBrowser) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  return new Promise((resolve, reject) => {
    // Version 2 — both sdk_storage and usage_tracking stores need to coexist.
    // Each driver creates its own store AND the other driver's store during
    // the upgrade to avoid a race where the second driver never gets onupgradeneeded.
    const request = indexedDB.open(dbName, 2);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Create our own store
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
      // Also create usage_tracking if it doesn't exist (cross-driver init)
      if (storeName !== "usage_tracking" && !db.objectStoreNames.contains("usage_tracking")) {
        const utStore = db.createObjectStore("usage_tracking", { keyPath: "id" });
        utStore.createIndex("timestamp", "timestamp", { unique: false });
        utStore.createIndex("modelId", "modelId", { unique: false });
        utStore.createIndex("baseUrl", "baseUrl", { unique: false });
        utStore.createIndex("sessionId", "sessionId", { unique: false });
        utStore.createIndex("client", "client", { unique: false });
      }
      // Also create sdk_storage if it doesn't exist (cross-driver init)
      if (storeName !== "sdk_storage" && !db.objectStoreNames.contains("sdk_storage")) {
        db.createObjectStore("sdk_storage");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      console.warn(
        `[IndexedDB driver] open blocked for "${dbName}" (store: "${storeName}") — close other tabs using this DB`
      );
      reject(new Error(`IndexedDB "${dbName}" blocked by another connection`));
    };
  });
};

export const createIndexedDBDriver = (
  options: IndexedDBDriverOptions = {}
): StorageDriver => {
  const dbName = options.dbName || "routstr-sdk";
  const storeName = options.storeName || "sdk_storage";

  let dbPromise: Promise<IDBDatabase> | null = null;

  const getDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openDatabase(dbName, storeName);
    }
    return dbPromise;
  };

  return {
    async getItem<T>(key: string, defaultValue: T): Promise<T> {
      try {
        const db = await getDb();
        return new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          const request = store.get(key);

          request.onsuccess = () => {
            const raw = request.result;
            if (raw === undefined) {
              resolve(defaultValue);
              return;
            }
            // Values are stored as raw JSON strings
            if (typeof raw === "string") {
              try {
                resolve(JSON.parse(raw) as T);
              } catch {
                if (typeof defaultValue === "string") {
                  resolve(raw as T);
                } else {
                  resolve(defaultValue);
                }
              }
            } else {
              // If stored as a native JS value (e.g. from a previous driver)
              resolve(raw as T);
            }
          };
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        console.error(`IndexedDB getItem failed for key "${key}":`, error);
        return defaultValue;
      }
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      try {
        const db = await getDb();
        return new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          store.put(JSON.stringify(value), key);

          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error(`IndexedDB setItem failed for key "${key}":`, error);
      }
    },

    async removeItem(key: string): Promise<void> {
      try {
        const db = await getDb();
        return new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          store.delete(key);

          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error(`IndexedDB removeItem failed for key "${key}":`, error);
      }
    },
  };
};
