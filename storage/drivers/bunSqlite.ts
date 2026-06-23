import type { StorageDriver } from "../types";
import type { SdkLogger } from "../../core/types";
import { consoleLogger } from "../../core/types";

// Bun-specific SQLite driver - requires bun:sqlite at runtime.
// This module is only exported from @routstr/sdk/bun and @routstr/sdk/storage/bun.
export async function createBunSqliteDriver(
  dbPath: string,
  options?: { logger?: SdkLogger }
): Promise<StorageDriver> {
  const logger = (options?.logger ?? consoleLogger).child("BunSqliteDriver");
  // @ts-ignore - bun:sqlite is only available at runtime in Bun environments
  const SQLite = (await import("bun:sqlite")).default;
  const db = new SQLite(dbPath);

  // Enable WAL mode and set a busy timeout so concurrent reads don't fail
  // instantly with "database is locked" when another connection is writing.
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");

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
        logger.error(`getItem failed for key "${key}":`, error);
        return defaultValue;
      }
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      try {
        db.query(
          "INSERT INTO sdk_storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(key, JSON.stringify(value));
      } catch (error) {
        logger.error(`setItem failed for key "${key}":`, error);
      }
    },
    async removeItem(key: string): Promise<void> {
      try {
        db.query("DELETE FROM sdk_storage WHERE key = ?").run(key);
      } catch (error) {
        logger.error(`removeItem failed for key "${key}":`, error);
      }
    },
  };
}
