import { describe, expect, it } from "vitest";
import {
  DEFAULT_COST_BASKET,
  estimateCost,
  hasUsableTokenRates,
  resolveBasket,
  resolveCostRates,
} from "../../client/costEstimate";

const WARM = {
  promptTokens: 100_000,
  outputTokens: 2_000,
  cacheHitRate: 0.9,
  cacheWriteRate: 0,
};

describe("costEstimate", () => {
  describe("estimateCost", () => {
    it("bills a cold basket entirely at the prompt and completion rates", () => {
      const estimate = estimateCost(
        { prompt: 2, completion: 10, request: 1 },
        { promptTokens: 1_000, outputTokens: 100, cacheHitRate: 0 }
      );

      expect(estimate.freshInputTokens).toBe(1_000);
      expect(estimate.cacheReadTokens).toBe(0);
      expect(estimate.cacheWriteTokens).toBe(0);
      expect(estimate.freshInputSats).toBe(2_000);
      expect(estimate.cacheReadSats).toBe(0);
      expect(estimate.cacheWriteSats).toBe(0);
      expect(estimate.outputSats).toBe(1_000);
      expect(estimate.total).toBe(3_000);
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

    it("splits prompt tokens into read, written and fresh classes", () => {
      const estimate = estimateCost(
        {
          prompt: 1,
          completion: 1,
          input_cache_read: 0.1,
          input_cache_write: 2,
        },
        {
          promptTokens: 1_000,
          outputTokens: 0,
          cacheHitRate: 0.5,
          cacheWriteRate: 0.25,
        }
      );

      // The classes partition the prompt: nothing is billed twice or dropped.
      expect(estimate.cacheReadTokens).toBe(500);
      expect(estimate.cacheWriteTokens).toBe(250);
      expect(estimate.freshInputTokens).toBe(250);
      expect(
        estimate.cacheReadTokens +
          estimate.cacheWriteTokens +
          estimate.freshInputTokens
      ).toBe(1_000);

      expect(estimate.cacheReadSats).toBe(50);
      expect(estimate.cacheWriteSats).toBe(500);
      expect(estimate.freshInputSats).toBe(250);
      expect(estimate.total).toBe(800);
    });

    it("prices the default basket as the old prompt+completion per-million sum", () => {
      // The default basket exists so swapping the ranking key to a cost does
      // not move a single route on its own.
      for (const [prompt, completion] of [
        [1, 1],
        [0.15, 0.6],
        [0.000332, 0.015921],
        [0.002708, 0.013541],
      ] as const) {
        expect(estimateCost({ prompt, completion }).total).toBeCloseTo(
          1_000_000 * (prompt + completion),
          6
        );
      }

      // No cache participation on the default basket, so a published write
      // premium cannot move it either.
      expect(
        estimateCost({ prompt: 1, completion: 1, input_cache_write: 5 }).total
      ).toBe(2_000_000);

      expect(DEFAULT_COST_BASKET).toEqual({
        promptTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheHitRate: 0,
        cacheWriteRate: 0,
      });
    });

    it("reports the per-request fee without billing it", () => {
      // The node settles token classes only; `sats_pricing.request` sizes the
      // deposit ceiling (`max_cost`) and is never added to the charge.
      const withFee = estimateCost({ prompt: 1, completion: 1, request: 50 });
      const withoutFee = estimateCost({ prompt: 1, completion: 1 });

      expect(withFee.total).toBe(withoutFee.total);
      expect(withFee.requestSats).toBe(50);
      expect(withoutFee.requestSats).toBe(0);
    });

    it("never gets more expensive as the cache hit rate rises", () => {
      // Regression: charging the write rate for the *fresh* remainder made a
      // barely-warm basket cost more than a cold one on any route that
      // publishes a write premium above its prompt rate.
      const pricing = {
        prompt: 10,
        completion: 10,
        input_cache_read: 0.5,
        input_cache_write: 12.5,
      };
      const costs = [0, 0.001, 0.05, 0.25, 0.5, 0.75, 1].map(
        (cacheHitRate) =>
          estimateCost(pricing, {
            promptTokens: 1_000,
            outputTokens: 0,
            cacheHitRate,
          }).total
      );

      expect(costs[0]).toBe(10_000);
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

  describe("unannounced cache rates", () => {
    const noCacheRates = { prompt: 4, completion: 8 };

    it("bills an unannounced cache-read rate at the prompt rate", () => {
      // This is the node's own fallback: `_get_pricing_rates` bills a cache
      // rate of <= 0 at the input rate, so ranking it any other way would rank
      // on a price no node charges.
      const estimate = estimateCost(noCacheRates, WARM);
      expect(estimate.cacheReadSats).toBe(90_000 * 4);
      expect(estimate.total).toBe(
        estimate.freshInputSats + estimate.cacheReadSats + estimate.outputSats
      );
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
        expect(resolveCostRates(pricing).cacheReadSource).toBe("prompt");
      }
    });

    it("never lets an unannounced cache rate beat an advertised one", () => {
      const basket = {
        promptTokens: 100_000,
        outputTokens: 2_000,
        cacheHitRate: 0.9,
      };
      const unannounced = estimateCost({ prompt: 1, completion: 10 }, basket);
      const advertised = estimateCost(
        { prompt: 5, completion: 10, input_cache_read: 0.5 },
        basket
      );
      expect(unannounced.total).toBeGreaterThan(advertised.total);
    });
  });

  describe("cache-write rate", () => {
    it("bills only the written share at the write rate", () => {
      const pricing = { prompt: 1, completion: 1, input_cache_write: 2 };
      const estimate = estimateCost(pricing, {
        promptTokens: 1_000,
        outputTokens: 0,
        cacheHitRate: 0,
        cacheWriteRate: 0.5,
      });

      expect(estimate.rates.cacheWrite).toBe(2);
      expect(estimate.rates.cacheWriteSource).toBe("advertised");
      expect(estimate.cacheWriteTokens).toBe(500);
      expect(estimate.cacheWriteSats).toBe(1_000);
      expect(estimate.freshInputTokens).toBe(500);
      expect(estimate.freshInputSats).toBe(500);
      expect(estimate.total).toBe(1_500);
    });

    it("falls back to the prompt rate when no write rate is advertised", () => {
      const rates = resolveCostRates({ prompt: 3, completion: 1 });
      expect(rates.cacheWrite).toBe(3);
      expect(rates.cacheWriteSource).toBe("prompt");

      // Writing therefore costs exactly what leaving the tokens fresh costs.
      const written = estimateCost(
        { prompt: 3, completion: 1 },
        {
          promptTokens: 1_000,
          outputTokens: 0,
          cacheHitRate: 0,
          cacheWriteRate: 0.4,
        }
      );
      expect(written.total).toBe(
        estimateCost(
          { prompt: 3, completion: 1 },
          { promptTokens: 1_000, outputTokens: 0, cacheHitRate: 0 }
        ).total
      );
    });

    it("caps the write share so the classes cannot overlap", () => {
      const basket = resolveBasket({
        promptTokens: 100_000,
        outputTokens: 0,
        cacheHitRate: 0.9,
        cacheWriteRate: 0.5,
      });
      // 0.9 read leaves 0.1 for writes.
      expect(basket.cacheWriteRate).toBeCloseTo(0.1, 10);

      const estimate = estimateCost(
        { prompt: 1, completion: 1, input_cache_read: 1, input_cache_write: 1 },
        basket
      );
      // 0.9 read leaves 0.1 for writes, so the share is capped and the
      // classes still partition the prompt (up to float drift).
      expect(estimate.freshInputTokens).toBeCloseTo(0, 6);
      expect(estimate.cacheReadTokens).toBeCloseTo(90_000, 6);
      expect(estimate.total).toBeCloseTo(100_000, 6);
    });
  });

  describe("resolveCostRates", () => {
    it("drops rates that are not prices", () => {
      for (const pricing of [
        { prompt: Number.NaN, completion: 2 },
        { prompt: -1, completion: 2 },
        { prompt: 1, completion: Number.POSITIVE_INFINITY },
      ]) {
        const rates = resolveCostRates(pricing);
        expect(Number.isFinite(rates.prompt)).toBe(true);
        expect(Number.isFinite(rates.completion)).toBe(true);
        expect(rates.prompt).toBeGreaterThanOrEqual(0);
        expect(rates.completion).toBeGreaterThanOrEqual(0);
      }
    });

    it("treats a missing pricing record as free of charge", () => {
      expect(resolveCostRates(undefined)).toEqual({
        prompt: 0,
        completion: 0,
        request: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheReadSource: "prompt",
        cacheWriteSource: "prompt",
      });
    });
  });

  describe("hasUsableTokenRates", () => {
    it("accepts published non-negative rates, including free", () => {
      expect(hasUsableTokenRates({ prompt: 0, completion: 0 })).toBe(true);
      expect(hasUsableTokenRates({ prompt: 0.5, completion: 2 })).toBe(true);
    });

    it("rejects rates a node could not bill", () => {
      expect(hasUsableTokenRates(undefined)).toBe(false);
      expect(hasUsableTokenRates({ completion: 2 })).toBe(false);
      expect(hasUsableTokenRates({ prompt: Number.NaN, completion: 2 })).toBe(
        false
      );
      expect(
        hasUsableTokenRates({ prompt: 1, completion: Number.POSITIVE_INFINITY })
      ).toBe(false);
      expect(hasUsableTokenRates({ prompt: -1, completion: 2 })).toBe(false);
    });
  });

  describe("resolveBasket", () => {
    it("fills and clamps a partial basket", () => {
      expect(resolveBasket({})).toEqual(DEFAULT_COST_BASKET);
      expect(resolveBasket({ cacheHitRate: 2 }).cacheHitRate).toBe(1);
      expect(resolveBasket({ cacheHitRate: -1 }).cacheHitRate).toBe(0);
      expect(resolveBasket({ cacheWriteRate: 2 }).cacheWriteRate).toBe(1);
      expect(resolveBasket({ promptTokens: 500 }).promptTokens).toBe(500);
      expect(resolveBasket({ outputTokens: 0 }).outputTokens).toBe(0);
      expect(
        resolveBasket({ promptTokens: -5, outputTokens: Number.NaN })
      ).toEqual(DEFAULT_COST_BASKET);
    });
  });
});
