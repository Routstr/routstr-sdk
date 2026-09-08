import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore } from "../../storage";
import { SDK_STORAGE_KEYS } from "../../storage/keys";

const base = "https://provider.example/";

describe("store cache policy", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); vi.restoreAllMocks(); });

  it("a failed cache write is logged, a failed credential write is reported by flush", async () => {
    const driver = { ...createMemoryDriver(), setItem: async () => { throw new Error("quota"); } };
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    store.getState().setLastUsedModel("gpt-4o");
    store.getState().setModelsFromAllProviders({ [base]: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
    store.getState().setApiKeys([{ baseUrl: base, key: "k" }]);
    await expect(store.getState().flush()).rejects.toThrow("quota");
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
  });

  it("an unreadable cache key defaults, an unreadable credential key fails hydration", async () => {
    const memory = createMemoryDriver();
    const failing = (bad: string) => ({ ...memory, getItem: async <T,>(key: string, def: T) => { if (key === bad) throw new Error("corrupt"); return memory.getItem(key, def); } });
    await memory.setItem(SDK_STORAGE_KEYS.API_KEYS, [{ baseUrl: base, key: "k", balance: 3 }]);
    const tolerant = createSdkStore({ driver: failing(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS) });
    await expect(tolerant.hydrate).resolves.toBeUndefined();
    expect(tolerant.store.getState().apiKeys[0]).toMatchObject({ key: "k", balance: 3 });
    const strict = createSdkStore({ driver: failing(SDK_STORAGE_KEYS.API_KEYS) });
    await expect(strict.hydrate).rejects.toThrow("corrupt");
  });

  it("reload takes disk as truth and reopens the write barrier after a failed write", async () => {
    const memory = createMemoryDriver();
    let fail = false;
    const driver = { ...memory, setItem: async (key: string, value: unknown) => { if (fail) throw new Error("disk"); return memory.setItem(key, value); } };
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(base, "k");
    storage.updateApiKeyBalance(base, 7);
    await storage.flush!();
    fail = true;
    storage.updateApiKeyBalance(base, 1);
    await expect(storage.flush!()).rejects.toThrow("disk");
    expect(storage.getApiKey(base)?.balance).toBe(1);
    fail = false;
    await store.getState().reload();
    expect(storage.getApiKey(base)?.balance).toBe(7);
    storage.updateApiKeyBalance(base, 5);
    await expect(storage.flush!()).resolves.toBeUndefined();
    expect(await memory.getItem(SDK_STORAGE_KEYS.API_KEYS, [])).toEqual([expect.objectContaining({ balance: 5 })]);
  });
});
