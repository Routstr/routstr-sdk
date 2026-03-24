import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createSdkStore,
} from "../storage";
import { createStorageAdapterFromStore } from "../storage/store";

describe("sdk storage store", () => {
  it("normalizes baseUrls and persists cached tokens", async () => {
    const seed = {
      [SDK_STORAGE_KEYS.LOCAL_CASHU_TOKENS]: JSON.stringify([
        {
          baseUrl: "https://provider.example.com",
          token: "token-1",
          balance: 12,
          lastUsed: null,
        },
      ]),
      [SDK_STORAGE_KEYS.BASE_URLS_LIST]: JSON.stringify([
        "https://provider.example.com",
      ]),
      [SDK_STORAGE_KEYS.DISABLED_PROVIDERS]: JSON.stringify([
        "https://provider.example.com",
      ]),
    };

    const driver = createMemoryDriver(seed);
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;

    expect(store.getState().cachedTokens[0]?.baseUrl).toBe(
      "https://provider.example.com/"
    );
    expect(store.getState().baseUrlsList).toEqual([
      "https://provider.example.com/",
    ]);
    expect(store.getState().disabledProviders).toEqual([
      "https://provider.example.com/",
    ]);
  });

  it("setToken rejects duplicate provider tokens", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setToken("https://provider.example.com", "token-1");

    expect(() =>
      storage.setToken("https://provider.example.com/", "token-2")
    ).toThrowError("Token already exists for baseUrl");
  });

  it("getToken updates lastUsed timestamp", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setToken("https://provider.example.com", "token-1");

    const before = store.getState().cachedTokens[0]?.lastUsed ?? 0;
    const token = storage.getToken("https://provider.example.com/");
    const after = store.getState().cachedTokens[0]?.lastUsed ?? 0;

    expect(token).toBe("token-1");
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
