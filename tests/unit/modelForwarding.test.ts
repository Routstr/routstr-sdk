/**
 * Upstream model-id forwarding for statically mapped models.
 *
 * When selection resolves through MODEL_ID_MAPPINGS (e.g. a request for
 * canonical "glm-5.3" routed to a provider serving "z-ai-glm-5-3"), the
 * request body sent upstream must carry the provider-native id — mapped
 * providers only know their own id. Covers:
 *
 * - RoutstrClient generic request path rewrites body.model to the
 *   provider-native id.
 * - Bodies without a string `model` field are left untouched.
 * - Failover retries rewrite body.model to the failover provider's native id.
 * - resolveRequestContext honors mappings for forced providers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const makeModel = (overrides?: Partial<Model>): Model =>
  ({
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
    ...overrides,
  } as Model);

const createDiscovery = (
  overrides?: Partial<DiscoveryAdapter>
): DiscoveryAdapter => ({
  getCachedModels: () => ({}),
  setCachedModels: () => {},
  getCachedMints: () => ({}),
  setCachedMints: () => {},
  getCachedProviderInfo: () => ({}),
  setCachedProviderInfo: () => {},
  getProviderLastUpdate: () => null,
  setProviderLastUpdate: () => {},
  getLastUsedModel: () => null,
  setLastUsedModel: () => {},
  getDisabledProviders: () => [],
  setDisabledProviders: () => {},
  getBaseUrlsList: () => [],
  getBaseUrlsLastUpdate: () => null,
  setBaseUrlsList: () => {},
  setBaseUrlsLastUpdate: () => {},
  getRoutstr21Models: () => [],
  setRoutstr21Models: () => {},
  getRoutstr21ModelsLastUpdate: () => null,
  setRoutstr21ModelsLastUpdate: () => {},
  ...overrides,
});

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  ...overrides,
});

const createStorage = (overrides?: Partial<StorageAdapter>): StorageAdapter =>
  ({
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: () => {},
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    getApiKeyDistribution: () => [],
    removeApiKey: () => {},
    saveProviderInfo: () => {},
    getProviderInfo: () => null,
    getApiKey: () => null,
    setApiKey: () => {},
    updateApiKeyBalance: () => {},
    touchApiKeyLastUsed: () => {},
    getAllApiKeys: () => [],
    getChildKey: () => null,
    setChildKey: () => {},
    updateChildKeyBalance: () => {},
    removeChildKey: () => {},
    getAllChildKeys: () => [],
    getCachedReceiveTokens: () => [],
    setCachedReceiveTokens: () => [],
    ...overrides,
  } as StorageAdapter);

// ---------------------------------------------------------------------------
// RoutstrClient generic request path
// ---------------------------------------------------------------------------

/** Run request preparation up to the transport boundary, without wallet spend. */
async function prepareRequest(opts: {
  body: unknown;
  modelId: string;
  providerModel: Model | null;
}) {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = "xcashu";
  client._checkBalance = vi.fn().mockResolvedValue(undefined);
  client._log = vi.fn();
  client.providerManager = {
    getModelForProvider: vi.fn().mockResolvedValue(opts.providerModel),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  client._spendToken = vi.fn().mockResolvedValue({
    token: "sdk-payment",
    tokenBalance: 1,
    tokenBalanceUnit: "sat",
  });
  client._spinOffTopupIfNeeded = vi.fn();
  const stop = new Error("transport boundary reached");
  client._makeRequest = vi.fn().mockRejectedValue(stop);
  await expect(
    client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: opts.body,
      modelId: opts.modelId,
      baseUrl: "https://core.example/",
      mintUrl: "https://mint.example/",
      clientApiKey: "local-client",
      headers: {},
    })
  ).rejects.toBe(stop);
  expect(client._makeRequest).toHaveBeenCalledOnce();
  return client._makeRequest.mock.calls[0][0] as { body: unknown };
}

describe("RoutstrClient upstream model forwarding", () => {
  it("rewrites body.model to the provider-native id for mapped models", async () => {
    const request = await prepareRequest({
      body: { model: "glm-5.3", messages: [] },
      modelId: "glm-5.3",
      providerModel: makeModel({ id: "z-ai-glm-5-3" }),
    });
    expect((request.body as any).model).toBe("z-ai-glm-5-3");
  });

  it("keeps body.model when it already matches the provider-native id", async () => {
    const request = await prepareRequest({
      body: { model: "glm-5.3", messages: [] },
      modelId: "glm-5.3",
      providerModel: makeModel({ id: "glm-5.3" }),
    });
    expect((request.body as any).model).toBe("glm-5.3");
  });

  it("does not add a model field to bodies that lack one", async () => {
    const request = await prepareRequest({
      body: { messages: [] },
      modelId: "glm-5.3",
      providerModel: makeModel({ id: "z-ai-glm-5-3" }),
    });
    expect("model" in (request.body as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failover retry path
// ---------------------------------------------------------------------------

describe("RoutstrClient failover upstream model forwarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rewrites the retry body model to the failover provider's native id", async () => {
    const BASE_URL = "https://provider.example.com/";
    const SECOND_BASE_URL = "https://provider2.example.com/";
    const SPENT_BODY = JSON.stringify({
      error: {
        type: "token_already_spent",
        code: "cashu_token_already_spent",
        message: "Token already spent",
      },
      request_id: "req-123",
    });

    const failoverModel = makeModel({ id: "glm-zai-5.3" });
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set<string>(),
      findNextBestProvider: vi.fn(() => SECOND_BASE_URL),
      getModelForProvider: vi.fn(async () => failoverModel),
      getRequiredSatsForModel: vi.fn(() => 100),
    } as any;

    const client = new RoutstrClient(
      createWallet(),
      createStorage(),
      createDiscovery(),
      "ERROR",
      "xcashu",
      { providerManager }
    );
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_failover_token",
      tokenBalance: 1000,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      {
        path: "/v1/chat/completions",
        method: "POST",
        body: { model: "z-ai-glm-5-3", messages: [] },
        selectedModel: makeModel({ id: "z-ai-glm-5-3" }),
        baseUrl: BASE_URL,
        mintUrl: "https://mint.example.com",
        token: "cashu_spent_token",
        requiredSats: 100,
        headers: {},
        baseHeaders: {},
        tinfoilEnabled: false,
      },
      "cashu_spent_token",
      400,
      "req-789",
      undefined,
      SPENT_BODY,
      0
    );

    expect(response.status).toBe(200);
    const retryParams = makeRequestSpy.mock.calls[0][0];
    expect(retryParams.baseUrl).toBe(SECOND_BASE_URL);
    expect(retryParams.body.model).toBe("glm-zai-5.3");
  });
});

// ---------------------------------------------------------------------------
// Forced provider resolution
// ---------------------------------------------------------------------------

describe("resolveRequestContext forced provider with mappings", () => {
  it("resolves a canonical id against a mapped provider-native id", async () => {
    const native = makeModel({ id: "z-ai-glm-5-3" });
    const modelManager = {
      getBaseUrls: () => ["https://cypherpunk.example/"],
      getAllCachedModels: () => ({
        "https://cypherpunk.example/": [native],
      }),
    };

    const resolved = await resolveRequestContext({
      modelId: "glm-5.3",
      forcedProvider: "https://cypherpunk.example/",
      walletAdapter: createWallet({
        getActiveMintUrl: () => "https://mint.example.com",
      }),
      storageAdapter: createStorage(),
      discoveryAdapter: createDiscovery(),
      modelManager: modelManager as any,
    });

    expect(resolved.baseUrl).toBe("https://cypherpunk.example/");
    expect(resolved.selectedModel.id).toBe("z-ai-glm-5-3");
  });
});
