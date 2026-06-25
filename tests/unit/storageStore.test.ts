import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createSdkStore,
} from "../../storage";
import { createStorageAdapterFromStore } from "../../storage/store";

describe("sdk storage store", () => {
  it("persists cached xcashu tokens through the store", async () => {
    const seed = {
      [SDK_STORAGE_KEYS.XCASHU_TOKENS]: JSON.stringify({
        "https://provider.example.com": [
          {
            baseUrl: "https://provider.example.com",
            token: "token-1",
            createdAt: Date.now(),
            tryCount: 0,
          },
        ],
      }),
    };

    const driver = createMemoryDriver(seed);
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;

    const tokens = store.getState().xcashuTokens["https://provider.example.com/"];
    expect(tokens?.[0]?.baseUrl).toBe("https://provider.example.com/");
  });

  it("addXcashuToken rejects duplicate tokens for the same provider", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.addXcashuToken("https://provider.example.com", "token-1");

    // Adding a second token for the same provider should work (multiple tokens allowed)
    storage.addXcashuToken("https://provider.example.com/", "token-2");

    const tokens = storage.getXcashuTokensForBaseUrl("https://provider.example.com/");
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.token)).toEqual(["token-1", "token-2"]);
  });

  it("getXcashuTokensForBaseUrl returns tokens with metadata", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.addXcashuToken("https://provider.example.com", "token-1");

    const tokens = storage.getXcashuTokensForBaseUrl("https://provider.example.com/");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token).toBe("token-1");
    expect(tokens[0]?.baseUrl).toBe("https://provider.example.com/");
    expect(tokens[0]?.createdAt).toBeGreaterThan(0);
    expect(tokens[0]?.tryCount).toBe(0);
  });
});
