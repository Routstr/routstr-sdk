/**
 * SQLite-backed models database (Node / better-sqlite3)
 *
 * Stores AI model metadata fetched from providers in a normalized
 * SQLite table, replacing the old key-value blob approach.
 *
 * Migration from legacy StorageDriver is handled in ensureMigrated().
 */

import type { Model } from "../../core/types";
import type { StorageDriver } from "../types";
import { SDK_STORAGE_KEYS } from "../keys";

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

type BetterSqlite3Database = {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: (...args: unknown[]) => T) => (...args: unknown[]) => T;
  close?: () => void;
};

const isBun = (): boolean =>
  typeof process !== "undefined" &&
  typeof process.versions !== "undefined" &&
  typeof process.versions.bun !== "undefined";

let cachedDbModule: unknown = null;

const loadDatabase = async (
  dbPath: string,
): Promise<BetterSqlite3Database> => {
  if (isBun()) {
    throw new Error(
      "modelsDatabase (better-sqlite3) is not supported in Bun. Use createModelsDatabaseBun() instead.",
    );
  }

  try {
    if (!cachedDbModule) {
      cachedDbModule = (await import("better-sqlite3")).default;
    }
    return new (cachedDbModule as new (path: string) => BetterSqlite3Database)(
      dbPath,
    );
  } catch (error) {
    throw new Error(
      `better-sqlite3 is required for sqlite models storage. Install it. (${error})`,
    );
  }
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_DDL = (tableName: string) => `
  CREATE TABLE IF NOT EXISTS ${tableName} (
    id      TEXT NOT NULL,
    base_url TEXT NOT NULL,
    data    TEXT NOT NULL,
    PRIMARY KEY (id, base_url)
  );

  CREATE INDEX IF NOT EXISTS idx_${tableName}_base_url
    ON ${tableName}(base_url);

  CREATE TABLE IF NOT EXISTS ${tableName}_timestamps (
    base_url    TEXT PRIMARY KEY,
    last_update INTEGER NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ModelsDatabaseOptions {
  /** Path to the SQLite database file (default: "routstr.sqlite") */
  dbPath?: string;
  /** Table name prefix (default: "models") */
  tableName?: string;
  /** Legacy key-value StorageDriver for migration */
  legacyStorageDriver?: StorageDriver;
}

const MIGRATION_MARKER_KEY = "models_sqlite_migration_v1";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModelsDatabase {
  /** Migrate models from a legacy key-value StorageDriver into SQLite */
  migrate(): Promise<void>;

  // ---- Model CRUD ----

  /** Replace all models for a single provider */
  upsertProviderModels(
    baseUrl: string,
    models: Model[],
    cachedAt: number,
  ): void;

  /** Get all models for a single provider */
  getProviderModels(baseUrl: string): Model[];

  /** Get all models grouped by base_url */
  getAllModels(): Record<string, Model[]>;

  /** Remove all models for a single provider */
  clearProvider(baseUrl: string): void;

  /** Remove every model */
  clearAll(): void;

  /** Delete models older than `maxAgeMs` (based on per-row cached_at derived from timestamp table) */
  deleteStale(maxAgeMs: number): number;

  // ---- Last-update timestamps (per provider) ----

  /** Get the last-update timestamp for a provider, or null if never cached */
  getProviderLastUpdate(baseUrl: string): number | null;

  /** Set the last-update timestamp for a provider */
  setProviderLastUpdate(baseUrl: string, timestamp: number): void;

  /** Bulk set last-update timestamps */
  setAllProviderLastUpdates(updates: Record<string, number>): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

export const createModelsDatabase = (
  options: ModelsDatabaseOptions = {},
): ModelsDatabase => {
  const dbPath = options.dbPath || "routstr.sqlite";
  const tableName = options.tableName || "models";
  const legacyStorageDriver = options.legacyStorageDriver;

  const timestampsTable = `${tableName}_timestamps`;

  // ---- Lazy initialisation ----

  let db: BetterSqlite3Database;

  let upsertStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let selectByBaseStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let selectAllStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let deleteByBaseStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let deleteAllStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let deleteStaleStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let selectTsStmt: ReturnType<BetterSqlite3Database["prepare"]>;
  let upsertTsStmt: ReturnType<BetterSqlite3Database["prepare"]>;

  const initDb = async () => {
    if (db) return;
    db = await loadDatabase(dbPath);
    db.exec(SCHEMA_DDL(tableName));

    upsertStmt = db.prepare(
      `INSERT OR REPLACE INTO ${tableName} (id, base_url, data)
       VALUES (?, ?, ?)`,
    );
    selectByBaseStmt = db.prepare(
      `SELECT data FROM ${tableName} WHERE base_url = ?`,
    );
    selectAllStmt = db.prepare(`SELECT id, base_url, data FROM ${tableName}`);
    deleteByBaseStmt = db.prepare(
      `DELETE FROM ${tableName} WHERE base_url = ?`,
    );
    deleteAllStmt = db.prepare(`DELETE FROM ${tableName}`);
    deleteStaleStmt = db.prepare(
      `DELETE FROM ${tableName}
       WHERE base_url IN (
         SELECT base_url FROM ${timestampsTable}
         WHERE last_update < ?
       )`,
    );
    selectTsStmt = db.prepare(
      `SELECT last_update FROM ${timestampsTable} WHERE base_url = ?`,
    );
    upsertTsStmt = db.prepare(
      `INSERT OR REPLACE INTO ${timestampsTable} (base_url, last_update)
       VALUES (?, ?)`,
    );
  };

  const ensureInit = async () => {
    if (!db) await initDb();
  };

  // ---- Parsing helpers ----

  const parseModel = (raw: unknown): Model | null => {
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as Model;
    } catch {
      return null;
    }
  };

  // ---- Migration ----

  let migrationComplete = false;

  const ensureMigrated = async (): Promise<void> => {
    if (!legacyStorageDriver || migrationComplete) return;

    const migrated = await legacyStorageDriver.getItem<boolean>(
      MIGRATION_MARKER_KEY,
      false,
    );
    if (migrated) {
      migrationComplete = true;
      return;
    }

    const legacyModels = await legacyStorageDriver.getItem<
      Record<string, Model[]>
    >(SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS, {});

    const legacyTimestamps = await legacyStorageDriver.getItem<
      Record<string, number>
    >(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE, {});

    if (Object.keys(legacyModels).length > 0) {
      for (const [baseUrl, models] of Object.entries(legacyModels)) {
        const normalized = normalizeBaseUrl(baseUrl);
        upsertProviderModelsInternal(normalized, models);

        if (legacyTimestamps[normalized]) {
          upsertTsStmt.run(normalized, legacyTimestamps[normalized]);
        }
      }

      // Clear old data after migration
      await legacyStorageDriver.removeItem(
        SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS,
      );
      await legacyStorageDriver.removeItem(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE);
    }

    await legacyStorageDriver.setItem(MIGRATION_MARKER_KEY, true);
    migrationComplete = true;
  };

  // ---- Internal helpers ----

  const upsertProviderModelsInternal = (
    baseUrl: string,
    models: Model[],
  ): void => {
    // Delete existing rows for this provider first, then insert
    deleteByBaseStmt.run(baseUrl);
    for (const model of models) {
      upsertStmt.run(model.id, baseUrl, JSON.stringify(model));
    }
  };

  // ---- Public API ----

  return {
    async migrate(): Promise<void> {
      await ensureInit();
      await ensureMigrated();
    },

    upsertProviderModels(
      baseUrl: string,
      models: Model[],
      cachedAt: number,
    ): void {
      const normalized = normalizeBaseUrl(baseUrl);
      upsertProviderModelsInternal(normalized, models);
      upsertTsStmt.run(normalized, cachedAt);
    },

    getProviderModels(baseUrl: string): Model[] {
      const normalized = normalizeBaseUrl(baseUrl);
      const rows = selectByBaseStmt.all(normalized) as { data: string }[];
      const models: Model[] = [];
      for (const row of rows) {
        const model = parseModel(row.data);
        if (model) models.push(model);
      }
      return models;
    },

    getAllModels(): Record<string, Model[]> {
      const rows = selectAllStmt.all() as {
        id: string;
        base_url: string;
        data: string;
      }[];
      const result: Record<string, Model[]> = {};
      for (const row of rows) {
        const model = parseModel(row.data);
        if (!model) continue;
        const key = row.base_url;
        if (!result[key]) result[key] = [];
        result[key].push(model);
      }
      return result;
    },

    clearProvider(baseUrl: string): void {
      const normalized = normalizeBaseUrl(baseUrl);
      deleteByBaseStmt.run(normalized);
    },

    clearAll(): void {
      deleteAllStmt.run();
    },

    deleteStale(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      const result = deleteStaleStmt.run(cutoff);
      return result.changes;
    },

    getProviderLastUpdate(baseUrl: string): number | null {
      const normalized = normalizeBaseUrl(baseUrl);
      const row = selectTsStmt.get(normalized) as
        | { last_update: number }
        | undefined;
      return row ? row.last_update : null;
    },

    setProviderLastUpdate(baseUrl: string, timestamp: number): void {
      const normalized = normalizeBaseUrl(baseUrl);
      upsertTsStmt.run(normalized, timestamp);
    },

    setAllProviderLastUpdates(updates: Record<string, number>): void {
      for (const [baseUrl, timestamp] of Object.entries(updates)) {
        const normalized = normalizeBaseUrl(baseUrl);
        upsertTsStmt.run(normalized, timestamp);
      }
    },
  };
};
