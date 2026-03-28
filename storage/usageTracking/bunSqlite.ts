import { SDK_STORAGE_KEYS } from "../keys";
import type { StorageDriver } from "../types";
import type {
  ListUsageTrackingOptions,
  UsageTrackingDriver,
} from "./interfaces";
import type { UsageTrackingEntry } from "./types";

const MIGRATION_MARKER_KEY = "usage_tracking_migration_v1";

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
  legacyStorageDriver?: StorageDriver;
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
  const legacyStorageDriver = options.legacyStorageDriver;
  const SQLiteDatabase = options.sqlite?.Database;

  let migrationPromise: Promise<void> | null = null;

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

  const ensureMigrated = async (): Promise<void> => {
    if (!legacyStorageDriver) return;
    if (!migrationPromise) {
      migrationPromise = (async () => {
        const migrated = await legacyStorageDriver.getItem<boolean>(
          MIGRATION_MARKER_KEY,
          false
        );
        if (migrated) return;

        const legacyEntries = await legacyStorageDriver.getItem<UsageTrackingEntry[]>(
          SDK_STORAGE_KEYS.USAGE_TRACKING,
          []
        );

        if (legacyEntries.length > 0) {
          for (const entry of legacyEntries) {
            appendOne(entry);
          }
          await legacyStorageDriver.removeItem(SDK_STORAGE_KEYS.USAGE_TRACKING);
        }

        await legacyStorageDriver.setItem(MIGRATION_MARKER_KEY, true);
      })();
    }
    await migrationPromise;
  };

  return {
    async migrate(): Promise<void> {
      await ensureMigrated();
    },

    async append(entry: UsageTrackingEntry): Promise<void> {
      await ensureMigrated();
      appendOne(entry);
    },

    async appendMany(entries: UsageTrackingEntry[]): Promise<void> {
      await ensureMigrated();
      for (const entry of entries) {
        appendOne(entry);
      }
    },

    async list(options: ListUsageTrackingOptions = {}): Promise<UsageTrackingEntry[]> {
      await ensureMigrated();
      const { sql, params } = buildWhereClause(options);
      const limitSql = typeof options.limit === "number" ? " LIMIT ?" : "";
      const query = `SELECT * FROM ${tableName} ${sql} ORDER BY timestamp DESC${limitSql}`;
      
      let rows: any[];
      if (typeof options.limit === "number") {
        rows = db.query(query).all(...params, options.limit);
      } else {
        rows = db.query(query).all(...params);
      }

      return rows.map(mapRow);
    },

    async count(options: Omit<ListUsageTrackingOptions, "limit"> = {}): Promise<number> {
      const { sql, params } = buildWhereClause(options);
      const query = `SELECT COUNT(*) as count FROM ${tableName} ${sql}`;
      const row = db.query(query).get(...params);
      return Number(row?.count ?? 0);
    },

    async deleteOlderThan(timestamp: number): Promise<number> {
      await ensureMigrated();
      const before = timestamp;
      const result = db.query(`DELETE FROM ${tableName} WHERE timestamp < ?`).run(before);
      return result.changes ?? 0;
    },

    async clear(): Promise<void> {
      await ensureMigrated();
      db.query(`DELETE FROM ${tableName}`).run();
    },
  };
};
