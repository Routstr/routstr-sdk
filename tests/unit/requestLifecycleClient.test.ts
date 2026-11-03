import { describe, expect, it, vi } from "vitest";
import { ProviderMintBalanceError } from "../../core/errors";
import { RoutstrClient } from "../../client/RoutstrClient";
import {
  beginRequestLifecycle,
  createMemoryRequestLifecycleDriver,
} from "../../storage/requestLifecycle";

const params = {
  path: "/v1/chat/completions",
  method: "POST",
  baseUrl: "https://a.example",
  mintUrl: "https://mint.example",
  modelId: "model",
  body: { model: "model" },
};
function client() {
  const value = Object.create(RoutstrClient.prototype) as any;
  value.mode = "apikeys";
  value.logger = {
    log() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
  return value;
}
function prepared(response: Response) {
  return {
    response,
    tokenUsed: "secret",
    baseUrlUsed: params.baseUrl,
    tokenBalanceInSats: 1,
    tokenBalanceUnknown: false,
    modelId: "model",
    usagePromise: Promise.resolve({}),
  };
}
describe("client lifecycle terminal boundary", () => {
  it("assigns one full SDK UUID immediately on success, even with no upstream ID", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    c._prepareRoutedRequestWithMintFailover = vi.fn(async () =>
      prepared(new Response("{}")),
    );
    c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
    const responses = await Promise.all([
      c.routeRequest(params),
      c.routeRequest(params),
    ]);
    expect(responses[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(responses[0].requestId).not.toBe(responses[1].requestId);
    expect(responses[0].headers.get("x-routstr-sdk-request-id")).toBe(
      responses[0].requestId,
    );
    expect((await driver.list()).map((r) => r.outcome)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });
  it("rewraps Fetch state without copying enumerable runtime symbols", async () => {
    for (const streaming of [false, true]) {
      const driver = createMemoryRequestLifecycleDriver();
      const c = client();
      c.requestLifecycleDriver = driver;
      const runtimeState = Symbol("runtime-owned-response-state");
      const original = new Response("payload", {
        headers: {
          "content-type": streaming ? "text/event-stream" : "application/json",
          "x-routstr-request-id": "node-original",
        },
      });
      // Node 22 exposes Fetch internal state as enumerable symbols. Model
      // that boundary on every runtime, including ones with private slots.
      Object.defineProperty(original, runtimeState, { enumerable: true, value: {} });
      const accounting = vi.fn(async () => {
        Object.assign(original, { upstreamResponseId: "gen-late", satsSpent: 7, usage: { totalTokens: 2 } });
        return 7;
      });
      if (streaming) Object.assign(original, { finalize: accounting });
      c._routeRequest = vi.fn(async () => original);
      const response = await c.routeRequest(params);
      expect(response.headers.get("x-routstr-sdk-request-id")).toBe(response.requestId);
      expect(response.headers.get("x-routstr-request-id")).toBe("node-original");
      expect(response.nodeRequestId).toBe("node-original");
      expect(original.headers.has("x-routstr-sdk-request-id")).toBe(false);
      expect(Object.hasOwn(response, runtimeState)).toBe(false);
      expect(response.body.locked).toBe(false);
      expect(response.bodyUsed).toBe(false);
      if (streaming) {
        expect(response.body).not.toBe(original.body);
        await response.finalize();
        expect(response.upstreamResponseId).toBe("gen-late");
        expect(response.satsSpent).toBe(7);
        expect(response.usage).toEqual({ totalTokens: 2 });
        expect((await driver.getTrace(response.requestId))?.request.outcome).toBe("in_progress");
      }
      expect(await response.text()).toBe("payload");
      await response.finalize?.();
      expect((await driver.getTrace(response.requestId))?.request.outcome).toBe("succeeded");
      if (streaming) expect(accounting).toHaveBeenCalled();
    }
  });
  it("finalizes passthrough errors without successful accounting or body mutation", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    const error = Object.assign(
      new Response('{"error":"bad"}', {
        status: 400,
        headers: { "x-routstr-request-id": "node-id" },
      }),
      { passthrough: true },
    );
    c._prepareRoutedRequestWithMintFailover = vi.fn(async () =>
      prepared(error),
    );
    c._handlePostResponseBalanceUpdate = vi.fn();
    const response = await c.routeRequest(params);
    expect(await response.text()).toBe('{"error":"bad"}');
    expect(response.nodeRequestId).toBe("node-id");
    expect(response.headers.get("x-routstr-request-id")).toBe("node-id");
    expect(c._handlePostResponseBalanceUpdate).not.toHaveBeenCalled();
    expect((await driver.getTrace(response.requestId))?.request.outcome).toBe(
      "failed",
    );
  });
  it("does not terminally succeed until the client-facing SSE closes", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    const bytes = new TextEncoder().encode('data: {"id":"gen-upstream"}\n\n');
    c._prepareRoutedRequestWithMintFailover = vi.fn(async () =>
      prepared(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
    const response = await c.routeRequest(params);
    await response.finalize();
    expect((await driver.getTrace(response.requestId))?.request.outcome).toBe(
      "in_progress",
    );
    await response.text();
    expect((await driver.getTrace(response.requestId))?.request.outcome).toBe(
      "succeeded",
    );
  });
  it("marks SSE read errors failed and cancellations aborted, including finalize races", async () => {
    for (const cancel of [false, true]) {
      const driver = createMemoryRequestLifecycleDriver();
      const c = client();
      c.requestLifecycleDriver = driver;
      c._prepareRoutedRequestWithMintFailover = vi.fn(async () =>
        prepared(
          new Response(
            new ReadableStream({
              pull(controller) {
                if (!cancel) controller.error(new Error("broken"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      );
      c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
      const response = await c.routeRequest(params);
      if (cancel) await response.body.cancel();
      else await expect(response.text()).rejects.toThrow("broken");
      await response.finalize();
      const trace = await driver.getTrace(response.requestId);
      expect(trace?.request.outcome).toBe(cancel ? "aborted" : "failed");
      expect(
        trace?.events.filter((e) => e.type === "request_finished"),
      ).toHaveLength(1);
    }
  });
  it("preserves separate SDK/node IDs on thrown errors", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    c._prepareRoutedRequestWithMintFailover = vi.fn(async () => {
      throw Object.assign(new Error("failed"), { requestId: "node-failed" });
    });
    const error = await c.routeRequest(params).catch((e: Error) => e);
    expect(error.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(error.nodeRequestId).toBe("node-failed");
    expect((await driver.getTrace(error.requestId))?.request.outcome).toBe(
      "failed",
    );
  });
});

describe("transport attempt lifecycle", () => {
  it("keeps one lifecycle across 400 A -> 200 B and records external node IDs", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    c.providerManager = { recordSuccess() {} };
    c._prepareRoutedRequestWithMintFailover = async (p: any) =>
      prepared(
        await c._makeRequest({
          ...p,
          token: "secret",
          requiredSats: 0,
          headers: {},
          baseHeaders: {},
        }),
      );
    c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
    c._handleErrorResponse = async (p: any) =>
      c._makeRequest({ ...p, baseUrl: "https://b.example" });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response('{"error":{"type":"provider_error"}}', {
          status: 400,
          headers: { "x-routstr-request-id": "node-a" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "x-routstr-request-id": "node-b" } }),
      );
    try {
      const response = await c.routeRequest(params);
      const trace = await driver.getTrace(response.requestId);
      expect(trace?.request).toMatchObject({
        attemptCount: 2,
        failoverCount: 1,
        retryCount: 0,
        providerCount: 2,
        outcome: "succeeded",
      });
      expect(
        trace?.attempts.map((a) => [
          a.ordinal,
          a.httpStatus,
          a.nodeRequestId,
          a.kind,
        ]),
      ).toEqual([
        [1, 400, "node-a", "initial"],
        [2, 200, "node-b", "provider_failover"],
      ]);
      expect(trace?.attempts[0].attemptId).not.toBe(
        trace?.attempts[1].attemptId,
      );
    } finally {
      fetch.mockRestore();
    }
  });
  it("records same-provider retries and network failures without synthetic statuses", async () => {
    for (const status of [402, 413, "network"] as const) {
      const driver = createMemoryRequestLifecycleDriver();
      const lifecycle = await beginRequestLifecycle({
        driver,
        method: "POST",
        path: params.path,
      });
      const c = client();
      c.providerManager = { recordSuccess() {} };
      c._handleErrorResponse = async (p: any) =>
        c._makeRequest({ ...p, retryCount: 1 });
      const fetch = vi.spyOn(globalThis, "fetch");
      if (status === "network")
        fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      else fetch.mockResolvedValueOnce(new Response("{}", { status }));
      fetch.mockResolvedValueOnce(new Response("{}"));
      try {
        await c._makeRequest({
          ...params,
          lifecycle,
          token: "secret",
          requiredSats: 0,
          headers: {},
          baseHeaders: {},
        });
        await lifecycle.finish({ outcome: "succeeded" });
        const trace = await driver.getTrace(lifecycle.requestId);
        expect(trace?.request).toMatchObject({
          attemptCount: 2,
          retryCount: 1,
          failoverCount: 0,
        });
        expect(trace?.attempts[0].httpStatus).toBe(
          status === "network" ? undefined : status,
        );
        expect(trace?.attempts[1].kind).toBe("same_provider_retry");
      } finally {
        fetch.mockRestore();
      }
    }
  });
  it("returns provider responses even if lifecycle persistence fails", async () => {
    const memory = createMemoryRequestLifecycleDriver();
    const driver = new Proxy(memory, {
      get(target, key) {
        if (
          [
            "migrate",
            "createRequest",
            "updateRequest",
            "createAttempt",
            "appendEvent",
          ].includes(String(key))
        )
          return async () => {
            throw new Error("database unavailable");
          };
        return Reflect.get(target, key);
      },
    });
    const c = client();
    c.requestLifecycleDriver = driver;
    c._prepareRoutedRequestWithMintFailover = vi.fn(async () =>
      prepared(new Response("{}")),
    );
    c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
    expect((await c.routeRequest(params)).status).toBe(200);
  });
});

describe("preflight and usage lifecycle", () => {
  it("records rejected provider mint preflight without an HTTP attempt", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    c._prepareRoutedRequest = vi.fn(async () => {
      throw new ProviderMintBalanceError(100, 200, params.baseUrl, [
        params.mintUrl,
      ]);
    });
    await expect(
      c.routeRequest({ ...params, pinnedProvider: true }),
    ).rejects.toBeInstanceOf(ProviderMintBalanceError);
    const rows = await driver.list();
    const trace = await driver.getTrace(rows[0].requestId);
    expect(trace?.request).toMatchObject({
      outcome: "failed",
      attemptCount: 0,
      failoverCount: 0,
    });
    expect(
      trace?.events.some((e) => e.type === "preflight_funding_failed"),
    ).toBe(true);
  });
  it("writes SDK request ID into usage while preserving upstream and node correlation", async () => {
    const entries: any[] = [];
    const c = client();
    c.usageTrackingDriver = {
      append: async (entry: any) => entries.push(entry),
    };
    c.sdkStore = { getState: () => ({ clientIds: [] }) };
    const requestId = crypto.randomUUID();
    const response = Response.json(
      {
        id: "gen-upstream",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
      { headers: { "x-routstr-request-id": "node-id" } },
    );
    await c._trackResponseUsage({
      token: "SECRET",
      baseUrl: params.baseUrl,
      response,
      modelId: "model",
      satsSpent: 2,
      requestId,
    });
    expect(entries[0]).toMatchObject({
      id: requestId,
      requestId,
      nodeRequestId: "node-id",
      upstreamResponseId: "gen-upstream",
    });
    expect((response as any).upstreamResponseId).toBe("gen-upstream");
    expect(JSON.stringify(entries)).not.toContain("SECRET");
  });
  it("aborts a blocked client stream and finalizes before returning the read error", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const c = client();
    c.requestLifecycleDriver = driver;
    c._prepareRoutedRequestWithMintFailover = vi.fn(async () =>
      prepared(
        new Response(new ReadableStream({}), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
    const controller = new AbortController();
    const response = await c.routeRequest({
      ...params,
      signal: controller.signal,
    });
    const consuming = response.text();
    controller.abort();
    await expect(consuming).rejects.toMatchObject({ name: "AbortError" });
    expect((await driver.getTrace(response.requestId))?.request.outcome).toBe(
      "aborted",
    );
  });
});

it("does not count JSON serialization errors as HTTP attempts", async () => {
  const driver = createMemoryRequestLifecycleDriver();
  const lifecycle = await beginRequestLifecycle({
    driver,
    method: "POST",
    path: params.path,
  });
  const c = client();
  const body: any = {};
  body.self = body;
  await expect(
    c._makeRequest({
      ...params,
      body,
      lifecycle,
      token: "secret",
      requiredSats: 0,
      headers: {},
      baseHeaders: {},
    }),
  ).rejects.toThrow();
  await lifecycle.finish({ outcome: "failed" });
  expect(
    (await driver.getTrace(lifecycle.requestId))?.request.attemptCount,
  ).toBe(0);
});

it("detects HTTP200 SSE error envelopes even when the stream closes cleanly", async () => {
  const driver = createMemoryRequestLifecycleDriver();
  const c = client();
  c.requestLifecycleDriver = driver;
  c._prepareRoutedRequestWithMintFailover = async (p: any) =>
    c._prepareRoutedRequest(p);
  c._checkBalance = vi.fn();
  c._topUpIfNeeded = vi.fn();
  c.discoveryAdapter = {};
  c.providerManager = {
    getModelForProvider: async () => ({ id: "model" }),
    getRequiredSatsForModel: () => 0,
    recordSuccess() {},
  };
  c._spendToken = vi.fn(async () => ({
    token: "secret",
    tokenBalance: 0,
    tokenBalanceUnit: "sat",
  }));
  c._handlePostResponseBalanceUpdate = vi.fn(async () => 0);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response('data: {"error":{"message":"secret provider detail"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  try {
    const response = await c.routeRequest(params);
    await response.text();
    const trace = await driver.getTrace(response.requestId);
    expect(trace?.request.outcome).toBe("failed");
    expect(trace?.attempts[0]).toMatchObject({
      outcome: "stream_error",
      failurePhase: "stream",
      httpStatus: 200,
    });
    expect(JSON.stringify(trace)).not.toContain("secret provider detail");
  } finally {
    fetch.mockRestore();
  }
});
