import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelManager } from "../../discovery/ModelManager";
import { MintDiscovery } from "../../discovery/MintDiscovery";
import type { DiscoveryAdapter, ProviderInfo } from "../../discovery/interfaces";
import type { Model, SdkLogger } from "../../core/types";

const A = "https://provider-a.example/";
const B = "https://provider-b.example/";
const C = "https://provider-c.example/";
const logger: SdkLogger = {
  log() {}, warn() {}, error() {}, debug() {}, child: () => logger,
};
const models = (id: string) => [{ id, sats_pricing: { completion: 1 } }] as Model[];
const info = (id: string) => ({ mints: [`https://${id}.mint/`] }) as ProviderInfo;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function adapter() {
  let modelCache: Record<string, Model[]> = {};
  let mintCache: Record<string, string[]> = {};
  let infoCache: Record<string, ProviderInfo> = {};
  const stamps = new Map<string, number>();
  const implementation: Partial<DiscoveryAdapter> = {
    getCachedModels: () => modelCache,
    setCachedModels: next => { modelCache = next; },
    getCachedMints: () => mintCache,
    setCachedMints: next => { mintCache = next; },
    getCachedProviderInfo: () => infoCache,
    setCachedProviderInfo: next => { infoCache = next; },
    getProviderLastUpdate: base => stamps.get(base) ?? null,
    setProviderLastUpdate: (base, stamp) => { stamps.set(base, stamp); },
    getModelIdMappings: () => null,
    getModelIdMappingsEvent: () => null,
    getDisabledProviders: () => [],
  };
  return new Proxy(implementation, {
    get: (target, key) => key in target
      ? target[key as keyof DiscoveryAdapter] : () => undefined,
  }) as DiscoveryAdapter;
}

function service(kind: "models" | "mints", storage: DiscoveryAdapter) {
  if (kind === "models") {
    const manager = new ModelManager(storage, { logger });
    return {
      run: (urls: string[], force = true) => manager.fetchModels(urls, force),
      response: (id: string) => Response.json({ data: models(id) }),
      cached: (base: string) => storage.getCachedModels()[base]?.[0]?.id,
    };
  }
  const discovery = new MintDiscovery(storage, { logger });
  return {
    run: (urls: string[], force = true) => discovery.discoverMints(urls, { forceRefresh: force }),
    response: (id: string) => Response.json(info(id)),
    cached: (base: string) => storage.getCachedMints()[base]?.[0],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

for (const kind of ["models", "mints"] as const) {
  describe(`${kind} provider deadline and single-flight`, () => {
    for (const late of ["resolve", "reject"] as const) {
      it(`bounds ignored aborts, drops late ${late}, and permits a fresh retry`, async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const storage = adapter();
        const s = service(kind, storage);
        const gate = deferred<Response>();
        let signal!: AbortSignal;
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
          signal = init!.signal!;
          return gate.promise;
        });
        vi.stubGlobal("fetch", fetchMock);
        let done = false;
        const pass = s.run([A]).then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(9999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pass;
        expect(signal.aborted).toBe(true);
        expect(s.cached(A)).toBeUndefined();
        expect(storage.getProviderLastUpdate(A)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        const retryGate = deferred<Response>();
        fetchMock.mockImplementation(() => retryGate.promise);
        const retry = s.run([A]);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        if (late === "resolve") gate.resolve(s.response("late"));
        else gate.reject(new Error("late failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(s.cached(A)).toBeUndefined();
        retryGate.resolve(s.response("fresh"));
        await retry;
        expect(s.cached(A)).toBe(kind === "models" ? "fresh" : "https://fresh.mint");
        expect(vi.getTimerCount()).toBe(0);
      });
    }

    it("settles all joined callers when fetch never resolves or honors abort", async () => {
      vi.useFakeTimers();
      const storage = adapter();
      const s = service(kind, storage);
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const first = s.run([A]);
      await vi.advanceTimersByTimeAsync(2_000);
      const joined = s.run([A.slice(0, -1)]);
      await vi.advanceTimersByTimeAsync(8_000);
      await Promise.all([first, joined]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(s.cached(A)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds JSON parsing too and keeps old payload without renewing freshness", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const storage = adapter();
      const s = service(kind, storage);
      vi.stubGlobal("fetch", vi.fn(async () => s.response("old")));
      await s.run([A]);
      const stamp = storage.getProviderLastUpdate(A);
      vi.setSystemTime(1_060_000);
      const body = deferred<unknown>();
      const fetchMock = vi.fn(async () => ({ ok: true, json: () => body.promise }));
      vi.stubGlobal("fetch", fetchMock);
      const pass = s.run([A]);
      await vi.advanceTimersByTimeAsync(10_000);
      await pass;
      expect(s.cached(A)).toBe(kind === "models" ? "old" : "https://old.mint");
      expect(storage.getProviderLastUpdate(A)).toBe(stamp);
      body.resolve(kind === "models" ? {data: models("late")} : info("late"));
      await vi.advanceTimersByTimeAsync(0);
      expect(s.cached(A)).toBe(kind === "models" ? "old" : "https://old.mint");
      expect(storage.getProviderLastUpdate(A)).toBe(stamp);
      // Failed mints did not slide their independent freshness clock either.
      vi.setSystemTime(1_000_000 + 21 * 60_000 + 1);
      fetchMock.mockImplementation(async () => s.response("recovered"));
      await s.run([A], false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("joins normalized overlapping providers but keeps distinct subsets and publishes early", async () => {
      vi.useFakeTimers();
      const storage = adapter();
      const s = service(kind, storage);
      const gates = new Map([A, B, C].map(base => [base, deferred<Response>()]));
      const fetchMock = vi.fn((url: string) => gates.get(url.replace(/v1\/(models|info)$/, ""))!.promise);
      vi.stubGlobal("fetch", fetchMock);
      const broad = s.run([A.slice(0, -1), B], false);
      const overlapping = s.run([A, C], true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      gates.get(A)!.resolve(s.response("a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(s.cached(A)).toBe(kind === "models" ? "a" : "https://a.mint");
      expect(s.cached(B)).toBeUndefined();
      if (kind === "models") expect(storage.getProviderLastUpdate(A)).toBeGreaterThan(0);
      else expect(storage.getCachedProviderInfo()[A]).toEqual(info("a"));
      gates.get(C)!.resolve(s.response("c"));
      const subset = await overlapping;
      if (kind === "models") expect((subset as Model[]).map(m => m.id).sort()).toEqual(["a", "c"]);
      gates.get(B)!.resolve(s.response("b"));
      const original = await broad;
      if (kind === "models") expect((original as Model[]).map(m => m.id).sort()).toEqual(["a", "b"]);
      // The older pass must not prune a provider introduced by the newer one.
      expect(s.cached(C)).toBe(kind === "models" ? "c" : "https://c.mint");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
}

it("does not rewrite newer mint advertisements when an older pass finishes", async () => {
  vi.useFakeTimers();
  const storage = adapter();
  const s = service("mints", storage);
  const pending = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    url.startsWith(B) ? pending.promise : Promise.resolve(s.response("old"))));
  const older = s.run([A, B]);
  await vi.advanceTimersByTimeAsync(0);
  vi.stubGlobal("fetch", vi.fn(async () => s.response("new")));
  await s.run([A]);
  storage.setCachedMints({ ...storage.getCachedMints(), [C]: ["https://concurrent.mint"] });
  pending.resolve(s.response("b"));
  await older;
  expect(storage.getCachedMints()[A]).toEqual(["https://new.mint"]);
  expect(storage.getCachedMints()[C]).toEqual(["https://concurrent.mint"]);
  expect(storage.getCachedProviderInfo()[A]).toEqual(info("new"));
});

it("keeps each model caller's progress and protects newer broad caches from an older narrow pass", async () => {
  vi.useFakeTimers();
  const storage = adapter();
  const manager = new ModelManager(storage, { logger });
  const a = deferred<Response>();
  const b = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((url: string) => url.startsWith(A) ? a.promise : b.promise));
  const narrowProgress = vi.fn();
  const broadProgress = vi.fn();
  const narrow = manager.fetchModels([A], false, narrowProgress);
  const broad = manager.fetchModels([A, B], true, broadProgress);
  a.resolve(Response.json({ data: models("a") }));
  await narrow;
  expect(narrowProgress).toHaveBeenCalledOnce();
  expect(broadProgress).toHaveBeenCalledOnce();
  b.resolve(Response.json({ data: models("b") }));
  await broad;
  expect(broadProgress).toHaveBeenCalledTimes(2);
  expect(storage.getCachedModels()[A]?.[0].id).toBe("a");
  expect(storage.getCachedModels()[B]?.[0].id).toBe("b");
  expect(vi.getTimerCount()).toBe(0);
});

it("never stamps models when publishing their payload fails", async () => {
  vi.useFakeTimers();
  const storage = adapter();
  const write = storage.setCachedModels;
  storage.setCachedModels = (next) => {
    if (next[A]) throw new Error("storage unavailable");
    write(next);
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: models("a") })));
  const manager = new ModelManager(storage, { logger });
  expect(await manager.fetchModels([A], true)).toEqual([]);
  expect(storage.getProviderLastUpdate(A)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("prunes to the latest narrow set after an older broad pass finishes", async () => {
  vi.useFakeTimers();
  const storage = adapter();
  const manager = new ModelManager(storage, { logger });
  const a = deferred<Response>();
  const b = deferred<Response>();
  const slow = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    (url.startsWith(A) ? a : url.startsWith(B) ? b : slow).promise));
  const broad = manager.fetchModels([A, B, C], true);
  await vi.advanceTimersByTimeAsync(0);
  const narrow = manager.fetchModels([A], true);
  a.resolve(Response.json({ data: models("a") }));
  await narrow;
  b.resolve(Response.json({ data: models("b") }));
  await vi.advanceTimersByTimeAsync(0);
  // While the broad pass is active its provider shards remain protected.
  expect(storage.getCachedModels()[B]?.[0].id).toBe("b");
  slow.resolve(Response.json({ data: models("slow") }));
  expect((await broad).map(model => model.id).sort()).toEqual(["a", "b", "slow"]);
  // Pass results remain caller-specific, but the final cache follows the
  // latest requested set, not whichever request happened to finish last.
  expect(Object.keys(storage.getCachedModels())).toEqual([A]);
  expect(storage.getProviderLastUpdate(B)).toBe(0);
  expect(storage.getProviderLastUpdate(C)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
