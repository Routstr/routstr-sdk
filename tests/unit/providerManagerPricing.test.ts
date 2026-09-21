import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeModel = (overrides?: Partial<Model>): Model => ({
  id: "gpt-4o-mini",
  name: "GPT-4o Mini",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  ...overrides,
} as Model);

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

/** Stub window for clearnet (non-Tor) tests */
const stubClearnetWindow = () =>
  vi.stubGlobal("window", { location: { hostname: "example.com" } });

/** Stub window for Tor tests */
const stubTorWindow = () =>
  vi.stubGlobal("window", { location: { hostname: "abc123.onion" } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderManager", () => {
  // ---- model discovery & pricing ----

  describe("model discovery and pricing", () => {
    it("returns providers sorted by total pricing", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
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

      expect(ranking.map((e) => e.baseUrl)).toEqual([
        "https://beta.example.com/",
        "https://alpha.example.com/",
      ]);
    });

    it("returns the cheapest provider for a model", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://expensive.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 10, completion: 10 },
            } as any,
          ],
          "https://cheap.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.1, completion: 0.1 },
            } as any,
          ],
          "https://mid.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 5, completion: 5 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const best = manager.getBestProviderForModel("gpt-4o-mini");

      expect(best).toBe("https://cheap.example.com/");
    });

    it("returns null when no provider has the model", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "other-model",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(manager.getBestProviderForModel("gpt-4o-mini")).toBeNull();
    });

    it("returns calculated per-million prices in ranking", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.15, completion: 0.60 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const [entry] = manager.getProviderPriceRankingForModel("gpt-4o-mini");

      expect(entry.promptPerMillion).toBe(150_000);
      expect(entry.completionPerMillion).toBe(600_000);
      expect(entry.totalPerMillion).toBe(750_000);
    });

    it("skips providers without sats_pricing", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            { id: "gpt-4o-mini" } as any, // no sats_pricing
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.getProviderPriceRankingForModel("gpt-4o-mini")
      ).toHaveLength(0);
    });

    it("skips providers where prompt or completion is not a number", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 } as any,
            },
          ],
          "https://beta.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: null } as any,
            },
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.getProviderPriceRankingForModel("gpt-4o-mini")
      ).toHaveLength(1);
    });

    it("alphabetical tiebreak when total prices are equal", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://zulu.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const ranking =
        manager.getProviderPriceRankingForModel("gpt-4o-mini");

      expect(ranking.map((e) => e.baseUrl)).toEqual([
        "https://alpha.example.com/",
        "https://zulu.example.com/",
      ]);
    });
  });

  // ---- provider filtering ----

  describe("provider filtering", () => {
    beforeEach(() => stubClearnetWindow());
    afterEach(() => vi.unstubAllGlobals());

    it("filters onion URLs when not in tor mode (getAllProvidersForModel)", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
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

      expect(providers.map((e) => e.baseUrl)).toEqual([
        "https://alpha.example.com/",
      ]);
    });

    it("filters onion URLs in getProviderPriceRankingForModel", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "http://hidden.onion/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.1, completion: 0.1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const ranking =
        manager.getProviderPriceRankingForModel("gpt-4o-mini");

      expect(ranking).toHaveLength(1);
      expect(ranking[0].baseUrl).toBe("https://alpha.example.com/");
    });

    it("includes onion URLs when torMode=true in getProviderPriceRankingForModel", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "http://hidden.onion/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.1, completion: 0.1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const ranking = manager.getProviderPriceRankingForModel("gpt-4o-mini", {
        torMode: true,
      });

      expect(ranking).toHaveLength(1);
      expect(ranking[0].baseUrl).toBe("http://hidden.onion/");
    });

    it("torMode=true excludes clearnet URLs from ranking", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://clearnet.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "http://hidden.onion/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.5, completion: 0.5 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const ranking = manager.getProviderPriceRankingForModel("gpt-4o-mini", {
        torMode: true,
      });

      expect(ranking).toHaveLength(1);
      expect(ranking[0].baseUrl).toBe("http://hidden.onion/");
    });

    it("filters disabled providers", () => {
      const registry = createRegistry({
        getDisabledProviders: () => ["https://disabled.example.com/"],
        getCachedModels: () => ({
          "https://disabled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 100, completion: 100 },
            } as any,
          ],
          "https://enabled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const providers = manager.getAllProvidersForModel("gpt-4o-mini");

      expect(providers).toHaveLength(1);
      expect(providers[0].baseUrl).toBe("https://enabled.example.com/");
    });

    it("includes disabled when includeDisabled=true", () => {
      const registry = createRegistry({
        getDisabledProviders: () => ["https://disabled.example.com/"],
        getCachedModels: () => ({
          "https://disabled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 100, completion: 100 },
            } as any,
          ],
          "https://enabled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const ranking = manager.getProviderPriceRankingForModel("gpt-4o-mini", {
        includeDisabled: true,
      });

      expect(ranking.map((e) => e.baseUrl)).toEqual([
        "https://enabled.example.com/",
        "https://disabled.example.com/",
      ]);
    });

    it("filters providers on cooldown", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "https://beta.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.5, completion: 0.5 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);

      // Put beta on cooldown with two rapid failures
      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://beta.example.com/");
      vi.setSystemTime(now + 5_000);
      manager.markFailed("https://beta.example.com/");

      // Beta should be excluded, leaving only alpha
      const providers = manager.getAllProvidersForModel("gpt-4o-mini");
      expect(providers).toHaveLength(1);
      expect(providers[0].baseUrl).toBe("https://alpha.example.com/");

      vi.useRealTimers();
    });
  });

  // ---- failover (findNextBestProvider) ----

  describe("findNextBestProvider (failover)", () => {
    beforeEach(() => stubClearnetWindow());
    afterEach(() => vi.unstubAllGlobals());

    it("returns cheapest available provider", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://expensive.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 10, completion: 10 },
            } as any,
          ],
          "https://cheap.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.findNextBestProvider("gpt-4o-mini", "https://some-other.example.com/")
      ).toBe("https://cheap.example.com/");
    });

    it("skips the current provider", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "https://beta.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 2, completion: 2 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const result = manager.findNextBestProvider(
        "gpt-4o-mini",
        "https://alpha.example.com/"
      );

      // Alpha is current so it's skipped — beta is the only candidate
      expect(result).toBe("https://beta.example.com/");
    });

    it("skips disabled providers", () => {
      const registry = createRegistry({
        getDisabledProviders: () => ["https://disabled.example.com/"],
        getCachedModels: () => ({
          "https://disabled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "https://enabled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 2, completion: 2 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.findNextBestProvider("gpt-4o-mini", "https://other.example.com/")
      ).toBe("https://enabled.example.com/");
    });

    it("skips providers on cooldown", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://cooled.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "https://healthy.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 2, completion: 2 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);

      // Trigger cooldown with two rapid failures
      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://cooled.example.com/");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://cooled.example.com/");

      const result = manager.findNextBestProvider(
        "gpt-4o-mini",
        "https://other.example.com/"
      );
      expect(result).toBe("https://healthy.example.com/");

      vi.useRealTimers();
    });

    it("skips onion when not in tor mode", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "http://dark.onion/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.1, completion: 0.1 },
            } as any,
          ],
          "https://clearnet.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.findNextBestProvider("gpt-4o-mini", "https://current.example.com/")
      ).toBe("https://clearnet.example.com/");
    });

    it("includes onion in Tor mode", () => {
      stubTorWindow();

      const registry = createRegistry({
        getCachedModels: () => ({
          "http://dark.onion/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 0.1, completion: 0.1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.findNextBestProvider("gpt-4o-mini", "https://current.example.com/")
      ).toBe("http://dark.onion/");

      vi.unstubAllGlobals();
    });

    it("returns null when no candidates remain", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      // Alpha IS the current provider, so it's skipped — no one left
      expect(
        manager.findNextBestProvider(
          "gpt-4o-mini",
          "https://alpha.example.com/"
        )
      ).toBeNull();
    });

    it("returns null when no provider has the model", () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "other-model",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.findNextBestProvider("gpt-4o-mini", "https://else.example.com/")
      ).toBeNull();
    });
  });

  // ---- cooldown state machine ----

  describe("cooldown state machine", () => {
    it("returns cooldown duration", () => {
      const manager = new ProviderManager(createRegistry());
      expect(manager.getCooldownDurationMs()).toBe(210_000);
    });

    it("isOnCooldown returns false initially", () => {
      const manager = new ProviderManager(createRegistry());
      expect(manager.isOnCooldown("https://any.example.com/")).toBe(false);
    });

    it("single failure does not trigger cooldown", () => {
      const manager = new ProviderManager(createRegistry());
      manager.markFailed("https://alpha.example.com/");

      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(false);
      expect(manager.hasFailed("https://alpha.example.com/")).toBe(true);
    });

    it("two failures within cooldown window trigger cooldown", () => {
      const manager = new ProviderManager(createRegistry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/");

      // Second failure well within the cooldown window
      vi.setSystemTime(t0 + 5_000);
      manager.markFailed("https://alpha.example.com/");

      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(true);

      vi.useRealTimers();
    });

    it("two failures outside cooldown window do not trigger cooldown", () => {
      const manager = new ProviderManager(createRegistry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/");

      // Second failure after the cooldown window
      vi.setSystemTime(t0 + manager.getCooldownDurationMs() + 1_000);
      manager.markFailed("https://alpha.example.com/");

      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(false);
      expect(manager.hasFailed("https://alpha.example.com/")).toBe(true);

      vi.useRealTimers();
    });

    it("cooldown expires after duration elapses", () => {
      const manager = new ProviderManager(createRegistry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/");
      vi.setSystemTime(t0 + 1_000);
      manager.markFailed("https://alpha.example.com/");

      // Provider is on cooldown
      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(true);

      // Advance past cooldown duration from the second failure
      vi.setSystemTime(t0 + 1_000 + manager.getCooldownDurationMs() + 1);

      // cleanupExpiredCooldowns runs inside isOnCooldown
      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(false);
      // The expired cooldown also clears the failed provider
      expect(manager.hasFailed("https://alpha.example.com/")).toBe(false);

      vi.useRealTimers();
    });

    it("removeFromCooldown manually removes a provider", () => {
      const manager = new ProviderManager(createRegistry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/");
      vi.setSystemTime(t0 + 1_000);
      manager.markFailed("https://alpha.example.com/");

      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(true);

      manager.removeFromCooldown("https://alpha.example.com/");
      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(false);

      vi.useRealTimers();
    });

    it("clearCooldowns clears all cooldowns", () => {
      const manager = new ProviderManager(createRegistry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/");
      manager.markFailed("https://beta.example.com/");
      vi.setSystemTime(t0 + 1_000);
      manager.markFailed("https://alpha.example.com/");
      manager.markFailed("https://beta.example.com/");

      expect(manager.getProvidersOnCooldown()).toHaveLength(2);

      manager.clearCooldowns();
      expect(manager.getProvidersOnCooldown()).toHaveLength(0);
      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(false);
      expect(manager.isOnCooldown("https://beta.example.com/")).toBe(false);

      vi.useRealTimers();
    });

    it("getProvidersOnCooldown returns current cooldowns with timestamps", () => {
      const manager = new ProviderManager(createRegistry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/");
      vi.setSystemTime(t0 + 1_000);
      manager.markFailed("https://alpha.example.com/");

      const cooldowns = manager.getProvidersOnCooldown();
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0].baseUrl).toBe("https://alpha.example.com/");
      expect(cooldowns[0].timestamp).toBe(t0 + 1_000); // timestamp of second failure
      // provider-scoped: no modelId on the entry
      expect(cooldowns[0].modelId).toBeUndefined();

      vi.useRealTimers();
    });

    it("clearFailureHistory clears all lastFailed timestamps", () => {
      const manager = new ProviderManager(createRegistry());

      manager.markFailed("https://alpha.example.com/");
      expect(manager.getLastFailed("https://alpha.example.com/")).toBeDefined();

      manager.clearFailureHistory();
      expect(manager.getLastFailed("https://alpha.example.com/")).toBeUndefined();
      // But it's still in failedProviders unless we also reset
      expect(manager.hasFailed("https://alpha.example.com/")).toBe(true);
    });
  });

  // ---- model-scoped cooldown ----

  describe("model-scoped cooldown", () => {
    const registry = () =>
      createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
            {
              id: "claude-3",
              sats_pricing: { prompt: 2, completion: 2 },
            } as any,
          ],
          "https://beta.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: 5, completion: 5 },
            } as any,
            {
              id: "claude-3",
              sats_pricing: { prompt: 5, completion: 5 },
            } as any,
          ],
        }),
      });

    it("cools down only the failed model on a provider, not the whole provider", () => {
      const manager = new ProviderManager(registry());

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");

      // Second strike: only gpt-4o-mini on alpha is cooled down
      expect(manager.isOnCooldown("https://alpha.example.com/", "gpt-4o-mini")).toBe(
        true
      );
      // Other models on the same provider are still selectable
      expect(manager.isOnCooldown("https://alpha.example.com/", "claude-3")).toBe(
        false
      );
      // Without a model, the provider as a whole is NOT considered down
      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(false);

      // The provider stays in ranking/selection for its other model
      const providers = manager.getAllProvidersForModel("claude-3");
      expect(providers.map((p) => p.baseUrl)).toEqual([
        "https://alpha.example.com/",
        "https://beta.example.com/",
      ]);
      // But is excluded for the cooled model
      const cooled = manager.getAllProvidersForModel("gpt-4o-mini");
      expect(cooled.map((p) => p.baseUrl)).toEqual(["https://beta.example.com/"]);

      vi.useRealTimers();
    });

    it("model-scoped strikes do not cross-contaminate: one failure per model does not trigger cooldown", () => {
      const manager = new ProviderManager(registry());

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://alpha.example.com/", undefined, "claude-3");

      // Two failures on the same provider but different models: no cooldown
      expect(manager.isOnCooldown("https://alpha.example.com/", "gpt-4o-mini")).toBe(
        false
      );
      expect(manager.isOnCooldown("https://alpha.example.com/", "claude-3")).toBe(
        false
      );
      expect(manager.getProvidersOnCooldown()).toHaveLength(0);

      vi.useRealTimers();
    });

    it("a provider-scoped failure (no modelId) cools down every model on the provider", () => {
      const manager = new ProviderManager(registry());

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://alpha.example.com/");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://alpha.example.com/");

      expect(manager.isOnCooldown("https://alpha.example.com/")).toBe(true);
      expect(manager.isOnCooldown("https://alpha.example.com/", "gpt-4o-mini")).toBe(
        true
      );
      expect(manager.isOnCooldown("https://alpha.example.com/", "claude-3")).toBe(
        true
      );
      // Other providers are unaffected
      expect(manager.isOnCooldown("https://beta.example.com/")).toBe(false);

      vi.useRealTimers();
    });

    it("findNextBestProvider skips a provider only for the cooled model", () => {
      const manager = new ProviderManager(registry());

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");

      // For gpt-4o-mini, alpha is skipped
      expect(
        manager.findNextBestProvider("gpt-4o-mini", "https://other.example.com/")
      ).toBe("https://beta.example.com/");
      // For claude-3, alpha is still a candidate (cheapest)
      expect(
        manager.findNextBestProvider("claude-3", "https://other.example.com/")
      ).toBe("https://alpha.example.com/");

      vi.useRealTimers();
    });

    it("getProviderPriceRankingForModel excludes a provider only for the cooled model", () => {
      const manager = new ProviderManager(registry());

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");

      expect(
        manager
          .getProviderPriceRankingForModel("gpt-4o-mini")
          .map((e) => e.baseUrl)
      ).toEqual(["https://beta.example.com/"]);
      expect(
        manager
          .getProviderPriceRankingForModel("claude-3")
          .map((e) => e.baseUrl)
      ).toEqual(["https://alpha.example.com/", "https://beta.example.com/"]);

      vi.useRealTimers();
    });

    it("removeFromCooldown with modelId releases only that model", () => {
      const manager = new ProviderManager(registry());

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(now + 1_000);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(now + 2_000);
      manager.markFailed("https://alpha.example.com/", undefined, "claude-3");
      vi.setSystemTime(now + 3_000);
      manager.markFailed("https://alpha.example.com/", undefined, "claude-3");

      expect(manager.getProvidersOnCooldown()).toHaveLength(2);

      manager.removeFromCooldown("https://alpha.example.com/", "gpt-4o-mini");
      const remaining = manager.getProvidersOnCooldown();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].modelId).toBe("claude-3");
      expect(manager.isOnCooldown("https://alpha.example.com/", "gpt-4o-mini")).toBe(
        false
      );
      expect(manager.isOnCooldown("https://alpha.example.com/", "claude-3")).toBe(
        true
      );

      // Without modelId, every entry for the provider is released
      manager.removeFromCooldown("https://alpha.example.com/");
      expect(manager.getProvidersOnCooldown()).toHaveLength(0);

      vi.useRealTimers();
    });

    it("cooldown entries carry modelId and expire independently", () => {
      const manager = new ProviderManager(registry());

      const t0 = Date.now();
      vi.setSystemTime(t0);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      vi.setSystemTime(t0 + 1_000);
      manager.markFailed("https://alpha.example.com/", undefined, "gpt-4o-mini");
      // claude-3 goes on cooldown slightly later
      vi.setSystemTime(t0 + 10_000);
      manager.markFailed("https://alpha.example.com/", undefined, "claude-3");
      vi.setSystemTime(t0 + 11_000);
      manager.markFailed("https://alpha.example.com/", undefined, "claude-3");

      const entries = manager.getProvidersOnCooldown();
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.modelId === "gpt-4o-mini")).toHaveLength(1);
      expect(entries.filter((e) => e.modelId === "claude-3")).toHaveLength(1);
      expect(entries.every((e) => e.baseUrl === "https://alpha.example.com/")).toBe(
        true
      );

      // After the full cooldown window, both entries expire
      vi.setSystemTime(t0 + 11_000 + manager.getCooldownDurationMs() + 1);
      expect(manager.getProvidersOnCooldown()).toHaveLength(0);
      expect(manager.isOnCooldown("https://alpha.example.com/", "gpt-4o-mini")).toBe(
        false
      );

      vi.useRealTimers();
    });

    it("expiry of a provider-wide entry keeps live model-scoped entries in the store", () => {
      // Stateful store stub mirroring storage/store.ts semantics
      const state: {
        failedProviders: string[];
        lastFailed: Record<string, number>;
        providersOnCooldown: Array<{
          baseUrl: string;
          modelId?: string;
          timestamp: number;
        }>;
      } = { failedProviders: [], lastFailed: {}, providersOnCooldown: [] };
      const store = {
        getState: () => ({
          ...state,
          setLastFailedTimestamp: (b: string, ts: number) => {
            state.lastFailed[b] = ts;
          },
          addFailedProvider: (b: string) => {
            if (!state.failedProviders.includes(b)) state.failedProviders.push(b);
          },
          removeFailedProvider: (b: string) => {
            state.failedProviders = state.failedProviders.filter((x) => x !== b);
          },
          addProviderOnCooldown: (b: string, ts: number, m?: string) => {
            if (
              !state.providersOnCooldown.some(
                (e) => e.baseUrl === b && e.modelId === m
              )
            ) {
              state.providersOnCooldown.push({
                baseUrl: b,
                modelId: m,
                timestamp: ts,
              });
            }
          },
          removeProviderFromCooldown: (b: string, m?: string) => {
            state.providersOnCooldown = state.providersOnCooldown.filter(
              (e) => !(e.baseUrl === b && e.modelId === m)
            );
          },
          removeAllProviderCooldowns: (b: string) => {
            state.providersOnCooldown = state.providersOnCooldown.filter(
              (e) => e.baseUrl !== b
            );
          },
          clearProvidersOnCooldown: () => {
            state.providersOnCooldown = [];
          },
          setLastFailed: vi.fn(),
          setFailedProviders: vi.fn(),
        }),
      } as any;

      const manager = new ProviderManager(registry(), store);
      const P = "https://alpha.example.com/";
      const t0 = Date.now();

      // Provider-wide cooldown created at t0+1s (expires at t0+211s)
      vi.setSystemTime(t0);
      manager.markFailed(P);
      vi.setSystemTime(t0 + 1_000);
      manager.markFailed(P);

      // Model-scoped cooldown for gpt-4o-mini created at t0+101s (expires t0+311s)
      vi.setSystemTime(t0 + 100_000);
      manager.markFailed(P, undefined, "gpt-4o-mini");
      vi.setSystemTime(t0 + 101_000);
      manager.markFailed(P, undefined, "gpt-4o-mini");

      expect(state.providersOnCooldown).toHaveLength(2);

      // At t0+212s the provider-wide entry has expired while the model-scoped
      // entry is still live: memory and store must agree on that.
      vi.setSystemTime(t0 + 212_000);
      expect(manager.isOnCooldown(P, "gpt-4o-mini")).toBe(true);
      expect(manager.isOnCooldown(P)).toBe(false);
      expect(state.providersOnCooldown).toHaveLength(1);
      expect(state.providersOnCooldown[0].modelId).toBe("gpt-4o-mini");

      // Provider-wide release clears the remaining model-scoped entry too
      manager.removeFromCooldown(P);
      expect(state.providersOnCooldown).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  describe("path-scoped cooldown", () => {
    const DEEPSEEK_PATH =
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
    const FIREWORKS_PATH =
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks";

    const registry = () =>
      createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "deepseek-v4.1-flash",
              sats_pricing: { prompt: 1, completion: 1 },
            } as any,
          ],
          "https://beta.example.com/": [
            {
              id: "deepseek-v4.1-flash",
              sats_pricing: { prompt: 2, completion: 2 },
            } as any,
          ],
        }),
      });

    it("cools down only the failed path, not the model or the provider", () => {
      const manager = new ProviderManager(registry());
      const P = "https://alpha.example.com/";

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);
      vi.setSystemTime(now + 1_000);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);

      // Second strike: only this path on alpha is cooled down
      expect(
        manager.isOnCooldown(P, "deepseek-v4.1-flash", DEEPSEEK_PATH)
      ).toBe(true);
      // The other route on the same node is still usable
      expect(
        manager.isOnCooldown(P, "deepseek-v4.1-flash", FIREWORKS_PATH)
      ).toBe(false);
      // Neither the model nor the provider as a whole is cooled
      expect(manager.isOnCooldown(P, "deepseek-v4.1-flash")).toBe(false);
      expect(manager.isOnCooldown(P)).toBe(false);

      // Unpinned model ranking is unaffected by path-scoped entries
      const providers = manager.getAllProvidersForModel("deepseek-v4.1-flash");
      expect(providers.map((p) => p.baseUrl)).toEqual([
        "https://alpha.example.com/",
        "https://beta.example.com/",
      ]);

      vi.useRealTimers();
    });
    
    it("model- and path-scoped failures on the same model track separate strikes", () => {
      const manager = new ProviderManager(registry());
      const P = "https://alpha.example.com/";

      const now = Date.now();
      // One model-scoped failure + one path-scoped failure: no cooldown yet,
      // because strikes are counted per scope.
      vi.setSystemTime(now);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash");
      vi.setSystemTime(now + 1_000);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);

      expect(manager.isOnCooldown(P, "deepseek-v4.1-flash")).toBe(false);
      expect(
        manager.isOnCooldown(P, "deepseek-v4.1-flash", DEEPSEEK_PATH)
      ).toBe(false);

      // A second path-scoped failure completes the path's two-strike cooldown
      vi.setSystemTime(now + 2_000);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);
      expect(
        manager.isOnCooldown(P, "deepseek-v4.1-flash", DEEPSEEK_PATH)
      ).toBe(true);
      expect(manager.isOnCooldown(P, "deepseek-v4.1-flash")).toBe(false);

      vi.useRealTimers();
    });

    it("removeFromCooldown with modelPath releases only that path", () => {
      const manager = new ProviderManager(registry());
      const P = "https://alpha.example.com/";

      const now = Date.now();
      vi.setSystemTime(now);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);
      vi.setSystemTime(now + 1_000);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);
      vi.setSystemTime(now + 2_000);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", FIREWORKS_PATH);
      vi.setSystemTime(now + 3_000);
      manager.markFailed(P, undefined, "deepseek-v4.1-flash", FIREWORKS_PATH);

      expect(manager.getProvidersOnCooldown()).toHaveLength(2);

      manager.removeFromCooldown(P, "deepseek-v4.1-flash", DEEPSEEK_PATH);
      const remaining = manager.getProvidersOnCooldown();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].modelPath).toBe(FIREWORKS_PATH);
      expect(
        manager.isOnCooldown(P, "deepseek-v4.1-flash", DEEPSEEK_PATH)
      ).toBe(false);
      expect(
        manager.isOnCooldown(P, "deepseek-v4.1-flash", FIREWORKS_PATH)
      ).toBe(true);

      vi.useRealTimers();
    });

    it("persists and rehydrates path-scoped entries", () => {
      const state: {
        providersOnCooldown: Array<{
          baseUrl: string;
          modelId?: string;
          modelPath?: string;
          timestamp: number;
        }>;
      } = { providersOnCooldown: [] };
      const store = {
        getState: () => ({
          failedProviders: [],
          lastFailed: {},
          ...state,
          setLastFailedTimestamp: vi.fn(),
          addFailedProvider: vi.fn(),
          removeFailedProvider: vi.fn(),
          addProviderOnCooldown: (
            b: string,
            ts: number,
            m?: string,
            p?: string
          ) => {
            if (
              !state.providersOnCooldown.some(
                (e) =>
                  e.baseUrl === b && e.modelId === m && e.modelPath === p
              )
            ) {
              state.providersOnCooldown.push({
                baseUrl: b,
                modelId: m,
                modelPath: p,
                timestamp: ts,
              });
            }
          },
          removeProviderFromCooldown: (b: string, m?: string, p?: string) => {
            state.providersOnCooldown = state.providersOnCooldown.filter(
              (e) =>
                !(e.baseUrl === b && e.modelId === m && e.modelPath === p)
            );
          },
          removeAllProviderCooldowns: (b: string) => {
            state.providersOnCooldown = state.providersOnCooldown.filter(
              (e) => e.baseUrl !== b
            );
          },
          clearProvidersOnCooldown: () => {
            state.providersOnCooldown = [];
          },
          setLastFailed: vi.fn(),
          setFailedProviders: vi.fn(),
        }),
      } as any;

      const P = "https://alpha.example.com/";
      const now = Date.now();
      vi.setSystemTime(now);
      const first = new ProviderManager(registry(), store);
      first.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);
      vi.setSystemTime(now + 1_000);
      first.markFailed(P, undefined, "deepseek-v4.1-flash", DEEPSEEK_PATH);

      expect(state.providersOnCooldown).toEqual([
        {
          baseUrl: P,
          modelId: "deepseek-v4.1-flash",
          modelPath: DEEPSEEK_PATH,
          timestamp: now + 1_000,
        },
      ]);

      // A fresh manager hydrating from the same store sees the path cooldown
      const second = new ProviderManager(registry(), store);
      expect(
        second.isOnCooldown(P, "deepseek-v4.1-flash", DEEPSEEK_PATH)
      ).toBe(true);
      expect(
        second.isOnCooldown(P, "deepseek-v4.1-flash", FIREWORKS_PATH)
      ).toBe(false);

      vi.useRealTimers();
    });
  });

  // ---- failure tracking ----

  describe("failure tracking", () => {
    it("hasFailed returns true after markFailed", () => {
      const manager = new ProviderManager(createRegistry());
      manager.markFailed("https://alpha.example.com/");
      expect(manager.hasFailed("https://alpha.example.com/")).toBe(true);
    });

    it("hasFailed returns false for never-failed provider", () => {
      const manager = new ProviderManager(createRegistry());
      expect(manager.hasFailed("https://alpha.example.com/")).toBe(false);
    });

    it("getFailedProviders returns a copy", () => {
      const manager = new ProviderManager(createRegistry());
      manager.markFailed("https://alpha.example.com/");

      const copy = manager.getFailedProviders();
      copy.add("https://beta.example.com/");

      // Original should not be mutated
      expect(manager.getFailedProviders().has("https://beta.example.com/")).toBe(
        false
      );
    });

    it("resetFailedProviders clears all failures", () => {
      const manager = new ProviderManager(createRegistry());
      manager.markFailed("https://alpha.example.com/");
      manager.markFailed("https://beta.example.com/");

      manager.resetFailedProviders();

      expect(manager.hasFailed("https://alpha.example.com/")).toBe(false);
      expect(manager.hasFailed("https://beta.example.com/")).toBe(false);
    });

    it("getLastFailed returns undefined for never-failed provider", () => {
      const manager = new ProviderManager(createRegistry());
      expect(manager.getLastFailed("https://alpha.example.com/")).toBeUndefined();
    });

    it("getLastFailed returns timestamp after failure", () => {
      const manager = new ProviderManager(createRegistry());
      const before = Date.now();
      manager.markFailed("https://alpha.example.com/");
      const ts = manager.getLastFailed("https://alpha.example.com/");

      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    });

    it("getAllLastFailed returns all timestamps", () => {
      const manager = new ProviderManager(createRegistry());
      manager.markFailed("https://alpha.example.com/");
      manager.markFailed("https://beta.example.com/");

      const all = manager.getAllLastFailed();
      expect(all.size).toBe(2);
      expect(all.has("https://alpha.example.com/")).toBe(true);
      expect(all.has("https://beta.example.com/")).toBe(true);
    });

    it("getInstanceId returns a unique string", () => {
      const a = new ProviderManager(createRegistry());
      const b = new ProviderManager(createRegistry());
      expect(a.getInstanceId()).toBeTruthy();
      expect(a.getInstanceId()).not.toBe(b.getInstanceId());
    });
  });

  // ---- getModelForProvider (version-aware matching) ----

  describe("getModelForProvider", () => {
    it("returns exact match", async () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [
            makeModel({ id: "gpt-4o-mini" }),
            makeModel({ id: "gpt-4o" }),
          ],
        }),
      });

      const manager = new ProviderManager(registry);
      const result = await manager.getModelForProvider(
        "https://alpha.example.com/",
        "gpt-4o-mini"
      );

      expect(result?.id).toBe("gpt-4o-mini");
    });

    it("returns suffix match for v0.1.x providers", async () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [makeModel({ id: "gpt-4o-mini" })],
        }),
        getCachedProviderInfo: () => ({
          "https://alpha.example.com/": { version: "0.1.5" } as any,
        }),
      });

      const manager = new ProviderManager(registry);
      const result = await manager.getModelForProvider(
        "https://alpha.example.com/",
        "openai/gpt-4o-mini"
      );

      expect(result?.id).toBe("gpt-4o-mini");
    });

    it("does not suffix match for non-v0.1.x providers", async () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [makeModel({ id: "gpt-4o-mini" })],
        }),
        getCachedProviderInfo: () => ({
          "https://alpha.example.com/": { version: "0.2.0" } as any,
        }),
      });

      const manager = new ProviderManager(registry);
      const result = await manager.getModelForProvider(
        "https://alpha.example.com/",
        "openai/gpt-4o-mini"
      );

      expect(result).toBeNull();
    });

    it("returns null when no match found", async () => {
      const registry = createRegistry({
        getCachedModels: () => ({
          "https://alpha.example.com/": [makeModel({ id: "claude-3" })],
        }),
      });

      const manager = new ProviderManager(registry);
      const result = await manager.getModelForProvider(
        "https://alpha.example.com/",
        "gpt-4o-mini"
      );

      expect(result).toBeNull();
    });
  });

  // ---- mint acceptance ----

  describe("mint acceptance", () => {
    it("accepts all when no mints are specified", () => {
      const registry = createRegistry({
        getCachedMints: () => ({}),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.providerAcceptsMint("https://alpha.example.com/", "https://mint.example.com/")
      ).toBe(true);
    });

    it("accepts when mint is listed", () => {
      const registry = createRegistry({
        getCachedMints: () => ({
          "https://alpha.example.com/": ["https://mint-a.example.com/", "https://mint-b.example.com/"],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.providerAcceptsMint("https://alpha.example.com/", "https://mint-b.example.com/")
      ).toBe(true);
    });

    it("rejects when mint is not listed", () => {
      const registry = createRegistry({
        getCachedMints: () => ({
          "https://alpha.example.com/": ["https://mint-a.example.com/"],
        }),
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.providerAcceptsMint("https://alpha.example.com/", "https://other-mint.example.com/")
      ).toBe(false);
    });
  });

  // ---- getRequiredSatsForModel ----

  describe("getRequiredSatsForModel", () => {
    it("returns 0 when model has no sats_pricing", () => {
      const manager = new ProviderManager(createRegistry());
      const model = { id: "gpt-4o-mini" } as Model;

      expect(manager.getRequiredSatsForModel(model, [])).toBe(0);
    });

    it("falls back to max_cost when no max_completion_cost", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: { prompt: 0.5, completion: 0.6, max_cost: 42 } as any,
      };

      expect(manager.getRequiredSatsForModel(model, [])).toBe(42);
    });

    it("falls back to 50 when neither max_completion_cost nor max_cost exist", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: { prompt: 0.5, completion: 0.6 } as any,
      };

      expect(manager.getRequiredSatsForModel(model, [])).toBe(50);
    });

    it("calculates cost based on message token estimation", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };

      const messages = [
        { role: "user", content: "Hello, how are you?" },
      ];

      const cost = manager.getRequiredSatsForModel(model, messages);

      // The cost should be a positive number based on token estimation
      expect(cost).toBeGreaterThan(0);
      // It should be (prompt * estimatedTokens + max_completion_cost) * 1.05
      expect(typeof cost).toBe("number");
    });

    it("uses maxTokens for completion cost when provided", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };

      const messages = [{ role: "user", content: "Hi" }];
      const withDefault = manager.getRequiredSatsForModel(model, messages);
      const withMaxTokens = manager.getRequiredSatsForModel(model, messages, 500);

      // When maxTokens is provided, completionCost = completion * maxTokens
      // instead of using max_completion_cost
      expect(withMaxTokens).not.toBe(withDefault);
    });

    it("ignores maxTokens for Tinfoil/EHBP models (no completion discount)", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "tinfoil-kimi-k2-6",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };

      const messages = [{ role: "user", content: "Hi" }];
      const withDefault = manager.getRequiredSatsForModel(model, messages);
      const withMaxTokens = manager.getRequiredSatsForModel(model, messages, 500);

      // Tinfoil/EHBP bodies are encrypted client-side, so max_tokens cannot be
      // enforced yet; pricing must stay at max_completion_cost.
      expect(withMaxTokens).toBe(withDefault);
    });

    it("includes the per-request base fee (sp.request) in the total", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "deepseek-v4-flash",
        name: "test",
        sats_pricing: {
          prompt: 0.00022588,
          completion: 0.00045176,
          max_completion_cost: 5,
          request: 1,
        } as any,
      };

      // Tiny probe: a single short message with maxTokens=10.
      // Without the request fee this would price at well under 1 sat.
      const messages = [{ role: "user", content: "hi" }];
      const cost = manager.getRequiredSatsForModel(model, messages, 10);

      // The request fee alone (1 sat) × 1.05 = 1.05, so the total must be
      // at least 1.05 — not rounded down to ~0.008.
      expect(cost).toBeGreaterThanOrEqual(1.05);
    });

    it("handles un-serializable messages conservatively instead of returning 0", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {} as any, // this will cause issues
      };

      // Circular references must not throw (safeStringify contains the
      // failure) and must not under-deposit: the estimator falls back to
      // a conservative 10,000-token assumption for the un-serializable
      // messages, and this model ({} pricing) falls through to the
      // max_cost ?? 50 default.
      const circular: any = { role: "user" };
      circular.content = circular;

      const cost = manager.getRequiredSatsForModel(model, [circular]);
      expect(cost).toBe(50);

      // With a real envelope, the unknown-text fallback prices at the
      // 10,000-token assumption instead of crashing to 0.
      const modelWithEnvelope: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };
      const costWithEnvelope = manager.getRequiredSatsForModel(
        modelWithEnvelope,
        [circular]
      );
      // Content-based counting never serializes the message envelope, so a
      // circular content reference no longer trips the 10,000-token
      // fallback: textLength counts it as 0 (un-stringifiable) and the
      // estimate is the completion floor.
      expect(costWithEnvelope).toBe((0 * 0.5 + 200) * 1.05);
    });

    it("counts Responses input and instructions instead of the 10k default", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };

      // No messages, no input, no instructions: the 10,000-token
      // minimum-balance assumption applies.
      const bare = manager.getRequiredSatsForModel(model, [], undefined, {});
      expect(bare).toBe((10000 * 0.5 + 200) * 1.05);

      // A small Responses input prices far below the 10k assumption...
      const withInput = manager.getRequiredSatsForModel(model, [], undefined, {
        input: [{ type: "message", role: "user", content: "hello" }],
        instructions: "be brief",
      });
      expect(withInput).toBeGreaterThan(200 * 1.05);
      expect(withInput).toBeLessThan(bare);

      // ...and grows with the input size.
      const withBigInput = manager.getRequiredSatsForModel(
        model,
        [],
        undefined,
        {
          input: [
            {
              type: "message",
              role: "user",
              content: "a".repeat(20_000),
            },
          ],
        }
      );
      expect(withBigInput).toBeGreaterThan(withInput);
    });

    it("counts serialized tools definitions on both API shapes", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };

      const messages = [{ role: "user", content: "hi" }];
      const tools = [
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather in a given location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city and state",
              },
            },
          },
        },
      ];

      const withoutTools = manager.getRequiredSatsForModel(
        model,
        messages,
        undefined,
        { messages }
      );
      const withTools = manager.getRequiredSatsForModel(
        model,
        messages,
        undefined,
        { messages, tools }
      );
      expect(withTools).toBeGreaterThan(withoutTools);

      // Tools alone (Responses-style request without messages) also
      // raise the estimate above the completion-only floor.
      const toolsOnly = manager.getRequiredSatsForModel(
        model,
        [],
        undefined,
        { tools }
      );
      expect(toolsOnly).toBeGreaterThan(200 * 1.05);
    });

    it("matches the node's billed-char numerator on a real captured request", () => {
      // Fixture derived from a real captured deepseek-v4-pro-0813 request
      // (routstr-core fixtures: billedTotal=112793). The estimator must
      // count ONLY billed content (string/text content + tool_calls
      // name/args + compact tool defs), NOT the pretty-printed JSON
      // envelope. The old indent=2 messages-only numerator was 209,678
      // chars (73,830 tok); the corrected numerator is 112,793 chars.
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "deepseek-v4-pro-0813",
        name: "test",
        sats_pricing: {
          prompt: 1, // 1 sat/token so prompt cost == token count
          completion: 0,
          max_completion_cost: 1, // non-zero so it's not treated as missing
        } as any,
      };

      const s = (n: number) => "x".repeat(n);
      const messages = [
        { role: "system", content: s(71235) }, // messageContent
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              function: { name: s(124), arguments: s(21053) }, // toolCallsSubtotal
            },
          ],
        },
      ];
      // tools def sized to the fixture's canonical (compact) total.
      const toolDef = {
        type: "function",
        function: { name: "t", description: s(20381 - 60) },
      };
      const toolsPad = 20381 - JSON.stringify([toolDef]).length;
      toolDef.function.description = s(20381 - 60 + toolsPad);
      const tools = [toolDef];
      expect(JSON.stringify(tools).length).toBe(20381);

      // prompt = ceil((71235 + 124 + 21053 + 20381) / 2.84) = ceil(112793/2.84)
      const expectedTokens = Math.ceil(112793 / 2.84);
      const cost = manager.getRequiredSatsForModel(
        model,
        messages,
        undefined,
        { messages, tools }
      );
      // (prompt*1 sat * tokens + max_completion_cost 1 + request 0) * 1.05
      expect(cost).toBeCloseTo((expectedTokens + 1) * 1.05, 5);
    });

    it("caps the estimate at the model's max_cost envelope", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
          max_cost: 300,
        } as any,
      };

      // 10,000-token assumption * 0.5 = 5,000 sats of prompt alone; the
      // envelope caps the deposit at max_cost.
      const cost = manager.getRequiredSatsForModel(model, [], undefined, {});
      expect(cost).toBe(300);
    });

    it("counts Responses input text content, not the JSON envelope", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 1, // 1 sat/token so prompt cost == token count
          completion: 0,
          max_completion_cost: 1,
        } as any,
      };

      // 300 chars of billed text across the Responses field set:
      // input_text(100) + function_call.arguments(50) +
      // function_call_output.output(50) + reasoning summary(50) +
      // content part text(40) + refusal(10) = 300. The huge
      // encrypted_content must NOT be counted.
      const input = [
        { type: "input_text", text: "x".repeat(100) },
        { type: "function_call", arguments: "x".repeat(50) },
        { type: "function_call_output", output: "x".repeat(50) },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "x".repeat(50) }],
          encrypted_content: "y".repeat(5000), // skipped
        },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "x".repeat(40) },
            { type: "refusal", refusal: "x".repeat(10) },
          ],
        },
      ];

      const expectedTokens = Math.ceil(300 / 2.84);
      const cost = manager.getRequiredSatsForModel(
        model,
        [],
        undefined,
        { input }
      );
      // (tokens*1 + max_completion_cost 1) * 1.05; encrypted_content excluded
      expect(cost).toBeCloseTo((expectedTokens + 1) * 1.05, 5);
    });

    it("prices image detail levels, remote URLs, and file_id references", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
        } as any,
      };

      const costOf = (messages: any[]): number =>
        manager.getRequiredSatsForModel(model, messages, undefined, {
          messages,
        });

      const messageWith = (part: any): any[] => [
        { role: "user", content: [{ type: "text", text: "hi" }, part] },
      ];

      // Remote URLs: the node fetches and measures them, so assume the
      // worst case for the detail level (765 tokens at auto).
      const remoteLow = costOf(
        messageWith({
          type: "image_url",
          image_url: { url: "https://example.com/cat.jpg", detail: "low" },
        })
      );
      const remoteAuto = costOf(
        messageWith({
          type: "image_url",
          image_url: { url: "https://example.com/cat.jpg" },
        })
      );
      // 85 tokens for low, 765 for auto: a 680-token difference at
      // 0.5 sats/token, all through the 1.05 safety multiplier.
      expect(remoteAuto - remoteLow).toBeCloseTo(680 * 0.5 * 1.05, 5);

      // Responses input_image with original detail and a file_id has
      // unknown dimensions: the 36,000-token worst case applies.
      const responsesCost = manager.getRequiredSatsForModel(
        model,
        [],
        undefined,
        {
          input: [
            { type: "input_text", text: "describe" },
            {
              type: "input_image",
              file_id: "file-1",
              detail: "original",
            },
          ],
        }
      );
      expect(responsesCost).toBeGreaterThan(36000 * 0.5 * 1.05);
    });
  });

  // ---- node gate (minimum-balance reserve) ----
  //
  // `getRequiredSatsForModel` prices what a request should *cost*. The node
  // gates on a discounted envelope instead, and the two come apart whenever
  // the node cannot discount a budget it holds in reserve — most notably for
  // any request carrying an inline image, because the node's prompt-token
  // count covers the whole body and counts base64 image data as text.
  //
  // The `core:` figure in each comment is what routstr-core's
  // `calculate_discounted_max_cost` returns (default settings) for the exact
  // same body. The reserve must never fall below it.
  describe("node gate reserve", () => {
    // 1x1 PNG: image token math is exact and the body stays small.
    const PNG_1X1 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    const gateModel = (overrides: Record<string, unknown> = {}): Model =>
      ({
        id: "test-model",
        name: "Test Model",
        context_length: 1000,
        top_provider: { context_length: 1000, max_completion_tokens: 900 },
        sats_pricing: {
          prompt: 0.001,
          completion: 0.01,
          request: 0,
          max_prompt_cost: 10,
          max_completion_cost: 50,
          max_cost: 60,
        },
        ...overrides,
      }) as unknown as Model;

    const imageBody = (model: Model, maxTokens?: number) => ({
      model: model.id,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: PNG_1X1 } },
          ],
        },
      ],
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    });

    it("reserves the node's gate when an inline image blocks the prompt discount", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel();
      const body = imageBody(model, 4096);

      // core: 50.860 (envelope 59.400 less the unused completion budget).
      // Pricing only the components gave 43.277 and under-deposited.
      expect(
        manager.getRequiredSatsForModel(model, body.messages, 4096, body)
      ).toBeCloseTo(53.403, 3);
    });

    it("caps at the envelope without dropping below the gate", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel();
      const body = imageBody(model);

      // core: 59.400. Without max_tokens the node discounts nothing, so the
      // reserve pins to max_cost (60) rather than the old 52.769.
      expect(
        manager.getRequiredSatsForModel(model, body.messages, undefined, body)
      ).toBe(60);
    });

    it("does not discount a Responses max_output_tokens budget", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel();
      const body = {
        model: model.id,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "hi" },
              { type: "input_image", image_url: PNG_1X1 },
            ],
          },
        ],
        max_output_tokens: 4096,
      };

      // The call site forwards max_output_tokens as maxTokens, but the node
      // only discounts `max_tokens`, so the gate stays at the envelope.
      // core: 59.372 — the old estimate was 43.277.
      expect(
        manager.getRequiredSatsForModel(model, body.messages ?? [], 4096, body)
      ).toBe(60);
    });

    it("applies the node's prompt discount to small text requests", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel();
      const body = {
        model: model.id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      };

      // A tiny body stays inside the prompt budget, so the node discounts
      // hard and the gate drops well below the envelope. core: 9.917.
      expect(
        manager.getRequiredSatsForModel(model, body.messages, 10, body)
      ).toBeCloseTo(10.413, 3);
    });

    it("tracks the gate for a large completion budget", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel();
      const body = {
        model: model.id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
      };

      // core: 50.777.
      expect(
        manager.getRequiredSatsForModel(model, body.messages, 4096, body)
      ).toBeCloseTo(53.316, 3);
    });

    it("falls back to max_prompt_cost when the model exposes no token budget", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel({
        id: "test-model-noctx",
        context_length: undefined,
        top_provider: undefined,
      });
      const body = {
        model: model.id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      };

      // core: 0.118 (prompt allowance falls back to max_prompt_cost).
      expect(
        manager.getRequiredSatsForModel(model, body.messages, 10, body)
      ).toBeCloseTo(0.1239, 3);
    });

    it("never discounts a sealed EHBP/Tinfoil body", () => {
      const manager = new ProviderManager(createRegistry());
      const model = gateModel({ id: "tinfoil-test-model" });
      const body = imageBody(model, 4096);

      // The enclave encrypts the body, so the node cannot read max_tokens and
      // holds the whole envelope. Same body as the discounted chat case
      // above, which reserved 53.403.
      expect(
        manager.getRequiredSatsForModel(model, body.messages, 4096, body)
      ).toBe(60);
    });
  });

  // ---- store hydration ----

  describe("store hydration", () => {
    it("hydrates failedProviders from store", () => {
      const store = {
        getState: () => ({
          failedProviders: ["https://alpha.example.com/", "https://beta.example.com/"],
          lastFailed: {},
          providersOnCooldown: [],
          removeFailedProvider: vi.fn(),
          setFailedProviders: vi.fn(),
          addFailedProvider: vi.fn(),
          setLastFailedTimestamp: vi.fn(),
          addProviderOnCooldown: vi.fn(),
          removeProviderFromCooldown: vi.fn(),
          removeAllProviderCooldowns: vi.fn(),
          clearProvidersOnCooldown: vi.fn(),
          setLastFailed: vi.fn(),
        }),
      } as any;

      const manager = new ProviderManager(createRegistry(), store);

      expect(manager.hasFailed("https://alpha.example.com/")).toBe(true);
      expect(manager.hasFailed("https://beta.example.com/")).toBe(true);
    });

    it("hydrates lastFailed from store", () => {
      const ts = Date.now();
      const store = {
        getState: () => ({
          failedProviders: [],
          lastFailed: { "https://alpha.example.com/": ts },
          providersOnCooldown: [],
          removeFailedProvider: vi.fn(),
          setFailedProviders: vi.fn(),
          addFailedProvider: vi.fn(),
          setLastFailedTimestamp: vi.fn(),
          addProviderOnCooldown: vi.fn(),
          removeProviderFromCooldown: vi.fn(),
          removeAllProviderCooldowns: vi.fn(),
          clearProvidersOnCooldown: vi.fn(),
          setLastFailed: vi.fn(),
        }),
      } as any;

      const manager = new ProviderManager(createRegistry(), store);

      expect(manager.getLastFailed("https://alpha.example.com/")).toBe(ts);
    });

    it("hydrates providersOnCooldown filtering expired", () => {
      const now = Date.now();
      const store = {
        getState: () => ({
          failedProviders: [],
          lastFailed: {},
          providersOnCooldown: [
            // Fresh cooldown — should be kept
            { baseUrl: "https://fresh.example.com/", timestamp: now - 5_000 },
            // Expired cooldown — older than COOLDOWN_DURATION_MS (210s), should be filtered out
            { baseUrl: "https://stale.example.com/", timestamp: now - 220_000 },
            // Fresh model-scoped cooldown — should be kept with its modelId
            {
              baseUrl: "https://modelcooled.example.com/",
              modelId: "gpt-4o-mini",
              timestamp: now - 5_000,
            },
          ],
          removeFailedProvider: vi.fn(),
          setFailedProviders: vi.fn(),
          addFailedProvider: vi.fn(),
          setLastFailedTimestamp: vi.fn(),
          addProviderOnCooldown: vi.fn(),
          removeProviderFromCooldown: vi.fn(),
          removeAllProviderCooldowns: vi.fn(),
          clearProvidersOnCooldown: vi.fn(),
          setLastFailed: vi.fn(),
        }),
      } as any;

      const manager = new ProviderManager(createRegistry(), store);

      const cooldowns = manager.getProvidersOnCooldown();
      expect(cooldowns).toHaveLength(2);
      expect(
        cooldowns.some(
          (e) => e.baseUrl === "https://fresh.example.com/" && !e.modelId
        )
      ).toBe(true);
      expect(
        cooldowns.some(
          (e) =>
            e.baseUrl === "https://modelcooled.example.com/" &&
            e.modelId === "gpt-4o-mini"
        )
      ).toBe(true);
      // The hydrated model-scoped entry only blocks that model
      expect(
        manager.isOnCooldown("https://modelcooled.example.com/", "gpt-4o-mini")
      ).toBe(true);
      expect(
        manager.isOnCooldown("https://modelcooled.example.com/", "claude-3")
      ).toBe(false);
    });

    it("does nothing when no store is provided", () => {
      // Should not throw — just use the registry directly
      const manager = new ProviderManager(createRegistry());
      expect(manager.getFailedProviders().size).toBe(0);
      expect(manager.getProvidersOnCooldown()).toHaveLength(0);
    });
  });
});
