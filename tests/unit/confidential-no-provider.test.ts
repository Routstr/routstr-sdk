/**
 * A confidential request for a model no node serves confidentially is the
 * caller's error with a stable code (`no_confidential_provider`), routed or
 * on a pinned provider, so routstrd answers 400 with the message instead of
 * an opaque 502.
 */
import { describe, expect, it } from "vitest";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import { ConfidentialError, confidentialFailoverError } from "../../client/confidential/errors";
import type { Model } from "../../core/types";

const NODE = "https://node.example/";

function input(models: Model[], extra: Record<string, unknown> = {}) {
  const modelManager = {
    getBaseUrls: () => [NODE],
    getAllCachedModels: () => ({ [NODE]: models }),
  };
  const providerManager = {
    getProviderPriceRankingForModel: (id: string) =>
      models.filter((m) => m.id === id).map((model) => ({ baseUrl: NODE, model })),
    getModelPathProviderRanking: async () => [],
  };
  return {
    modelId: "m1",
    requireConfidential: true,
    walletAdapter: { getBalances: async () => ({}) },
    storageAdapter: {},
    discoveryAdapter: {
      getModelPathWhitelist: () => ({}),
      getModelIdMappings: () => null,
      getDisabledProviders: () => [],
      getCachedMints: () => ({}),
    },
    modelManager,
    providerManager,
    ...extra,
  } as never;
}

const plain = { id: "m1", name: "m1", sats_pricing: { prompt: 1, completion: 1, max_cost: 10 } } as Model;

async function codeOf(p: Promise<unknown>): Promise<{ code?: unknown; message: string; error: unknown }> {
  try {
    await p;
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message, error };
  }
  throw new Error("resolved");
}

describe("no node serves the model confidentially", () => {
  it("routed: no_confidential_provider", async () => {
    const r = await codeOf(resolveRequestContext(input([plain])));
    expect(r.error).toBeInstanceOf(ConfidentialError);
    expect(r.code).toBe("no_confidential_provider");
    expect(r.message).toBe("No provider offers model m1 confidentially");
    // The caller's fault: never failed over to another node.
    expect(confidentialFailoverError(r.error)).toBe(false);
  });

  it("pinned provider that offers the model only on the plain path", async () => {
    const r = await codeOf(resolveRequestContext(input([plain], { forcedProvider: NODE })));
    expect(r.code).toBe("no_confidential_provider");
    expect(r.message).toBe(`Provider ${NODE} does not offer model m1 confidentially`);
  });

  it("pinned provider that does not list the model", async () => {
    const r = await codeOf(resolveRequestContext(input([], { forcedProvider: NODE })));
    expect(r.code).toBe("no_confidential_provider");
    expect(r.message).toBe(`Provider ${NODE} does not offer model: m1`);
  });

  it("a plain request keeps the plain error", async () => {
    const r = await codeOf(resolveRequestContext(input([], { requireConfidential: false })));
    expect(r.error).not.toBeInstanceOf(ConfidentialError);
    expect(r.message).toBe("No providers found for model: m1");
  });
});
