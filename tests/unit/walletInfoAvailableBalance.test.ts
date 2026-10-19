import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import { getAvailableBalanceInSats } from "../../wallet/tokenUtils";

/**
 * `/v1/wallet/info` reports `balance` as routstr-core's `total_balance`, i.e.
 * gross funds minus everything currently held for in-flight requests, plus
 * `reserved` for diagnostics. That `balance` figure is exactly what the node's
 * `pay_for_request` gate compares the request price against, and the node pins
 * it with `test_balance_info_matches_chat_available_balance` in
 * `tests/integration/test_insufficient_balance.py`.
 *
 * These tests fix the interpretation: `reserved` is never deducted from
 * `amount` a second time. Doing so understated available funds by the held
 * amount, which inflated every topup by that same amount.
 */

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
      message: "Insufficient balance: 100000 mSats required. 0 available.",
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

async function handle402(client: RoutstrClient, retryCount = 0) {
  return (client as any)._handleErrorResponse(
    params,
    API_KEY,
    402,
    "req-402",
    undefined,
    localInsufficientBalanceBody,
    retryCount
  );
}

function stubBalance(
  client: RoutstrClient,
  read: { amount: number; reserved: number }
) {
  return vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
    ...read,
    unit: "msat",
    apiKey: API_KEY,
  });
}

describe("getAvailableBalanceInSats", () => {
  it("is the provider-reported amount, not amount minus reserved", () => {
    expect(getAvailableBalanceInSats(120_000, "msat")).toBe(120);
    // A fully reserved key reports 0 available and a non-zero reserved hold.
    expect(getAvailableBalanceInSats(0, "msat")).toBe(0);
    // core's own regression fixture: 4_404_339 gross, 4_410_636 held.
    expect(getAvailableBalanceInSats(-6_297, "msat")).toBeCloseTo(-6.297);
  });
});

describe("402 topup sizing uses the node's available balance", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not size the deposit off the reserved amount when the key is fully held", async () => {
    const { client } = createClient();
    // 500 sat on the key, all of it held by in-flight requests.
    stubBalance(client, { amount: 0, reserved: 500_000 });
    const topUp = vi
      .spyOn(client.getBalanceManager(), "topUp")
      .mockResolvedValue({ success: true, toppedUpAmount: 140, message: "ok" });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response("ok", { status: 200 })
    );

    await handle402(client);

    // available = 0 → shortfall = 100 → 100 x TOPUP_MARGIN(1.4) = 140.
    // Deducting `reserved` again would ask for (100 + 500) x 1.4 = 840.
    expect(topUp).toHaveBeenCalledOnce();
    expect(topUp.mock.calls[0][0]).toMatchObject({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 140,
      token: API_KEY,
    });
  });

  it("handles a negative available balance (over-reserved key) without multiplying the hold", async () => {
    const { client } = createClient();
    // Exact payload from core's test_balance_info_matches_chat_available_balance.
    stubBalance(client, { amount: -6_297, reserved: 4_410_636 });
    const topUp = vi
      .spyOn(client.getBalanceManager(), "topUp")
      .mockResolvedValue({ success: true, toppedUpAmount: 149, message: "ok" });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response("ok", { status: 200 })
    );

    await handle402(client);

    // available = -6.297 sat → shortfall = 106.297 → deposit 106.297 x 1.4.
    // The old double subtraction saw -4416.933 available and deposited
    // ~6324 sat, i.e. the hold (4410 sat) plus the real gap, with margin.
    const deposited = topUp.mock.calls[0][0].amount as number;
    expect(deposited).toBeCloseTo(106.297 * 1.4, 4);
    expect(deposited).toBeLessThan(200);
  });

  it("retries the same provider instead of topping up when only the hold made it look short", async () => {
    const { client } = createClient();
    // available = exactly the request price; the 40 sat hold is already
    // reflected in it. Subtracting it again would look 40 sat short.
    stubBalance(client, { amount: 100_000, reserved: 40_000 });
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    await handle402(client);

    expect(topUp).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: BASE_URL, retryCount: 1 })
    );
  });
});
