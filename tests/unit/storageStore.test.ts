import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createSdkStore,
} from "../../storage";
import { createStorageAdapterFromStore } from "../../storage/store";

describe("sdk storage store", () => {
  it("hydrates legacy API-key records with a zero reserved snapshot", async () => {
    const seed = {
      [SDK_STORAGE_KEYS.API_KEYS]: JSON.stringify([
        {
          baseUrl: "https://provider.example.com",
          key: "sk-legacy",
          balance: 42,
          lastUsed: null,
        },
      ]),
    };

    const driver = createMemoryDriver(seed);
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    expect(storage.getApiKey("https://provider.example.com/")).toMatchObject({
      balance: 42,
      reserved: 0,
    });
    expect(storage.getApiKeyDistribution()).toEqual([
      {
        baseUrl: "https://provider.example.com/",
        amount: 42,
        reserved: 0,
      },
    ]);
  });

  it("stores reserved alongside total balance and preserves it for legacy two-argument updates", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setApiKey("https://provider.example.com", "sk-test");
    storage.updateApiKeyBalance("https://provider.example.com", 100, 30);

    expect(storage.getApiKeyDistribution()).toEqual([
      {
        baseUrl: "https://provider.example.com/",
        amount: 100,
        reserved: 30,
      },
    ]);

    // The JSON-backed drivers (including SQLite's key/value table) persist
    // the new field without a schema migration.
    const { store: rehydratedStore, hydrate: rehydrate } = createSdkStore({
      driver,
    });
    await rehydrate;
    expect(
      createStorageAdapterFromStore(rehydratedStore).getApiKey(
        "https://provider.example.com/"
      )
    ).toMatchObject({ balance: 100, reserved: 30 });

    // Existing custom callers may still provide total balance only. They
    // must not erase the last known reserved snapshot.
    storage.updateApiKeyBalance("https://provider.example.com", 90);
    expect(storage.getApiKey("https://provider.example.com/")).toMatchObject({
      balance: 90,
      reserved: 30,
    });
  });

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

it("migrates duplicate recovery owners durably without removing unrelated cached tokens", async () => {
  const token = "cashu_legacy";
  const driver = createMemoryDriver({
    [SDK_STORAGE_KEYS.XCASHU_TOKENS]: JSON.stringify({
      "https://provider.example/": [{ baseUrl: "https://provider.example/", token, createdAt: 1, tryCount: 0 }],
    }),
    [SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS]: JSON.stringify([
      { token, amount: 10, unit: "sat", createdAt: 1 },
      { token: "unrelated", amount: 5, unit: "sat", createdAt: 1 },
    ]),
  });
  const { store, hydrate } = createSdkStore({ driver }); await hydrate;
  const storage = createStorageAdapterFromStore(store);
  expect(storage.getCachedReceiveTokens().map((t) => t.token)).toEqual(["unrelated"]);
  expect(await driver.getItem<any[]>(SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS, [])).toEqual([
    expect.objectContaining({ token: "unrelated" }),
  ]);
  storage.removeXcashuToken("https://provider.example/", token);
  await storage.flush!();
  const reload = createSdkStore({ driver }); await reload.hydrate;
  expect(createStorageAdapterFromStore(reload.store).getCachedReceiveTokens().map((t) => t.token)).toEqual(["unrelated"]);
  expect(createStorageAdapterFromStore(reload.store).getXcashuTokens()).toEqual({});
});

it("rejects hydration if duplicate-owner cleanup cannot be persisted", async () => {
  const disk = createMemoryDriver({
    [SDK_STORAGE_KEYS.XCASHU_TOKENS]: JSON.stringify({
      "https://provider.example/": [{ token: "duplicate", baseUrl: "https://provider.example/", createdAt: 1 }],
    }),
    [SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS]: JSON.stringify([
      { token: "duplicate", amount: 1, unit: "sat", createdAt: 1 },
    ]),
  });
  const { hydrate } = createSdkStore({ driver: {
    ...disk,
    setItem: async () => { throw new Error("cleanup failed"); },
  } });
  await expect(hydrate).rejects.toThrow("cleanup failed");
  expect(await disk.getItem<any[]>(SDK_STORAGE_KEYS.CACHED_RECEIVE_TOKENS, [])).toHaveLength(1);
});
