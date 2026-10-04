import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { FailoverError, InsufficientBalanceError } from "../../core/errors";
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

function createClient(nextProvider: string | null = null) {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(() => nextProvider),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 5),
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
      toppedUpAmount: 112,
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
      amount: 80 * 1.4,
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
      expect.stringContaining("type=upstream_error"),
      // model-scoped cooldown: the 402 belongs to this model's request
      "gpt-test",
      // no pinned model path: no path-scoped cooldown
      undefined
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


  function walletShortForTopup(client: RoutstrClient) {
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 0, reserved: 0, unit: "msat", apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      message: "Insufficient balance: need 117 sats, have 349 sats available.",
    });
  }

  it("fails over when the wallet cannot fund this provider's top-up", async () => {
    const { client } = createClient("https://other.example.com/");
    walletShortForTopup(client);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu-next", selectedMintUrl: MINT_URL, tokenBalance: 5, tokenBalanceUnit: "sat",
    });
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    expect((await handle402(client, localInsufficientBalanceBody)).status).toBe(200);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://other.example.com/" })
    );
  });

  it("still reports insufficient balance when no provider is left", async () => {
    const { client } = createClient();
    walletShortForTopup(client);

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("fails over when the top-up cannot fund any mint the provider accepts", async () => {
    const NEXT_URL = "https://next.example.com/";
    const { client, providerManager } = createClient(NEXT_URL);
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      providerMintsShort: true,
      providerBaseUrl: BASE_URL,
      acceptedMints: ["https://mint.accepted.example"],
      required: 100,
      available: 20,
      maxMintBalance: 0,
      maxMintUrl: "",
      message: "No funded mint accepted by provider",
    });
    const spend = vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "tok-next",
      tokenBalance: 1000,
      tokenReserved: 0,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
      selectedMintUrl: "https://mint.accepted.example",
    });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response("ok", { status: 200 })
    );

    const response = await handle402(client, localInsufficientBalanceBody);

    expect(response.status).toBe(200);
    expect(spend).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: NEXT_URL })
    );
    // A local wallet condition must not cool the provider down.
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("surfaces an honest provider-mint 402 only after every provider is exhausted", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      providerMintsShort: true,
      providerBaseUrl: BASE_URL,
      acceptedMints: ["https://mint.accepted.example"],
      required: 100,
      available: 20,
      maxMintBalance: 5,
      maxMintUrl: "https://mint.accepted.example",
      message: "No funded mint accepted by provider",
    });

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toMatchObject({
      name: "ProviderMintBalanceError",
      required: 100,
      available: 20,
      maxMintBalance: 5,
      maxMintUrl: "https://mint.accepted.example",
      acceptedMints: ["https://mint.accepted.example"],
    });
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("parses decimal balances and the largest-mint hint for a true wallet 402", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      message:
        "Insufficient balance: need 100.5 sats, have 20.25 sats available. Largest mint balance: 15.75 sats from https://mint.small.example",
    });

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toMatchObject({
      name: "InsufficientBalanceError",
      required: 100.5,
      available: 20.25,
      maxMintBalance: 15.75,
      maxMintUrl: "https://mint.small.example",
    });
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });
});
