import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_AWARE_BASKET,
  estimateCacheAwareCost,
  resolveCacheAwareRates,
} from "../../client/cacheAwareCost";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";

const createAdapter = (models: Record<string, Model[]>): DiscoveryAdapter =>
  ({
    getModelIdMappings: () => null,
    setModelIdMappings: () => {},
    getModelIdMappingsEvent: () => null,
    setModelIdMappingsEvent: () => {},
    getCachedModels: () => models,
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
  }) as unknown as DiscoveryAdapter;

const model = (id: string, sats_pricing: Record<string, unknown>): Model =>
  ({ id, name: id, sats_pricing }) as unknown as Model;

describe("cache-aware cost", () => {
  const pricing = {
    prompt: 1000 / 1e6,
    completion: 2000 / 1e6,
    request: 0,
    input_cache_read: 100 / 1e6,
    input_cache_write: 1250 / 1e6,
  };

  it("splits the prompt into fresh and cached classes", () => {
    const cost = estimateCacheAwareCost(pricing, {
      promptTokens: 100_000,
      outputTokens: 2_000,
      cacheHitRate: 0.9,
    });

    // 10k fresh at 1250 sats/M, 90k cached at 100 sats/M, 2k out at 2000 sats/M
    expect(cost.freshInputTokens).toBeCloseTo(10_000, 6);
    expect(cost.cacheReadTokens).toBeCloseTo(90_000, 6);
    expect(cost.freshInputSats).toBeCloseTo(12.5, 6);
    expect(cost.cacheReadSats).toBeCloseTo(9, 6);
    expect(cost.outputSats).toBeCloseTo(4, 6);
    expect(cost.total).toBeCloseTo(25.5, 6);
  });

  it("bills the fresh remainder at the prompt rate when no write rate is published", () => {
    const cost = estimateCacheAwareCost(
      { ...pricing, input_cache_write: undefined },
      { promptTokens: 100_000, outputTokens: 0, cacheHitRate: 0.5 }
    );
    expect(cost.freshInputSats).toBeCloseTo(50, 6); // 50k * 1000/M
  });

  it("treats a published 0 cache rate as unannounced, not free", () => {
    const rates = resolveCacheAwareRates({ ...pricing, input_cache_read: 0 });
    expect(rates.cacheReadSource).toBe("assume-miss");
    expect(rates.cacheRead).toBeCloseTo(pricing.prompt, 12);

    const cost = estimateCacheAwareCost(
      { ...pricing, input_cache_read: 0 },
      { promptTokens: 100_000, outputTokens: 0, cacheHitRate: 0.9 }
    );
    // All prompt tokens priced at the prompt rate, none at 0.
    expect(cost.cacheReadSats).toBeCloseTo(90, 6);
  });

  it("honours the optimistic policy for unannounced cache rates", () => {
    const cost = estimateCacheAwareCost(
      { prompt: 1000 / 1e6, completion: 0 },
      { promptTokens: 100_000, outputTokens: 0, cacheHitRate: 0.9 },
      "assume-free"
    );
    expect(cost.cacheReadSats).toBeCloseTo(0, 12);
    expect(cost.total).toBeCloseTo(10, 6);
  });

  it("prices the default basket at 100k prompt, 90% hit, 2k output", () => {
    expect(DEFAULT_CACHE_AWARE_BASKET).toEqual({
      promptTokens: 100_000,
      outputTokens: 2_000,
      cacheHitRate: 0.9,
    });
  });

  it("is monotonic in the cache hit rate when cache reads are cheaper", () => {
    const at = (hit: number) =>
      estimateCacheAwareCost(pricing, {
        promptTokens: 100_000,
        outputTokens: 0,
        cacheHitRate: hit,
      }).total;
    expect(at(1)).toBeLessThan(at(0.9));
    expect(at(0.9)).toBeLessThan(at(0));
  });

  it("clamps a hit rate outside 0..1", () => {
    const over = estimateCacheAwareCost(pricing, {
      promptTokens: 100_000,
      outputTokens: 0,
      cacheHitRate: 5,
    });
    const full = estimateCacheAwareCost(pricing, {
      promptTokens: 100_000,
      outputTokens: 0,
      cacheHitRate: 1,
    });
    expect(over.total).toBeCloseTo(full.total, 9);
  });

  it("returns 0 for a route with no pricing", () => {
    expect(estimateCacheAwareCost(null).total).toBe(0);
  });
});

describe("ProviderManager.getProviderCacheAwareRankingForModel", () => {
  // Route A looks expensive per-token but is cheap once most of a long prompt
  // is cached; route B looks cheap per-token and has no cache discount. This
  // is the flip the cache-aware ranking exists to catch.
  const CACHED = "https://cached.example.com/";
  const NO_CACHE = "https://nocache.example.com/";

  const adapter = createAdapter({
    [CACHED]: [
      model("kimi-k3", {
        prompt: 2708 / 1e6,
        completion: 13540 / 1e6,
        request: 0,
        input_cache_read: 278 / 1e6,
        input_cache_write: 0,
      }),
    ],
    [NO_CACHE]: [
      model("kimi-k3", {
        prompt: 332 / 1e6,
        completion: 15920 / 1e6,
        request: 0,
      }),
    ],
  });

  it("ranks by basket cost, not by the prompt+completion rate", () => {
    const manager = new ProviderManager(adapter);
    // The old metric prefers the cached route: 2708+13540 < 332+15920.
    expect(manager.getProviderPriceRankingForModel("kimi-k3")[0].baseUrl).toBe(
      CACHED
    );

    // On a warm 100k basket the cheap-prompt route is ~18% cheaper instead.
    const ranking = manager.getProviderCacheAwareRankingForModel("kimi-k3");
    expect(ranking.map((r) => r.baseUrl)).toEqual([NO_CACHE, CACHED]);
  });

  it("exposes the rates and the cost breakdown it ranked on", () => {
    const manager = new ProviderManager(adapter);
    const [, cached] = manager.getProviderCacheAwareRankingForModel("kimi-k3");

    expect(cached.rates.cacheReadSource).toBe("advertised");
    expect(cached.rates.cacheRead).toBeCloseTo(278 / 1e6, 12);
    expect(cached.breakdown.cacheReadTokens).toBeCloseTo(90_000, 6);
    expect(cached.breakdown.total).toBeCloseTo(cached.cost, 9);
    expect(cached.basket).toEqual(DEFAULT_CACHE_AWARE_BASKET);
    // 10k fresh @ 2708/M + 90k @ 278/M + 2k @ 13540/M
    expect(cached.cost).toBeCloseTo(27.08 + 25.02 + 27.08, 4);
  });

  it("accepts a caller-supplied basket", () => {
    const manager = new ProviderManager(adapter);
    const cold = manager.getProviderCacheAwareRankingForModel("kimi-k3", {
      basket: { promptTokens: 1_000, outputTokens: 0, cacheHitRate: 0 },
    });
    // With nothing cached, the cheap-prompt route wins by a wide margin.
    expect(cold[0].baseUrl).toBe(NO_CACHE);
    expect(cold[0].cost).toBeCloseTo(0.332, 6);
  });

  it("does not let an unannounced cache rate win the ranking as free", () => {
    const manager = new ProviderManager(adapter);
    const [, cached] = manager.getProviderCacheAwareRankingForModel("kimi-k3");
    expect(cached.rates.cacheReadSource).toBe("advertised");

    // Strip the cache rate: the route must be priced at its prompt rate.
    const stripped = new ProviderManager(
      createAdapter({
        [CACHED]: [
          model("kimi-k3", { prompt: 2708 / 1e6, completion: 13540 / 1e6 }),
        ],
        [NO_CACHE]: [
          model("kimi-k3", { prompt: 332 / 1e6, completion: 15920 / 1e6 }),
        ],
      })
    );
    const ranking = stripped.getProviderCacheAwareRankingForModel("kimi-k3");
    expect(ranking[0].baseUrl).toBe(NO_CACHE);
    const cachedEntry = ranking.find((r) => r.baseUrl === CACHED)!;
    expect(cachedEntry.rates.cacheReadSource).toBe("assume-miss");
    expect(cachedEntry.cost).toBeCloseTo(270.8 + 27.08, 4);
  });

  it("honours model-scoped cooldowns like the price ranking", () => {
    const DOWN = "https://down.example.com/";
    const manager = new ProviderManager(
      createAdapter({
        [CACHED]: [model("kimi-k3", { prompt: 1 / 1e6, completion: 1 / 1e6 })],
        [NO_CACHE]: [model("kimi-k3", { prompt: 2 / 1e6, completion: 2 / 1e6 })],
        [DOWN]: [model("kimi-k3", { prompt: 0.5 / 1e6, completion: 0.5 / 1e6 })],
      })
    );

    // Cheapest before the strikes land.
    expect(manager.getProviderCacheAwareRankingForModel("kimi-k3")[0].baseUrl).toBe(
      DOWN
    );

    manager.markFailed(DOWN, "boom", "kimi-k3");
    manager.markFailed(DOWN, "boom", "kimi-k3");

    const ranking = manager.getProviderCacheAwareRankingForModel("kimi-k3");
    expect(ranking.map((r) => r.baseUrl)).toEqual([CACHED, NO_CACHE]);
  });

  it("includes a disabled provider only when asked", () => {
    const disabledAdapter = createAdapter({
      [CACHED]: [model("kimi-k3", { prompt: 1 / 1e6, completion: 1 / 1e6 })],
    });
    (disabledAdapter as any).getDisabledProviders = () => [CACHED];
    const manager = new ProviderManager(disabledAdapter);

    expect(manager.getProviderCacheAwareRankingForModel("kimi-k3")).toEqual([]);
    expect(
      manager.getProviderCacheAwareRankingForModel("kimi-k3", {
        includeDisabled: true,
      })
    ).toHaveLength(1);
  });

  it("returns an empty ranking for an unknown model", () => {
    const manager = new ProviderManager(adapter);
    expect(manager.getProviderCacheAwareRankingForModel("nope")).toEqual([]);
  });
});
