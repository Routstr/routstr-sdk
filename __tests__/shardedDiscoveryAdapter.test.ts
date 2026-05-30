import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createShardedDiscoveryAdapter,
} from "../storage";
import type { Model } from "../core/types";

const model = (id: string): Model => ({
  id,
  name: id,
  sats_pricing: {
    prompt: 1,
    completion: 1,
    request: 0,
    image: 0,
    web_search: 0,
    internal_reasoning: 0,
    max_completion_cost: 1,
    max_prompt_cost: 1,
    max_cost: 2,
  },
});

describe("Sharded DiscoveryAdapter", () => {
  it("migrates legacy model blob and timestamps from storage driver", async () => {
    const driver = createMemoryDriver({
      [SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS]: JSON.stringify({
        "https://provider-a.example.com": [model("model-a")],
      }),
      [SDK_STORAGE_KEYS.LAST_MODELS_UPDATE]: JSON.stringify({
        "https://provider-a.example.com/": 123,
      }),
    });

    const adapter = await createShardedDiscoveryAdapter({ driver });

    expect(adapter.getCachedModels()).toEqual({
      "https://provider-a.example.com/": [model("model-a")],
    });
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBe(123);

    // Legacy keys should be cleared
    const legacyModels = await driver.getItem(
      SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS,
      {},
    );
    expect(legacyModels).toEqual({});
    const legacyTimestamps = await driver.getItem(
      SDK_STORAGE_KEYS.LAST_MODELS_UPDATE,
      {},
    );
    expect(legacyTimestamps).toEqual({});
  });

  it("replaces cached models and removes omitted providers", async () => {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    adapter.setCachedModels({
      "https://provider-a.example.com": [model("model-a")],
      "https://provider-b.example.com": [model("model-b")],
    });

    adapter.setCachedModels({
      "https://provider-a.example.com": [model("model-a2")],
    });

    expect(adapter.getCachedModels()).toEqual({
      "https://provider-a.example.com/": [model("model-a2")],
    });
    expect(
      adapter.getProviderLastUpdate("https://provider-b.example.com"),
    ).toBeNull();
  });

  it("clears all cached models through replacement semantics", async () => {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    adapter.setCachedModels({
      "https://provider-a.example.com": [model("model-a")],
    });
    adapter.setCachedModels({});

    expect(adapter.getCachedModels()).toEqual({});
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBeNull();
  });

  it("reads and writes provider timestamps", async () => {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBeNull();

    adapter.setProviderLastUpdate("https://provider-a.example.com", 1000);
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBe(1000);

    adapter.setProviderLastUpdate("https://provider-a.example.com", 2000);
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBe(2000);
  });

  it("handles base URL normalization consistently", async () => {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    // Set without trailing slash
    adapter.setCachedModels({
      "https://provider-a.example.com": [model("model-a")],
    });

    // Get with trailing slash should match
    expect(
      adapter.getCachedModels()["https://provider-a.example.com/"],
    ).toEqual([model("model-a")]);

    adapter.setProviderLastUpdate("https://provider-a.example.com", 500);
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com/"),
    ).toBe(500);
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBe(500);
  });

  it("survives re-creation (data persisted in driver)", async () => {
    const driver = createMemoryDriver();
    const adapter1 = await createShardedDiscoveryAdapter({ driver });

    adapter1.setCachedModels({
      "https://provider-a.example.com": [model("model-a")],
    });
    adapter1.setProviderLastUpdate("https://provider-a.example.com", 999);

    // Create a second adapter over the same driver
    const adapter2 = await createShardedDiscoveryAdapter({ driver });

    expect(adapter2.getCachedModels()).toEqual({
      "https://provider-a.example.com/": [model("model-a")],
    });
    expect(
      adapter2.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBe(999);
  });

  it("passes through non-model fields from kv", async () => {
    const driver = createMemoryDriver({
      [SDK_STORAGE_KEYS.MINTS_FROM_ALL_PROVIDERS]: JSON.stringify({
        "https://provider-a.example.com": ["https://mint.example.com"],
      }),
      [SDK_STORAGE_KEYS.INFO_FROM_ALL_PROVIDERS]: JSON.stringify({
        "https://provider-a.example.com/": { name: "Test Provider" },
      }),
      [SDK_STORAGE_KEYS.LAST_USED_MODEL]: JSON.stringify("gpt-4"),
      [SDK_STORAGE_KEYS.DISABLED_PROVIDERS]: JSON.stringify([
        "https://disabled.example.com",
      ]),
      [SDK_STORAGE_KEYS.BASE_URLS_LIST]: JSON.stringify([
        "https://provider-a.example.com",
      ]),
      [SDK_STORAGE_KEYS.LAST_BASE_URLS_UPDATE]: JSON.stringify(42),
      [SDK_STORAGE_KEYS.ROUTSTR21_MODELS]: JSON.stringify(["model-21"]),
      [SDK_STORAGE_KEYS.LAST_ROUTSTR21_MODELS_UPDATE]: JSON.stringify(77),
    });

    const adapter = await createShardedDiscoveryAdapter({ driver });

    expect(adapter.getCachedMints()).toEqual({
      "https://provider-a.example.com/": ["https://mint.example.com"],
    });
    expect(adapter.getCachedProviderInfo()).toEqual({
      "https://provider-a.example.com/": { name: "Test Provider" },
    });
    expect(adapter.getLastUsedModel()).toBe("gpt-4");
    expect(adapter.getDisabledProviders()).toEqual([
      "https://disabled.example.com/",
    ]);
    expect(adapter.getBaseUrlsList()).toEqual([
      "https://provider-a.example.com/",
    ]);
    expect(adapter.getBaseUrlsLastUpdate()).toBe(42);
    expect(adapter.getRoutstr21Models()).toEqual(["model-21"]);
    expect(adapter.getRoutstr21ModelsLastUpdate()).toBe(77);
  });
});