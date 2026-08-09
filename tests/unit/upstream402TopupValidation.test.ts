import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { FailoverError } from "../../core/errors";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example.com/";
const MINT_URL = "https://mint.example.com";
const API_KEY = "sk-test-key";

const createWallet = (): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => MINT_URL,
  sendToken: async () => "cashu-token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
});

const createStorage = (): StorageAdapter => ({
  getXcashuTokens: () => ({}),
  getXcashuTokensForBaseUrl: () => [],
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  clearXcashuTokensForBaseUrl: () => {},
  updateXcashuTokenTryCount: () => {},
  getApiKeyDistribution: () => [],
  getApiKey: () => ({
    key: API_KEY,
    baseUrl: BASE_URL,
    balance: 0,
    lastUsed: null,
  }),
  setApiKey: () => {},
  updateApiKeyBalance: () => {},
  touchApiKeyLastUsed: () => {},
  removeApiKey: () => {},
  getAllApiKeys: () => [],
  getChildKey: () => null,
  setChildKey: () => {},
  updateChildKeyBalance: () => {},
  removeChildKey: () => {},
  getAllChildKeys: () => [],
  getCachedReceiveTokens: () => [],
  setCachedReceiveTokens: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
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

const model = {
  id: "gpt-test",
  name: "GPT Test",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

const params = {
  path: "/v1/chat/completions",
  method: "POST",
  body: { model: model.id, messages: [] },
  selectedModel: model,
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token: API_KEY,
  requiredSats: 100,
  headers: {},
  baseHeaders: {},
  tinfoilEnabled: false,
};

const localInsufficientBalanceBody = JSON.stringify({
  detail: {
    error: {
      message: "Insufficient balance: 100 sats required; 20 sats available.",
      type: "insufficient_quota",
      code: "insufficient_balance",
    },
  },
});

function createClient() {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(() => null),
  } as any;
  const client = new RoutstrClient(
    createWallet(),
    createStorage(),
    createDiscovery(),
    "ERROR",
    "apikeys",
    { providerManager }
  );
  return { client, providerManager };
}

async function handle402(client: RoutstrClient, body: string) {
  return (client as any)._handleErrorResponse(
    params,
    API_KEY,
    402,
    "req-402",
    undefined,
    body,
    0
  );
}

describe("RoutstrClient 402 top-up validation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tops up only after a structured local insufficient-balance error and a confirmed shortfall", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: true,
      toppedUpAmount: 96,
      message: "ok",
    });
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await handle402(client, localInsufficientBalanceBody);

    expect(response.status).toBe(200);
    expect(topUp).toHaveBeenCalledOnce();
    expect(topUp).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 96,
      token: API_KEY,
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not top up a passed-through upstream-provider 402", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    const getBalance = vi.spyOn(balanceManager, "getTokenBalance");
    const topUp = vi.spyOn(balanceManager, "topUp");
    const body = JSON.stringify({
      error: {
        type: "upstream_error",
        code: 402,
        message: "Provider account has insufficient credits",
      },
    });

    await expect(handle402(client, body)).rejects.toBeInstanceOf(FailoverError);
    expect(getBalance).not.toHaveBeenCalled();
    expect(topUp).not.toHaveBeenCalled();
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=upstream_error")
    );
  });

  it("does not top up an unknown or unstructured 402", async () => {
    const { client } = createClient();
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");

    await expect(handle402(client, "Payment Required")).rejects.toBeInstanceOf(
      FailoverError
    );
    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not top up when the local API-key balance is already sufficient", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 150_000,
      reserved: 10_000,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi.spyOn(balanceManager, "topUp");

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toBeInstanceOf(FailoverError);
    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not top up when the API-key balance cannot be validated", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 0,
      reserved: 0,
      unit: "sat",
      apiKey: "",
      balanceUnknown: true,
    });
    const topUp = vi.spyOn(balanceManager, "topUp");

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toBeInstanceOf(FailoverError);
    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not top up when a balance limit, rather than available funds, was exceeded", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    const getBalance = vi.spyOn(balanceManager, "getTokenBalance");
    const topUp = vi.spyOn(balanceManager, "topUp");
    const body = JSON.stringify({
      error: {
        type: "insufficient_quota",
        code: "balance_limit_exceeded",
        message: "Balance limit exceeded",
      },
    });

    await expect(handle402(client, body)).rejects.toBeInstanceOf(FailoverError);
    expect(getBalance).not.toHaveBeenCalled();
    expect(topUp).not.toHaveBeenCalled();
  });
});
