import type { StorageDriver } from "../types";

export interface IndexedDBDriverOptions {
  dbName?: string;
  storeName?: string;
}

const openDatabase = (
  dbName: string,
  storeName: string
): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
