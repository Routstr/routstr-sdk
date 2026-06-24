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

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? 0);
  const costValue = usage.cost;

  let cost = 0;
  let satsCost = fallbackSatsCost;
  let breakdown: Partial<UsageTrackingData> = {};

  if (typeof costValue === "number") {
    cost = costValue;
  } else if (costValue && typeof costValue === "object") {
    const costObj = costValue as Record<string, unknown>;
    const totalUsd = costObj.total_usd;
    const totalMsats = costObj.total_msats;

    cost = typeof totalUsd === "number" ? totalUsd : 0;
    if (typeof totalMsats === "number") {
      satsCost = totalMsats / 1000;
    }
    breakdown = extractCostBreakdown(costObj);
  }

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

  if (!parsed.usage) {
    return null;
  }

  const usage = parsed.usage;
  const usageCost = usage.cost;
  
  let cost = 0;
  let msats = 0;
  let breakdown: Partial<UsageTrackingData> = {};

  if (typeof usageCost === "number") {
    cost = usageCost;
  } else if (usageCost && typeof usageCost === "object") {
    cost = usageCost.total_usd ?? 0;
    msats = usageCost.total_msats ?? 0;
    breakdown = extractCostBreakdown(usageCost as Record<string, unknown>);
  }

  // Some upstreams put the detailed breakdown under metadata.routstr.cost.
  const routstrCost = parsed.metadata?.routstr?.cost;
  if (routstrCost && typeof routstrCost === "object") {
    breakdown = { ...extractCostBreakdown(routstrCost), ...breakdown };
  }

  // Fallbacks if not in usage.cost
  if (cost === 0) {
    cost = parsed.metadata?.routstr?.cost?.total_usd ?? 0;
  }
  if (msats === 0) {
    msats =
      parsed.metadata?.routstr?.cost?.total_msats ??
      (typeof usage.cost_sats === "number" ? usage.cost_sats * 1000 : 0);
  }

  // Support both OpenAI-style (prompt_tokens/completion_tokens) and Anthropic-style (input_tokens/output_tokens)
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));

  const result: UsageTrackingData = {
    promptTokens,
    completionTokens,
    totalTokens,
    cost: Number(cost ?? 0),
    satsCost: msats > 0 ? msats / 1000 : fallbackSatsCost,
    provider,
    ...breakdown,
  };

  if (
    result.promptTokens === 0 &&
    result.completionTokens === 0 &&
    result.totalTokens === 0 &&
    result.cost === 0 &&
    result.satsCost === 0
  ) {
    return null;
  }

  return result;
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
