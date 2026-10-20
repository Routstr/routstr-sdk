/**
 * Provider selection prices a warm session.
 *
 * A continuing conversation bills most of its prompt at the cache rate, so the
 * route that is cheapest on a cold `prompt + completion` sum is not the route
 * that is cheapest to bill. Both routing paths in resolveRequestContext must
 * rank on WARM_COST_BASKET, not on the cold default — otherwise the cost model
 * this SDK ranks on never reaches a real request.
 *
 * The fixtures are chosen so the two baskets disagree: cold-cheap.example has
 * the cheaper prompt+completion sum, warm-cheap.example the cheaper bill once
 * 90% of the prompt is served from cache.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import {
  DEFAULT_COST_BASKET,
  WARM_COST_BASKET,
  estimateCost,
} from "../../client/costEstimate";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";
import { DEEPSEEK_AUTO_MODEL_ID } from "../../utils/modelPaths";

const COLD_CHEAP = "https://cold-cheap.example.com/";
const WARM_CHEAP = "https://warm-cheap.example.com/";
const MINT_URL = "https://mint.example.com";

// Cold sum: 1 + 1 = 2 sats/token. Warm bill at 90% cache: expensive reads.
const COLD_PRICING = { prompt: 1, completion: 1, input_cache_read: 2 };
// Cold sum: 1.5 + 1 = 2.5 sats/token (loses cold). Warm bill: cheap reads.
const WARM_PRICING = { prompt: 1.5, completion: 1, input_cache_read: 0.1 };

const CACHED_MODELS: Record<string, Model[]> = {
  [COLD_CHEAP]: [
    { id: DEEPSEEK_AUTO_MODEL_ID, sats_pricing: COLD_PRICING } as Model,
  ],
  [WARM_CHEAP]: [
    { id: DEEPSEEK_AUTO_MODEL_ID, sats_pricing: WARM_PRICING } as Model,
  ],
};

const createRegistry = (): DiscoveryAdapter =>
  ({
    getCachedModels: () => CACHED_MODELS,
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
  }) as DiscoveryAdapter;

const createWallet = (): WalletAdapter =>
  ({
    getBalances: async () => ({ [MINT_URL]: 5000 }),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT_URL,
    sendToken: async () => "token",
    receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  }) as unknown as WalletAdapter;

const createStorage = (): StorageAdapter =>
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
    setCachedReceiveTokens: () => {},
  }) as unknown as StorageAdapter;

/**
 * ModelManager is injected: routing reads the provider list from it, and a
 * forced provider reads that node's cached models.
 */
const createModelManager = () =>
  ({
    getBaseUrls: () => [COLD_CHEAP, WARM_CHEAP],
    getAllCachedModels: () => CACHED_MODELS,
  }) as any;

const resolveOnce = (overrides: Record<string, unknown> = {}) => {
  const discoveryAdapter = createRegistry();
  const providerManager = new ProviderManager(discoveryAdapter);
  return {
    providerManager,
    resolved: resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      modelManager: createModelManager(),
      providerManager,
      discoveryAdapter,
      walletAdapter: createWallet(),
      storageAdapter: createStorage(),
      ...overrides,
    } as any),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing prices a warm basket", () => {
  it("the fixtures actually disagree between a cold and a warm basket", () => {
    // Guards the two tests below: if the numbers ever stop flipping, they stop
    // proving anything about the basket routing uses.
    const cold = estimateCost(COLD_PRICING, DEFAULT_COST_BASKET).total;
    const coldOnWarm = estimateCost(WARM_PRICING, DEFAULT_COST_BASKET).total;
    expect(cold).toBeLessThan(coldOnWarm);

    const warm = estimateCost(COLD_PRICING, WARM_COST_BASKET).total;
    const warmOnWarm = estimateCost(WARM_PRICING, WARM_COST_BASKET).total;
    expect(warmOnWarm).toBeLessThan(warm);

    expect(WARM_COST_BASKET.cacheHitRate).toBe(0.9);
  });

  it("ranks the ordinary path on the warm basket", async () => {
    const { providerManager, resolved } = resolveOnce();
    const context = await resolved;

    expect(context.baseUrl).toBe(WARM_CHEAP);
    // The same fixtures, priced cold, pick the other node — which is the
    // ordering this path used to produce.
    expect(
      providerManager
        .getProviderPriceRankingForModel(DEEPSEEK_AUTO_MODEL_ID)
        .map((entry) => entry.baseUrl)
    ).toEqual([COLD_CHEAP, WARM_CHEAP]);
  });

  it("ranks the auto-model-path fallback on the warm basket", async () => {
    const discoveryAdapter = createRegistry();
    const providerManager = new ProviderManager(discoveryAdapter);
    // No node advertises a usable route, so the path ranking degrades to the
    // ordinary price ranking (the second call site).
    const pathRanking = vi
      .spyOn(providerManager, "getModelPathProviderRanking")
      .mockResolvedValue([]);

    const context = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      modelManager: createModelManager(),
      providerManager,
      discoveryAdapter,
      walletAdapter: createWallet(),
      storageAdapter: createStorage(),
    } as any);

    expect(pathRanking).toHaveBeenCalled();
    expect(context.baseUrl).toBe(WARM_CHEAP);
    expect(context.modelPath).toBeUndefined();
  });

  it("still honours a forced provider instead of ranking", async () => {
    const { resolved } = resolveOnce({ forcedProvider: COLD_CHEAP });
    const context = await resolved;
    expect(context.baseUrl).toBe(COLD_CHEAP);
    expect(context.pinnedProvider).toBe(true);
  });
});
