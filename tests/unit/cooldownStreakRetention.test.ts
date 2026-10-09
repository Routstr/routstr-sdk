import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import { createMemoryDriver, createSdkStore, SDK_STORAGE_KEYS } from "../../storage";

const provider = "https://provider.example/";
const SIX_HOURS = 6 * 60 * 60 * 1000;

describe("streak retention and sweep guard", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  it("forgets scopes that have not failed within the retention window", async () => {
    const driver = createMemoryDriver({
      [SDK_STORAGE_KEYS.MODEL_FAILURE_STREAKS]: JSON.stringify([
        { baseUrl: provider, modelId: "forgotten", failureStreak: 9, failedAt: 1_000_000 - SIX_HOURS },
        { baseUrl: provider, modelId: "recent", failureStreak: 4, failedAt: 1_000_000 - 60_000 },
      ]),
    });
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager({ getModelIdMappings: () => null } as DiscoveryAdapter, store);

    pm.markFailed(provider, undefined, "forgotten");
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(Date.now() + 10_000);
    expect(store.getState().modelFailureStreaks).toEqual([
      expect.objectContaining({ modelId: "recent", failureStreak: 4 }),
      expect.objectContaining({ modelId: "forgotten", failureStreak: 1 }),
    ]);
  });

  it("keeps a streak across its own cooldown window (retention > max cooldown)", () => {
    const pm = new ProviderManager({ getModelIdMappings: () => null } as DiscoveryAdapter);
    const now = Date.now();
    pm.markFailed(provider, undefined, "model-a", "path-a");
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(now + 10_000);
    // let the 10s cooldown expire, then fail again well inside the window
    vi.setSystemTime(now + 11_000);
    pm.markFailed(provider, undefined, "model-a", "path-a");
    expect(pm.getProvidersOnCooldown()[0].cooldownUntil).toBe(now + 11_000 + 20_000);
  });

  it("re-keys from a replaced discovery snapshot without waiting for the sweep interval", () => {
    let mappings: Record<string, string> | null = null;
    const pm = new ProviderManager({ getModelIdMappings: () => mappings } as DiscoveryAdapter);
    pm.markFailed(provider, undefined, "native");
    mappings = { native: "canonical" };
    pm.markFailed(provider, undefined, "canonical");
    expect(pm.getProvidersOnCooldown()[0]).toMatchObject({
      modelId: "canonical",
      cooldownUntil: Date.now() + 20_000,
    });
  });

  it("writes nothing while the streak map is unchanged", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager({ getModelIdMappings: () => null } as DiscoveryAdapter, store);
    await store.getState().flush();
    const writes = vi.spyOn(driver, "setItem");
    for (let i = 0; i < 200; i++) pm.isOnCooldown(provider, "model-a");
    vi.setSystemTime(Date.now() + 1_000);
    for (let i = 0; i < 200; i++) pm.getProvidersOnCooldown();
    expect(writes.mock.calls.filter(([key]) => key === SDK_STORAGE_KEYS.MODEL_FAILURE_STREAKS)).toEqual([]);
    expect(writes.mock.calls.filter(([key]) => key === SDK_STORAGE_KEYS.PROVIDERS_ON_COOLDOWN)).toEqual([]);
  });

  it("amortizes the sweep instead of paying it on every check", async () => {
    const driver = createMemoryDriver({
      [SDK_STORAGE_KEYS.MODEL_FAILURE_STREAKS]: JSON.stringify(
        Array.from({ length: 5_000 }, (_, i) => ({
          baseUrl: `https://live-${i}.example/`,
          modelId: `model-${i}`,
          failureStreak: 3,
          failedAt: 1_000_000 - 60_000,
        }))
      ),
    });
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const pm = new ProviderManager({ getModelIdMappings: () => null } as DiscoveryAdapter, store);
    // Per-entry work is the cost under test: 5,000 entries means 5,000
    // canonicalizations per pass. Hydration ends with one sweep.
    const canon = vi.spyOn(pm, "canonicalizeModelId");
    pm.isOnCooldown(provider, "model-a");
    const afterFirst = canon.mock.calls.length;
    expect(afterFirst).toBe(1);

    for (let i = 0; i < 500; i++) pm.isOnCooldown(provider, "model-a");
    // one canonicalization per check, none per entry
    expect(canon.mock.calls.length - afterFirst).toBe(500);

    // once the interval elapses the pass runs again
    vi.setSystemTime(Date.now() + 61_000);
    pm.isOnCooldown(provider, "model-a");
    expect(canon.mock.calls.length - afterFirst - 500).toBeGreaterThanOrEqual(5_000);
    expect(store.getState().modelFailureStreaks).toHaveLength(5_000);
  });
});
