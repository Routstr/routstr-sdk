import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import { createMemoryDriver, createSdkStore, SDK_STORAGE_KEYS } from "../../storage";

const provider = "https://provider.example/";
const discovery = { getModelIdMappings: () => null } as DiscoveryAdapter;
const manager = () => new ProviderManager(discovery);

describe("exponential scoped cooldowns", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it.each([undefined, "upstream-a"])("doubles after expiry and caps at ten minutes (path %s)", (path) => {
    const pm = manager();
    for (const duration of [10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000]) {
      const now = Date.now();
      pm.markFailed(provider, "failure", "model", path);
      expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(now + duration);
      vi.setSystemTime(now + duration - 1);
      expect(pm.isOnCooldown(provider, "model", path)).toBe(true);
      vi.setSystemTime(now + duration);
      expect(pm.isOnCooldown(provider, "model", path)).toBe(false);
    }
  });

  it("success resets only the exact scope, including a pre-cooldown provider strike", () => {
    const pm = manager();
    pm.markFailed(provider);
    pm.recordSuccess(provider);
    pm.markFailed(provider);
    expect(pm.isOnCooldown(provider)).toBe(false);
    pm.markFailed(provider, undefined, "a");
    pm.markFailed(provider, undefined, "b");
    pm.markFailed(provider, undefined, "a", "path");
    pm.recordSuccess(provider);
    expect(pm.isOnCooldown(provider, "a")).toBe(true);
    pm.recordSuccess(provider, "a");
    expect(pm.isOnCooldown(provider, "a")).toBe(false);
    expect(pm.isOnCooldown(provider, "b")).toBe(true);
    expect(pm.isOnCooldown(provider, "a", "path")).toBe(true);
    pm.recordSuccess(provider, "a", "path");
    pm.markFailed(provider, undefined, "a", "path");
    expect(pm.getProvidersOnCooldown().find((entry) => entry.modelPath)?.cooldownUntil).toBe(Date.now() + 10_000);
  });

  it("keeps providers independent and normalizes provider identities", () => {
    const pm = manager();
    pm.markFailed(provider.slice(0, -1), undefined, "a");
    pm.markFailed(provider, undefined, "a");
    pm.markFailed("https://other.example/", undefined, "a");
    expect(pm.getProvidersOnCooldown().map((entry) => entry.cooldownUntil)).toEqual([Date.now() + 20_000, Date.now() + 10_000]);
  });

  it("manual release preserves history; explicit history clearing resets it", () => {
    const pm = manager();
    pm.markFailed(provider, undefined, "a");
    pm.removeFromCooldown(provider, "a");
    pm.markFailed(provider, undefined, "a");
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 20_000);
    pm.clearCooldowns();
    pm.clearFailureHistory();
    pm.markFailed(provider, undefined, "a");
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 10_000);
  });

  it.each([undefined, "path"])("persists expiry, streak, and success across restart (path %s)", async (path) => {
    const driver = createMemoryDriver();
    const first = createSdkStore({ driver });
    await first.hydrate;
    const pm = new ProviderManager(discovery, first.store);
    pm.markFailed(provider.slice(0, -1), undefined, "a", path);
    pm.markFailed(provider, undefined, "a", path);
    const second = createSdkStore({ driver });
    await second.hydrate;
    const restarted = new ProviderManager(discovery, second.store);
    expect(restarted.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 20_000);
    vi.setSystemTime(Date.now() + 20_000);
    expect(restarted.isOnCooldown(provider, "a", path)).toBe(false);
    expect(second.store.getState().modelFailureStreaks[0].failureStreak).toBe(2);
    const third = createSdkStore({ driver });
    await third.hydrate;
    const afterExpiry = new ProviderManager(discovery, third.store);
    expect(afterExpiry.hasFailed(provider)).toBe(false);
    afterExpiry.markFailed(provider, undefined, "a", path);
    expect(afterExpiry.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 40_000);
    afterExpiry.recordSuccess(provider, "a", path);
    const fourth = createSdkStore({ driver });
    await fourth.hydrate;
    const afterSuccess = new ProviderManager(discovery, fourth.store);
    afterSuccess.markFailed(provider, undefined, "a", path);
    expect(afterSuccess.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 10_000);
  });

  it("rekeys streaks when discovery mappings arrive and resets through either spelling", async () => {
    let mappings: Record<string, string> = {};
    const registry = { getModelIdMappings: () => mappings } as DiscoveryAdapter;
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager(registry, store);
    pm.markFailed(provider, undefined, "native");
    vi.setSystemTime(Date.now() + 10_000);
    mappings = { native: "canonical" };
    pm.markFailed(provider, undefined, "canonical");
    expect(pm.getProvidersOnCooldown()[0]).toMatchObject({ modelId: "canonical", cooldownUntil: Date.now() + 20_000 });
    expect(store.getState().modelFailureStreaks).toEqual([{ baseUrl: provider, modelId: "canonical", modelPath: undefined, failureStreak: 2 }]);
    pm.recordSuccess(provider, "native");
    pm.markFailed(provider, undefined, "canonical");
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 10_000);
    const restartedStore = createSdkStore({ driver });
    await restartedStore.hydrate;
    const restarted = new ProviderManager(registry, restartedStore.store);
    vi.setSystemTime(Date.now() + 10_000);
    restarted.markFailed(provider, undefined, "native");
    expect(restarted.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 20_000);
  });

  it("normalizes and retains new storage fields through setter, upsert, and hydration", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    store.getState().setProvidersOnCooldown([{ baseUrl: provider.slice(0, -1), modelId: "a", timestamp: 100, cooldownUntil: 200 }]);
    store.getState().addProviderOnCooldown(provider, 150, "a", undefined, 300);
    store.getState().setModelFailureStreaks([{ baseUrl: provider.slice(0, -1), modelId: "a", failureStreak: 9 }]);
    const restarted = createSdkStore({ driver });
    await restarted.hydrate;
    expect(restarted.store.getState().providersOnCooldown).toEqual([{ baseUrl: provider, modelId: "a", modelPath: undefined, timestamp: 150, cooldownUntil: 300 }]);
    expect(restarted.store.getState().modelFailureStreaks).toEqual([{ baseUrl: provider, modelId: "a", failureStreak: 9 }]);
  });

  it.each([undefined, "different-model"])("resets persisted path scope regardless of model label (%s)", async (successModel) => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager(discovery, store);
    pm.markFailed(provider, undefined, "model-a", "path");
    pm.markFailed(provider, undefined, "model-b", "path");
    expect(store.getState().providersOnCooldown).toHaveLength(1);
    pm.recordSuccess(provider, successModel, "path");
    expect(store.getState().providersOnCooldown).toEqual([]);
    expect(store.getState().modelFailureStreaks).toEqual([]);
    const second = createSdkStore({ driver });
    await second.hydrate;
    const restarted = new ProviderManager(discovery, second.store);
    expect(restarted.isOnCooldown(provider, "model-a", "path")).toBe(false);
    restarted.markFailed(provider, undefined, "model-a", "path");
    expect(restarted.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 10_000);
  });

  it("keeps legacy stored cooldowns at 210 seconds", async () => {
    const now = Date.now();
    const driver = createMemoryDriver({ [SDK_STORAGE_KEYS.PROVIDERS_ON_COOLDOWN]: JSON.stringify([{ baseUrl: provider, modelId: "a", timestamp: now }]) });
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager(discovery, store);
    vi.setSystemTime(now + 209_999);
    expect(pm.isOnCooldown(provider, "a")).toBe(true);
    vi.setSystemTime(now + 210_000);
    expect(pm.isOnCooldown(provider, "a")).toBe(false);
  });

  it("releases persisted failed providers when restarting after cooldown expiry", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager(discovery, store);
    pm.markFailed(provider, undefined, "a");
    vi.setSystemTime(Date.now() + 10_000);
    const restartedStore = createSdkStore({ driver });
    await restartedStore.hydrate;
    const restarted = new ProviderManager(discovery, restartedStore.store);
    expect(restarted.hasFailed(provider)).toBe(false);
    expect(restartedStore.store.getState().failedProviders).toEqual([]);
    expect(restartedStore.store.getState().providersOnCooldown).toEqual([]);
    restarted.markFailed(provider, undefined, "a");
    expect(restarted.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 20_000);
  });

  it("preserves provider-wide two-strike 210-second policy", () => {
    const pm = manager();
    pm.markFailed(provider);
    expect(pm.isOnCooldown(provider)).toBe(false);
    pm.markFailed(provider);
    expect(pm.isOnCooldown(provider, "any-model")).toBe(true);
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBeUndefined();
    vi.setSystemTime(Date.now() + 210_000);
    expect(pm.isOnCooldown(provider)).toBe(false);
    pm.markFailed(provider);
    expect(pm.isOnCooldown(provider)).toBe(false);
  });
});
