/**
 * Cache-aware request costing.
 *
 * A node bills four input/output rates, not one:
 *
 *   cost = fresh*input + cacheRead*input_cache_read
 *        + cacheWrite*input_cache_write + output*completion + request
 *
 * The weights (`fresh`, `cacheRead`, `output`) are properties of the *request
 * and the session*, not of the model — two requests to the same route with
 * the same prompt length can price differently depending on whether the
 * prompt shares a prefix with the previous one. So a route is compared by
 * pricing one explicit basket against the rates it publishes, rather than by
 * comparing a single rate.
 *
 * This module is the cost function only: pure, no I/O, no selection policy.
 * Callers (ProviderManager.getProviderCacheAwareRankingForModel) rank on it.
 */

import type { ModelSatsPricing } from "../core/types";

/** The request a route is priced against. */
export interface CacheAwareBasket {
  /** Total prompt tokens (cached + fresh). */
  promptTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Fraction of promptTokens expected to be served from the upstream cache, 0..1. */
  cacheHitRate: number;
}

/**
 * Generic basket used when the caller has nothing better.
 *
 * 100k prompt at a 90% cache hit with 2k output describes a long agentic
 * session (a large shared prefix re-sent every turn) far better than a
 * per-million rate does; it is deliberately *not* calibrated to any one
 * buyer's traffic. Callers that measure their own traffic (usage ledger,
 * session prefix) should pass their own basket.
 */
export const DEFAULT_CACHE_AWARE_BASKET: CacheAwareBasket = {
  promptTokens: 100_000,
  outputTokens: 2_000,
  cacheHitRate: 0.9,
};

/**
 * What to assume when a route publishes no usable cache-read rate.
 *
 * A missing rate (absent, null, 0, negative) is *unknown*, not a price:
 * - `"assume-miss"`: bill those tokens at the prompt rate (cache never
 *   engaged). An unverifiable cache claim can never win a ranking.
 * - `"assume-free"`: bill them at 0 (cache always engaged).
 *
 * The default is `"assume-miss"`. It ranks an unknown route as if it had no
 * cache at all, which understates a route whose cache does engage, but never
 * rewards a route for a number it did not advertise.
 */
export type MissingCacheRatePolicy = "assume-miss" | "assume-free";

/** The four rates a bill is computed from, plus where each came from. */
export interface CacheAwareRates {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  request: number;
  /** `advertised` when the node published a usable value, else the policy's fill. */
  cacheReadSource: "advertised" | "assume-miss" | "assume-free";
  cacheWriteSource: "advertised" | "prompt";
}

/** Per-class sats, so a ranking decision can be inspected and argued with. */
export interface CacheAwareCost {
  /** Total sats for the basket. */
  total: number;
  freshInputSats: number;
  cacheReadSats: number;
  outputSats: number;
  requestSats: number;
  /** Tokens the basket splits into. */
  freshInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/**
 * A rate is usable when the node published a positive finite number. A
 * published 0 is treated as "not announced": it is what a node sends when it
 * has no cache pricing for the route, and reading it as free would let that
 * route win every ranking.
 */
function usableRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Resolve the four rates a route bills against, filling gaps explicitly. */
export function resolveCacheAwareRates(
  pricing: Partial<ModelSatsPricing> | null | undefined,
  policy: MissingCacheRatePolicy = "assume-miss"
): CacheAwareRates {
  const prompt = pricing?.prompt ?? 0;
  const advertisedRead = usableRate(pricing?.input_cache_read);
  const advertisedWrite = usableRate(pricing?.input_cache_write);

  return {
    prompt,
    completion: pricing?.completion ?? 0,
    request: pricing?.request ?? 0,
    cacheRead:
      advertisedRead ?? (policy === "assume-free" ? 0 : prompt),
    cacheWrite: advertisedWrite ?? prompt,
    cacheReadSource:
      advertisedRead !== null
        ? "advertised"
        : policy === "assume-free"
          ? "assume-free"
          : "assume-miss",
    cacheWriteSource: advertisedWrite !== null ? "advertised" : "prompt",
  };
}

/**
 * Price one basket on one route.
 *
 * The uncached remainder of the prompt is billed at the cache-write rate when
 * the route publishes one (a warm session rewrites it every turn), otherwise
 * at the prompt rate.
 */
export function estimateCacheAwareCost(
  pricing: Partial<ModelSatsPricing> | null | undefined,
  basket: CacheAwareBasket = DEFAULT_CACHE_AWARE_BASKET,
  policy: MissingCacheRatePolicy = "assume-miss"
): CacheAwareCost {
  const rates = resolveCacheAwareRates(pricing, policy);
  const hit = Math.min(Math.max(basket.cacheHitRate, 0), 1);
  const freshInputTokens = basket.promptTokens * (1 - hit);
  const cacheReadTokens = basket.promptTokens * hit;

  const freshInputSats = freshInputTokens * rates.cacheWrite;
  const cacheReadSats = cacheReadTokens * rates.cacheRead;
  const outputSats = basket.outputTokens * rates.completion;
  const requestSats = rates.request;

  return {
    total: freshInputSats + cacheReadSats + outputSats + requestSats,
    freshInputSats,
    cacheReadSats,
    outputSats,
    requestSats,
    freshInputTokens,
    cacheReadTokens,
    outputTokens: basket.outputTokens,
  };
}
