import { SDK_STORAGE_KEYS } from "../keys";
import type { StorageDriver } from "../types";
import type {
  AggregateUsageOptions,
  ListUsageTrackingOptions,
  UsageAggregateRow,
  UsageTrackingDriver,
} from "./interfaces";
import type { UsageTrackingEntry } from "./types";
import { buildAggregateSql, mapAggregateRow } from "./aggregate";

type BetterSqlite3Database = {
  prepare: (sql: string) => {
    run: (...params: any[]) => { changes: number };
    get: (...params: any[]) => any;
    all: (...params: any[]) => any[];
  };
  exec: (sql: string) => void;
};

export interface SqliteUsageTrackingDriverOptions {
  dbPath?: string;
  tableName?: string;
  legacyStorageDriver?: StorageDriver;
}

const MIGRATION_MARKER_KEY = "usage_tracking_migration_v1";

// Columns added after the initial release. Each entry is added via
// `ALTER TABLE ... ADD COLUMN` only if it is not already present, so the
// migration is safe to run repeatedly and against partially-migrated DBs.
const ADDED_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "provider", type: "TEXT" },
  { name: "base_msats", type: "REAL" },
  { name: "input_msats", type: "REAL" },
  { name: "output_msats", type: "REAL" },
  { name: "total_msats", type: "REAL" },
  { name: "total_usd", type: "REAL" },
  { name: "cache_read_input_tokens", type: "INTEGER" },
  { name: "cache_creation_input_tokens", type: "INTEGER" },
  { name: "cache_read_msats", type: "REAL" },
  { name: "cache_creation_msats", type: "REAL" },
  { name: "remaining_balance_msats", type: "REAL" },
];

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const isBun = (): boolean => {
  return typeof process.versions.bun !== "undefined";
};

let cachedDbModule: any = null;

const loadDatabase = async (dbPath: string): Promise<BetterSqlite3Database> => {
  if (isBun()) {
    throw new Error(
      "SQLite driver not supported in Bun. Use createMemoryDriver() instead."
    );
  }

  try {
    if (!cachedDbModule) {
      cachedDbModule = (await import("better-sqlite3")).default;
    }
    return new cachedDbModule(dbPath);
  } catch (error) {
    throw new Error(
      `better-sqlite3 is required for sqlite usage tracking. Install it to use sqlite storage. (${error})`
    );
  }
};

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
  if (options.clients && options.clients.length > 0) {
    const placeholders = options.clients.map(() => "?").join(", ");
    clauses.push(`client IN (${placeholders})`);
    params.push(...options.clients);
  }
  if (options.provider) {
    clauses.push("provider = ?");
    params.push(options.provider);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

export const createSqliteUsageTrackingDriver = (
  options: SqliteUsageTrackingDriverOptions = {}
): UsageTrackingDriver => {
  const dbPath = options.dbPath || "routstr.sqlite";
  const tableName = options.tableName || "usage_tracking";
  const legacyStorageDriver = options.legacyStorageDriver;

  let db: BetterSqlite3Database;
  let insertStmt: any;

  let migrationComplete = false;

  const initDb = async () => {
    if (!db) {
      db = await loadDatabase(dbPath);
      db.exec(`
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
        );
        CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${tableName}(timestamp);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_model_id ON ${tableName}(model_id);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_base_url ON ${tableName}(base_url);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_session_id ON ${tableName}(session_id);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_client ON ${tableName}(client);
      `);

      // Add columns introduced after the initial schema. `PRAGMA table_info`
      // tells us which already exist so repeated/partial migrations are safe.
      const existingColumns = new Set<string>(
        db
          .prepare(`PRAGMA table_info(${tableName})`)
          .all()
          .map((row: any) => String(row.name))
      );
      for (const column of ADDED_COLUMNS) {
        if (!existingColumns.has(column.name)) {
          db.exec(
            `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.type}`
          );
        }
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${tableName}_provider ON ${tableName}(provider)`
      );

      insertStmt = db.prepare(`
        INSERT OR REPLACE INTO ${tableName} (
          id, timestamp, model_id, base_url, request_id,
          cost, sats_cost, prompt_tokens, completion_tokens, total_tokens,
          client, session_id, tags,
          provider, base_msats, input_msats, output_msats, total_msats,
          total_usd, cache_read_input_tokens, cache_creation_input_tokens,
          cache_read_msats, cache_creation_msats, remaining_balance_msats
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
    }
  };

  const ensureInit = async () => {
    if (!db) {
      await initDb();
    }
  };

  const appendOne = (entry: UsageTrackingEntry): void => {
    insertStmt.run(
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
      JSON.stringify(entry.tags ?? []),
      entry.provider ?? null,
      entry.baseMsats ?? null,
      entry.inputMsats ?? null,
      entry.outputMsats ?? null,
      entry.totalMsats ?? null,
      entry.totalUsd ?? null,
      entry.cacheReadInputTokens ?? null,
      entry.cacheCreationInputTokens ?? null,
      entry.cacheReadMsats ?? null,
      entry.cacheCreationMsats ?? null,
      entry.remainingBalanceMsats ?? null
    );
  };

  const ensureMigrated = async (): Promise<void> => {
    if (!legacyStorageDriver || migrationComplete) return;

    const migrated = await legacyStorageDriver.getItem<boolean>(
      MIGRATION_MARKER_KEY,
      false
    );
    if (migrated) {
      migrationComplete = true;
      return;
    }

    const legacyEntries = await legacyStorageDriver.getItem<UsageTrackingEntry[]>(
      SDK_STORAGE_KEYS.USAGE_TRACKING,
      []
    );

    for (const entry of legacyEntries) {
      appendOne(entry);
    }

    if (legacyEntries.length > 0) {
      await legacyStorageDriver.removeItem(SDK_STORAGE_KEYS.USAGE_TRACKING);
    }
    await legacyStorageDriver.setItem(MIGRATION_MARKER_KEY, true);
    migrationComplete = true;
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
    provider: row.provider ?? undefined,
    baseMsats: row.base_msats ?? undefined,
    inputMsats: row.input_msats ?? undefined,
    outputMsats: row.output_msats ?? undefined,
    totalMsats: row.total_msats ?? undefined,
    totalUsd: row.total_usd ?? undefined,
    cacheReadInputTokens: row.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? undefined,
    cacheReadMsats: row.cache_read_msats ?? undefined,
    cacheCreationMsats: row.cache_creation_msats ?? undefined,
    remainingBalanceMsats: row.remaining_balance_msats ?? undefined,
  });

  return {
    async migrate(): Promise<void> {
      await ensureInit();
      await ensureMigrated();
    },

    async append(entry: UsageTrackingEntry): Promise<void> {
      await ensureInit();
      await ensureMigrated();
      appendOne(entry);
    },

    async appendMany(entries: UsageTrackingEntry[]): Promise<void> {
      await ensureInit();
      await ensureMigrated();
      for (const entry of entries) {
        appendOne(entry);
      }
    },

    async list(options: ListUsageTrackingOptions = {}): Promise<UsageTrackingEntry[]> {
      await ensureInit();
      await ensureMigrated();
      const { sql, params } = buildWhereClause(options);
      const limitSql = typeof options.limit === "number" ? " LIMIT ?" : "";
      const stmt = db.prepare(
        `SELECT * FROM ${tableName} ${sql} ORDER BY timestamp DESC${limitSql}`
      );
      const rows = stmt.all(
        ...(typeof options.limit === "number" ? [...params, options.limit] : params)
      );
      return rows.map(mapRow);
    },

    async count(options: Omit<ListUsageTrackingOptions, "limit"> = {}): Promise<number> {
      await ensureInit();
      await ensureMigrated();
      const { sql, params } = buildWhereClause(options);
      const stmt = db.prepare(`SELECT COUNT(*) as count FROM ${tableName} ${sql}`);
      const row = stmt.get(...params);
      return Number(row?.count ?? 0);
    },

    async aggregate(options: AggregateUsageOptions = {}): Promise<UsageAggregateRow[]> {
      await ensureInit();
      await ensureMigrated();
      const where = buildWhereClause(options);
      const { sql, params } = buildAggregateSql(tableName, where, options);
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map(mapAggregateRow);
    },

    async deleteOlderThan(timestamp: number): Promise<number> {
      await ensureInit();
      await ensureMigrated();
      const stmt = db.prepare(`DELETE FROM ${tableName} WHERE timestamp < ?`);
      const result = stmt.run(timestamp);
      return result.changes;
    },

    async clear(): Promise<void> {
      await ensureInit();
      await ensureMigrated();
      db.prepare(`DELETE FROM ${tableName}`).run();
    },
  };
};
