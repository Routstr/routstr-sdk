import { createSqlLifecycleDriver } from "./sql";
export interface BunSqliteRequestLifecycleDriverOptions {
  dbPath?: string;
}
export async function createBunSqliteRequestLifecycleDriver(
  options: BunSqliteRequestLifecycleDriverOptions = {},
) {
  // @ts-ignore Bun runtime only; this module is never exported by browser entrypoints.
  const { Database } = await import("bun:sqlite");
  const db = new Database(options.dbPath ?? "routstr.sqlite");
  return createSqlLifecycleDriver(async () => db);
}
