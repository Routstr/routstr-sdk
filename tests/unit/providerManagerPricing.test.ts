import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import type { ProviderRegistry } from "../../wallet/interfaces";
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

      expect(ranking.map((e) => e.baseUrl)).toEqual([
        "https://beta.example.com/",
        "https://alpha.example.com/",
      ]);
    });

    it("returns the best provider for a model", () => {
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
      const best = manager.getBestProviderForModel("gpt-4o-mini");

      expect(best).toBe("https://alpha.example.com/");
    });

    it("returns null when no provider has the model", () => {
      const registry = createRegistry({
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
          "https://alpha.example.com/": [
            {
              id: "gpt-4o-mini",
              sats_pricing: { prompt: "1", completion: 1 } as any,
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
      ).toHaveLength(0);
    });

    it("alphabetical tiebreak when total prices are equal", () => {
      const registry = createRegistry({
        getAllProvidersModels: () => ({
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

      expect(providers.map((e) => e.baseUrl)).toEqual([
        "https://alpha.example.com/",
      ]);
    });

    it("filters onion URLs in getProviderPriceRankingForModel", () => {
      const registry = createRegistry({
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
        getAllProvidersModels: () => ({
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
      expect(manager.getCooldownDurationMs()).toBe(42_000);
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

      // Second failure well within the 42s window
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
      vi.setSystemTime(t0 + 43_000);
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
      vi.setSystemTime(t0 + 1_000 + 42_001);

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
      expect(cooldowns[0][0]).toBe("https://alpha.example.com/");
      expect(cooldowns[0][1]).toBe(t0 + 1_000); // timestamp of second failure

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
        getModelsForProvider: () => [
          makeModel({ id: "gpt-4o-mini" }),
          makeModel({ id: "gpt-4o" }),
        ],
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
        getModelsForProvider: () => [makeModel({ id: "gpt-4o-mini" })],
        getProviderInfo: async () => ({ version: "0.1.5" } as any),
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
        getModelsForProvider: () => [makeModel({ id: "gpt-4o-mini" })],
        getProviderInfo: async () => ({ version: "0.2.0" } as any),
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
        getModelsForProvider: () => [makeModel({ id: "claude-3" })],
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
        getProviderMints: () => [],
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.providerAcceptsMint("https://alpha.example.com/", "https://mint.example.com/")
      ).toBe(true);
    });

    it("accepts when mint is listed", () => {
      const registry = createRegistry({
        getProviderMints: () => ["https://mint-a.example.com/", "https://mint-b.example.com/"],
      });

      const manager = new ProviderManager(registry);
      expect(
        manager.providerAcceptsMint("https://alpha.example.com/", "https://mint-b.example.com/")
      ).toBe(true);
    });

    it("rejects when mint is not listed", () => {
      const registry = createRegistry({
        getProviderMints: () => ["https://mint-a.example.com/"],
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

    it("returns 0 when an error occurs during calculation", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "gpt-4o-mini",
        name: "test",
        sats_pricing: {} as any, // this will cause issues
      };

      // Force an error by passing a circular reference
      const circular: any = { role: "user" };
      circular.content = circular;

      const cost = manager.getRequiredSatsForModel(model, [circular]);
      expect(cost).toBe(0);
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
            // Expired cooldown — should be filtered out
            { baseUrl: "https://stale.example.com/", timestamp: now - 50_000 },
          ],
          removeFailedProvider: vi.fn(),
          setFailedProviders: vi.fn(),
          addFailedProvider: vi.fn(),
          setLastFailedTimestamp: vi.fn(),
          addProviderOnCooldown: vi.fn(),
          removeProviderFromCooldown: vi.fn(),
          clearProvidersOnCooldown: vi.fn(),
          setLastFailed: vi.fn(),
        }),
      } as any;

      const manager = new ProviderManager(createRegistry(), store);

      const cooldowns = manager.getProvidersOnCooldown();
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0][0]).toBe("https://fresh.example.com/");
    });

    it("does nothing when no store is provided", () => {
      // Should not throw — just use the registry directly
      const manager = new ProviderManager(createRegistry());
      expect(manager.getFailedProviders().size).toBe(0);
      expect(manager.getProvidersOnCooldown()).toHaveLength(0);
    });
  });
});
