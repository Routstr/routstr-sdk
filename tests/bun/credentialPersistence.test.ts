import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBunSqliteDriver } from "../../storage/drivers/bunSqlite";
import { createSdkStore, createStorageAdapterFromStore } from "../../storage/store";
import { noopLogger } from "../../core/types";

test("real Bun SQLite write failure rejects flush and retry persists across reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr66-bun-"));
  const path = join(dir, "store.sqlite");
  let control: Database | undefined;
  try {
    const driver = await createBunSqliteDriver(path, { logger: noopLogger });
    control = new Database(path);
    control.run("CREATE TRIGGER fail_writes BEFORE INSERT ON sdk_storage BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const { store, hydrate } = createSdkStore({ driver }); await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey("https://provider.example/", "cashu_persist_me");
    await expect(storage.flush!()).rejects.toThrow("disk full");
    expect(control.query("SELECT value FROM sdk_storage WHERE key = 'api_keys'").get()).toBeNull();
    control.run("DROP TRIGGER fail_writes");
    await storage.flush!();
    const reloadedDriver = await createBunSqliteDriver(path, { logger: noopLogger });
    const reload = createSdkStore({ driver: reloadedDriver }); await reload.hydrate;
    expect(createStorageAdapterFromStore(reload.store).getApiKey("https://provider.example/")?.key)
      .toBe("cashu_persist_me");
  } finally {
    control?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
