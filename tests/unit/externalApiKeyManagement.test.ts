import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, noopLogger } from "../../core";
import { RoutstrClient } from "../../client/RoutstrClient";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import type { Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { ModelManager } from "../../discovery/ModelManager";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example/";
const API_KEY = "sk-externally-managed";

function createWallet(): WalletAdapter {
  return {
    getBalances: vi.fn(async () => {
      throw new Error("externally managed API keys must not read wallet balance");
    }),
    getMintUnits: vi.fn(() => ({})),
    getActiveMintUrl: vi.fn(() => null),
    sendToken: vi.fn(async () => {
      throw new Error("externally managed API keys must not spend wallet proofs");
    }),
    receiveToken: vi.fn(async () => {
      throw new Error("externally managed API keys must not receive refunds");
    }),
  };
}

function createStorage(options: { withKey?: boolean } = {}): StorageAdapter {
  const withKey = options.withKey ?? true;
  return {
    saveProviderInfo: vi.fn(),
    getProviderInfo: vi.fn(() => null),
    getApiKey: vi.fn(() =>
      withKey
        ? { baseUrl: BASE_URL, key: API_KEY, balance: 100, lastUsed: null }
        : null
    ),
    setApiKey: vi.fn(),
    updateApiKeyBalance: vi.fn(),
    removeApiKey: vi.fn(),
    getAllApiKeys: vi.fn(() => []),
    getApiKeyDistribution: vi.fn(() =>
      withKey ? [{ baseUrl: BASE_URL, amount: 100 }] : []
    ),
    getChildKey: vi.fn(() => null),
    setChildKey: vi.fn(),
    updateChildKeyBalance: vi.fn(),
    removeChildKey: vi.fn(),
    getAllChildKeys: vi.fn(() => []),
    getCachedReceiveTokens: vi.fn(() => []),
    setCachedReceiveTokens: vi.fn(),
    getXcashuTokens: vi.fn(() => ({})),
    getXcashuTokensForBaseUrl: vi.fn(() => []),
    addXcashuToken: vi.fn(),
    removeXcashuToken: vi.fn(),
    clearXcashuTokensForBaseUrl: vi.fn(),
    updateXcashuTokenTryCount: vi.fn(),
  };
}

function createDiscovery(): DiscoveryAdapter {
  return {
    getCachedModels: vi.fn(() => ({})),
    setCachedModels: vi.fn(),
    getCachedMints: vi.fn(() => ({})),
    setCachedMints: vi.fn(),
    getCachedProviderInfo: vi.fn(() => ({})),
    setCachedProviderInfo: vi.fn(),
    getProviderLastUpdate: vi.fn(() => null),
    setProviderLastUpdate: vi.fn(),
    getLastUsedModel: vi.fn(() => null),
    setLastUsedModel: vi.fn(),
    getDisabledProviders: vi.fn(() => []),
    setDisabledProviders: vi.fn(),
    getBaseUrlsList: vi.fn(() => [BASE_URL]),
    getBaseUrlsLastUpdate: vi.fn(() => null),
    setBaseUrlsList: vi.fn(),
    setBaseUrlsLastUpdate: vi.fn(),
    getRoutstr21Models: vi.fn(() => []),
    setRoutstr21Models: vi.fn(),
    getRoutstr21ModelsLastUpdate: vi.fn(() => null),
    setRoutstr21ModelsLastUpdate: vi.fn(),
  };
}

function createClient(
  wallet: WalletAdapter,
  storage: StorageAdapter
): RoutstrClient {
  return new RoutstrClient(
    wallet,
    storage,
    createDiscovery(),
    "min",
    "apikeys",
    {
      apiKeyManagement: "external",
      autoProviderFailover: false,
      logger: noopLogger,
    }
  );
}

function assertNoMoneyMutation(
  wallet: WalletAdapter,
  storage: StorageAdapter
): void {
  expect(wallet.getBalances).not.toHaveBeenCalled();
  expect(wallet.sendToken).not.toHaveBeenCalled();
  expect(wallet.receiveToken).not.toHaveBeenCalled();
  expect(storage.setApiKey).not.toHaveBeenCalled();
  expect(storage.removeApiKey).not.toHaveBeenCalled();
  expect(storage.addXcashuToken).not.toHaveBeenCalled();
  expect(storage.removeXcashuToken).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("externally managed API keys", () => {
  it("resolves request context without requiring a configured mint", async () => {
    const wallet = createWallet();
    const storage = createStorage();
    const model: Model = {
      id: "test-model",
      name: "Test model",
      sats_pricing: {
        prompt: 1,
        completion: 1,
        request: 0,
        image: 0,
        web_search: 0,
        internal_reasoning: 0,
        max_completion_cost: 1,
        max_prompt_cost: 1,
        max_cost: 2,
      },
    };
    const modelManager = {
      getBaseUrls: () => [BASE_URL],
      getAllCachedModels: () => ({ [BASE_URL]: [model] }),
    } as unknown as ModelManager;

    const resolved = await resolveRequestContext({
      modelId: model.id,
      forcedProvider: BASE_URL,
      walletAdapter: wallet,
      storageAdapter: storage,
      discoveryAdapter: createDiscovery(),
      modelManager,
      mode: "apikeys",
      apiKeyManagement: "external",
      autoProviderFailover: false,
      logger: noopLogger,
    });

    expect(resolved.baseUrl).toBe(BASE_URL);
    expect(resolved.mintUrl).toBe("");
    expect(wallet.getBalances).not.toHaveBeenCalled();
  });

  it("uses an existing funded key without reading or spending the local wallet", async () => {
    const wallet = createWallet();
    const storage = createStorage();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/wallet/info")) {
        return new Response(
          JSON.stringify({ balance: 99000, reserved: 0, api_key: API_KEY }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ id: "response-1", usage: { total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createClient(wallet, storage).routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: "test-model", messages: [], stream: false },
      baseUrl: BASE_URL,
      mintUrl: "",
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
    });
    expect(storage.updateApiKeyBalance).toHaveBeenCalledWith(BASE_URL, 99);
    assertNoMoneyMutation(wallet, storage);
  });

  it("does not refund, remove, top up, or fail over after a provider error", async () => {
    const wallet = createWallet();
    const storage = createStorage();
    const fetchMock = vi.fn(async () =>
      new Response("upstream unavailable", {
        status: 500,
        headers: { "x-routstr-request-id": "request-500" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient(wallet, storage);

    await expect(
      client.routeRequest({
        path: "/v1/chat/completions",
        method: "POST",
        body: { model: "test-model", messages: [], stream: false },
        baseUrl: BASE_URL,
        mintUrl: "",
      })
    ).rejects.toMatchObject<Partial<ProviderError>>({
      name: "ProviderError",
      statusCode: 500,
      requestId: "request-500",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getProviderManager().hasFailed(BASE_URL)).toBe(false);
    assertNoMoneyMutation(wallet, storage);
  });

  it("fails before network access when the external key is missing", async () => {
    const wallet = createWallet();
    const storage = createStorage({ withKey: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createClient(wallet, storage).routeRequest({
        path: "/v1/chat/completions",
        method: "POST",
        body: { model: "test-model", messages: [], stream: false },
        baseUrl: BASE_URL,
        mintUrl: "",
      })
    ).rejects.toThrow(
      `No externally managed API key available for provider: ${BASE_URL}`
    );

    expect(fetchMock).not.toHaveBeenCalled();
    assertNoMoneyMutation(wallet, storage);
  });
});
