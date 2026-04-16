import type { UsageStats } from "../core/types";

export interface UsageTrackingData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
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
  }

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
    };
  }

  if (!parsed.usage) {
    return null;
  }

  const usage = parsed.usage;
  const usageCost = usage.cost;
  
  let cost = 0;
  let msats = 0;

  if (typeof usageCost === "number") {
    cost = usageCost;
  } else if (usageCost && typeof usageCost === "object") {
    cost = usageCost.total_usd ?? 0;
    msats = usageCost.total_msats ?? 0;
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
