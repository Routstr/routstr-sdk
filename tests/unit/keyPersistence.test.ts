import { describe, expect, it, vi } from "vitest";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore } from "../../storage";
import type { StorageAdapter } from "../../wallet/interfaces";

type DurableStorage = StorageAdapter & { flush(): Promise<void>; replaceApiKey(base: string, key: string): void };
const base = "https://provider.example/";

describe("funded key persistence", () => {
  it("waits for disk before reporting persistence complete", async () => {
    const disk = createMemoryDriver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { store, hydrate } = createSdkStore({ driver: {
      ...disk,
      setItem: async (key, value) => { await gate; await disk.setItem(key, value); },
    } });
    await hydrate;
    const storage = createStorageAdapterFromStore(store) as DurableStorage;
    storage.setApiKey(base, "fixture-key");
    let done = false;
    const persisted = storage.flush().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await persisted;
    const reloaded = createSdkStore({ driver: disk });
    await reloaded.hydrate;
    expect(createStorageAdapterFromStore(reloaded.store).getApiKey(base)?.key).toBe("fixture-key");
  });

  it("reports a failed write and refuses subsequent funding barriers", async () => {
    const disk = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver: {
      ...disk,
      setItem: vi.fn().mockRejectedValue(new Error("storage full")),
    } });
    await hydrate;
    const storage = createStorageAdapterFromStore(store) as DurableStorage;
    storage.setApiKey(base, "fixture-key");
    await expect(storage.flush()).rejects.toThrow("storage full");
    await expect(storage.flush()).rejects.toThrow("storage full");
  });

  it("replaces a bootstrap key in one write without an empty intermediate record", async () => {
    const disk = createMemoryDriver();
    const write = vi.fn(disk.setItem);
    const { store, hydrate } = createSdkStore({ driver: { ...disk, setItem: write } });
    await hydrate;
    const storage = createStorageAdapterFromStore(store) as DurableStorage;
    storage.setApiKey(base, "cashu-fixture");
    await storage.flush();
    write.mockClear();
    storage.replaceApiKey(base, "canonical-fixture");
    await storage.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual([expect.objectContaining({ key: "canonical-fixture" })]);
  });
});
