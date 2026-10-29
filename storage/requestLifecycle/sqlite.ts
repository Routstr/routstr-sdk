import { createSqlLifecycleDriver } from "./sql";
export interface SqliteRequestLifecycleDriverOptions {
  dbPath?: string;
}
export function createSqliteRequestLifecycleDriver(
  options: SqliteRequestLifecycleDriverOptions = {},
) {
  return createSqlLifecycleDriver(async () => {
    const { default: Database } = await import("better-sqlite3");
    return new Database(options.dbPath ?? "routstr.sqlite");
  });
}
