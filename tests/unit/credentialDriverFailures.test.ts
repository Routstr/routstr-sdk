import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdkStore, createStorageAdapterFromStore, SDK_STORAGE_KEYS } from "../../storage";
import { localStorageDriver } from "../../storage/drivers/localStorage";
import { createSqliteDriver } from "../../storage/drivers/sqlite";
import type { StorageDriver } from "../../storage/types";

const sql = vi.hoisted(() => ({ fail: false }));
vi.mock("better-sqlite3", () => ({ default: class {
  exec() {}
  prepare() { return { get: () => undefined, run: () => { if (sql.fail) throw new Error("disk full"); } }; }
} }));

const credentialKeys = [SDK_STORAGE_KEYS.API_KEYS, SDK_STORAGE_KEYS.CHILD_KEYS,
  SDK_STORAGE_KEYS.XCASHU_TOKENS, SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); sql.fail = false; });

async function expectFlushFailure(driver: StorageDriver, message: string) {
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  storage.setApiKey("https://provider.example/", "cashu_bootstrap");
  await expect(storage.flush!()).rejects.toThrow(message);
}

describe("built-in credential write failures", () => {
  it("rejects quota failures for every localStorage credential key, including flush", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("window", { localStorage: {
      getItem: () => null, removeItem: () => {},
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
    } });
    for (const key of credentialKeys) await expect(localStorageDriver.setItem(key, [])).rejects.toThrow("full");
    await expectFlushFailure(localStorageDriver, "full");
    await expect(localStorageDriver.setItem(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS, {})).resolves.toBeUndefined();
  });

  it("rejects when localStorage is unavailable", async () => {
    vi.stubGlobal("window", undefined);
    await expect(localStorageDriver.setItem(SDK_STORAGE_KEYS.API_KEYS, [])).rejects.toThrow("not available");
  });

  it("rejects IndexedDB open failures instead of falsely completing flush", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", { open: () => {
      const request: any = { error: new Error("open failed") };
      setTimeout(() => request.onerror());
      return request;
    } });
    const { createIndexedDBDriver } = await import("../../storage/drivers/indexedDB");
    await expectFlushFailure(createIndexedDBDriver(), "open failed");
  });

  it("rejects SQLite writes for all credential keys and lets flush retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = createSqliteDriver({ dbPath: ":memory:" });
    sql.fail = true;
    for (const key of credentialKeys) await expect(driver.setItem(key, [])).rejects.toThrow("disk full");
    const { store, hydrate } = createSdkStore({ driver }); await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey("https://provider.example/", "cashu_bootstrap");
    await expect(storage.flush!()).rejects.toThrow("disk full");
    sql.fail = false;
    await expect(storage.flush!()).resolves.toBeUndefined();
  });
});
