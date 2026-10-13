import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelPathsCache, fetchModelPaths, fetchModelPathsForModel, getNodeModelPathsForModel } from "../../utils/modelPaths";

const base = "https://deadline.example/";
afterEach(() => { clearModelPathsCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("model-path caller deadlines", () => {
  for (const perModel of [false, true]) {
    for (const hangsInBody of [false, true]) {
      it(`bounds ${perModel ? "per-model" : "full"} lookup with ignored abort during ${hangsInBody ? "body" : "fetch"}`, async () => {
        vi.useFakeTimers();
        let resolve!: (value: any) => void;
        const pending = new Promise<any>(yes => { resolve = yes; });
        let signal: AbortSignal | undefined;
        const fetchImpl = vi.fn(async (_url, init) => {
          signal = init.signal;
          return hangsInBody ? { ok: true, json: () => pending } : pending;
        }) as unknown as typeof fetch;
        const result = perModel
          ? fetchModelPathsForModel(base, "m", fetchImpl)
          : fetchModelPaths(base, fetchImpl);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await result).toBeNull();
        expect(signal?.aborted).toBe(true);
        resolve(hangsInBody ? { data: [] } : { ok: true, json: async () => ({ data: [] }) });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
      });
    }
  }

  it("cleans up in-flight lookups, backs off, and discards late payloads", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(yes => { resolve = yes; })));
    const lookup = getNodeModelPathsForModel(base, "m", { mappings: {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await lookup).toBeNull();
    resolve(new Response(JSON.stringify({ data: [] })));
    await vi.advanceTimersByTimeAsync(0);
    expect(await getNodeModelPathsForModel(base, "m", { mappings: {} })).toBeNull();
    await vi.advanceTimersByTimeAsync(60_001);
    const recovered = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", recovered);
    expect(await getNodeModelPathsForModel(base, "m", { mappings: {} })).toEqual({ data: [], updatedAt: null });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
