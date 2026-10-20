/**
 * Request costing — the key provider ranking sorts on.
 *
 * A node does not bill one rate, it bills a request's token classes
 * separately. `payment/cost_calculation.py::_calculate_from_tokens` in
 * routstr-core settles:
 *
 *   cost = fresh      * promptRate
 *        + cacheRead  * cacheReadRate
 *        + cacheWrite * cacheWriteRate
 *        + output     * completionRate
 *
 * with plain input at the prompt rate and only the tokens upstream reports as
 * cache creation at the write rate — a token read from the cache is not
 * written again. There is no per-request fee in the settled charge
 * (`base_msats` is 0 on that path); `sats_pricing.request` only enters the
 * `max_cost` that sizes the deposit ceiling. So it is reported in the
 * breakdown but kept out of `total`, which is what a node actually bills.
 *
 * The weights (`fresh`, `cacheRead`, `cacheWrite`, `output`) are properties of
 * the request and of the session, not of the model: two requests of the same
 * prompt length to the same route price differently depending on whether the
 * prompt shares a prefix with the previous turn. So a route is compared by
 * pricing one explicit basket against the rates it publishes, not by comparing
 * a single rate. A `prompt + completion` per-million sum prices a token class
 * the request may not send and ignores the input class it mostly does send: on
 * a warm session most of the prompt is billed at the cache rate, which can be
 * 5-10x cheaper than the prompt rate.
 *
 * Routing prices WARM_COST_BASKET; DEFAULT_COST_BASKET is the cold basket the
 * old `prompt + completion` key implied, kept so the two orderings can be
 * compared.
 *
 * Pure: no I/O, no selection policy. ProviderManager ranks on it.
 */

import type { ModelSatsPricing } from "../core/types";

/** The request a route is priced against. */
export interface CostBasket {
  /** Total prompt tokens (cached read + cache write + fresh). */
  promptTokens: number;
  /** Completion tokens. */
  outputTokens: number;
  /** Fraction of promptTokens served from the upstream cache, 0..1. */
  cacheHitRate: number;
  /**
   * Fraction of promptTokens written into the upstream cache, 0..1.
   *
   * Defaults to 0: a client cannot know what an upstream will decide to write,
   * and the node only charges the write rate for the tokens upstream reports
   * as cache creation. Ignoring it never invents a premium; pass a measured
   * write share to rank on it.
   */
  cacheWriteRate: number;
}

/**
 * The basket the previous ranking key implied, kept as the default.
 *
 * 1M prompt and 1M completion tokens, all fresh: no cache reads, no cache
 * writes. A route that advertises cache rates but no write share prices as
 * `1_000_000 * (prompt + completion)` — exactly the `prompt + completion`
 * per-million sum the ranking sorted on before. So swapping the sort key to a
 * cost does not move a single route by itself; changing this constant (or
 * passing a measured basket) is what changes routing, and that decision gets to
 * be reviewed on its own.
 */
export const DEFAULT_COST_BASKET: CostBasket = {
  promptTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheHitRate: 0,
  cacheWriteRate: 0,
};

/**
 * The basket routing prices a request against.
 *
 * A warm session: 90% of the prompt is served from the upstream cache, so the
 * prompt is billed mostly at the cache rate — which is 5-10x cheaper than the
 * prompt rate — instead of at the prompt rate. Ranking on this picks the route
 * a continuing conversation would actually be billed on, rather than the route
 * with the cheapest cold `prompt + completion` sum.
 *
 * The token counts are a chat-sized warm turn, not a measured one: deriving
 * them from the request (prompt tokens, `max_tokens`, a hit rate measured from
 * the session) is the follow-up, and this constant is where that lands. Keep
 * `outputTokens` small relative to `promptTokens` — a large output weight
 * dilutes the cache-rate signal into the completion rate.
 */
export const WARM_COST_BASKET: CostBasket = {
  promptTokens: 100_000,
  outputTokens: 2_000,
  cacheHitRate: 0.9,
  cacheWriteRate: 0,
};

/** The rates a bill is computed from, plus where each cache rate came from. */
export interface CostRates {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  request: number;
  /** `advertised` when the node published a usable value, else the fill. */
  cacheReadSource: "advertised" | "prompt";
  cacheWriteSource: "advertised" | "prompt";
}

/** Per-class sats, so a ranking decision can be inspected and argued with. */
export interface CostEstimate {
  /**
   * Sats the node settles for the basket — the ranking key.
   *
   * The token classes only. `requestSats` is excluded on purpose: the node
   * settles token classes, and the per-request fee sizes the deposit ceiling.
   */
  total: number;
  /** The rates used, so the decision can be re-derived from the entry. */
  rates: CostRates;
  freshInputSats: number;
  cacheReadSats: number;
  cacheWriteSats: number;
  outputSats: number;
  /** Reported for inspection; not part of `total` (see above). */
  requestSats: number;
  /** The token classes the basket split into. */
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/**
 * A published rate for a token class the node always bills something for.
 * Zero is a real price there (a free model), which is why `prompt`,
 * `completion` and `request` accept it; only nonsense is dropped.
 */
function pricedRate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * A rate is usable when the node published a positive finite number. A
 * published 0 is treated as "not announced": it is what a node sends when it
 * has no cache pricing for the route, and reading it as free would let that
 * route win every ranking.
 *
 * This mirrors the node's own fallback (`_get_pricing_rates` bills a cache
 * rate of `<= 0` at the prompt rate), so a route is ranked on the price it
 * would actually charge, not on a cautious guess.
 */
function advertisedRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function tokenCount(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function ratio(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

/** Fill a caller's partial basket, clamping shares and token counts. */
export function resolveBasket(basket: Partial<CostBasket> = {}): CostBasket {
  const cacheHitRate = ratio(
    basket.cacheHitRate,
    DEFAULT_COST_BASKET.cacheHitRate
  );
  return {
    promptTokens: tokenCount(
      basket.promptTokens,
      DEFAULT_COST_BASKET.promptTokens
    ),
    outputTokens: tokenCount(
      basket.outputTokens,
      DEFAULT_COST_BASKET.outputTokens
    ),
    cacheHitRate,
    // A token cannot be both read from and written to the cache, so the write
    // share is capped by what the read share leaves over.
    cacheWriteRate: Math.min(
      ratio(basket.cacheWriteRate, DEFAULT_COST_BASKET.cacheWriteRate),
      1 - cacheHitRate
    ),
  };
}

/**
 * Resolve the rates a route bills against, filling gaps the way the node does.
 *
 * A route with no usable cache rate is billed those tokens at the prompt rate,
 * which is what `_get_pricing_rates` charges for a cache rate it cannot use.
 */
export function resolveCostRates(
  pricing: Partial<ModelSatsPricing> | null | undefined
): CostRates {
  const prompt = pricedRate(pricing?.prompt);
  const advertisedRead = advertisedRate(pricing?.input_cache_read);
  const advertisedWrite = advertisedRate(pricing?.input_cache_write);

  return {
    prompt,
    completion: pricedRate(pricing?.completion),
    request: pricedRate(pricing?.request),
    cacheRead: advertisedRead ?? prompt,
    cacheWrite: advertisedWrite ?? prompt,
    cacheReadSource: advertisedRead === null ? "prompt" : "advertised",
    cacheWriteSource: advertisedWrite === null ? "prompt" : "advertised",
  };
}

/**
 * Whether a route publishes rates the node could bill at all.
 *
 * `NaN`, `±inf` and negative rates are not prices: a negative one produces a
 * negative cost and wins every ranking, and a `NaN` poisons the sort. A rate
 * of 0 does qualify — the node treats it as "free", which is a real price.
 */
export function hasUsableTokenRates(
  pricing: Partial<ModelSatsPricing> | null | undefined
): boolean {
  const usable = (value: unknown): boolean =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  return usable(pricing?.prompt) && usable(pricing?.completion);
}

/** Price one basket on one route. */
export function estimateCost(
  pricing: Partial<ModelSatsPricing> | null | undefined,
  basket: CostBasket | Partial<CostBasket> = DEFAULT_COST_BASKET
): CostEstimate {
  const resolved = resolveBasket(basket);
  const rates = resolveCostRates(pricing);

  const cacheReadTokens = resolved.promptTokens * resolved.cacheHitRate;
  const cacheWriteTokens = resolved.promptTokens * resolved.cacheWriteRate;
  const freshInputTokens = Math.max(
    0,
    resolved.promptTokens - cacheReadTokens - cacheWriteTokens
  );

  const freshInputSats = freshInputTokens * rates.prompt;
  const cacheReadSats = cacheReadTokens * rates.cacheRead;
  const cacheWriteSats = cacheWriteTokens * rates.cacheWrite;
  const outputSats = resolved.outputTokens * rates.completion;
  const requestSats = rates.request;

  return {
    total: freshInputSats + cacheReadSats + cacheWriteSats + outputSats,
    rates,
    freshInputSats,
    cacheReadSats,
    cacheWriteSats,
    outputSats,
    requestSats,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: resolved.outputTokens,
  };
}
