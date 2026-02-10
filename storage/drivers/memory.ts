import type { StorageDriver } from "../types";

export const createMemoryDriver = (
  seed?: Record<string, string>
): StorageDriver => {
  const store = new Map<string, string>();

  if (seed) {
    for (const [key, value] of Object.entries(seed)) {
      store.set(key, value);
    }
  }

  return {
    getItem<T>(key: string, defaultValue: T): T {
      const item = store.get(key);
      if (item === undefined) return defaultValue;
      try {
        return JSON.parse(item) as T;
      } catch (parseError) {
        if (typeof defaultValue === "string") {
          return item as T;
        }
        throw parseError;
      }
    },
    setItem<T>(key: string, value: T): void {
      store.set(key, JSON.stringify(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
};
