import type { StorageDriver } from "../types";

type BetterSqlite3Database = {
  prepare: (sql: string) => {
    run: (...params: any[]) => { changes: number };
    get: (...params: any[]) => any;
  };
  exec: (sql: string) => void;
  close?: () => void;
};

export interface SqliteDriverOptions {
  dbPath?: string;
  tableName?: string;
}

const isBun = (): boolean => {
  return typeof process.versions.bun !== "undefined";
};

const createDatabase = (dbPath: string): BetterSqlite3Database => {
  if (isBun()) {
    throw new Error(
      "SQLite driver not supported in Bun. Use createBunSqliteDriver() instead."
    );
  }

  let Database: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(
      `better-sqlite3 is required for sqlite storage. Install it to use sqlite storage. (${error})`
    );
  }
  return new Database(dbPath);
};

export const createSqliteDriver = (
  options: SqliteDriverOptions = {}
): StorageDriver => {
  const dbPath = options.dbPath || "routstr.sqlite";
  const tableName = options.tableName || "sdk_storage";

  const db = createDatabase(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${tableName} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  );

  const selectStmt = db.prepare(`SELECT value FROM ${tableName} WHERE key = ?`);
  const upsertStmt = db.prepare(
    `INSERT INTO ${tableName} (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE key = ?`);

  return {
    async getItem<T>(key: string, defaultValue: T): Promise<T> {
      try {
        const row = selectStmt.get(key);
        if (!row || typeof row.value !== "string") return defaultValue;
        try {
          return JSON.parse(row.value) as T;
        } catch (parseError) {
          if (typeof defaultValue === "string") {
            return row.value as T;
          }
          throw parseError;
        }
      } catch (error) {
        console.error(`SQLite getItem failed for key "${key}":`, error);
        return defaultValue;
      }
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      try {
        upsertStmt.run(key, JSON.stringify(value));
      } catch (error) {
        console.error(`SQLite setItem failed for key "${key}":`, error);
      }
    },
    async removeItem(key: string): Promise<void> {
      try {
        deleteStmt.run(key);
      } catch (error) {
        console.error(`SQLite removeItem failed for key "${key}":`, error);
      }
    },
  };
};

// Bun-specific SQLite driver - requires bun:sqlite at runtime
// This function is only meant to be used in Bun environments
export async function createBunSqliteDriver(
  dbPath: string
): Promise<StorageDriver> {
  // @ts-ignore - bun:sqlite is only available at runtime in Bun environments
  const SQLite = (await import("bun:sqlite")).default;
  const db = new SQLite(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  return {
    async getItem<T>(key: string, defaultValue: T): Promise<T> {
      try {
        const row = db
          .query("SELECT value FROM sdk_storage WHERE key = ?")
          .get(key) as { value: string } | undefined;
        if (!row || typeof row.value !== "string") return defaultValue;
        try {
          return JSON.parse(row.value) as T;
        } catch (parseError) {
          if (typeof defaultValue === "string") {
            return row.value as T;
          }
          throw parseError;
        }
      } catch (error) {
        console.error(`SQLite getItem failed for key "${key}":`, error);
        return defaultValue;
      }
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      try {
        db.query(
          "INSERT INTO sdk_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(key, JSON.stringify(value));
      } catch (error) {
        console.error(`SQLite setItem failed for key "${key}":`, error);
      }
    },
    async removeItem(key: string): Promise<void> {
      try {
        db.query("DELETE FROM sdk_storage WHERE key = ?").run(key);
      } catch (error) {
        console.error(`SQLite removeItem failed for key "${key}":`, error);
      }
    },
  };
}
