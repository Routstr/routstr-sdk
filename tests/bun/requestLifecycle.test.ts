import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSqliteRequestLifecycleDriver } from "../../storage/requestLifecycle/bunSqlite";
import { beginRequestLifecycle } from "../../storage/requestLifecycle";

test("Bun SQLite persists full lifecycle, isolated owner reconciliation, retention and usage DB coexistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-bun-"));
  const dbPath = join(dir, "shared.sqlite");
  try {
    const control = new Database(dbPath);
    control.run("CREATE TABLE usage_tracking(id TEXT PRIMARY KEY)");
    control.run("INSERT INTO usage_tracking VALUES('existing')");
    const d = await createBunSqliteRequestLifecycleDriver({ dbPath });
    await d.migrate();
    await d.migrate();
    const c = await beginRequestLifecycle({
      driver: d,
      ownerInstanceId: "previous",
      method: "POST",
      path: "/v1/responses",
    });
    const a = await c.beginAttempt({ baseUrl: "https://a.test" });
    await c.updateAttempt(a.attemptId, {
      httpStatus: 400,
      outcome: "failed",
      nodeRequestId: "node-a",
    });
    const b = await c.beginAttempt({ baseUrl: "https://b.test" });
    await c.updateAttempt(b.attemptId, {
      httpStatus: 200,
      nodeRequestId: "node-b",
    });
    await c.finish({ outcome: "succeeded", httpStatus: 200 });
    const reopened = await createBunSqliteRequestLifecycleDriver({ dbPath });
    const trace = (await reopened.getTrace(c.requestId))!;
    expect(trace.request).toMatchObject({
      outcome: "succeeded",
      attemptCount: 2,
      failoverCount: 1,
    });
    expect(trace.attempts.map((a) => a.httpStatus)).toEqual([400, 200]);
    const stale = await beginRequestLifecycle({
      driver: d,
      ownerInstanceId: "previous",
      method: "POST",
      path: "/v1/messages",
    });
    await stale.beginAttempt({ baseUrl: "https://a.test" });
    const active = await beginRequestLifecycle({
      driver: d,
      ownerInstanceId: "current",
      method: "POST",
      path: "/v1/messages",
    });
    expect(await reopened.reconcileInterrupted("previous")).toBe(1);
    expect((await d.getTrace(active.requestId))!.request.outcome).toBe(
      "in_progress",
    );
    expect(await d.deleteOlderThan(Date.now() + 1)).toBe(3);
    expect(
      control.query("SELECT COUNT(*) AS n FROM request_attempts").get(),
    ).toEqual({ n: 0 });
    expect(
      control.query("SELECT COUNT(*) AS n FROM request_events").get(),
    ).toEqual({ n: 0 });
    expect(control.query("SELECT * FROM usage_tracking").all()).toEqual([
      { id: "existing" },
    ]);
    control.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
