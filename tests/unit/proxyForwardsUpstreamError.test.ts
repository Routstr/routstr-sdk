/**
 * L4: routeRequests must hand a provider's error response to the proxy.
 *
 * `routeRequests` used to flatten any non-ok response into
 * `Error("400 Bad Request")`, so routstrd's 500 handler replaced the node's own
 * envelope with `{"error":"All providers failed. ..."}`. This file covers the
 * change itself plus the workstream's end-to-end acceptance test: the original
 * customer-visible bug (a `web_search_options` rejection) must now reach the
 * caller as a 400 carrying the upstream's real complaint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import type { RoutstrClient } from "../../client/RoutstrClient";
import type { Model } from "../../core/types";
import type { SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

// routeRequests() resolves its provider context through resolveRequestContext;
// mock it so these tests exercise the real client + real routeRequests seam.
vi.mock("../../client/resolveRequestContext", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../client/resolveRequestContext")>();
  return {
    ...original,
    resolveRequestContext: vi.fn(original.resolveRequestContext),
  };
});
import { routeRequests } from "../../routeRequests";
import { RoutstrClient as RoutstrClientImpl } from "../../client/RoutstrClient";
import { FailoverError, InsufficientBalanceError } from "../../core/errors";

const baseUrl = "https://first.example/";
const mintUrl = "https://mint.example/";
const credential = "sk-test-key";

const model = {
  id: "test-model",
  name: "Test Model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

/** The exact production body from the bug report. */
const upstreamBody = JSON.stringify({
  error: {
    message:
      "Upstream error via litellm: litellm.BadRequestError: OpenAIException - Error code: 400 - {'details': {'_errors': [\"Unrecognized key(s) in object: 'web_search_options'\"]}, 'error': 'Invalid request parameters'}",
    type: "upstream_error",
    code: 400,
  },
  request_id: "04aee611-2e54-4151-8be4-4ef6c7e9523b",
});

function makeClient() {
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
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([baseUrl]),
    findNextBestProvider: vi.fn(() => null),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClientImpl(
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
  return client;
}

/** Route through the public entrypoint with the context resolver stubbed. */
async function routeThroughProxy(
  client: RoutstrClientImpl,
  body: unknown = {},
  path = "/v1/chat/completions"
) {
  vi.mocked(resolveRequestContext).mockResolvedValueOnce({
    client,
    baseUrl,
    mintUrl,
    selectedModel: model,
  } as never);

  return routeRequests({
    modelId: model.id,
    path,
    requestBody: body,
    walletAdapter: {} as never,
    storageAdapter: {} as never,
    discoveryAdapter: {} as never,
  });
}

describe("L4 routeRequests forwards a provider error response", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the node's 400 instead of throwing a flattened error", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(upstreamBody, {
          status: 400,
          statusText: "Bad Request",
          headers: {
            "content-type": "application/json",
            "x-routstr-request-id": "04aee611-2e54-4151-8be4-4ef6c7e9523b",
          },
        })
      )
    );

    const response = await routeThroughProxy(client);

    expect(response.status).toBe(400);
    expect(response.statusText).toBe("Bad Request");
    expect(response.headers.get("x-routstr-request-id")).toBe(
      "04aee611-2e54-4151-8be4-4ef6c7e9523b"
    );
    expect((response as any).passthrough).toBe(true);
  });

  it("still propagates InsufficientBalanceError so routstrd can map a 402", async () => {
    const client = makeClient();
    vi.spyOn(client, "routeRequest").mockRejectedValue(
      new InsufficientBalanceError(100, 20)
    );

    await expect(routeThroughProxy(client)).rejects.toBeInstanceOf(
      InsufficientBalanceError
    );
  });

  it("still propagates failover exhaustion errors", async () => {
    const client = makeClient();
    vi.spyOn(client, "routeRequest").mockRejectedValue(
      new FailoverError(baseUrl, [baseUrl])
    );

    await expect(routeThroughProxy(client)).rejects.toBeInstanceOf(
      FailoverError
    );
  });
});

describe("acceptance: the web_search_options bug is fixed end to end", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("the client receives a 400 explaining the real upstream complaint", async () => {
    const client = makeClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(upstreamBody, {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        })
      )
    );

    // Exactly the request in the bug report: Anthropic-format /v1/messages with
    // an OpenAI-only field the upstream refuses.
    const response = await routeThroughProxy(client, {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      web_search_options: {},
    }, "/v1/messages");

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${baseUrl}v1/messages`,
      expect.objectContaining({ method: "POST" })
    );

    // Before L1-L4 this was a 500 with
    // {"error":"All providers failed. Original: https://routstr.cypherpunk.today/, Failed: ..."}
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain(
      "Unrecognized key(s) in object: 'web_search_options'"
    );
    expect(text).not.toContain("All providers failed");
  });
});
