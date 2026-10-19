/**
 * Request costing — the key provider ranking sorts on.
 *
 * A node bills four rates, not one:
 *
 *   cost = fresh * promptRate + cacheRead * cacheReadRate
 *        + output * completionRate + request
 *
 * where the fresh remainder of a warm prompt is billed at the cache-write rate
 * when the route publishes one (a warm turn rewrites the prefix it just read).
 *
 * The weights (`fresh`, `cacheRead`, `output`) are properties of the request
 * and of the session, not of the model: two requests of the same prompt length
 * to the same route price differently depending on whether the prompt shares a
 * prefix with the previous turn. So a route is compared by pricing one
 * explicit basket against the rates it publishes, not by comparing a single
 * rate. A `prompt + completion` per-million sum prices a token class the
 * request may not send and ignores the input class it mostly does send: on a
 * warm session most of the prompt is billed at the cache rate, which can be
 * 5-10x cheaper than the prompt rate.
 *
 * Pure: no I/O, no selection policy. ProviderManager ranks on it.
 */

import type { ModelSatsPricing } from "../core/types";

/** The request a route is priced against. */
export interface CostBasket {
  /** Total prompt tokens (cached + fresh). */
  promptTokens: number;
  /** Completion tokens. */
  outputTokens: number;
  /** Fraction of promptTokens served from the upstream cache, 0..1. */
  cacheHitRate: number;
}

/**
 * The basket the previous ranking key implied, kept as the default.
 *
 * 1M prompt and 1M completion tokens at a 0% cache hit prices as
 * `1_000_000 * (prompt + completion)` plus the request fee — i.e. exactly the
 * `prompt + completion` per-million sum the ranking sorted on before. So
 * swapping the sort key to a cost does not move a single route by itself;
 * changing this constant (or passing a measured basket) is what changes
 * routing, and that decision gets to be reviewed on its own.
 */
export const DEFAULT_COST_BASKET: CostBasket = {
  promptTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheHitRate: 0,
};

/**
 * What to assume when a route publishes no usable cache-read rate.
 *
 * A missing rate (absent, null, 0, negative) is *unknown*, not a price:
 * - `"assume-miss"`: bill those tokens at the prompt rate (cache never
 *   engaged). An unverifiable cache claim can never win a ranking.
 * - `"assume-free"`: bill them at 0 (cache always engaged).
 *
 * The default is `"assume-miss"`. It prices an unknown route as if it had no
 * cache at all, which understates a route whose cache does engage, but never
 * rewards a route for a number it did not advertise.
 */
export type MissingCacheRatePolicy = "assume-miss" | "assume-free";

/** The rates a bill is computed from, plus where each rate came from. */
export interface CostRates {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  request: number;
  /** `advertised` when the node published a usable value, else the fill. */
  cacheReadSource: "advertised" | "assume-miss" | "assume-free";
  cacheWriteSource: "advertised" | "prompt";
}

/** Per-class sats, so a ranking decision can be inspected and argued with. */
export interface CostEstimate {
  /** Total sats for the basket — the ranking key. */
  total: number;
  freshInputSats: number;
  cacheReadSats: number;
  outputSats: number;
  requestSats: number;
  /** The token classes the basket split into. */
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
function advertisedRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function clampHitRate(hitRate: number): number {
  if (!Number.isFinite(hitRate)) return 0;
  return Math.min(Math.max(hitRate, 0), 1);
}

function tokenCount(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** Fill a caller's partial basket, clamping the hit rate and token counts. */
export function resolveBasket(basket: Partial<CostBasket> = {}): CostBasket {
  return {
    promptTokens: tokenCount(basket.promptTokens, DEFAULT_COST_BASKET.promptTokens),
    outputTokens: tokenCount(basket.outputTokens, DEFAULT_COST_BASKET.outputTokens),
    cacheHitRate: clampHitRate(basket.cacheHitRate ?? DEFAULT_COST_BASKET.cacheHitRate),
  };
}

/**
 * Resolve the rates a route bills against, filling gaps explicitly.
 *
 * The cache-write premium is only charged when the basket participates in the
 * cache (`cacheHitRate > 0`): a cold request is billed exactly as it is today,
 * at the prompt rate, even on a route that publishes an `input_cache_write`
 * above its prompt rate.
 */
export function resolveCostRates(
  pricing: Partial<ModelSatsPricing> | null | undefined,
  options: {
    missingCacheRate?: MissingCacheRatePolicy;
    cacheHitRate?: number;
  } = {}
): CostRates {
  const policy = options.missingCacheRate ?? "assume-miss";
  const cacheEngaged = clampHitRate(options.cacheHitRate ?? 0) > 0;
  const prompt = pricing?.prompt ?? 0;
  const advertisedRead = advertisedRate(pricing?.input_cache_read);
  const advertisedWrite = advertisedRate(pricing?.input_cache_write);

  return {
    prompt,
    completion: pricing?.completion ?? 0,
    request: pricing?.request ?? 0,
    cacheRead:
      advertisedRead ?? (policy === "assume-free" ? 0 : prompt),
    cacheWrite: cacheEngaged ? (advertisedWrite ?? prompt) : prompt,
    cacheReadSource:
      advertisedRead !== null
        ? "advertised"
        : policy === "assume-free"
          ? "assume-free"
          : "assume-miss",
    cacheWriteSource:
      cacheEngaged && advertisedWrite !== null ? "advertised" : "prompt",
  };
}

/** Price one basket on one route. */
export function estimateCost(
  pricing: Partial<ModelSatsPricing> | null | undefined,
  basket: CostBasket | Partial<CostBasket> = DEFAULT_COST_BASKET,
  missingCacheRate: MissingCacheRatePolicy = "assume-miss"
): CostEstimate {
  const resolved = resolveBasket(basket);
  const rates = resolveCostRates(pricing, {
    missingCacheRate,
    cacheHitRate: resolved.cacheHitRate,
  });

  const cacheReadTokens = resolved.promptTokens * resolved.cacheHitRate;
  const freshInputTokens = resolved.promptTokens - cacheReadTokens;

  const freshInputSats = freshInputTokens * rates.cacheWrite;
  const cacheReadSats = cacheReadTokens * rates.cacheRead;
  const outputSats = resolved.outputTokens * rates.completion;
  const requestSats = rates.request;

  return {
    total: freshInputSats + cacheReadSats + outputSats + requestSats,
    freshInputSats,
    cacheReadSats,
    outputSats,
    requestSats,
    freshInputTokens,
    cacheReadTokens,
    outputTokens: resolved.outputTokens,
  };
}
