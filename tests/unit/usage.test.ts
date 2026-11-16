import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import {
  extractUsageFromResponseBody,
  extractUsageFromResponseHeaders,
  extractUsageFromSSEJson,
} from "../../client/usage";
import { createSSEParserTransform } from "../../client/sse";

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
      reportedSatsCost: 0.087,
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
      reportedSatsCost: 5,
      provider: "test-provider",
    });
    expect(extractUsageFromResponseBody(response)).toEqual(
      extractUsageFromSSEJson(response)
    );
  });
});


describe("Anthropic-shaped usage", () => {
  it("maps /v1/messages cache tokens into the total prompt count", () => {
    const response = {
      id: "msg_01ABC",
      type: "message",
      role: "assistant",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 63226,
        output_tokens: 7,
      },
    };

    const body = extractUsageFromResponseBody(response);
    expect(body).toMatchObject({
      promptTokens: 63228, // input + cache_read (Anthropic input_tokens excludes cached)
      completionTokens: 7,
      totalTokens: 63235,
      cacheReadInputTokens: 63226,
    });
    expect(extractUsageFromSSEJson(response)).toEqual(body);
  });

  it("sums cache_creation ephemeral 5m/1h buckets when the aggregate is absent", () => {
    const response = {
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_creation: {
          ephemeral_5m_input_tokens: 100,
          ephemeral_1h_input_tokens: 50,
        },
      },
    };

    expect(extractUsageFromResponseBody(response)).toMatchObject({
      promptTokens: 160, // 10 + 100 + 50
      completionTokens: 3,
      cacheCreationInputTokens: 150,
    });
  });

  it("prefers the aggregate cache_creation_input_tokens over the bucket split", () => {
    const response = {
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: 150,
        cache_creation: {
          ephemeral_5m_input_tokens: 999,
          ephemeral_1h_input_tokens: 999,
        },
      },
    };

    expect(extractUsageFromResponseBody(response)).toMatchObject({
      promptTokens: 160,
      cacheCreationInputTokens: 150,
    });
  });

  it("records no cache tokens for Anthropic usage without cache keys", () => {
    const response = {
      usage: { input_tokens: 12, output_tokens: 8 },
    };

    expect(extractUsageFromResponseBody(response)).toMatchObject({
      promptTokens: 12,
      completionTokens: 8,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });

  it("keeps the OpenAI shape byte-for-byte: prompt_tokens already includes cached subsets", () => {
    const response = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        input_tokens: 2,
        cache_read_input_tokens: 98,
      },
    };

    expect(extractUsageFromResponseBody(response)).toMatchObject({
      promptTokens: 100, // NOT 100 + 98
      completionTokens: 10,
      totalTokens: 110,
    });
  });

  it("returns null for genuinely empty usage", () => {
    expect(extractUsageFromResponseBody({ usage: {} })).toBeNull();
  });

  it("extracts usage across Anthropic message_start/message_delta SSE events", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_01ABC",
          type: "message",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 63226,
            output_tokens: 1,
          },
        },
      },
      { type: "message_delta", usage: { output_tokens: 8 } },
    ];

    const captured: Array<Record<string, unknown>> = [];
    const transform = createSSEParserTransform(usage => {
      captured.push({ ...usage });
    });
    const source = Readable.from(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`)
    );
    const merged = await new Promise<Record<string, unknown>>(resolve => {
      source.pipe(transform);
      transform.on("data", () => {});
      transform.on("end", () => resolve(captured.at(-1) ?? {}));
    });

    expect(merged).toMatchObject({
      promptTokens: 63228,
      completionTokens: 8,
      cacheReadInputTokens: 63226,
    });
  });
});

describe("reported sats-cost provenance", () => {
  it("distinguishes missing cost from an explicitly free response", () => {
    const missing = extractUsageFromResponseBody({ usage: { total_tokens: 1 } }, 7);
    expect(missing?.satsCost).toBe(7);
    expect(missing).not.toHaveProperty("reportedSatsCost");
    expect(extractUsageFromResponseBody({ usage: {} })).toBeNull();
    expect(extractUsageFromResponseBody({ usage: { cost_sats: 0 } }, 7))
      .toMatchObject({ satsCost: 0, reportedSatsCost: 0 });
    expect(extractUsageFromResponseBody({ usage: {}, cost: { total_msats: 0 } }, 7))
      .toMatchObject({ satsCost: 0, reportedSatsCost: 0 });
  });

  it.each([0, 0.125, 1.5])("preserves fractional or zero explicit cost: %s", value => {
    for (const extract of [extractUsageFromResponseBody, extractUsageFromSSEJson]) {
      expect(extract({ usage: { cost_sats: value } }, 7))
        .toMatchObject({ satsCost: value, reportedSatsCost: value });
      expect(extract({ usage: { cost_sats: 9 }, cost: { total_msats: value } }, 7))
        .toMatchObject({ satsCost: value / 1000, reportedSatsCost: value / 1000 });
    }
    expect(extractUsageFromSSEJson({ cost: { total_msats: value } }, 7))
      .toMatchObject({ satsCost: value / 1000, reportedSatsCost: value / 1000 });
  });

  it.each([-1, NaN, Infinity, -Infinity, "100", "", null, undefined])(
    "does not treat invalid body/standalone cost as reported: %s", value => {
      for (const field of ["cost_sats", "total_msats"]) {
        const body = field === "cost_sats"
          ? { usage: { total_tokens: 1, cost_sats: value } }
          : { usage: { total_tokens: 1 }, cost: { total_msats: value } };
        const result = extractUsageFromResponseBody(body, 7);
        expect(result?.satsCost).toBe(7);
        expect(result).not.toHaveProperty("reportedSatsCost");
      }
      const result = extractUsageFromSSEJson({ cost: { total_msats: value } }, 7);
      expect(result?.satsCost).toBe(7);
      expect(result).not.toHaveProperty("reportedSatsCost");
    },
  );

  it("falls back to valid cost_sats when total_msats is invalid", () => {
    expect(extractUsageFromResponseBody({ usage: { cost_sats: 0.25 }, cost: { total_msats: -1 } }))
      .toMatchObject({ satsCost: 0.25, reportedSatsCost: 0.25 });
  });

  it.each(["0", "0.5", "125"])("extracts valid header cost: %s", value => {
    for (const headers of [new Headers({ "X-Routstr-Cost-Msats": value }), { "x-routstr-cost-msats": value }]) {
      expect(extractUsageFromResponseHeaders(headers)).toMatchObject({
        satsCost: Number(value) / 1000,
        reportedSatsCost: Number(value) / 1000,
      });
    }
  });

  it.each(["", " ", "-1", "NaN", "Infinity", "invalid"])("rejects invalid header cost: %s", value => {
    expect(extractUsageFromResponseHeaders(new Headers({ "X-Routstr-Cost-Msats": value }))).toBeNull();
  });

  it("does not mistake missing header for zero", () => {
    expect(extractUsageFromResponseHeaders(new Headers())).toBeNull();
  });
});
