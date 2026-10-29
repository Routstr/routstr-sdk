import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { it, expect, vi, afterEach } from "vitest";
import {
  createIndexedDBRequestLifecycleDriver,
  beginRequestLifecycle,
} from "../../storage/requestLifecycle";
afterEach(() => vi.unstubAllGlobals());
it("uses dedicated lifecycle database v1 with separate stores and unique ordering indexes", async () => {
  const stores = new Map<string, any>();
  const db = {
    createObjectStore: vi.fn((name: string, options: unknown) => {
      const store = { createIndex: vi.fn() };
      stores.set(name, store);
      return store;
    }),
    close: vi.fn(),
    onversionchange: null,
  };
  const open = vi.fn((name: string, version: number) => {
    const req: any = { result: db };
    queueMicrotask(() => {
      req.onupgradeneeded();
      req.onsuccess();
    });
    return req;
  });
  vi.stubGlobal("indexedDB", { open });
  await createIndexedDBRequestLifecycleDriver().migrate();
  expect(open).toHaveBeenCalledWith("routstr-request-lifecycle", 1);
  expect([...stores.keys()]).toEqual([
    "requests",
    "request_attempts",
    "request_events",
  ]);
  expect(stores.get("request_attempts").createIndex).toHaveBeenCalledWith(
    "ordinal",
    ["requestId", "ordinal"],
    { unique: true },
  );
  expect(stores.get("request_events").createIndex).toHaveBeenCalledWith(
    "sequence",
    ["requestId", "sequence"],
    { unique: true },
  );
  expect(db.createObjectStore).not.toHaveBeenCalledWith(
    "usage_tracking",
    expect.anything(),
  );
});
it("IndexedDB denial does not prevent lifecycle context or terminal completion", async () => {
  vi.stubGlobal("indexedDB", {
    open: () => {
      const req: any = { error: new Error("Denied") };
      queueMicrotask(() => req.onerror());
      return req;
    },
  });
  const error = vi.fn();
  const logger = {
    error,
    log: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as any;
  const context = await beginRequestLifecycle({
    driver: createIndexedDBRequestLifecycleDriver(),
    method: "POST",
    path: "/v1/responses",
    logger,
  });
  await context.finish({ outcome: "succeeded" });
  expect(context.requestId).toHaveLength(36);
  expect(context.trackingErrors.length).toBeGreaterThan(0);
  expect(error).toHaveBeenCalled();
});

it("real IndexedDB lifecycle retention is cascading and never upgrades the usage DB", async () => {
  const factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const usage = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open("routstr-sdk", 3);
    r.onupgradeneeded = () => r.result.createObjectStore("usage_tracking");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const d = createIndexedDBRequestLifecycleDriver();
  await d.migrate();
  await d.migrate();
  const c = await beginRequestLifecycle({
    driver: d,
    method: "POST",
    path: "/v1/responses",
  });
  await c.beginAttempt({ baseUrl: "https://a.test" });
  await c.finish({ outcome: "succeeded" });
  const reloaded = createIndexedDBRequestLifecycleDriver();
  expect((await reloaded.getTrace(c.requestId))!.attempts).toHaveLength(1);
  expect(await d.deleteOlderThan(Date.now() + 1)).toBe(1);
  expect(await reloaded.getTrace(c.requestId)).toBeUndefined();
  const lifecycle = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open("routstr-request-lifecycle");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  for (const name of ["requests", "request_attempts", "request_events"]) {
    const count = await new Promise<number>((resolve, reject) => {
      const r = lifecycle.transaction(name).objectStore(name).count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(count).toBe(0);
  }
  expect(usage.version).toBe(3);
  expect([...usage.objectStoreNames]).toEqual(["usage_tracking"]);
  expect(lifecycle.version).toBe(1);
  usage.close();
  lifecycle.close();
});
