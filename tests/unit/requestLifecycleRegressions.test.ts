import { it, expect, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { beginRequestLifecycle, createMemoryRequestLifecycleDriver } from "../../storage/requestLifecycle";

const params = {
  path: "/v1/chat/completions", method: "POST",
  baseUrl: "https://a.example", mintUrl: "https://mint.example",
  modelId: "model", body: { model: "model" }, trackLifecycle: false,
};
function client() {
  const c: any = Object.create(RoutstrClient.prototype);
  c.mode = "apikeys";
  c.logger = { error() {}, log() {}, warn() {} };
  return c;
}

it.each(["opted-out POST", "ineligible GET"])("%s retains caller abort after headers", async (kind) => {
  const c = client();
  c._routeRequest = vi.fn(async (p: any) => new Response(new ReadableStream({
    start(controller) {
      p.signal.addEventListener("abort", () => controller.error(new DOMException("Request aborted", "AbortError")), { once: true });
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const ac = new AbortController();
  const response = await c.routeRequest({ ...params, method: kind === "ineligible GET" ? "GET" : "POST", trackLifecycle: kind === "ineligible GET", signal: ac.signal });
  const reading = response.body.getReader().read();
  ac.abort();
  expect(c._routeRequest.mock.calls[0][0].signal.aborted).toBe(true);
  await expect(reading).rejects.toMatchObject({ name: "AbortError" });
});

it.each([false, true])("opted-out JSON preserves upstream IDs (pre-inspected: %s)", async (inspected) => {
  const c = client();
  const rows: any[] = [];
  c.usageTrackingDriver = { append: async (entry: any) => { rows.push(entry); } };
  c.sdkStore = { getState: () => ({ clientIds: [] }) };
  c._prepareRoutedRequestWithMintFailover = async () => ({
    response: new Response(JSON.stringify({ id: "gen-123", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), { headers: { "content-type": "application/json" } }),
    tokenUsed: "token", baseUrlUsed: params.baseUrl, modelId: "model",
    usagePromise: Promise.resolve(inspected ? { capturedResponseId: "gen-123" } : {}),
  });
  c._handlePostResponseBalanceUpdate = async (p: any) => { await c._trackResponseUsage({ ...p, satsSpent: 0 }); return 0; };
  const response = await c.routeRequest(params);
  expect(response.requestId).toBe("gen-123");
  expect(rows[0]).toMatchObject({ id: "gen-123", requestId: "gen-123", upstreamResponseId: "gen-123" });
});

it.each(["updateAttempt", "updateRequest"] as const)("terminal writes continue after %s failure", async (operation) => {
  const driver = createMemoryRequestLifecycleDriver();
  const lifecycle = await beginRequestLifecycle({ driver, method: "POST", path: "/v1/chat/completions", logger: { error: vi.fn() } as any });
  await lifecycle.beginAttempt({ baseUrl: params.baseUrl });
  vi.spyOn(driver, operation).mockRejectedValueOnce(new Error("storage unavailable"));
  await lifecycle.finish({ outcome: "succeeded" });
  await lifecycle.finish({ outcome: "failed" });
  const trace = (await driver.getTrace(lifecycle.requestId))!;
  expect(lifecycle.trackingErrors).toHaveLength(1);
  expect(trace.events.filter((event) => event.type === "request_finished")).toHaveLength(1);
  if (operation === "updateAttempt") expect(trace.request.outcome).toBe("succeeded");
  else expect(trace.attempts[0].outcome).toBe("succeeded");
});
