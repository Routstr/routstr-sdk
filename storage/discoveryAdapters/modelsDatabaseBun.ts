/**
 * SQLite-backed models database (Bun runtime)
 *
 * Bun-specific variant using bun:sqlite. Import this in Bun environments
 * instead of modelsDatabase.ts (which requires better-sqlite3).
 */

import type { Model } from "../../core/types";
import type { StorageDriver } from "../types";
import { SDK_STORAGE_KEYS } from "../keys";
import type { ModelsDatabase, ModelsDatabaseOptions } from "./modelsDatabase";

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

export interface BunModelsDatabaseOptions {
  /** Path to the SQLite database file (default: "routstr.sqlite") */
  dbPath?: string;
  /** Table name prefix (default: "models") */
  tableName?: string;
  /** Legacy key-value StorageDriver for migration */
  legacyStorageDriver?: StorageDriver;
  /** bun:sqlite Database constructor (required) */
  Database: new (path: string) => {
    query: (sql: string) => {
      run: (...params: unknown[]) => void;
      get: (...params: unknown[]) => unknown;
      all: (...params: unknown[]) => unknown[];
    };
    run: (sql: string) => void;
  };
}

const MIGRATION_MARKER_KEY = "models_sqlite_migration_v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const parseModel = (raw: unknown): Model | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Model;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createModelsDatabaseBun = (
  options: BunModelsDatabaseOptions,
): ModelsDatabase => {
  const dbPath = options.dbPath || "routstr.sqlite";
  const tableName = options.tableName || "models";
  const legacyStorageDriver = options.legacyStorageDriver;
  const Database = options.Database;

  if (!Database) {
    throw new Error(
      "Bun SQLite Database constructor is required. Pass { Database } when creating the driver.",
    );
  }

  const timestampsTable = `${tableName}_timestamps`;
  const db = new Database(dbPath);

  // Create schema
  db.run(SCHEMA_DDL(tableName));

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

        // Delete existing, then insert
        db.query(`DELETE FROM ${tableName} WHERE base_url = ?`).run(
          normalized,
        );
        for (const model of models) {
          db.query(
            `INSERT OR REPLACE INTO ${tableName} (id, base_url, data) VALUES (?, ?, ?)`,
          ).run(model.id, normalized, JSON.stringify(model));
        }

        if (legacyTimestamps[normalized]) {
          db.query(
            `INSERT OR REPLACE INTO ${timestampsTable} (base_url, last_update) VALUES (?, ?)`,
          ).run(normalized, legacyTimestamps[normalized]);
        }
      }

      await legacyStorageDriver.removeItem(
        SDK_STORAGE_KEYS.MODELS_FROM_ALL_PROVIDERS,
      );
      await legacyStorageDriver.removeItem(SDK_STORAGE_KEYS.LAST_MODELS_UPDATE);
    }

    await legacyStorageDriver.setItem(MIGRATION_MARKER_KEY, true);
    migrationComplete = true;
  };

  return {
    async migrate(): Promise<void> {
      await ensureMigrated();
    },

    upsertProviderModels(
      baseUrl: string,
      models: Model[],
      cachedAt: number,
    ): void {
      const normalized = normalizeBaseUrl(baseUrl);

      // Delete existing, then insert
      db.query(`DELETE FROM ${tableName} WHERE base_url = ?`).run(normalized);
      for (const model of models) {
        db.query(
          `INSERT OR REPLACE INTO ${tableName} (id, base_url, data) VALUES (?, ?, ?)`,
        ).run(model.id, normalized, JSON.stringify(model));
      }

      // Update timestamp
      db.query(
        `INSERT OR REPLACE INTO ${timestampsTable} (base_url, last_update) VALUES (?, ?)`,
      ).run(normalized, cachedAt);
    },

    getProviderModels(baseUrl: string): Model[] {
      const normalized = normalizeBaseUrl(baseUrl);
      const rows = db
        .query(`SELECT data FROM ${tableName} WHERE base_url = ?`)
        .all(normalized) as { data: string }[];
      const models: Model[] = [];
      for (const row of rows) {
        const model = parseModel(row.data);
        if (model) models.push(model);
      }
      return models;
    },

    getAllModels(): Record<string, Model[]> {
      const rows = db
        .query(`SELECT id, base_url, data FROM ${tableName}`)
        .all() as { id: string; base_url: string; data: string }[];
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
      db.query(`DELETE FROM ${tableName} WHERE base_url = ?`).run(normalized);
    },

    clearAll(): void {
      db.query(`DELETE FROM ${tableName}`).run();
    },

    deleteStale(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs;
      db.query(
        `DELETE FROM ${tableName}
         WHERE base_url IN (
           SELECT base_url FROM ${timestampsTable}
           WHERE last_update < ?
         )`,
      ).run(cutoff);
      // bun:sqlite .run() doesn't return changes count — return 0
      return 0;
    },

    getProviderLastUpdate(baseUrl: string): number | null {
      const normalized = normalizeBaseUrl(baseUrl);
      const row = db
        .query(`SELECT last_update FROM ${timestampsTable} WHERE base_url = ?`)
        .get(normalized) as { last_update: number } | undefined;
      return row ? row.last_update : null;
    },

    setProviderLastUpdate(baseUrl: string, timestamp: number): void {
      const normalized = normalizeBaseUrl(baseUrl);
      db.query(
        `INSERT OR REPLACE INTO ${timestampsTable} (base_url, last_update) VALUES (?, ?)`,
      ).run(normalized, timestamp);
    },

    setAllProviderLastUpdates(updates: Record<string, number>): void {
      for (const [baseUrl, timestamp] of Object.entries(updates)) {
        const normalized = normalizeBaseUrl(baseUrl);
        db.query(
          `INSERT OR REPLACE INTO ${timestampsTable} (base_url, last_update) VALUES (?, ?)`,
        ).run(normalized, timestamp);
      }
    },
  };
};
