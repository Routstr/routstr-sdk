import type { UsageStats } from "../core/types";

export interface UsageTrackingData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
  /** Explicit finite, nonnegative provider cost in sats; absent when cost is unknown. */
  reportedSatsCost?: number;
  /** Upstream provider/route that handled the request (e.g. "openrouter:openrouter:Anthropic"). */
  provider?: string;
  /** Full cost breakdown emitted by the upstream `cost` object. */
  baseMsats?: number;
  inputMsats?: number;
  outputMsats?: number;
  totalMsats?: number;
  totalUsd?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadMsats?: number;
  cacheCreationMsats?: number;
  remainingBalanceMsats?: number;
  /** Images an image endpoint returned and billed (`X-Routstr-Image-Count`). */
  outputImages?: number;
}

const numOrUndef = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonnegativeOrUndef = (value: unknown): number | undefined => {
  const number = numOrUndef(value);
  return number !== undefined && number >= 0 ? number : undefined;
};

// Some upstream adapters serialize token counts as strings.
const tokenCount = (value: unknown): number | undefined =>
  nonnegativeOrUndef(
    typeof value === "string" && value.trim() !== "" ? Number(value) : value
  );

/**
 * Extract the detailed cost breakdown from an upstream `cost` object.
 * Returns the camelCased fields we persist on a UsageTrackingData/entry.
 */
function extractCostBreakdown(
  costObj: Record<string, unknown> | null | undefined
): Partial<UsageTrackingData> {
  if (!costObj || typeof costObj !== "object") return {};
  return {
    baseMsats: numOrUndef(costObj.base_msats),
    inputMsats: numOrUndef(costObj.input_msats),
    outputMsats: numOrUndef(costObj.output_msats),
    totalMsats: nonnegativeOrUndef(costObj.total_msats),
    totalUsd: numOrUndef(costObj.total_usd),
    cacheReadInputTokens: tokenCount(costObj.cache_read_input_tokens),
    cacheCreationInputTokens: tokenCount(costObj.cache_creation_input_tokens),
    cacheReadMsats: numOrUndef(costObj.cache_read_msats),
    cacheCreationMsats: numOrUndef(costObj.cache_creation_msats),
    remainingBalanceMsats: numOrUndef(costObj.remaining_balance_msats),
  };
}

export function extractUsageFromResponseBody(
  body: unknown,
  fallbackSatsCost = 0
): UsageTrackingData | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return null;

  const costValue = usage.cost;
  const response = body as {
    cost?: unknown;
    metadata?: { routstr?: { cost?: unknown } };
  };
  const usageCost =
    costValue && typeof costValue === "object"
      ? (costValue as Record<string, unknown>)
      : undefined;
  const topLevelCost =
    response.cost && typeof response.cost === "object"
      ? (response.cost as Record<string, unknown>)
      : undefined;
  const metadataCost =
    response.metadata?.routstr?.cost &&
    typeof response.metadata.routstr.cost === "object"
      ? (response.metadata.routstr.cost as Record<string, unknown>)
      : undefined;
  const breakdownCost = metadataCost ?? topLevelCost ?? usageCost;
  const breakdown = extractCostBreakdown(breakdownCost);

  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object"
    ? (usage.cache_creation as Record<string, unknown>)
    : undefined;
  const cacheWrite5m = tokenCount(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheWrite1h = tokenCount(cacheCreation?.ephemeral_1h_input_tokens);
  const anthropicCacheCreation = tokenCount(usage.cache_creation_input_tokens) ??
    (cacheWrite5m === undefined && cacheWrite1h === undefined
      ? undefined
      : (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0));
  const anthropicCacheRead = tokenCount(usage.cache_read_input_tokens);
  const anthropicShaped = usage.prompt_tokens == null && (
    usage.input_tokens != null || anthropicCacheRead !== undefined ||
    anthropicCacheCreation !== undefined
  );

  let promptTokens = Number(usage.prompt_tokens ?? 0);
  if (anthropicShaped) {
    const wireInput = tokenCount(usage.input_tokens);
    const freshInput = tokenCount(breakdownCost?.input_tokens);
    const cached = (anthropicCacheRead ?? breakdown.cacheReadInputTokens ?? 0) +
      (anthropicCacheCreation ?? breakdown.cacheCreationInputTokens ?? 0);
    // Raw Anthropic input excludes cache. Routstr publishes inclusive input
    // alongside the fresh count in its cost summary. A matching fresh count
    // indicates an unfolded (legacy) response. If the counts differ and the
    // wire total can fit the cache, preserve it; the cost count can be a zero
    // placeholder. Without a fresh count, assume raw usage: size alone cannot
    // distinguish a folded total from fresh input with a small cache.
    const isFolded =
      wireInput !== undefined && freshInput !== undefined &&
      wireInput !== freshInput && wireInput >= cached;
    promptTokens = isFolded ? wireInput : (wireInput ?? freshInput ?? 0) + cached;
  }
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);

  // OpenAI-style prompt cache details (e.g. Tinfoil/vLLM). These live on
  // `usage.prompt_tokens_details` rather than in a Routstr `cost` object.
  const promptDetails = usage.prompt_tokens_details;
  const details =
    promptDetails && typeof promptDetails === "object"
      ? (promptDetails as Record<string, unknown>)
      : undefined;

  const cost =
    typeof costValue === "number"
      ? costValue
      : numOrUndef(usageCost?.total_usd) ??
        numOrUndef(breakdownCost?.total_usd) ??
        0;
  const totalMsats = nonnegativeOrUndef(breakdownCost?.total_msats);
  const reportedSatsCost = totalMsats !== undefined
    ? totalMsats / 1000
    : nonnegativeOrUndef(usage.cost_sats);
  const satsCost = reportedSatsCost ?? fallbackSatsCost;

  const provider =
    typeof (body as { provider?: unknown }).provider === "string"
      ? ((body as { provider?: string }).provider as string)
      : undefined;

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cost === 0 &&
    satsCost === 0 &&
    reportedSatsCost === undefined
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    satsCost,
    ...(reportedSatsCost !== undefined ? { reportedSatsCost } : {}),
    provider,
    ...breakdown,
    cacheReadInputTokens: breakdown.cacheReadInputTokens ??
      tokenCount(details?.cached_tokens) ?? anthropicCacheRead,
    cacheCreationInputTokens: breakdown.cacheCreationInputTokens ??
      tokenCount(details?.created_cache_tokens) ?? anthropicCacheCreation,
  };
}

export function extractResponseId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractUsageFromSSEJson(
  parsed: any,
  fallbackSatsCost = 0
): UsageTrackingData | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const provider =
    typeof parsed.provider === "string" ? parsed.provider : undefined;

  // Anthropic message_start nests usage; normalize it before looking for a
  // standalone cost summary (which uses a different token-count convention).
  const usage = parsed.usage ?? parsed.message?.usage;
  if (!usage && parsed.cost && typeof parsed.cost === "object") {
    const costObj = parsed.cost;
    const msats = nonnegativeOrUndef(costObj.total_msats);
    const reportedSatsCost = msats !== undefined ? msats / 1000 : undefined;
    const cost = numOrUndef(costObj.total_usd) ?? 0;
    const satsCost = reportedSatsCost ?? fallbackSatsCost;
    const breakdown = extractCostBreakdown(costObj);
    // Routstr's cost contract always separates fresh input from cache tokens.
    const promptTokens = (tokenCount(costObj.input_tokens) ?? 0) +
      (breakdown.cacheReadInputTokens ?? 0) +
      (breakdown.cacheCreationInputTokens ?? 0);
    const completionTokens = tokenCount(costObj.output_tokens) ?? 0;
    if (reportedSatsCost === undefined && satsCost === 0 && cost === 0 &&
      promptTokens === 0 && completionTokens === 0) return null;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cost,
      satsCost,
      ...(reportedSatsCost !== undefined ? { reportedSatsCost } : {}),
      provider,
      ...breakdown,
    };
  }

  return extractUsageFromResponseBody(
    parsed.usage || !usage ? parsed : { ...parsed, usage },
    fallbackSatsCost
  );
}

/**
 * Extract cost/usage from response headers.
 *
 * For EHBP requests the proxy cannot inject cost into the JSON/SSE body
 * (the body is opaque encrypted), and image endpoints may relay raw image
 * bytes. Instead it returns cost as response headers. This parses those headers into the same UsageTrackingData
 * shape used for SSE/body extraction, so callers can merge or fall back.
 */
export function extractUsageFromResponseHeaders(
  headers: Headers | Record<string, string>
): UsageTrackingData | null {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    // Case-insensitive lookup for plain objects
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  };

  const rawTotalMsats = get("X-Routstr-Cost-Msats");
  if (rawTotalMsats === null || rawTotalMsats.trim() === "") return null;
  const totalMsats = nonnegativeOrUndef(Number(rawTotalMsats));
  if (totalMsats === undefined) return null;

  const rawImages = get("X-Routstr-Image-Count")?.trim();
  const count = rawImages && /^\d+$/.test(rawImages) ? Number(rawImages) : NaN;

  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: Number(get("X-Routstr-Cost-Usd")) || 0,
    satsCost: totalMsats / 1000,
    reportedSatsCost: totalMsats / 1000,
    totalMsats,
    inputMsats: Number(get("X-Routstr-Input-Cost-Msats")) || 0,
    outputMsats: Number(get("X-Routstr-Output-Cost-Msats")) || 0,
    totalUsd: Number(get("X-Routstr-Cost-Usd")) || undefined,
    outputImages: Number.isSafeInteger(count) ? count : undefined,
  };
}

export function toUsageStats(
  usage: UsageTrackingData | null | undefined
): UsageStats | undefined {
  if (!usage) return undefined;
  return {
    total_tokens: usage.totalTokens,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    cost: usage.cost,
    sats_cost: usage.satsCost,
  };
}
