import { describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../client/ProviderManager";
import type { ProviderRegistry } from "../wallet/interfaces";

const createRegistry = (overrides?: Partial<ProviderRegistry>) => {
  const registry: ProviderRegistry = {
    getModelsForProvider: () => [],
    getDisabledProviders: () => [],
    getProviderMints: () => [],
    getProviderInfo: async () => null,
    getAllProvidersModels: () => ({}),
    ...overrides,
  };
  return registry;
};

describe("ProviderManager pricing", () => {
  it("returns providers sorted by total pricing", () => {
    const registry = createRegistry({
      getAllProvidersModels: () => ({
        "https://alpha.example.com/": [
          {
            id: "openai/gpt-4o-mini",
            sats_pricing: { prompt: 1, completion: 2 },
          } as any,
        ],
        "https://beta.example.com/": [
          {
            id: "openai/gpt-4o-mini",
            sats_pricing: { prompt: 0.5, completion: 1 },
          } as any,
        ],
      }),
    });

    const manager = new ProviderManager(registry);

    const ranking =
      manager.getProviderPriceRankingForModel("openai/gpt-4o-mini");

    expect(ranking.map((entry) => entry.baseUrl)).toEqual([
      "https://beta.example.com/",
      "https://alpha.example.com/",
    ]);
  });

  it("normalizes model ids for matching", () => {
    const registry = createRegistry({
      getAllProvidersModels: () => ({
        "https://alpha.example.com/": [
          {
            id: "gpt-4o-mini",
            sats_pricing: { prompt: 1, completion: 1 },
          } as any,
        ],
      }),
    });

    const manager = new ProviderManager(registry);
    const best = manager.getBestProviderForModel("openai/gpt-4o-mini");

    expect(best).toBe("https://alpha.example.com/");
  });

  it("filters onion URLs when not in tor mode", () => {
    vi.stubGlobal("window", { location: { hostname: "example.com" } });

    const registry = createRegistry({
      getAllProvidersModels: () => ({
        "https://alpha.example.com/": [
          {
            id: "gpt-4o-mini",
            sats_pricing: { prompt: 1, completion: 1 },
          } as any,
        ],
        "http://onionaddress.onion/": [
          {
            id: "gpt-4o-mini",
            sats_pricing: { prompt: 0.1, completion: 0.1 },
          } as any,
        ],
      }),
    });

    const manager = new ProviderManager(registry);
    const providers = manager.getAllProvidersForModel("gpt-4o-mini");

    expect(providers.map((entry) => entry.baseUrl)).toEqual([
      "https://alpha.example.com/",
    ]);

    vi.unstubAllGlobals();
  });
});
