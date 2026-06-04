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
  provider: overrides.provider,
  baseMsats: overrides.baseMsats,
  inputMsats: overrides.inputMsats,
  outputMsats: overrides.outputMsats,
  totalMsats: overrides.totalMsats,
  totalUsd: overrides.totalUsd,
  cacheReadInputTokens: overrides.cacheReadInputTokens,
  cacheCreationInputTokens: overrides.cacheCreationInputTokens,
  cacheReadMsats: overrides.cacheReadMsats,
  cacheCreationMsats: overrides.cacheCreationMsats,
  remainingBalanceMsats: overrides.remainingBalanceMsats,
});

const costFields = {
  provider: "openrouter:openrouter:Anthropic",
  baseMsats: 0,
  inputMsats: 24638,
  outputMsats: 51,
  totalMsats: 24689,
  totalUsd: 0.0176475,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadMsats: 0,
  cacheCreationMsats: 0,
  remainingBalanceMsats: 3605659,
} satisfies Partial<UsageTrackingEntry>;

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

  it("memory driver round-trips the full cost breakdown and provider", async () => {
    const driver = createMemoryUsageTrackingDriver();
    await driver.append(entry({ id: "c1", ...costFields }));

    const [row] = await driver.list();
    expect(row).toMatchObject(costFields);
  });

  it("memory driver filters by provider", async () => {
    const driver = createMemoryUsageTrackingDriver();
    await driver.appendMany([
      entry({ id: "a", timestamp: 1, provider: "prov-a" }),
      entry({ id: "b", timestamp: 2, provider: "prov-b" }),
    ]);
    const rows = await driver.list({ provider: "prov-b" });
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("sqlite driver persists and filters the cost breakdown + provider", async () => {
    const driver = createSqliteUsageTrackingDriver({
      dbPath: ":memory:",
      tableName: "usage_tracking_cost",
    });
    await driver.migrate();
    await driver.append(entry({ id: "c1", ...costFields }));

    const [row] = await driver.list();
    expect(row).toMatchObject(costFields);

    const filtered = await driver.list({ provider: costFields.provider });
    expect(filtered.map((r) => r.id)).toEqual(["c1"]);
  });

  it("sqlite driver migrates an existing pre-breakdown table by adding columns", async () => {
    const Database = (await import("better-sqlite3")).default;
    // Create the old schema (no breakdown/provider columns) on a shared file.
    const dbPath = `:memory:`;
    const db = new Database(dbPath);
    const tableName = "usage_tracking_old";
    db.exec(`
      CREATE TABLE ${tableName} (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        base_url TEXT NOT NULL,
        request_id TEXT NOT NULL,
        cost REAL NOT NULL,
        sats_cost REAL NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        client TEXT,
        session_id TEXT,
        tags TEXT
      );
    `);
    db.prepare(
      `INSERT INTO ${tableName} (id, timestamp, model_id, base_url, request_id, cost, sats_cost, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("old-1", 50, "m", "https://x/", "r", 1, 1, 1, 1, 2);

    const cols = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((r: any) => r.name);
    expect(cols).not.toContain("provider");
    expect(cols).not.toContain("total_msats");

    // Now add the columns the same way the driver migration does.
    for (const col of [
      ["provider", "TEXT"],
      ["total_msats", "REAL"],
    ] as const) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col[0]} ${col[1]}`);
    }
    const migratedCols = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((r: any) => r.name);
    expect(migratedCols).toContain("provider");
    expect(migratedCols).toContain("total_msats");
    db.close();
  });
});
