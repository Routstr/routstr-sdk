import type { UsageStats } from "../core/types";

export interface UsageTrackingData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
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
}

const numOrUndef = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
    totalMsats: numOrUndef(costObj.total_msats),
    totalUsd: numOrUndef(costObj.total_usd),
    cacheReadInputTokens: numOrUndef(costObj.cache_read_input_tokens),
    cacheCreationInputTokens: numOrUndef(costObj.cache_creation_input_tokens),
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

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? 0
  );
  const totalTokens = Number(
    usage.total_tokens ?? promptTokens + completionTokens
  );
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
  const totalMsats = numOrUndef(breakdownCost?.total_msats) ?? 0;
  const satsCost =
    totalMsats > 0
      ? totalMsats / 1000
      : numOrUndef(usage.cost_sats) ?? fallbackSatsCost;

  const provider =
    typeof (body as { provider?: unknown }).provider === "string"
      ? ((body as { provider?: string }).provider as string)
      : undefined;

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cost === 0 &&
    satsCost === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    satsCost,
    provider,
    ...breakdown,
    cacheReadInputTokens:
      breakdown.cacheReadInputTokens ?? numOrUndef(details?.cached_tokens),
    cacheCreationInputTokens:
      breakdown.cacheCreationInputTokens ??
      numOrUndef(details?.created_cache_tokens),
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

  // Handle standalone cost chunk: {"cost":{"base_msats":...,"input_msats":...,"output_msats":...,"total_msats":2,...}}
  if (!parsed.usage && parsed.cost && typeof parsed.cost === "object") {
    const costObj = parsed.cost;
    const msats = costObj.total_msats ?? 0;
    const cost = costObj.total_usd ?? 0;
    if (msats === 0 && cost === 0) return null;
    return {
      promptTokens: Number(costObj.input_tokens ?? 0),
      completionTokens: Number(costObj.output_tokens ?? 0),
      totalTokens: Number((costObj.input_tokens ?? 0) + (costObj.output_tokens ?? 0)),
      cost: Number(cost),
      satsCost: msats > 0 ? msats / 1000 : fallbackSatsCost,
      provider,
      ...extractCostBreakdown(costObj),
    };
  }

  return extractUsageFromResponseBody(parsed, fallbackSatsCost);
}

/**
 * Extract cost/usage from EHBP/Tinfoil response headers.
 *
 * For EHBP requests the proxy cannot inject cost into the JSON/SSE body
 * (the body is opaque encrypted). Instead it returns cost as response
 * headers. This parses those headers into the same UsageTrackingData
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

  const totalMsats = Number(get("X-Routstr-Cost-Msats"));
  if (!totalMsats || !Number.isFinite(totalMsats)) return null;

  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: Number(get("X-Routstr-Cost-Usd")) || 0,
    satsCost: totalMsats / 1000,
    totalMsats,
    inputMsats: Number(get("X-Routstr-Input-Cost-Msats")) || 0,
    outputMsats: Number(get("X-Routstr-Output-Cost-Msats")) || 0,
    totalUsd: Number(get("X-Routstr-Cost-Usd")) || undefined,
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
