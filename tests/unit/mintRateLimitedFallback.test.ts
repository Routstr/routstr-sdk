/**
 * Behavior tests for the `cashu_mint_rate_limited` / `mint_rate_limited` case.
 *
 * routstr-core answers 503 `{"detail":{"error":{"type":"mint_rate_limited",
 * "code":"cashu_mint_rate_limited"}}}` when the node's mint is throttling it.
 * The limit is bucket-scoped to the mint the token came from, so — like
 * `mint_unreachable` — the failure identifies the mint, not the provider:
 * the SDK has to reclaim the token and retry the SAME provider with a token
 * from another mint the provider accepts, before falling back to provider
 * failover.
 *
 * The fixes under test:
 *
 * - `shouldFailoverToAnotherMint` treats `mint_rate_limited` as retryable, so
 *   `RoutstrClient._handleErrorResponse` re-spends against the same provider
 *   with the throttled mint excluded instead of abandoning the node.
 * - Failed mint rotation retains model/path-scoped cooldowns: a healthy
 *   alternative mint may still have enough balance for cheaper requests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://provider.example.com/";
const SECOND_BASE_URL = "https://provider2.example.com/";
const MINT_URL = "https://mint.example.com";
const FALLBACK_MINT_URL = "https://fallback-mint.example.com";
const BOOTSTRAP_TOKEN = "cashu_bootstrap_token_123";
const REFUND_TOKEN = "cashu_refund_token_456";
const RATE_LIMITED_BODY = JSON.stringify({
  detail: {
    error: {
      message: "Cashu mint is rate-limiting requests; retry later",
      type: "mint_rate_limited",
      code: "cashu_mint_rate_limited",
    },
  },
  error: {
    message: "Cashu mint is rate-limiting requests; retry later",
    type: "mint_rate_limited",
    code: "cashu_mint_rate_limited",
  },
  request_id: "54ca081a-7657-41d6-a096-61ae9c94c80b",
});

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 1747, unit: "sat" }),
  ...overrides,
});

/** Stateful storage mock mirroring the one-key-per-provider store semantics. */
const createStorage = (
  initialKey: string | null = BOOTSTRAP_TOKEN
): StorageAdapter & {
  removedApiKeys: string[];
  removedXcashu: Array<[string, string]>;
  setApiKeys: string[];
} => {
  let storedKey: string | null = initialKey;
  const removedApiKeys: string[] = [];
  const removedXcashu: Array<[string, string]> = [];
  const setApiKeys: string[] = [];

  const storage = {
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: (baseUrl: string, token: string) => {
      removedXcashu.push([baseUrl, token]);
    },
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    getApiKeyDistribution: () =>
      storedKey ? [{ baseUrl: BASE_URL, amount: 0 }] : [],
    removeApiKey: (baseUrl: string) => {
      removedApiKeys.push(baseUrl);
      storedKey = null;
    },
    saveProviderInfo: () => {},
    getProviderInfo: () => null,
    getApiKey: (baseUrl: string) =>
      storedKey
        ? { key: storedKey, baseUrl: BASE_URL, balance: 0, lastUsed: Date.now() }
        : null,
    setApiKey: (_baseUrl: string, key: string) => {
      setApiKeys.push(key);
      storedKey = key;
    },
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
  } as StorageAdapter;

  return Object.assign(storage, { removedApiKeys, removedXcashu, setApiKeys });
};

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

const makeModel = (): Model =>
  ({
    id: "gpt-6.1-sol",
    name: "GPT Test",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

const errorParams = (token: string) => ({
  path: "/v1/responses",
  method: "POST",
  body: { model: "gpt-6.1-sol", messages: [] },
  selectedModel: makeModel(),
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token,
  requiredSats: 100,
  headers: {},
  baseHeaders: {},
  tinfoilEnabled: false,
});

const failoverProviderManager = () => {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set<string>(),
    findNextBestProvider: vi.fn(() => SECOND_BASE_URL),
    getModelForProvider: vi.fn(async () => makeModel()),
    getRequiredSatsForModel: vi.fn(() => 100),
  } as any;
  return providerManager;
};

const freshSpend = () => ({
  token: "cashu_fresh_failover_token",
  tokenBalance: 1747,
  tokenBalanceUnit: "sat" as const,
  tokenBalanceUnknown: false,
  selectedMintUrl: FALLBACK_MINT_URL,
});

describe("RoutstrClient._handleErrorResponse — 503 cashu_mint_rate_limited", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("apikeys: reclaims and retries the same provider (pinnedProvider=%s)", async (pinnedProvider) => {
    const storage = createStorage(BOOTSTRAP_TOKEN);
    const providerManager = failoverProviderManager();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys",
      { providerManager }
    );
    const receiveSpy = vi.spyOn(client.getCashuSpender(), "receiveToken");
    const spendSpy = vi
      .spyOn(client as any, "_spendToken")
      .mockResolvedValue(freshSpend());
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      { ...errorParams(BOOTSTRAP_TOKEN), pinnedProvider },
      BOOTSTRAP_TOKEN,
      503,
      "req-503",
      undefined, // no X-Cashu refund header in apikeys mode
      RATE_LIMITED_BODY,
      0
    );

    expect(response.status).toBe(200);
    // The node never consumed the proofs, so the bootstrap token comes back.
    expect(receiveSpy).toHaveBeenCalledOnce();
    expect(receiveSpy).toHaveBeenCalledWith(BOOTSTRAP_TOKEN);
    // ...and its now-dead bootstrap API key record is purged.
    expect(storage.removedApiKeys).toEqual([BASE_URL]);
    // A rate limit identifies the mint, not the provider: same provider, fresh
    // token, throttled mint excluded.
    expect(spendSpy).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: BASE_URL,
      excludeMints: [MINT_URL],
    });
    expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
    expect(providerManager.markFailed).not.toHaveBeenCalled();
    const retryParams = makeRequestSpy.mock.calls[0][0];
    expect(retryParams.baseUrl).toBe(BASE_URL);
    expect(retryParams.token).toBe("cashu_fresh_failover_token");
    expect(retryParams.excludeMints).toEqual([MINT_URL]);
    expect(retryParams.selectedMintUrl).toBe(FALLBACK_MINT_URL);
  });

  it("xcashu: receives the refund header and retries the same provider with the throttled mint excluded", async () => {
    const storage = createStorage(null);
    const providerManager = failoverProviderManager();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "xcashu",
      { providerManager }
    );
    const receiveSpy = vi.spyOn(client.getCashuSpender(), "receiveToken");
    const spendSpy = vi
      .spyOn(client as any, "_spendToken")
      .mockResolvedValue(freshSpend());
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      errorParams("cashu_original_token"),
      "cashu_original_token",
      503,
      "req-503",
      REFUND_TOKEN,
      RATE_LIMITED_BODY,
      0
    );

    expect(response.status).toBe(200);
    // The refund token is claimed first, and the original IOU is dropped.
    expect(receiveSpy).toHaveBeenCalledOnce();
    expect(receiveSpy).toHaveBeenCalledWith(REFUND_TOKEN);
    expect(storage.removedXcashu).toEqual([[BASE_URL, "cashu_original_token"]]);
    expect(storage.removedApiKeys).toEqual([]);
    expect(spendSpy).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: BASE_URL,
      excludeMints: [MINT_URL],
    });
    expect(providerManager.markFailed).not.toHaveBeenCalled();
    expect(makeRequestSpy).toHaveBeenCalledOnce();
    expect(makeRequestSpy.mock.calls[0][0].baseUrl).toBe(BASE_URL);
  });

  it("cools only the requested model and fails over when no alternative mint can fund it", async () => {
    const storage = createStorage(BOOTSTRAP_TOKEN);
    const providerManager = failoverProviderManager();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys",
      { providerManager }
    );
    vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({
      success: true,
      amount: 1747,
      unit: "sat",
    });
    // No alternative mint the provider accepts: the same-provider mint retry
    // cannot produce a token, so the request falls through to failover.
    const spendSpy = vi
      .spyOn(client as any, "_spendToken")
      .mockRejectedValueOnce(new Error("no funded mint accepted"))
      .mockResolvedValueOnce(freshSpend());
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      errorParams(BOOTSTRAP_TOKEN),
      BOOTSTRAP_TOKEN,
      503,
      "req-503",
      undefined,
      RATE_LIMITED_BODY,
      0
    );

    expect(response.status).toBe(200);
    // Keep the failure request-scoped: an alternative mint may still fund
    // cheaper sibling models on this provider.
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=mint_rate_limited"),
      makeModel().id,
      undefined
    );
    expect(providerManager.findNextBestProvider).toHaveBeenCalledOnce();
    expect(spendSpy).toHaveBeenNthCalledWith(2, {
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: SECOND_BASE_URL,
    });
    expect(makeRequestSpy.mock.calls[0][0].baseUrl).toBe(SECOND_BASE_URL);
  });

  it("keeps cheaper models routable when an alternative mint cannot fund expensive bootstrap retries", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const expensiveModel = makeModel();
    const cheapModel = {
      ...expensiveModel,
      id: "cheap-model",
      sats_pricing: { prompt: 0.01, completion: 0.01, max_cost: 1 },
    } as Model;
    const discovery: DiscoveryAdapter = {
      ...createDiscovery(),
      getCachedModels: () => ({ [BASE_URL]: [expensiveModel, cheapModel] }),
      getCachedMints: () => ({ [BASE_URL]: [MINT_URL, FALLBACK_MINT_URL] }),
    };
    const sendToken = vi.fn(async () => "cashu_cheap_bootstrap_token");
    const wallet = createWallet({
      getBalances: async () => ({ [MINT_URL]: 1000, [FALLBACK_MINT_URL]: 20 }),
      getMintUnits: () => ({ [MINT_URL]: "sat", [FALLBACK_MINT_URL]: "sat" }),
      sendToken,
    });
    const storage = createStorage();
    const providerManager = new ProviderManager(discovery);
    const client = new RoutstrClient(
      wallet,
      storage,
      discovery,
      "ERROR",
      "apikeys",
      { providerManager }
    );
    const spendSpy = vi.spyOn(client as any, "_spendToken");
    const receiveSpy = vi.spyOn(client.getCashuSpender(), "receiveToken");
    const requestSpy = vi.spyOn(client as any, "_makeRequest");

    // Exercise actual mint selection/spending: B's 20 sats cannot cover the
    // expensive request's 140-sat bootstrap deposit. Two failures previously
    // activated a provider-wide cooldown, removing even the cheap model.
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = `${BOOTSTRAP_TOKEN}_${attempt}`;
      storage.setApiKey(BASE_URL, token);
      const response = await (client as any)._handleErrorResponse(
        { ...errorParams(token), pinnedProvider: true },
        token,
        503,
        "req-expensive",
        undefined,
        RATE_LIMITED_BODY,
        0
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(storage.getApiKey(BASE_URL)).toBeNull();
    }
    expect(receiveSpy).toHaveBeenCalledTimes(2);
    expect(spendSpy).toHaveBeenCalledTimes(2);
    expect(spendSpy).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: BASE_URL,
      excludeMints: [MINT_URL],
    });
    expect(sendToken).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(providerManager.isOnCooldown(BASE_URL, expensiveModel.id)).toBe(true);
    expect(providerManager.isOnCooldown(BASE_URL)).toBe(false);
    expect(providerManager.isOnCooldown(BASE_URL, cheapModel.id)).toBe(false);
    expect(providerManager.getProviderPriceRankingForModel(cheapModel.id)).toEqual([
      expect.objectContaining({ baseUrl: BASE_URL, model: cheapModel }),
    ]);

    // Prove the remaining route is fundable, not just visible in ranking:
    // the cheap request's minimum 7-sat deposit can be issued from mint B.
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 7000,
      reserved: 0,
      unit: "msat",
      apiKey: "canonical-cheap-key",
    });
    const cheapSpend = await (client as any)._spendToken({
      mintUrl: MINT_URL,
      amount: 1,
      baseUrl: BASE_URL,
      excludeMints: [MINT_URL],
    });
    expect(cheapSpend.selectedMintUrl).toBe(FALLBACK_MINT_URL);
    expect(cheapSpend.token).toBe("cashu_cheap_bootstrap_token");
    expect(sendToken).toHaveBeenCalledExactlyOnceWith(
      FALLBACK_MINT_URL,
      7,
      undefined,
      expect.any(Function)
    );
  });
});
