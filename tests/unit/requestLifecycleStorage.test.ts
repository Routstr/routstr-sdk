import "fake-indexeddb/auto";
import { createIndexedDBRequestLifecycleDriver } from "../../storage/requestLifecycle";
import { describe, it, expect, vi } from "vitest";
import {
  beginRequestLifecycle,
  createMemoryRequestLifecycleDriver,
  shouldTrackRequestLifecycle,
} from "../../storage/requestLifecycle";
import { createSqliteRequestLifecycleDriver } from "../../storage/requestLifecycle/sqlite";
import type { RequestLifecycleDriver } from "../../storage/requestLifecycle";

const factories: [string, () => RequestLifecycleDriver][] = [
  ["memory", () => createMemoryRequestLifecycleDriver()],
  [
    "IndexedDB",
    () =>
      createIndexedDBRequestLifecycleDriver({
        dbName: `test-lifecycle-${globalThis.crypto.randomUUID()}`,
      }),
  ],
  [
    "node SQLite",
    () => createSqliteRequestLifecycleDriver({ dbPath: ":memory:" }),
  ],
];
for (const [name, factory] of factories)
  describe(name, () => {
    it("creates ordered traces, counts, unique full UUIDs, and idempotent terminal writes", async () => {
      const driver = factory();
      await driver.migrate();
      await driver.migrate();
      const ctx = await beginRequestLifecycle({
        driver,
        method: "POST",
        path: "/v1/chat/completions",
        modelId: "canonical",
      });
      const other = await beginRequestLifecycle({
        driver,
        method: "POST",
        path: "/v1/messages",
      });
      expect(ctx.requestId).toMatch(
        /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/,
      );
      expect(other.requestId).not.toBe(ctx.requestId);
      const a = await ctx.beginAttempt({ baseUrl: "https://a.test" });
      await ctx.updateAttempt(a.attemptId, {
        httpStatus: 400,
        nodeRequestId: "node-a",
        outcome: "failed",
      });
      const b = await ctx.beginAttempt({ baseUrl: "https://b.test" });
      expect(b.attemptId).not.toBe(a.attemptId);
      await ctx.updateAttempt(b.attemptId, {
        httpStatus: 200,
        nodeRequestId: "node-b",
      });
      await Promise.all([
        ctx.finish({ outcome: "succeeded", httpStatus: 200 }),
        ctx.finish({ outcome: "failed" }),
      ]);
      await ctx.updateAttempt(b.attemptId, { outcome: "in_progress" });
      const t = (await driver.getTrace(ctx.requestId))!;
      expect(t.request).toMatchObject({
        outcome: "succeeded",
        requestedModelId: "canonical",
        attemptCount: 2,
        failoverCount: 1,
        retryCount: 0,
        providerCount: 2,
      });
      expect(t.attempts.map((a) => a.ordinal)).toEqual([1, 2]);
      expect(t.attempts[1].outcome).toBe("succeeded");
      expect(
        t.events.filter((e) => e.type === "request_finished"),
      ).toHaveLength(1);
      expect(t.events.map((e) => e.sequence)).toEqual(
        t.events.map((_, i) => i + 1),
      );
    });
    it("records preflight failover without fake attempts, same-provider/mint retries", async () => {
      const driver = factory();
      const c = await beginRequestLifecycle({
        driver,
        method: "POST",
        path: "/v1/responses",
      });
      await c.event("preflight_funding_failed", {
        errorType: "ProviderMintBalanceError",
      });
      expect((await driver.getTrace(c.requestId))!.attempts).toHaveLength(0);
      await c.event("preflight_provider_failover", {
        from: "https://a.test",
        to: "https://b.test",
      });
      await c.beginAttempt({ baseUrl: "https://b.test" });
      await c.beginAttempt({ baseUrl: "https://b.test" });
      await c.beginAttempt({ baseUrl: "https://b.test", kind: "mint_retry" });
      await c.finish({ outcome: "failed" });
      expect((await driver.getTrace(c.requestId))!.request).toMatchObject({
        attemptCount: 3,
        retryCount: 2,
        failoverCount: 1,
        providerCount: 1,
      });
    });
    it("filters, retains all tables together, and reconciles only exact owner", async () => {
      const driver = factory();
      const c = await beginRequestLifecycle({
        driver,
        ownerInstanceId: "old",
        method: "POST",
        path: "/v1/embeddings",
        modelId: "model",
        clientId: "alice",
      });
      await c.beginAttempt({ baseUrl: "https://a.test" });
      await beginRequestLifecycle({
        driver,
        ownerInstanceId: "active",
        method: "POST",
        path: "/v1/messages",
      });
      expect(await driver.reconcileInterrupted("old")).toBe(1);
      expect(await driver.reconcileInterrupted("old")).toBe(0);
      expect(
        await driver.list({
          clientId: "alice",
          modelId: "model",
          baseUrl: "https://a.test",
          outcome: "interrupted",
        }),
      ).toHaveLength(1);
      expect(
        (await driver.list()).find((x) => x.ownerInstanceId === "active")!
          .outcome,
      ).toBe("in_progress");
      expect(await driver.deleteOlderThan(Date.now() + 1)).toBe(2);
      expect(await driver.getTrace(c.requestId)).toBeUndefined();
      await driver.clear();
      expect(await driver.list()).toEqual([]);
    });
    it("allowlists diagnostics and reasons rather than accepting secret-shaped codes", async () => {
      const driver = factory();
      const c = await beginRequestLifecycle({
        driver,
        method: "POST",
        path: "/v1/responses",
      });
      for (const secret of [
        "sk-live-secret",
        "cashuAsecret",
        "privatepromptwithoutspaces",
        "arbitrary_unknown",
      ]) {
        const a = await c.beginAttempt({ baseUrl: "https://a.test" });
        await c.updateAttempt(a.attemptId, {
          errorType: secret,
          errorCode: secret,
        });
        await c.event("response_received", {
          errorType: secret,
          errorCode: secret,
          reason: secret,
        });
      }
      await c.event("retry_decision", {
        reason: "same_provider_retry",
        errorType: "mint_unreachable",
        errorCode: "cashu_mint_unreachable",
      });
      await c.finish({
        outcome: "failed",
        errorType: "sk-live-secret",
        errorCode: "cashuAsecret",
      });
      const trace = (await driver.getTrace(c.requestId))!;
      const raw = JSON.stringify(trace);
      for (const secret of [
        "sk-live-secret",
        "cashuAsecret",
        "privatepromptwithoutspaces",
        "arbitrary_unknown",
      ])
        expect(raw).not.toContain(secret);
      expect(trace.request.errorType).toBe("unknown");
      expect(trace.attempts.every((a) => a.errorCode === "unknown")).toBe(true);
      expect(raw).toContain("cashu_mint_unreachable");
      expect(raw).toContain("same_provider_retry");
    });
    it("does not persist payloads, secrets, raw errors, or URL credentials", async () => {
      const driver = factory();
      const c = await beginRequestLifecycle({
        driver,
        method: "POST",
        path: "/v1/messages?api_key=SECRET",
      });
      const a = await c.beginAttempt({
        baseUrl: "https://user:SECRET@a.test/path?key=SECRET",
        modelPath: "https://user:SECRET@model.test/v1?key=SECRET",
      });
      await c.updateAttempt(a.attemptId, {
        modelPath:
          "url=https%3A%2F%2Fuser%3ASECRET%40model.test%2Fv1%3Fapi_key%3DSECRET&model-id=safe-model&endpoint=chat&unknown=SECRET",
      });
      await c.event("response_received", {
        modelPath:
          "url=https%3A%2F%2Fuser%3ASECRET%40model.test%2Fv1%3Fapi_key%3DSECRET&model-id=safe-model&unknown=SECRET",
        reason: "the user's private prompt",
        prompt: "SECRET",
        Authorization: "SECRET",
        errorMessage: "SECRET",
        status: 400,
      });
      await c.updateAttempt(a.attemptId, {
        errorMessage: '{"prompt":"SECRET","token":"SECRET"}',
        errorType: "bad_request",
        body: "SECRET",
      } as any);
      await c.finish({ outcome: "failed", errorMessage: "Bearer SECRET" });
      const raw = JSON.stringify(await driver.getTrace(c.requestId));
      expect(raw).not.toContain("SECRET");
      expect(raw).not.toContain("private prompt");
      expect(raw).toContain("bad_request");
    });
  });
it("bounds memory requests and events", async () => {
  const d = createMemoryRequestLifecycleDriver({
    maxRequests: 1,
    maxEventsPerRequest: 2,
  });
  const c = await beginRequestLifecycle({
    driver: d,
    method: "POST",
    path: "/v1/responses",
  });
  for (let i = 0; i < 4; i++) await c.event("retry");
  expect((await d.getTrace(c.requestId))!.events).toHaveLength(2);
  await beginRequestLifecycle({
    driver: d,
    method: "POST",
    path: "/v1/messages",
  });
  expect(await d.getTrace(c.requestId)).toBeUndefined();
});
it("fails open with safe diagnostics", async () => {
  const d = createMemoryRequestLifecycleDriver();
  d.createRequest = async () => {
    throw new Error("SECRET");
  };
  const error = vi.fn();
  const logger = {
    error,
    log: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as any;
  const c = await beginRequestLifecycle({
    driver: d,
    method: "POST",
    path: "/v1/responses",
    logger,
  });
  await c.finish({ outcome: "succeeded" });
  expect(c.trackingErrors).toHaveLength(1);
  expect(JSON.stringify(error.mock.calls)).not.toContain("SECRET");
});
it("limits eligibility to model POST routing", () => {
  for (const p of [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/responses",
    "/v1/messages/count_tokens",
    "/v1/embeddings",
    "/system-one",
    "/custom/inference",
  ])
    expect(shouldTrackRequestLifecycle("POST", p)).toBe(true);
  for (const p of [
    "/v1/models",
    "/wallet/topup",
    "/admin/reset",
    "/health",
    "/v1/usage",
  ])
    expect(shouldTrackRequestLifecycle("POST", p)).toBe(false);
  expect(shouldTrackRequestLifecycle("GET", "/v1/responses")).toBe(false);
});
