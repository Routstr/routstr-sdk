import { describe, expect, it } from "vitest";
import {
  DEFAULT_COST_BASKET,
  estimateCost,
  resolveBasket,
  resolveCostRates,
} from "../../client/costEstimate";

const WARM = { promptTokens: 100_000, outputTokens: 2_000, cacheHitRate: 0.9 };

describe("costEstimate", () => {
  describe("estimateCost", () => {
    it("bills a cold basket entirely at the prompt and completion rates", () => {
      const estimate = estimateCost(
        { prompt: 2, completion: 10, request: 1 },
        { promptTokens: 1_000, outputTokens: 100, cacheHitRate: 0 }
      );

      expect(estimate.freshInputTokens).toBe(1_000);
      expect(estimate.cacheReadTokens).toBe(0);
      expect(estimate.freshInputSats).toBe(2_000);
      expect(estimate.cacheReadSats).toBe(0);
      expect(estimate.outputSats).toBe(1_000);
      expect(estimate.requestSats).toBe(1);
      expect(estimate.total).toBe(3_001);
    });

    it("splits a warm basket across the cache rate", () => {
      const estimate = estimateCost(
        { prompt: 5, completion: 10, input_cache_read: 0.5 },
        WARM
      );

      expect(estimate.cacheReadTokens).toBe(90_000);
      expect(estimate.freshInputTokens).toBe(10_000);
      expect(estimate.cacheReadSats).toBe(45_000);
      expect(estimate.freshInputSats).toBe(50_000);
      expect(estimate.outputSats).toBe(20_000);
      expect(estimate.total).toBe(115_000);
    });

    it("prices the default basket as the old prompt+completion per-million sum", () => {
      // The default basket exists so swapping the ranking key to a cost does
      // not move a single route on its own.
      for (const [prompt, completion] of [
        [1, 1],
        [0.15, 0.6],
        [332, 15_921],
        [2_708, 13_541],
      ] as const) {
        const estimate = estimateCost({ prompt, completion });
        expect(estimate.total).toBe(1_000_000 * (prompt + completion));
      }
      expect(DEFAULT_COST_BASKET).toEqual({
        promptTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheHitRate: 0,
      });
    });

    it("includes the per-request fee", () => {
      const withoutFee = estimateCost({ prompt: 1, completion: 1 });
      const withFee = estimateCost({ prompt: 1, completion: 1, request: 50 });
      expect(withFee.total - withoutFee.total).toBe(50);
    });

    it("gets monotonically cheaper as the cache hit rate rises", () => {
      const pricing = { prompt: 10, completion: 10, input_cache_read: 0.5 };
      const costs = [0, 0.25, 0.5, 0.75, 1].map(
        (cacheHitRate) =>
          estimateCost(pricing, { promptTokens: 1_000, outputTokens: 0, cacheHitRate })
            .total
      );
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]).toBeLessThan(costs[i - 1]!);
      }
      expect(costs[costs.length - 1]).toBe(500);
    });

    it("clamps a nonsensical hit rate instead of pricing outside the basket", () => {
      const pricing = { prompt: 5, completion: 1, input_cache_read: 1 };
      const over = estimateCost(pricing, {
        promptTokens: 1_000,
        outputTokens: 0,
        cacheHitRate: 4,
      });
      const full = estimateCost(pricing, {
        promptTokens: 1_000,
        outputTokens: 0,
        cacheHitRate: 1,
      });
      expect(over.total).toBe(full.total);

      const nan = estimateCost(pricing, {
        promptTokens: 1_000,
        outputTokens: 0,
        cacheHitRate: Number.NaN,
      });
      expect(nan.cacheReadTokens).toBe(0);
    });
  });

  describe("missing cache rates", () => {
    const noCacheRates = { prompt: 4, completion: 8 };

    it("bills an unannounced cache-read rate at the prompt rate by default", () => {
      const estimate = estimateCost(noCacheRates, WARM);
      expect(estimate.cacheReadSats).toBe(90_000 * 4);
      expect(estimate.total).toBe(estimate.freshInputSats + estimate.cacheReadSats + estimate.outputSats);
    });

    it("treats a published 0 as unannounced, not free", () => {
      for (const pricing of [
        noCacheRates,
        { ...noCacheRates, input_cache_read: 0 },
        { ...noCacheRates, input_cache_read: null as unknown as number },
        { ...noCacheRates, input_cache_read: Number.NaN },
        { ...noCacheRates, input_cache_read: -1 },
      ]) {
        expect(estimateCost(pricing, WARM).cacheReadSats).toBe(90_000 * 4);
        expect(
          resolveCostRates(pricing, { cacheHitRate: WARM.cacheHitRate })
            .cacheReadSource
        ).toBe("assume-miss");
      }
    });

    it("assume-free prices an unannounced cache rate at zero", () => {
      const rates = resolveCostRates(noCacheRates, {
        missingCacheRate: "assume-free",
        cacheHitRate: WARM.cacheHitRate,
      });
      expect(rates.cacheRead).toBe(0);
      expect(rates.cacheReadSource).toBe("assume-free");
      expect(estimateCost(noCacheRates, WARM, "assume-free").cacheReadSats).toBe(0);
    });

    it("never lets an unannounced cache rate beat an advertised one under the default policy", () => {
      const basket = { promptTokens: 100_000, outputTokens: 2_000, cacheHitRate: 0.9 };
      const unannounced = estimateCost({ prompt: 1, completion: 10 }, basket);
      const advertised = estimateCost(
        { prompt: 5, completion: 10, input_cache_read: 0.5 },
        basket
      );
      expect(unannounced.total).toBeGreaterThan(advertised.total);

      // ... whereas reading it as free would win (which is why 0 is not free).
      const readAsFree = estimateCost({ prompt: 1, completion: 10 }, basket, "assume-free");
      expect(readAsFree.total).toBeLessThan(advertised.total);
    });
  });

  describe("cache-write rate", () => {
    const pricing = { prompt: 1, completion: 1, input_cache_write: 2 };

    it("does not charge the write premium on a cold basket", () => {
      const rates = resolveCostRates(pricing, { cacheHitRate: 0 });
      expect(rates.cacheWrite).toBe(1);
      expect(rates.cacheWriteSource).toBe("prompt");

      // A cold basket prices exactly as it did before the key changed.
      expect(
        estimateCost(pricing, {
          promptTokens: 1_000,
          outputTokens: 0,
          cacheHitRate: 0,
        }).total
      ).toBe(1_000);
    });

    it("charges the advertised write rate for fresh tokens once the basket is warm", () => {
      const rates = resolveCostRates(pricing, { cacheHitRate: 0.5 });
      expect(rates.cacheWrite).toBe(2);
      expect(rates.cacheWriteSource).toBe("advertised");

      const estimate = estimateCost(
        { ...pricing, input_cache_read: 0.5 },
        { promptTokens: 1_000, outputTokens: 0, cacheHitRate: 0.5 }
      );
      expect(estimate.freshInputSats).toBe(1_000);
      expect(estimate.cacheReadSats).toBe(250);
    });

    it("falls back to the prompt rate when no write rate is advertised", () => {
      const rates = resolveCostRates(
        { prompt: 3, completion: 1 },
        { cacheHitRate: 0.5 }
      );
      expect(rates.cacheWrite).toBe(3);
      expect(rates.cacheWriteSource).toBe("prompt");
    });
  });

  describe("resolveBasket", () => {
    it("fills and clamps a partial basket", () => {
      expect(resolveBasket({})).toEqual(DEFAULT_COST_BASKET);
      expect(resolveBasket({ cacheHitRate: 2 }).cacheHitRate).toBe(1);
      expect(resolveBasket({ cacheHitRate: -1 }).cacheHitRate).toBe(0);
      expect(resolveBasket({ promptTokens: 500 }).promptTokens).toBe(500);
      expect(resolveBasket({ outputTokens: 0 }).outputTokens).toBe(0);
      expect(
        resolveBasket({ promptTokens: -5, outputTokens: Number.NaN })
      ).toEqual(DEFAULT_COST_BASKET);
    });
  });
});
