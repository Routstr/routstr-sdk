/**
 * Unit tests: fetchModels cache invariant
 *
 * A fresh provider timestamp must always imply a present model payload.
 * Covers the poisoned-cache family: failures stamped fresh, stamps written
 * before the end-of-pass payload write, prunes leaving stale stamps, and
 * cache hits sliding the expiry window.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ModelManager } from "../../discovery/ModelManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, SdkLogger } from "../../core/types";

const PROVIDER_A = "https://provider-a.example.com/";
const PROVIDER_B = "https://provider-b.example.com/";

const silentLogger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

const modelsFor = (id: string): Model[] => [
  {
    id,
    name: id,
    sats_pricing: {
      prompt: 1,
      completion: 1,
      max_completion_cost: 10,
      max_prompt_cost: 10,
      max_cost: 10,
    },
  } as Model,
];

function makeAdapter(): DiscoveryAdapter {
  let cachedModels: Record<string, Model[]> = {};
  const lastUpdate = new Map<string, number>();
  return {
    getCachedModels: () => cachedModels,
    setCachedModels: (models) => {
      cachedModels = models;
    },
    getCachedMints: () => ({}),
    setCachedMints: () => {},
    getCachedProviderInfo: () => ({}),
    setCachedProviderInfo: () => {},
    getProviderLastUpdate: (baseUrl) => lastUpdate.get(baseUrl) ?? null,
    setProviderLastUpdate: (baseUrl, timestamp) => {
      lastUpdate.set(baseUrl, timestamp);
    },
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    setDisabledProviders: () => {},
    getManuallyDisabledProviders: () => [],
    setManuallyDisabledProviders: () => {},
    getBaseUrlsList: () => [],
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  };
}

const okResponse = (id: string) => Response.json({ data: modelsFor(id) });

describe("fetchModels cache invariant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a provider whose fetch failed instead of serving it as empty", async () => {
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PROVIDER_A)) return okResponse("model-a");
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await manager.fetchModels([PROVIDER_A, PROVIDER_B], true);
    expect(first.map((m) => m.id)).toEqual(["model-a"]);

    // B comes back up; a non-forced pass inside the TTL must refetch it.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(PROVIDER_A)) return okResponse("model-a");
      return okResponse("model-b");
    });
    const second = await manager.fetchModels([PROVIDER_A, PROVIDER_B], false);
    expect(second.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
  });

  it("does not refresh the freshness stamp when a fetch fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse("model-b"))
    );

    await manager.fetchModels([PROVIDER_B], true);
    expect(adapter.getProviderLastUpdate(PROVIDER_B)).toBe(1_000_000);

    vi.setSystemTime(1_060_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await manager.fetchModels([PROVIDER_B], true);
    expect(adapter.getProviderLastUpdate(PROVIDER_B)).toBe(1_000_000);
    // The last known payload keeps serving while the provider is down.
    expect(adapter.getCachedModels()[PROVIDER_B]?.map((m) => m.id)).toEqual([
      "model-b",
    ]);
  });

  it("does not expose a fresh stamp before the pass writes its payload", async () => {
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    let resolveB!: (res: Response) => void;
    const bGate = new Promise<Response>((resolve) => (resolveB = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith(PROVIDER_A)) return Promise.resolve(okResponse("model-a"));
        return bGate;
      })
    );

    // The progress tick fires once provider A has fully settled, while B is
    // still in flight; no timing sleep needed.
    let firstTick!: () => void;
    const aSettled = new Promise<void>((resolve) => (firstTick = resolve));
    const pass = manager.fetchModels([PROVIDER_A, PROVIDER_B], true, () =>
      firstTick()
    );
    await aSettled;
    expect(adapter.getProviderLastUpdate(PROVIDER_A)).toBeNull();
    expect(adapter.getCachedModels()[PROVIDER_A]).toBeUndefined();

    resolveB(okResponse("model-b"));
    await pass;
    expect(adapter.getCachedModels()[PROVIDER_A]?.length).toBe(1);
    expect(adapter.getProviderLastUpdate(PROVIDER_A)).toBeGreaterThan(0);
  });

  it("zeroes the freshness stamp of providers pruned from the pass", async () => {
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PROVIDER_A)) return okResponse("model-a");
      return okResponse("model-b");
    });
    vi.stubGlobal("fetch", fetchMock);

    await manager.fetchModels([PROVIDER_A, PROVIDER_B], true);
    // A narrow pass prunes provider A's payload...
    await manager.fetchModels([PROVIDER_B], false);
    expect(adapter.getCachedModels()[PROVIDER_A]).toBeUndefined();
    expect(adapter.getProviderLastUpdate(PROVIDER_A)).toBe(0);

    // ...so the next broad pass fetches A again instead of serving it empty.
    const models = await manager.fetchModels([PROVIDER_A, PROVIDER_B], false);
    expect(models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
  });

  it("refetches a provider whose stamp survived without a payload", async () => {
    const adapter = makeAdapter();
    // The poison shape older SDK versions persisted: fresh stamp, no payload.
    adapter.setProviderLastUpdate(PROVIDER_A, Date.now());
    const manager = new ModelManager(adapter, { logger: silentLogger });
    const fetchMock = vi.fn(async () => okResponse("model-a"));
    vi.stubGlobal("fetch", fetchMock);

    const models = await manager.fetchModels([PROVIDER_A], false);
    expect(fetchMock).toHaveBeenCalled();
    expect(models.map((m) => m.id)).toEqual(["model-a"]);
  });

  it("still serves a legitimately cached empty list without refetching", async () => {
    const adapter = makeAdapter();
    adapter.setCachedModels({ [PROVIDER_A]: [] });
    adapter.setProviderLastUpdate(PROVIDER_A, Date.now());
    const manager = new ModelManager(adapter, { logger: silentLogger });
    const fetchMock = vi.fn(async () => okResponse("model-a"));
    vi.stubGlobal("fetch", fetchMock);

    await manager.fetchModels([PROVIDER_A], false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clearing caches zeroes the stamps with the payloads", async () => {
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("model-a")));

    await manager.fetchModels([PROVIDER_A, PROVIDER_B], true);
    manager.clearProviderCache(PROVIDER_A);
    expect(adapter.getProviderLastUpdate(PROVIDER_A)).toBe(0);
    manager.clearAllCache();
    expect(adapter.getProviderLastUpdate(PROVIDER_B)).toBe(0);
    expect(adapter.getCachedModels()).toEqual({});
  });

  it("does not extend a provider's freshness window on cache hits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse("model-a"))
    );

    await manager.fetchModels([PROVIDER_A], true);
    expect(adapter.getProviderLastUpdate(PROVIDER_A)).toBe(2_000_000);

    vi.setSystemTime(2_060_000);
    await manager.fetchModels([PROVIDER_A], false);
    expect(adapter.getProviderLastUpdate(PROVIDER_A)).toBe(2_000_000);
  });

  it("passes an abort signal so a hanging provider cannot stall the pass", async () => {
    const adapter = makeAdapter();
    const manager = new ModelManager(adapter, { logger: silentLogger });
    // Assert outside the mock: an expectation throwing inside fetch is
    // swallowed by fetchModels' own error handling.
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return okResponse("model-a");
    });
    vi.stubGlobal("fetch", fetchMock);

    await manager.fetchModels([PROVIDER_A], true);
    expect(fetchMock).toHaveBeenCalled();
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });
});
