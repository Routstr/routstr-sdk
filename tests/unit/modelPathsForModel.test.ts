/**
 * Per-model path lookups (GET /v1/models/paths/model?model_id=<id>).
 *
 * Regression context (2026-10-12): the full GET /v1/models/paths payload on
 * ai.redsh1ft.com was 5.4 MB and took 13–22 s, so the 10 s abort dropped
 * that node from every auto-pin ranking, and with no negative cache every
 * request re-paid the full timeout (~45 requests × 10 s in 14 minutes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelPathsCache,
  fetchModelPathsForModel,
  getNodeModelPathsForModel,
  parseModelPathsForModelPayload,
  resolveDeepSeekModelPathSelectors,
} from "../../utils/modelPaths";
import { ProviderManager, MODEL_PATH_RANKING_BUDGET_MS } from "../../client/ProviderManager";
import { DEEPSEEK_AUTO_NODE_URLS } from "../../utils/modelPaths";

const NODE = "https://node.example/";
const PPQ = "url=https%3A%2F%2Fapi.ppq.ai&model-id=deepseek-v4.1-flash";
const VENICE_DASH =
  "url=https%3A%2F%2Fapi.venice.ai%2Fapi%2Fv1&model-id=deepseek-v4-1-flash";

// Shape served live by routstr-core's /v1/models/paths/model: a flat list,
// one entry per route, with the route's spelling in model.id.
const flatPayload = (id: string, paths: string[], completion = 0.001) => ({
  data: paths.map((path) => ({
    path,
    provider: { slug: "x", type: "x" },
    endpoint: null,
    model: { id, sats_pricing: { prompt: 0.0004, completion, max_cost: 500 } },
  })),
  updated_at: 1789000000,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => clearModelPathsCache());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseModelPathsForModelPayload", () => {
  it("parses the flat per-model shape, grouping routes by their spelling", () => {
    const parsed = parseModelPathsForModelPayload(
      {
        data: [
          ...flatPayload("deepseek-v4.1-flash", [PPQ]).data,
          ...flatPayload("deepseek-v4-1-flash", [VENICE_DASH]).data,
        ],
        updated_at: 5,
      },
      "deepseek-v4.1-flash"
    );
    expect(parsed?.updatedAt).toBe(5);
    expect(parsed?.data.map((m) => [m.id, m.paths.map((p) => p.path)])).toEqual([
      ["deepseek-v4.1-flash", [PPQ]],
      ["deepseek-v4-1-flash", [VENICE_DASH]],
    ]);
    expect(parsed?.data[0].paths[0].model?.sats_pricing?.completion).toBe(0.001);
  });

  it("feeds resolveDeepSeekModelPathSelectors like the full payload does", () => {
    const parsed = parseModelPathsForModelPayload(
      flatPayload("deepseek-v4.1-flash", [PPQ]),
      "deepseek-v4.1-flash"
    )!;
    const resolved = resolveDeepSeekModelPathSelectors(parsed, "deepseek-v4.1-flash");
    expect(resolved?.selectors.filter(Boolean)).toEqual([PPQ]);
  });

  it("falls back to the requested id when a route carries no model.id", () => {
    const parsed = parseModelPathsForModelPayload(
      { data: [{ path: PPQ }] },
      "deepseek-v4.1-flash"
    );
    expect(parsed?.data).toEqual([
      { id: "deepseek-v4.1-flash", paths: [{ path: PPQ }], alias_ids: [] },
    ]);
  });

  it("returns an empty result for no paths and null for malformed payloads", () => {
    expect(parseModelPathsForModelPayload({ data: [] }, "m")?.data).toEqual([]);
    expect(parseModelPathsForModelPayload({ nope: 1 }, "m")).toBeNull();
    expect(parseModelPathsForModelPayload(null, "m")).toBeNull();
  });
});

describe("fetchModelPathsForModel", () => {
  it("queries the per-model endpoint with model_id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(flatPayload("deepseek-v4.1-flash", [PPQ]))
    );
    await fetchModelPathsForModel(NODE, "deepseek-v4.1-flash", fetchImpl as any);
    const url = new URL(String((fetchImpl.mock.calls[0] as any[])[0]));
    expect(url.pathname).toBe("/v1/models/paths/model");
    expect(url.searchParams.get("model_id")).toBe("deepseek-v4.1-flash");
  });

  it("treats 404 (spelling not served) as empty, other errors as failure", async () => {
    const notFound = vi.fn(async () => jsonResponse({ detail: "Model not found" }, 404));
    expect(
      (await fetchModelPathsForModel(NODE, "x", notFound as any))?.data
    ).toEqual([]);
    const boom = vi.fn(async () => jsonResponse({}, 502));
    expect(await fetchModelPathsForModel(NODE, "x", boom as any)).toBeNull();
    const net = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchModelPathsForModel(NODE, "x", net as any)).toBeNull();
  });
});

describe("getNodeModelPathsForModel caching", () => {
  it("merges every known spelling (the dash spelling holds the Venice route)", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const id = new URL(String(input)).searchParams.get("model_id")!;
      return jsonResponse(
        id === "deepseek-v4-1-flash"
          ? flatPayload(id, [VENICE_DASH])
          : flatPayload(id, [PPQ])
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const paths = await getNodeModelPathsForModel(NODE, "deepseek-v4.1-flash");
    const all = paths!.data.flatMap((m) => m.paths.map((p) => p.path));
    expect(all).toEqual(expect.arrayContaining([PPQ, VENICE_DASH]));
  });

  it("dedupes concurrent lookups into one fetch per spelling", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async (input: unknown) => {
      await gate;
      const id = new URL(String(input)).searchParams.get("model_id")!;
      return jsonResponse(flatPayload(id, [PPQ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const lookups = Array.from({ length: 5 }, () =>
      getNodeModelPathsForModel(NODE, "deepseek-v4.1-flash", {
        mappings: {},
      })
    );
    release();
    await Promise.all(lookups);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a failing node instead of re-paying its timeout on every request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const opts = { mappings: {} };
    expect(await getNodeModelPathsForModel(NODE, "m", opts)).toBeNull();
    expect(await getNodeModelPathsForModel(NODE, "m", opts)).toBeNull();
    expect(await getNodeModelPathsForModel(NODE, "m", opts)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // After the backoff window the node is probed again.
    vi.advanceTimersByTime(61_000);
    await getNodeModelPathsForModel(NODE, "m", opts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a stale entry immediately and refreshes it in the background", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: unknown) => {
      const id = new URL(String(input)).searchParams.get("model_id")!;
      return jsonResponse(flatPayload(id, [PPQ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const opts = { mappings: {} };
    await getNodeModelPathsForModel(NODE, "m", opts);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11 * 60 * 1000);
    // Now the node hangs; the stale entry is still served without waiting.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const stale = await getNodeModelPathsForModel(NODE, "m", opts);
    expect(stale?.data[0].paths[0].path).toBe(PPQ);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("getModelPathProviderRanking latency budget", () => {
  it("does not let one hung node stall the ranking past the budget", async () => {
    vi.useFakeTimers();
    const [FAST, HUNG] = DEEPSEEK_AUTO_NODE_URLS;
    vi.stubGlobal("window", { location: { hostname: "localhost" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith(HUNG)) return new Promise(() => {});
        const id = new URL(url).searchParams.get("model_id")!;
        return jsonResponse(flatPayload(id, [PPQ]));
      })
    );
    const model = {
      id: "deepseek-v4.1-flash",
      sats_pricing: { prompt: 1, completion: 1 },
    } as any;
    const manager = new ProviderManager({
      getCachedModels: () => ({ [`${FAST}/`]: [model], [`${HUNG}/`]: [model] }),
      getCachedMints: () => ({}),
      getCachedProviderInfo: () => ({}),
      getDisabledProviders: () => [],
      getModelIdMappings: () => null,
      getBaseUrlsList: () => [],
    } as any);
    const rankingPromise = manager.getModelPathProviderRanking("deepseek-v4.1-flash", {
      torMode: false,
    });
    await vi.advanceTimersByTimeAsync(MODEL_PATH_RANKING_BUDGET_MS + 10);
    const ranking = await rankingPromise;
    expect(ranking.map((r) => r.baseUrl)).toEqual([`${FAST}/`]);
    expect(ranking[0].selectors).toEqual([PPQ]);
  });
});
