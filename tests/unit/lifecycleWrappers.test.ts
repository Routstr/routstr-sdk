import { describe, expect, it, vi } from "vitest";
import { routeRequests } from "../../routeRequests";
import { fetchAIResponse } from "../../client/fetchAIResponse";
import {
  beginRequestLifecycle,
  createMemoryRequestLifecycleDriver,
} from "../../storage/requestLifecycle";

vi.mock("../../client/resolveRequestContext", () => ({
  resolveRequestContext: vi.fn(async () => {
    throw new Error("discovery unavailable");
  }),
}));

const logger: any = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
};
const callbacks = () => ({
  onRequestId: vi.fn(),
  onMessageAppend: vi.fn(),
  onStreamingUpdate: vi.fn(),
  onThinkingUpdate: vi.fn(),
  onPaymentProcessing: vi.fn(),
});

describe("lifecycle wrapper boundaries", () => {
  it("records discovery failure before routeRequests resolves context", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    await expect(
      routeRequests({
        modelId: "model",
        requestBody: {},
        walletAdapter: {} as any,
        storageAdapter: {} as any,
        discoveryAdapter: {} as any,
        requestLifecycleDriver: driver,
        logger,
      }),
    ).rejects.toMatchObject({
      message: "discovery unavailable",
      requestId: expect.any(String),
    });
    const rows = await driver.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestedModelId: "model",
      outcome: "failed",
      attemptCount: 0,
    });
  });

  it("uses the configured driver of a prebuilt client before discovery", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const client = { getRequestLifecycleDriver: () => driver } as any;
    await expect(
      routeRequests({
        modelId: "model",
        requestBody: {},
        client,
        walletAdapter: {} as any,
        storageAdapter: {} as any,
        discoveryAdapter: {} as any,
      }),
    ).rejects.toThrow();
    expect(await driver.list()).toHaveLength(1);
  });

  it("does not create rows for opted-out metadata calls", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    await expect(
      routeRequests({
        modelId: "model",
        path: "/v1/models",
        requestBody: {},
        walletAdapter: {} as any,
        storageAdapter: {} as any,
        discoveryAdapter: {} as any,
        requestLifecycleDriver: driver,
      }),
    ).rejects.toThrow();
    expect(await driver.list()).toHaveLength(0);
  });

  it("finishes an ingress-created lifecycle on discovery rejection", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const lifecycle = await beginRequestLifecycle({
      driver,
      method: "POST",
      path: "/v1/responses",
      clientId: "alice",
    });
    await expect(
      routeRequests({
        modelId: "model",
        lifecycle,
        requestBody: {},
        walletAdapter: {} as any,
        storageAdapter: {} as any,
        discoveryAdapter: {} as any,
      }),
    ).rejects.toMatchObject({ requestId: lifecycle.requestId });
    expect((await driver.getTrace(lifecycle.requestId))?.request).toMatchObject(
      { clientId: "alice", outcome: "failed" },
    );
  });

  it("fetchAIResponse reports its SDK ID exactly once on discovery failure", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const cb = callbacks();
    await fetchAIResponse(
      { messageHistory: [], modelId: "model", requestLifecycleDriver: driver },
      cb as any,
      { alertLevel: "none" as any, logger },
    );
    const [row] = await driver.list();
    expect(row.outcome).toBe("failed");
    expect(cb.onRequestId).toHaveBeenCalledExactlyOnceWith(row.requestId);
  });

  it("fetchAIResponse preserves request-local contexts under concurrency", async () => {
    const driver = createMemoryRequestLifecycleDriver();
    const first = callbacks();
    const second = callbacks();
    await Promise.all(
      [first, second].map((cb) =>
        fetchAIResponse(
          {
            messageHistory: [],
            modelId: "model",
            requestLifecycleDriver: driver,
          },
          cb as any,
          { alertLevel: "none" as any, logger },
        ),
      ),
    );
    expect(await driver.list()).toHaveLength(2);
    expect(first.onRequestId.mock.calls[0][0]).not.toBe(
      second.onRequestId.mock.calls[0][0],
    );
  });
});

describe("abort-aware discovery wait", () => {
  it("stops awaiting a stalled operation and removes its listener", async () => {
    const { awaitWithAbort } = await import("../../client/abortable");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = awaitWithAbort(
      new Promise<never>(() => {}),
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
