import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createSdkStore,
  createStorageAdapterFromStore,
} from "../../storage";

const PROVIDER = "https://provider.example.com/";

const storedKey = async (driver: ReturnType<typeof createMemoryDriver>) => {
  const reloaded = createSdkStore({ driver });
  await reloaded.hydrate;
  return createStorageAdapterFromStore(reloaded.store).getApiKey(PROVIDER)?.key;
};

describe("credential and token writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("flush waits until a pending API key write reaches storage", async () => {
    const disk = createMemoryDriver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { store, hydrate } = createSdkStore({
      driver: {
        ...disk,
        setItem: async (key, value) => {
          await gate;
          await disk.setItem(key, value);
        },
      },
    });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setApiKey(PROVIDER, "cashu_bootstrap");
    let flushed = false;
    const flush = storage.flush!().then(() => (flushed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flushed).toBe(false);

    release();
    await flush;
    expect(await storedKey(disk)).toBe("cashu_bootstrap");
  });

  it("flush retries a failed write and rejects until storage works again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = createMemoryDriver();
    let broken = true;
    const { store, hydrate } = createSdkStore({
      driver: {
        ...disk,
        setItem: async (key, value) => {
          if (broken && key === SDK_STORAGE_KEYS.API_KEYS) {
            throw new Error("QuotaExceededError");
          }
          await disk.setItem(key, value);
        },
      },
    });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setApiKey(PROVIDER, "cashu_bootstrap");
    await expect(storage.flush!()).rejects.toThrow("QuotaExceededError");
    await expect(storage.flush!()).rejects.toThrow("QuotaExceededError");
    expect(await storedKey(disk)).toBeUndefined();

    broken = false;
    await storage.flush!();
    expect(await storedKey(disk)).toBe("cashu_bootstrap");
  });

  it("an aborted IndexedDB write rejects instead of hanging", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const quota = new DOMException("quota", "QuotaExceededError");
    const transaction = () => {
      const tx: any = {
        error: null,
        objectStore: () => ({
          put: () =>
            setTimeout(() => {
              tx.error = quota;
              tx.onabort?.();
            }),
        }),
      };
      return tx;
    };
    vi.stubGlobal("indexedDB", {
      open: () => {
        const request: any = {
          result: { objectStoreNames: { contains: () => true }, transaction },
        };
        setTimeout(() => request.onsuccess?.());
        return request;
      },
    });
    const { createIndexedDBDriver } = await import(
      "../../storage/drivers/indexedDB"
    );

    const write = createIndexedDBDriver().setItem(SDK_STORAGE_KEYS.API_KEYS, []);
    const outcome = await Promise.race([
      write.then(
        () => "resolved",
        (error) => error
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    expect(outcome).toBe(quota);
  });
});
