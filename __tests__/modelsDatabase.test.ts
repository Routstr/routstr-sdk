import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createModelsDatabase,
  createSqliteDiscoveryAdapter,
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

describe("SQLite models database and discovery adapter", () => {
  it("migrates legacy model blob and timestamps from storage driver", async () => {
    const legacyDriver = createMemoryDriver({
      [SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS]: JSON.stringify({
        "https://provider-a.example.com": [model("model-a")],
      }),
      [SDK_STORAGE_KEYS.LAST_MODELS_UPDATE]: JSON.stringify({
        "https://provider-a.example.com/": 123,
      }),
    });

    const modelsDb = createModelsDatabase({
      dbPath: ":memory:",
      tableName: "models_migration_test",
      legacyStorageDriver: legacyDriver,
    });

    await modelsDb.migrate();

    expect(modelsDb.getProviderModels("https://provider-a.example.com")).toEqual([
      model("model-a"),
    ]);
    expect(
      modelsDb.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBe(123);

    expect(
      await legacyDriver.getItem(
        SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS,
        {} as Record<string, Model[]>,
      ),
    ).toEqual({});
    expect(
      await legacyDriver.getItem(
        SDK_STORAGE_KEYS.LAST_MODELS_UPDATE,
        {} as Record<string, number>,
      ),
    ).toEqual({});
  });

  it("requires migrate before synchronous database methods", () => {
    const modelsDb = createModelsDatabase({
      dbPath: ":memory:",
      tableName: "models_uninitialized_test",
    });

    expect(() => modelsDb.getAllModels()).toThrow(/not initialized/i);
  });

  it("replaces cached models and removes omitted providers", async () => {
    const modelsDb = createModelsDatabase({
      dbPath: ":memory:",
      tableName: "models_replace_test",
    });
    const kv = createMemoryDriver();
    const adapter = await createSqliteDiscoveryAdapter({ modelsDb, kv });

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
    const modelsDb = createModelsDatabase({
      dbPath: ":memory:",
      tableName: "models_clear_all_test",
    });
    const kv = createMemoryDriver();
    const adapter = await createSqliteDiscoveryAdapter({ modelsDb, kv });

    adapter.setCachedModels({
      "https://provider-a.example.com": [model("model-a")],
    });
    adapter.setCachedModels({});

    expect(adapter.getCachedModels()).toEqual({});
    expect(
      adapter.getProviderLastUpdate("https://provider-a.example.com"),
    ).toBeNull();
  });
});
