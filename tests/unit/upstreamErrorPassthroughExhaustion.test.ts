/**
 * L3: forward the last upstream envelope at failover exhaustion.
 *
 * Once L2 short-circuits request errors, anything that reaches the end of
 * `_handleErrorResponse` is a provider/infrastructure failure (5xx, 424, 429,
 * network). Previously that end always threw `FailoverError`, which routstrd maps
 * to a 500 — so the last node's real complaint was replaced by
 * "All providers failed". These tests pin the new forwarding, and the typed-error
 * guard rails that must survive it.
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

/** Distinguishable per-provider bodies so "last envelope" is provable. */
function providerBody(name: string, type = "upstream_error") {
  return JSON.stringify({
    error: { type, message: `${name} says no`, code: 503 },
  });
}

function stubFetchByProvider(
  responses: Record<string, { status: number; statusText: string; body: string; requestId: string }>
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

describe("L3 failover exhaustion forwards the last envelope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns both diagnostics with the last provider's 503 status", async () => {
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

    // The LAST node's answer reaches the caller intact.
    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Service Unavailable");
    expect((response as any).passthrough).toBe(true);
    expect(response.headers.get("x-routstr-request-id")).toBe("req-second");
    expect((await response.json()).error.errors.map((error: any) => error.message)).toEqual([
      "first-node says no", "second-node says no",
    ]);
  });

  it("forwards a 429 envelope at exhaustion", async () => {
    const { client } = setup();
    stubFetchByProvider({
      [baseUrl]: {
        status: 429,
        statusText: "Too Many Requests",
        body: providerBody("first-node"),
        requestId: "req-first",
      },
      [nextUrl]: {
        status: 429,
        statusText: "Too Many Requests",
        body: providerBody("second-node"),
        requestId: "req-second",
      },
    });

    const response = await routeRequest(client);

    expect(response.status).toBe(429);
    expect((await response.json()).error.errors.map((error: any) => error.message)).toEqual([
      "first-node says no", "second-node says no",
    ]);
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

  it("keeps 402 typed: a payment failure is not forwarded as a passthrough", async () => {
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

    await expect(routeRequest(client)).rejects.toBeInstanceOf(FailoverError);
  });
});
