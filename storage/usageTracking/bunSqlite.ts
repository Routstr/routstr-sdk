import type {
  ListUsageTrackingOptions,
  UsageTrackingDriver,
} from "./interfaces";
import type { UsageTrackingEntry } from "./types";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const buildWhereClause = (
  options: Omit<ListUsageTrackingOptions, "limit"> = {}
): { sql: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (typeof options.before === "number") {
    clauses.push("timestamp < ?");
    params.push(options.before);
  }
  if (typeof options.after === "number") {
    clauses.push("timestamp > ?");
    params.push(options.after);
  }
  if (options.modelId) {
    clauses.push("model_id = ?");
    params.push(options.modelId);
  }
  if (options.baseUrl) {
    clauses.push("base_url = ?");
    params.push(normalizeBaseUrl(options.baseUrl));
  }
  if (options.sessionId) {
    clauses.push("session_id = ?");
    params.push(options.sessionId);
  }
  if (options.client) {
    clauses.push("client = ?");
    params.push(options.client);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

export interface BunSqliteUsageTrackingDriverOptions {
  dbPath?: string;
  tableName?: string;
  sqlite?: {
    Database: any;
  };
}

// Bun-specific SQLite usage tracking driver using bun:sqlite
export const createBunSqliteUsageTrackingDriver = (
  options: BunSqliteUsageTrackingDriverOptions = {}
): UsageTrackingDriver => {
  const dbPath = options.dbPath || "routstr.sqlite";
  const tableName = options.tableName || "usage_tracking";
  const SQLiteDatabase = options.sqlite?.Database;

  console.log("[USAGE_TRACKING_BUN_SQLITE] Creating Bun SQLite driver with dbPath:", dbPath);

  if (!SQLiteDatabase) {
    throw new Error(
      "Bun SQLite Database constructor is required. Pass { sqlite: { Database } } when creating the driver."
    );
  }

  const db = new SQLiteDatabase(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
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
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${tableName}(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${tableName}_model_id ON ${tableName}(model_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${tableName}_base_url ON ${tableName}(base_url)`);

  const appendOne = (entry: UsageTrackingEntry): void => {
    console.log("[USAGE_TRACKING_BUN_SQLITE] appendOne called with:", JSON.stringify(entry, null, 2));
    db.query(`
      INSERT OR REPLACE INTO ${tableName} (
        id, timestamp, model_id, base_url, request_id,
        cost, sats_cost, prompt_tokens, completion_tokens, total_tokens,
        client, session_id, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.timestamp,
      entry.modelId,
      normalizeBaseUrl(entry.baseUrl),
      entry.requestId,
      entry.cost,
      entry.satsCost,
      entry.promptTokens,
      entry.completionTokens,
      entry.totalTokens,
      entry.client ?? null,
      entry.sessionId ?? null,
      JSON.stringify(entry.tags ?? [])
    );
    console.log("[USAGE_TRACKING_BUN_SQLITE] Successfully inserted into Bun SQLite DB");
  };

  const mapRow = (row: any): UsageTrackingEntry => ({
    id: row.id,
    timestamp: row.timestamp,
    modelId: row.model_id,
    baseUrl: row.base_url,
    requestId: row.request_id,
    cost: row.cost,
    satsCost: row.sats_cost,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    client: row.client ?? undefined,
    sessionId: row.session_id ?? undefined,
    tags: typeof row.tags === "string" ? JSON.parse(row.tags) : undefined,
  });

  return {
    async migrate(): Promise<void> {
      console.log("[USAGE_TRACKING_BUN_SQLITE] migrate() called - no-op for Bun SQLite");
      return;
    },

    async append(entry: UsageTrackingEntry): Promise<void> {
      console.log("[USAGE_TRACKING_BUN_SQLITE] append() called");
      appendOne(entry);
    },

    async appendMany(entries: UsageTrackingEntry[]): Promise<void> {
      console.log("[USAGE_TRACKING_BUN_SQLITE] appendMany() called with", entries.length, "entries");
      for (const entry of entries) {
        appendOne(entry);
      }
    },

    async list(options: ListUsageTrackingOptions = {}): Promise<UsageTrackingEntry[]> {
      console.log("[USAGE_TRACKING_BUN_SQLITE] list() called with options:", options);
      const { sql, params } = buildWhereClause(options);
      const limitSql = typeof options.limit === "number" ? " LIMIT ?" : "";
      const query = `SELECT * FROM ${tableName} ${sql} ORDER BY timestamp DESC${limitSql}`;
      
      let rows: any[];
      if (typeof options.limit === "number") {
        rows = db.query(query).all(...params, options.limit);
      } else {
        rows = db.query(query).all(...params);
      }
      
      console.log("[USAGE_TRACKING_BUN_SQLITE] list() returned", rows.length, "entries");
      return rows.map(mapRow);
    },

    async count(options: Omit<ListUsageTrackingOptions, "limit"> = {}): Promise<number> {
      const { sql, params } = buildWhereClause(options);
      const query = `SELECT COUNT(*) as count FROM ${tableName} ${sql}`;
      const row = db.query(query).get(...params);
      return Number(row?.count ?? 0);
    },

    async deleteOlderThan(timestamp: number): Promise<number> {
      const before = timestamp;
      const result = db.query(`DELETE FROM ${tableName} WHERE timestamp < ?`).run(before);
      return result.changes ?? 0;
    },

    async clear(): Promise<void> {
      db.query(`DELETE FROM ${tableName}`).run();
    },
  };
};
