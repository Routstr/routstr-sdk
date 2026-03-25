import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createMemoryUsageTrackingDriver,
  createSqliteUsageTrackingDriver,
} from "../storage";
import type { UsageTrackingEntry } from "../storage";

const entry = (overrides: Partial<UsageTrackingEntry> = {}): UsageTrackingEntry => ({
  id: overrides.id ?? "entry-1",
  timestamp: overrides.timestamp ?? 100,
  modelId: overrides.modelId ?? "model-a",
  baseUrl: overrides.baseUrl ?? "https://provider.example.com",
  requestId: overrides.requestId ?? "req-1",
  cost: overrides.cost ?? 1,
  satsCost: overrides.satsCost ?? 10,
  promptTokens: overrides.promptTokens ?? 2,
  completionTokens: overrides.completionTokens ?? 3,
  totalTokens: overrides.totalTokens ?? 5,
  client: overrides.client,
  sessionId: overrides.sessionId,
  tags: overrides.tags,
});

describe("usage tracking drivers", () => {
  it("memory driver appends and lists entries in descending timestamp order", async () => {
    const driver = createMemoryUsageTrackingDriver();

    await driver.appendMany([
      entry({ id: "1", timestamp: 100 }),
      entry({ id: "2", timestamp: 300 }),
      entry({ id: "3", timestamp: 200 }),
    ]);

    const rows = await driver.list();
    expect(rows.map((row) => row.id)).toEqual(["2", "3", "1"]);
  });

  it("memory driver filters and deletes by timestamp", async () => {
    const driver = createMemoryUsageTrackingDriver();

    await driver.appendMany([
      entry({ id: "1", timestamp: 100, modelId: "a" }),
      entry({ id: "2", timestamp: 200, modelId: "b" }),
      entry({ id: "3", timestamp: 300, modelId: "a" }),
    ]);

    const filtered = await driver.list({ modelId: "a", after: 150 });
    expect(filtered.map((row) => row.id)).toEqual(["3"]);

    const deleted = await driver.deleteOlderThan(250);
    expect(deleted).toBe(2);
    expect(await driver.count()).toBe(1);
  });

  it("sqlite usage tracking migrates legacy blob data from storage driver", async () => {
    const legacyDriver = createMemoryDriver({
      [SDK_STORAGE_KEYS.USAGE_TRACKING]: JSON.stringify([
        entry({ id: "legacy-1", timestamp: 123 }),
      ]),
    });

    const driver = createSqliteUsageTrackingDriver({
      dbPath: ":memory:",
      tableName: "usage_tracking_test",
      legacyStorageDriver: legacyDriver,
    });

    await driver.migrate();

    const rows = await driver.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("legacy-1");

    const legacyRows = await legacyDriver.getItem(SDK_STORAGE_KEYS.USAGE_TRACKING, [] as UsageTrackingEntry[]);
    expect(legacyRows).toEqual([]);
  });
});
