import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MODEL_ID_MAPPINGS,
  canonicalIdForModel,
  findModelForId,
  modelIdentifiers,
} from "../../core/modelMappings";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";

const makeModel = (overrides?: Partial<Model>): Model =>
  ({
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
    ...overrides,
  } as Model);

// ---------------------------------------------------------------------------
// modelIdentifiers
// ---------------------------------------------------------------------------

describe("modelIdentifiers", () => {
  it("returns the native id and all declared aliases", () => {
    const m = makeModel({ id: "glm-zai-5.3", alias_ids: ["z-ai-glm-5-3", "glm-5.3"] });
    expect(modelIdentifiers(m)).toEqual(["glm-zai-5.3", "z-ai-glm-5-3", "glm-5.3"]);
  });

  it("returns just the id when no aliases are declared", () => {
    const m = makeModel({ id: "kimi-k3" });
    expect(modelIdentifiers(m)).toEqual(["kimi-k3"]);
  });
});

// ---------------------------------------------------------------------------
// canonicalIdForModel
// ---------------------------------------------------------------------------

describe("canonicalIdForModel", () => {
  it("keeps unmapped native ids as-is", () => {
    expect(canonicalIdForModel(makeModel({ id: "kimi-k3" }))).toBe("kimi-k3");
  });

  it("maps a provider-native id that is a map key", () => {
    expect(canonicalIdForModel(makeModel({ id: "z-ai-glm-5-3" }))).toBe("glm-5.3");
  });

  it("maps via a declared alias when the native id is not a map key", () => {
    const m = makeModel({ id: "glm-zai-5.3", alias_ids: ["z-ai-glm-5-3"] });
    expect(canonicalIdForModel(m)).toBe("glm-5.3");
  });

  it("prefers the native id mapping over alias mappings", () => {
    const m = makeModel({
      id: "z-ai-glm-5-3",
      alias_ids: ["openai-gpt-56-sol"],
    });
    expect(canonicalIdForModel(m)).toBe("glm-5.3");
  });
});

// ---------------------------------------------------------------------------
// findModelForId
// ---------------------------------------------------------------------------

describe("findModelForId", () => {
  it("finds exact native id matches", () => {
    const models = [makeModel({ id: "glm-5.3" })];
    expect(findModelForId(models, "glm-5.3")?.id).toBe("glm-5.3");
  });

  it("finds models via a statically mapped native id", () => {
    const models = [makeModel({ id: "z-ai-glm-5-3" })];
    expect(findModelForId(models, "glm-5.3")?.id).toBe("z-ai-glm-5-3");
  });

  it("finds models via a statically mapped alias of a different native id", () => {
    const models = [
      makeModel({ id: "glm-zai-5.3", alias_ids: ["z-ai-glm-5-3"] }),
    ];
    expect(findModelForId(models, "glm-5.3")?.id).toBe("glm-zai-5.3");
  });

  it("prefers an exact native match over a mapped one on the same provider", () => {
    const models = [
      makeModel({ id: "z-ai-glm-5-3" }),
      makeModel({ id: "glm-5.3" }),
    ];
    expect(findModelForId(models, "glm-5.3")?.id).toBe("glm-5.3");
  });

  it("returns undefined when nothing matches", () => {
    const models = [makeModel({ id: "claude-opus-5" })];
    expect(findModelForId(models, "glm-5.3")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// map hygiene
// ---------------------------------------------------------------------------

describe("MODEL_ID_MAPPINGS hygiene", () => {
  it("is single-hop: no map value is also a map key", () => {
    for (const [variant, canonical] of Object.entries(MODEL_ID_MAPPINGS)) {
      expect(
        MODEL_ID_MAPPINGS[canonical],
        `mapping ${variant} -> ${canonical} chains into another mapping`,
      ).toBeUndefined();
    }
  });

  it("never maps an id to itself", () => {
    for (const [variant, canonical] of Object.entries(MODEL_ID_MAPPINGS)) {
      expect(variant).not.toBe(canonical);
    }
  });
});

// ---------------------------------------------------------------------------
// ranking integration
// ---------------------------------------------------------------------------

const createRegistry = (overrides?: Partial<DiscoveryAdapter>) => {
  const registry: DiscoveryAdapter = {
    getCachedModels: () => ({}),
    setCachedModels: () => {},
    getCachedMints: () => ({}),
    setCachedMints: () => {},
    getCachedProviderInfo: () => ({}),
    setCachedProviderInfo: () => {},
    getProviderLastUpdate: () => null,
    setProviderLastUpdate: () => {},
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    setDisabledProviders: () => {},
    getBaseUrlsList: () => [],
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
    ...overrides,
  };
  return registry;
};

describe("getProviderPriceRankingForModel with model mappings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ranks providers serving the model under mapped ids or aliases", () => {
    vi.stubGlobal("window", { location: { hostname: "example.com" } });

    const registry = createRegistry({
      getCachedModels: () => ({
        // native canonical id
        "https://cheap.example.com/": [
          makeModel({ id: "glm-5.3", sats_pricing: { prompt: 0.001, completion: 0.003 } }),
        ],
        // mapped via native id (z-ai-glm-5-3 -> glm-5.3)
        "https://cypherpunk.example.com/": [
          makeModel({ id: "z-ai-glm-5-3", sats_pricing: { prompt: 0.002, completion: 0.006 } }),
        ],
        // mapped via alias (native glm-zai-5.3, alias z-ai-glm-5-3)
        "https://aliased.example.com/": [
          makeModel({
            id: "glm-zai-5.3",
            alias_ids: ["z-ai-glm-5-3"],
            sats_pricing: { prompt: 0.0015, completion: 0.0045 },
          }),
        ],
        // unrelated provider
        "https://other.example.com/": [
          makeModel({ id: "claude-opus-5", sats_pricing: { prompt: 0.0001, completion: 0.0001 } }),
        ],
      }),
    });

    const manager = new ProviderManager(registry);
    const ranking = manager.getProviderPriceRankingForModel("glm-5.3");

    expect(ranking.map((r) => r.baseUrl)).toEqual([
      "https://cheap.example.com/",
      "https://aliased.example.com/",
      "https://cypherpunk.example.com/",
    ]);
    // Ranking entries keep the provider-native id for request forwarding.
    expect(ranking.map((r) => r.model.id)).toEqual([
      "glm-5.3",
      "glm-zai-5.3",
      "z-ai-glm-5-3",
    ]);
  });

  it("does not let a mapping shadow a natively served model", () => {
    vi.stubGlobal("window", { location: { hostname: "example.com" } });

    const registry = createRegistry({
      getCachedModels: () => ({
        "https://both.example.com/": [
          makeModel({ id: "glm-5.3", sats_pricing: { prompt: 0.002, completion: 0.006 } }),
          makeModel({ id: "z-ai-glm-5-3", sats_pricing: { prompt: 0.001, completion: 0.003 } }),
        ],
      }),
    });

    const manager = new ProviderManager(registry);
    const ranking = manager.getProviderPriceRankingForModel("glm-5.3");

    // One entry per provider, priced as the native glm-5.3 (0.008 total),
    // not the cheaper mapped variant.
    expect(ranking).toHaveLength(1);
    expect(ranking[0].model.id).toBe("glm-5.3");
  });
});
