import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example.com/";
const MINT_URL = "https://mint.example.com";
const API_KEY = "stored-api-key";

const createStorage = (): StorageAdapter => ({
  getXcashuTokens: () => ({}),
  getXcashuTokensForBaseUrl: () => [],
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  clearXcashuTokensForBaseUrl: () => {},
  updateXcashuTokenTryCount: () => {},
  getApiKeyDistribution: () => [{ baseUrl: BASE_URL, amount: 42 }],
  removeApiKey: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
  getApiKey: (baseUrl) =>
    baseUrl === BASE_URL
      ? { key: API_KEY, baseUrl: BASE_URL, balance: 42, lastUsed: null }
      : null,
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
  setCachedReceiveTokens: () => {},
});

const createDiscovery = (): DiscoveryAdapter => ({
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
});

describe("RoutstrClient balance check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createApiKeyClient = (getBalances = vi.fn(async () => ({}))) => {
    const wallet: WalletAdapter = {
      getBalances,
      getMintUnits: () => ({}),
      getActiveMintUrl: () => null,
      sendToken: async () => {
        throw new Error("sendToken should not be called");
      },
      receiveToken: async () => ({ success: true, amount: 0, unit: "sat" }),
    };
    const client = new RoutstrClient(
      wallet,
      createStorage(),
      createDiscovery(),
      "max",
      "apikeys"
    );
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 42_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    return { client, getBalances };
  };

  it("routes with an existing API key when the local wallet has zero balance", async () => {
    const { client, getBalances } = createApiKeyClient();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${API_KEY}`
      );
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
    });

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getBalances).not.toHaveBeenCalled();
  });

  it("forwards app attribution without forwarding client authorization", async () => {
    const { client } = createApiKeyClient();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("http-referer")).toBe("https://hermes-agent.nousresearch.com");
      expect(headers.get("x-title")).toBe("Hermes Agent");
      expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-client-only")).toBeNull();
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      headers: {
        "http-referer": "https://hermes-agent.nousresearch.com",
        "X-TITLE": "Hermes Agent",
        Authorization: "Bearer client-facing-key",
        Cookie: "session=client-secret",
        "X-Client-Only": "do-not-forward",
      },
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
