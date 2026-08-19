import { describe, expect, it } from "vitest";
import {
  extractUsageFromResponseBody,
  extractUsageFromSSEJson,
} from "../../client/usage";

const costBreakdown = {
  base_msats: 0,
  input_msats: 24,
  output_msats: 63,
  total_msats: 87,
  total_usd: 0.000055570815,
  input_tokens: 129,
  output_tokens: 242,
};

const usage = {
  prompt_tokens: 129,
  completion_tokens: 242,
  total_tokens: 371,
  cost: 0.000055570815,
  cost_sats: 0,
};

describe("usage extraction", () => {
  it("preserves the Routstr cost breakdown for non-streaming responses", () => {
    const response = {
      usage,
      metadata: { routstr: { cost: costBreakdown } },
      cost: costBreakdown,
    };

    const nonStreaming = extractUsageFromResponseBody(response);
    const streaming = extractUsageFromSSEJson(response);

    expect(nonStreaming).toEqual({
      promptTokens: 129,
      completionTokens: 242,
      totalTokens: 371,
      cost: usage.cost,
      satsCost: 0.087,
      provider: undefined,
      baseMsats: 0,
      inputMsats: 24,
      outputMsats: 63,
      totalMsats: 87,
      totalUsd: usage.cost,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadMsats: undefined,
      cacheCreationMsats: undefined,
      remainingBalanceMsats: undefined,
    });
    expect(nonStreaming).toEqual(streaming);
  });

  it("uses metadata, top-level cost, then object-valued usage cost for breakdown fields", () => {
    const usageCost = {
      ...costBreakdown,
      input_msats: 3,
      output_msats: 4,
      total_msats: 7,
    };
    const topLevelCost = {
      ...costBreakdown,
      input_msats: 10,
      output_msats: 20,
      total_msats: 30,
    };
    const metadataCost = {
      ...costBreakdown,
      input_msats: 40,
      output_msats: 50,
      total_msats: 90,
    };

    const fromUsage = extractUsageFromResponseBody({
      usage: { ...usage, cost: usageCost },
    });
    const fromTopLevel = extractUsageFromResponseBody({
      usage: { ...usage, cost: usageCost },
      cost: topLevelCost,
    });
    const fromMetadata = extractUsageFromResponseBody({
      usage: { ...usage, cost: usageCost },
      cost: topLevelCost,
      metadata: { routstr: { cost: metadataCost } },
    });

    expect(fromUsage).toMatchObject({ inputMsats: 3, totalMsats: 7 });
    expect(fromTopLevel).toMatchObject({ inputMsats: 10, totalMsats: 30 });
    expect(fromMetadata).toMatchObject({
      inputMsats: 40,
      outputMsats: 50,
      totalMsats: 90,
      satsCost: 0.09,
    });
  });

  it("extracts OpenAI-style prompt_tokens_details cache tokens (Tinfoil/vLLM)", () => {
    const response = {
      id: "chatcmpl-aa8734bc7bae2956",
      usage: {
        prompt_tokens: 5481,
        completion_tokens: 14,
        total_tokens: 5495,
        prompt_tokens_details: {
          cached_tokens: 768,
          created_cache_tokens: 4608,
        },
      },
    };

    const body = extractUsageFromResponseBody(response);
    const streaming = extractUsageFromSSEJson(response);

    expect(body).toEqual(streaming);
    expect(body).toMatchObject({
      promptTokens: 5481,
      completionTokens: 14,
      totalTokens: 5495,
      cacheReadInputTokens: 768,
      cacheCreationInputTokens: 4608,
    });
  });

  it("prefers cost-object cache fields over prompt_tokens_details when both exist", () => {
    const response = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: {
          cached_tokens: 1,
          created_cache_tokens: 2,
        },
      },
      cost: {
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    };

    const extracted = extractUsageFromResponseBody(response);
    expect(extracted).toMatchObject({
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
    });
  });

  it("uses the same token and sats fallbacks for streaming and non-streaming responses", () => {
    const response = {
      provider: "test-provider",
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cost: 0.001,
        cost_sats: 5,
      },
    };

    expect(extractUsageFromResponseBody(response)).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      cost: 0.001,
      satsCost: 5,
      provider: "test-provider",
    });
    expect(extractUsageFromResponseBody(response)).toEqual(
      extractUsageFromSSEJson(response)
    );
  });
});
