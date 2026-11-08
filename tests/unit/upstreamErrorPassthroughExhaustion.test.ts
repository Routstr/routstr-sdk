import { createMemoryRequestLifecycleDriver } from "../../storage/requestLifecycle";
/**
 * Exhausted failover aggregates diagnostic entries across all attempts and
 * classifies status from the entire chain. Credentials are removed from
 * messages without damaging caller-visible diagnostics or machine labels.
 * Typed node-authentication, wallet and pinned-path errors retain precedence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { FailoverError, MintError, TokenAlreadySpentError } from "../../core/errors";
import type { SdkLogger, Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://first.example/";
const nextUrl = "https://second.example/";
const mintUrl = "https://mint.example/";
const credential = "sk-test-key";

const model = {
  id: "test-model",
  name: "Test Model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

function setup() {
  const logger: SdkLogger = {
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    },
  };
  const wallet = {
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl,
    sendToken: async () => credential,
    receiveToken: async () => ({ success: false, message: "no refund" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl, balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  // Two providers, then nothing left: the chain ends inside _handleErrorResponse.
  let nextCalls = 0;
  const findNextBestProvider = vi.fn(() => {
    nextCalls += 1;
    return nextCalls === 1 ? nextUrl : null;
  });
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([baseUrl, nextUrl]),
    findNextBestProvider,
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(
    wallet,
    storage,
    {} as DiscoveryAdapter,
    "max",
    "apikeys",
    { providerManager: providerManager as any, logger }
  );
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: credential,
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const balanceManager = client.getBalanceManager();
  vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
    amount: 399_000,
    reserved: 0,
    unit: "msat",
    apiKey: credential,
  });
  vi.spyOn(balanceManager, "refundApiKey").mockResolvedValue({
    success: true,
    message: "refunded",
    amount: 399,
  } as any);
  vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
  return { client, providerManager };
}

/** Distinguishable per-provider bodies expose both entries in the aggregate. */
function providerBody(name: string, type = "upstream_error") {
  return JSON.stringify({
    error: { type, message: `${name} says no`, code: 503 },
  });
}

function stubFetchByProvider(
  responses: Record<string, { status: number; statusText: string; body: string; requestId: string; headers?: Record<string, string> }>
) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const key = Object.keys(responses).find((k) => String(url).startsWith(k));
    if (!key) throw new Error(`unexpected fetch to ${String(url)}`);
    const spec = responses[key];
    return new Response(spec.body, {
      status: spec.status,
      statusText: spec.statusText,
      headers: {
        "content-type": "application/json",
        "x-routstr-request-id": spec.requestId,
        ...spec.headers,
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function routeRequest(client: RoutstrClient) {
  return client.routeRequest({
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: model.id, messages: [] },
    baseUrl,
    mintUrl,
    modelId: model.id,
    headers: {},
  });
}

describe("failover exhaustion aggregates diagnostics across the chain", () => {
  it("records real 400 failover recursion then 200 under a single SDK ID", async () => {
    const { client, providerManager } = setup();
    (providerManager as any).recordSuccess = vi.fn();
    const driver = createMemoryRequestLifecycleDriver();
    (client as any).requestLifecycleDriver = driver;
    stubFetchByProvider({
      [baseUrl]: { status: 400, statusText: "Bad Request", body: providerBody("A", "provider_error"), requestId: "node-A" },
      [nextUrl]: { status: 200, statusText: "OK", body: "{}", requestId: "node-B" },
    });
    const response = await routeRequest(client);
    const trace = await driver.getTrace(response.requestId!);
    expect(trace?.request).toMatchObject({ outcome: "succeeded", attemptCount: 2, failoverCount: 1, retryCount: 0 });
    expect(trace?.attempts.map(a => [a.httpStatus, a.nodeRequestId, a.kind])).toEqual([[400, "node-A", "initial"], [200, "node-B", "provider_failover"]]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns both diagnostics with the uniform 503 status", async () => {
    const { client, providerManager } = setup();
    const fetchMock = stubFetchByProvider({
      [baseUrl]: {
        status: 503,
        statusText: "Service Unavailable",
        body: providerBody("first-node"),
        requestId: "req-first",
      },
      [nextUrl]: {
        status: 503,
        statusText: "Service Unavailable",
        body: providerBody("second-node"),
        requestId: "req-second",
      },
    });

    const response = await routeRequest(client);

    // Both nodes were tried and cooled down before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      nextUrl,
      expect.stringContaining("status=503"),
      model.id,
      undefined
    );
    expect(providerManager.findNextBestProvider).toHaveBeenCalledTimes(2);

    // Uniform status is preserved; diagnostics from both nodes are retained.
    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Service Unavailable");
    expect((response as any).passthrough).toBe(true);
    expect(response.headers.get("x-routstr-request-id")).toBe("req-second");
    expect((await response.json()).error.errors.map((error: any) => error.message)).toEqual([
      "first-node says no", "second-node says no",
    ]);
  });

  it("preserves the smallest retry-after for homogeneous 429 exhaustion", async () => {
    const { client } = setup();
    stubFetchByProvider({
      [baseUrl]: {
        status: 429,
        statusText: "Too Many Requests",
        body: providerBody("first-node"),
        requestId: "req-first",
        headers: { "retry-after": "30" },
      },
      [nextUrl]: {
        status: 429,
        statusText: "Too Many Requests",
        body: providerBody("second-node"),
        requestId: "req-second",
        headers: { "retry-after": "60" },
      },
    });

    const response = await routeRequest(client);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect((await response.json()).error.errors.map((error: any) => error.message)).toEqual([
      "first-node says no", "second-node says no",
    ]);
  });

  it.each([
    { name: "date before numeric", first: "Thu, 01 Jan 2026 00:00:20 GMT", last: "60", expected: "20" },
    { name: "numeric before date", first: "30", last: "Thu, 01 Jan 2026 00:01:00 GMT", expected: "30" },
    { name: "earlier of two dates", first: "Thu, 01 Jan 2026 00:01:00 GMT", last: "Thu, 01 Jan 2026 00:00:30 GMT", expected: "30" },
    { name: "malformed first value", first: "not-a-delay", last: "60", expected: "60" },
    { name: "malformed last value", first: "30", last: "-1", expected: "30" },
    { name: "no valid value", first: "not-a-delay", last: "-1", expected: null },
    { name: "decimal delay ignored", first: "1.5", last: "60", expected: "60" },
    { name: "Infinity ignored", first: "Infinity", last: "60", expected: "60" },
    { name: "overflow delay ignored", first: "9".repeat(400), last: "60", expected: "60" },
    { name: "past HTTP date", first: "Wed, 31 Dec 2025 23:59:00 GMT", last: "60", expected: "0" },
    { name: "invalid calendar date ignored", first: "Mon, 30 Feb 2026 00:00:00 GMT", last: "60", expected: "60" },
    { name: "RFC 850 date", first: "Thursday, 01-Jan-26 00:00:20 GMT", last: "60", expected: "20" },
    { name: "asctime date", first: "Thu Jan  1 00:00:20 2026", last: "60", expected: "20" },
  ])("uses valid retry-after delays for homogeneous 429: $name", async ({ first, last, expected }) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    const { client } = setup();
    stubFetchByProvider({
      [baseUrl]: { status: 429, statusText: "Too Many Requests", body: providerBody("first"), requestId: "first", headers: { "retry-after": first } },
      [nextUrl]: { status: 429, statusText: "Too Many Requests", body: providerBody("last"), requestId: "last", headers: { "retry-after": last } },
    });
    const response = await routeRequest(client);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(expected);
  });

  it("omits retry-after when neither 429 attempt supplied it", async () => {
    const { client } = setup();
    stubFetchByProvider({
      [baseUrl]: { status: 429, statusText: "Too Many Requests", body: providerBody("first"), requestId: "first" },
      [nextUrl]: { status: 429, statusText: "Too Many Requests", body: providerBody("last"), requestId: "last" },
    });
    const response = await routeRequest(client);
    expect(response.status).toBe(429);
    expect(response.headers.has("retry-after")).toBe(false);
  });

  it.each([[10, "20"], [40, "0"]])("subtracts %i elapsed seconds from the first numeric retry deadline", async (elapsed, expected) => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { client } = setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const first = String(url).startsWith(baseUrl);
      if (!first) now += elapsed * 1000;
      return Response.json({ error: { type: "upstream_error", message: first ? "first" : "last" } }, {
        status: 429, headers: { "retry-after": first ? "30" : "60" },
      });
    }));
    const response = await routeRequest(client);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(expected);
  });

  it.each([[429, 400], [400, 429], [429, 503]])("omits retry-after for a mixed %i then %i chain", async (first, last) => {
    const { client } = setup();
    stubFetchByProvider({
      [baseUrl]: { status: first, statusText: "Failure", body: providerBody("first"), requestId: "first", headers: { "retry-after": "30" } },
      [nextUrl]: { status: last, statusText: "Failure", body: providerBody("last"), requestId: "last", headers: { "retry-after": "60" } },
    });
    const response = await routeRequest(client);
    expect(response.status).toBe(502);
    expect(response.headers.has("retry-after")).toBe(false);
  });

  it("returns a 502 aggregate when network failures exhaust the chain", async () => {
    const { client } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const response = await routeRequest(client);
    expect(response.status).toBe(502);
    expect((await response.json()).error.errors[0].status).toBe(-1);
  });

  it.each([[503, 400], [400, 503], [429, 400], [402, 400], [401, 400], [424, 422]])(
    "does not misclassify mixed %i then %i as a caller error", async (first, last) => {
      const { client } = setup();
      stubFetchByProvider({
        [baseUrl]: { status: first, statusText: "Failure", body: providerBody("first"), requestId: "first" },
        [nextUrl]: { status: last, statusText: "Failure", body: providerBody("last"), requestId: "last" },
      });
      const response = await routeRequest(client);
      expect(response.status).toBe(502);
      expect((await response.json()).error.errors.map((e: any) => e.status)).toEqual([first, last]);
    }
  );

  it.each([[400, 422, 400], [422, 400, 400], [422, 422, 422], [401, 401, 502], [403, 403, 502], [503, 502, 502], [424, 424, 424]])(
    "uses deterministic status for %i then %i", async (first, last, expected) => {
      const { client } = setup();
      stubFetchByProvider({
        [baseUrl]: { status: first, statusText: "Failure", body: providerBody("first"), requestId: "first" },
        [nextUrl]: { status: last, statusText: "Failure", body: providerBody("last"), requestId: "last" },
      });
      const response = await routeRequest(client);
      expect(response.status).toBe(expected);
    }
  );

  it("redacts credentials from messages only, preserving labels, docs and safe headers", async () => {
    const { client } = setup();
    const type = "invalid_request_error";
    const code = "invalid_type";
    const documentation = "https://docs.example.com/models";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      type, code,
      message: `Invalid model. See ${documentation}; cashuBprivateproof; Bearer privatekey\n${credential}`,
      refund_token: "cashuBrefund",
    } }, { status: 400, headers: {
      "set-cookie": "secret", authorization: "Bearer privatekey", "retry-after": "123",
      "x-routstr-provider": "https://internal.invalid", "x-routstr-request-id": "node-id",
    } })));
    const response = await client.routeRequest({ path: "/v1/chat/completions", method: "POST",
      body: { model: model.id, messages: [{ content: "a" }, { content: "no" }] },
      baseUrl, mintUrl, modelId: model.id, headers: {} });
    const result = await response.json();
    expect(result.error.errors[0]).toMatchObject({
      type, code, message: `Invalid model. See ${documentation}; [REDACTED]; [REDACTED]\n[REDACTED]`,
    });
    expect(JSON.stringify(result)).not.toMatch(/privateproof|privatekey|sk-test-key|refund_token/);
    for (const name of ["set-cookie", "authorization", "retry-after", "x-routstr-provider"]) {
      expect(response.headers.has(name)).toBe(false);
    }
    expect(response.headers.get("x-routstr-request-id")).toBe("node-id");
  });

  it.each([
    { name: "short chat replies", fields: { messages: ["no", "a", "ok", "y"].map(content => ({ content })) }, message: "max_tokens: value is not a valid integer" },
    { name: "duplicate short input", fields: { messages: Array.from({ length: 20 }, () => ({ content: "E" })) }, message: "Expected number" },
    { name: "completions and Responses fields", fields: { prompt: "private completion prompt", instructions: "private responses instructions" }, message: "private completion prompt; private responses instructions" },
    { name: "overlapping inputs", fields: { input: ["abcd", "bcdef", "a", "abcd"] }, message: "abcdef" },
  ])("does not redact caller input from diagnostics: $name", async ({ fields, message }) => {
    const { client } = setup();
    const type = "invalid_request_error";
    const code = "invalid_type";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { type, code, message } }, { status: 400 })));
    const response = await client.routeRequest({ path: "/v1/chat/completions", method: "POST",
      body: { model: model.id, ...fields }, baseUrl, mintUrl, modelId: model.id, headers: {} });
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error.message).toBe(message);
    expect(result.error.errors[0]).toMatchObject({ type, code, message });
  });

  it.each([
    { name: "more than 512 strings", input: Array.from({ length: 600 }, (_, i) => `input-${i}`) },
    { name: "more than 64 KiB of input", input: "a".repeat(65537) },
  ])("preserves context-length diagnostics for $name", async ({ input }) => {
    const { client } = setup();
    const error = { type: "invalid_request_error", code: "context_length_exceeded", message: "context length exceeded" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error }, { status: 400 })));
    const response = await client.routeRequest({ path: "/v1/responses", method: "POST",
      body: { model: model.id, instructions: "instructions", input }, baseUrl, mintUrl, modelId: model.id, headers: {} });
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error.message).toBe(error.message);
    expect(result.error.errors[0]).toMatchObject(error);
  });

  it("never redacts machine-readable type or code, even when they contain credential-like text", async () => {
    const { client } = setup();
    const error = {
      type: "cashuBmachine_label", code: credential,
      message: `cashuBprivateproof; Bearer privatekey\n${credential}`,
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error }, { status: 400 })));
    const response = await routeRequest(client);
    expect((await response.json()).error.errors[0]).toMatchObject({
      type: error.type, code: error.code, message: "[REDACTED]; [REDACTED]\n[REDACTED]",
    });
  });

  it("preserves useful validation details without retrying the same node", async () => {
    const { client } = setup();
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "temperature: expected number", code: "invalid_type" } });
    const fetch = stubFetchByProvider({
      [baseUrl]: { status: 400, statusText: "Bad Request", body, requestId: "first" },
      [nextUrl]: { status: 400, statusText: "Bad Request", body, requestId: "last" },
    });
    const response = await routeRequest(client);
    expect(response.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await response.json()).error.errors[0]).toMatchObject({ status: 400, code: "invalid_type", message: "temperature: expected number" });
  });

  it("still throws TokenAlreadySpentError at exhaustion", async () => {
    const { client } = setup();
    const body = JSON.stringify({
      error: {
        type: "token_already_spent",
        code: "cashu_token_already_spent",
        message: "Token has already been spent",
      },
    });
    stubFetchByProvider({
      [baseUrl]: {
        status: 400,
        statusText: "Bad Request",
        body,
        requestId: "req-first",
      },
      [nextUrl]: {
        status: 400,
        statusText: "Bad Request",
        body,
        requestId: "req-second",
      },
    });

    await expect(routeRequest(client)).rejects.toBeInstanceOf(
      TokenAlreadySpentError
    );
  });

  it("still throws MintError at exhaustion", async () => {
    const { client } = setup();
    const body = JSON.stringify({
      error: {
        type: "mint_error",
        code: "cashu_foreign_mint_swap_failed",
        message: "Mint refused the swap",
      },
    });
    stubFetchByProvider({
      [baseUrl]: {
        status: 422,
        statusText: "Unprocessable Entity",
        body,
        requestId: "req-first",
      },
      [nextUrl]: {
        status: 422,
        statusText: "Unprocessable Entity",
        body,
        requestId: "req-second",
      },
    });

    await expect(routeRequest(client)).rejects.toBeInstanceOf(MintError);
  });

  it("keeps a caller-pinned 404 typed: invalid_model_path is not forwarded", async () => {
    const { client } = setup();
    const body = JSON.stringify({
      error: {
        type: "invalid_model_path",
        message: "selector is not valid on this node",
      },
    });
    stubFetchByProvider({
      [baseUrl]: {
        status: 404,
        statusText: "Not Found",
        body,
        requestId: "req-first",
      },
      [nextUrl]: {
        status: 404,
        statusText: "Not Found",
        body,
        requestId: "req-second",
      },
    });

    await expect(routeRequest(client)).rejects.toBeInstanceOf(FailoverError);
  });

  it.each([401, 403].flatMap(status =>
    ["invalid_api_key", "key_expired", "unauthorized", "send_token_failed", "key_not_found"].map(code => ({ status, code }))
  ))("keeps node authentication $status/$code as FailoverError", async ({ status, code }) => {
    const { client } = setup();
    const body = JSON.stringify({ error: { type: "invalid_request_error", code, message: "Node rejected SDK credentials" } });
    stubFetchByProvider({
      [baseUrl]: { status, statusText: "Rejected", body, requestId: "first" },
      [nextUrl]: { status, statusText: "Rejected", body, requestId: "last" },
    });
    await expect(routeRequest(client)).rejects.toBeInstanceOf(FailoverError);
  });

  it.each([401, 403])("keeps explicitly node-scoped %i as FailoverError", async status => {
    const { client } = setup();
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "Node rejected credentials" } });
    stubFetchByProvider({
      [baseUrl]: { status, statusText: "Rejected", body, requestId: "first", headers: { "x-routstr-error-scope": "node" } },
      [nextUrl]: { status, statusText: "Rejected", body, requestId: "last", headers: { "x-routstr-error-scope": "node" } },
    });
    await expect(routeRequest(client)).rejects.toBeInstanceOf(FailoverError);
  });

  it.each([401, 403])("keeps explicitly upstream-scoped %i as a 502 aggregate", async status => {
    const { client } = setup();
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "Provider rejected credentials" } });
    stubFetchByProvider({
      [baseUrl]: { status, statusText: "Rejected", body, requestId: "first", headers: { "x-routstr-error-scope": "upstream" } },
      [nextUrl]: { status, statusText: "Rejected", body, requestId: "last", headers: { "x-routstr-error-scope": "upstream" } },
    });
    const response = await routeRequest(client);
    expect(response.status).toBe(502);
    expect((await response.json()).error.errors[0]).toMatchObject({ status, type: "invalid_request_error" });
  });

  it.each([401, 403])("lets explicit upstream scope override invalid_api_key on %i", async status => {
    const { client } = setup();
    const body = JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key", message: "Provider rejected credentials" } });
    stubFetchByProvider({
      [baseUrl]: { status, statusText: "Rejected", body, requestId: "first", headers: { "x-routstr-error-scope": "upstream" } },
      [nextUrl]: { status, statusText: "Rejected", body, requestId: "last", headers: { "x-routstr-error-scope": "upstream" } },
    });
    const response = await routeRequest(client);
    expect(response.status).toBe(502);
    expect((await response.json()).error.errors[0]).toMatchObject({ status, code: "invalid_api_key" });
  });

  it("treats upstream account quota exhaustion as infrastructure, not caller payment", async () => {
    const { client } = setup();
    const body = JSON.stringify({
      error: {
        type: "upstream_error",
        code: 402,
        message: "Provider account has insufficient credits",
      },
    });
    stubFetchByProvider({
      [baseUrl]: {
        status: 402,
        statusText: "Payment Required",
        body,
        requestId: "req-first",
      },
      [nextUrl]: {
        status: 402,
        statusText: "Payment Required",
        body,
        requestId: "req-second",
      },
    });

    const response = await routeRequest(client);
    expect(response.status).toBe(502);
    expect((await response.json()).error.errors[0].status).toBe(402);
  });
});
