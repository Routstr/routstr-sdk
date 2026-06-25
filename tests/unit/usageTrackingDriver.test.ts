import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createMemoryUsageTrackingDriver,
} from "../../storage";
import { createSqliteUsageTrackingDriver } from "../../storage/node";
import type { UsageTrackingEntry } from "../../storage";

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

describe("usage tracking aggregate", () => {
  // UTC times chosen so a -300min (UTC-5) tz shift crosses a day boundary:
  //   D1 -> local 2026-01-14 21:30, D2 -> local 2026-01-15 09:00
  const D1 = Date.UTC(2026, 0, 15, 2, 30);
  const D2 = Date.UTC(2026, 0, 15, 14, 0);
  const seed: UsageTrackingEntry[] = [
    entry({
      id: "1",
      timestamp: D1,
      modelId: "m-a",
      client: "c1",
      provider: "prov-a",
      baseUrl: "https://p1/",
      satsCost: 10,
      cost: 1,
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: 10,
      baseMsats: 1,
      inputMsats: 2,
      outputMsats: 3,
      totalMsats: 6,
      totalUsd: 0.01,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5,
      cacheReadMsats: 6,
      cacheCreationMsats: 7,
    }),
    entry({
      id: "2",
      timestamp: D1 + 1000,
      modelId: "m-b",
      client: "c1",
      provider: "prov-b",
      baseUrl: "https://p2/",
      satsCost: 50,
      cost: 5,
      promptTokens: 100,
      completionTokens: 100,
      totalTokens: 200,
      baseMsats: 10,
      inputMsats: 20,
      outputMsats: 30,
      totalMsats: 60,
      totalUsd: 0.02,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 50,
      cacheReadMsats: 60,
      cacheCreationMsats: 70,
    }),
    entry({
      id: "3",
      timestamp: D2,
      modelId: "m-a",
      client: "c2",
      provider: "prov-a",
      baseUrl: "https://p1/",
      satsCost: 30,
      cost: 3,
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      baseMsats: 100,
      inputMsats: 200,
      outputMsats: 300,
      totalMsats: 600,
      totalUsd: 0.03,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 500,
      cacheReadMsats: 600,
      cacheCreationMsats: 700,
    }),
    entry({ id: "4", timestamp: D2 + 5000, modelId: "m-a", client: undefined, provider: undefined, baseUrl: "https://p1/", satsCost: 7, cost: 0.5, promptTokens: 50000, completionTokens: 60000, totalTokens: 110000 }),
  ];

  const seeded = async () => {
    const driver = createMemoryUsageTrackingDriver();
    await driver.appendMany(seed);
    return driver;
  };

  it("returns a single grand-total row when groupBy is omitted", async () => {
    const driver = await seeded();
    const [total] = await driver.aggregate();
    expect(total).toMatchObject({
      group: null,
      requests: 4,
      satsCost: 97,
      totalTokens: 112210,
      baseMsats: 111,
      inputMsats: 222,
      outputMsats: 333,
      totalMsats: 666,
      cacheReadInputTokens: 444,
      cacheCreationInputTokens: 555,
      cacheReadMsats: 666,
      cacheCreationMsats: 777,
    });
    expect(total?.totalUsd).toBeCloseTo(0.06);
  });

  it("returns a zero total row for an empty store", async () => {
    const driver = createMemoryUsageTrackingDriver();
    expect(await driver.aggregate()).toEqual([
      {
        group: null,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        satsCost: 0,
        baseMsats: 0,
        inputMsats: 0,
        outputMsats: 0,
        totalMsats: 0,
        totalUsd: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadMsats: 0,
        cacheCreationMsats: 0,
      },
    ]);
  });

  it("groups by model sorted by satsCost descending", async () => {
    const driver = await seeded();
    const rows = await driver.aggregate({ groupBy: "modelId" });
    expect(rows.map((r) => r.group)).toEqual(["m-b", "m-a"]);
    expect(rows[1]).toMatchObject({ group: "m-a", requests: 3, satsCost: 47 });
  });

  it("groups by client and bucket-keys a missing client as null", async () => {
    const driver = await seeded();
    const rows = await driver.aggregate({ groupBy: "client" });
    expect(rows.find((r) => r.group === null)).toMatchObject({ requests: 1, satsCost: 7 });
  });

  it("groups by provider sorted by satsCost descending", async () => {
    const driver = await seeded();
    const rows = await driver.aggregate({ groupBy: "provider" });
    expect(rows.map((r) => r.group)).toEqual(["prov-b", "prov-a", null]);
    expect(rows.find((r) => r.group === "prov-a")).toMatchObject({
      requests: 2,
      satsCost: 40,
      totalMsats: 606,
      cacheReadInputTokens: 404,
    });
  });

  it("buckets days by the caller's timezone offset", async () => {
    const driver = await seeded();
    const local = await driver.aggregate({ groupBy: "day", tzOffsetMinutes: 300 });
    expect(local.map((r) => r.group)).toEqual(["2026-01-14", "2026-01-15"]);

    const utc = await driver.aggregate({ groupBy: "day", tzOffsetMinutes: 0 });
    expect(utc.map((r) => r.group)).toEqual(["2026-01-15"]);
  });

  it("buckets hours by the caller's timezone offset, ascending", async () => {
    const driver = await seeded();
    const rows = await driver.aggregate({ groupBy: "hour", tzOffsetMinutes: 300 });
    expect(rows.map((r) => r.group)).toEqual(["09", "21"]);
  });

  it("restricts to a set of clients", async () => {
    const driver = await seeded();
    const rows = await driver.aggregate({ groupBy: "modelId", clients: ["c1"] });
    expect(rows.reduce((sum, r) => sum + r.requests, 0)).toBe(2);
  });

  it("produces identical results across memory and sqlite drivers", async () => {
    const mem = await seeded();
    const sql = createSqliteUsageTrackingDriver({ dbPath: ":memory:", tableName: "usage_aggregate_test" });
    await sql.appendMany(seed);

    for (const opts of [
      {},
      { groupBy: "modelId" as const },
      { groupBy: "client" as const },
      { groupBy: "provider" as const },
      { groupBy: "day" as const, tzOffsetMinutes: 300 },
      { groupBy: "hour" as const, tzOffsetMinutes: 300 },
      { groupBy: "modelId" as const, clients: ["c1"] },
    ]) {
      expect(await sql.aggregate(opts)).toEqual(await mem.aggregate(opts));
    }
  });
});
