import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URLS,
  MODEL_PATH_HEADER,
  clearModelPathsCache,
} from "../../utils/modelPaths";
import { ProviderManager } from "../../client/ProviderManager";
import { MODEL_PATH_BOOTSTRAP, type ModelPathWhitelist } from "../../core/modelPathWhitelist";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";

// routeRequests() resolves its provider context through resolveRequestContext;
// mock it for the passthrough tests at the bottom.
vi.mock("../../client/resolveRequestContext", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../client/resolveRequestContext")>();
  return { ...original, resolveRequestContext: vi.fn(original.resolveRequestContext) };
});
import { routeRequests } from "../../routeRequests";

const [NODE_A, NODE_B] = DEEPSEEK_AUTO_NODE_URLS;

// Byte-exact advertised selectors from a node's /v1/models/paths.
const DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
const FIREWORKS_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks";
const PPQ_SELECTOR =
  "url=https%3A%2F%2Fapi.ppq.ai&model-id=deepseek-v4.1-flash";

const pathsPayload = (
  paths: Array<{ path: string; completion?: number }>
) => ({
  data: [
    {
      id: DEEPSEEK_AUTO_MODEL_ID,
      paths: paths.map(({ path, completion }) => ({
        path,
        provider: { slug: "openrouter", type: "openrouter" },
        endpoint: null,
        model:
          completion === undefined
            ? undefined
            : { sats_pricing: { prompt: 0.001, completion, max_cost: 700 } },
      })),
    },
  ],
  updated_at: null,
});

const stubPathsFetch = (byNode: Record<string, unknown | Error>) => {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [node, payload] of Object.entries(byNode)) {
      if (url.startsWith(node)) {
        if (payload instanceof Error) throw payload;
        return { ok: true, json: async () => payload };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

const makeModel = (completion = 1): Model =>
  ({
    id: DEEPSEEK_AUTO_MODEL_ID,
    sats_pricing: { prompt: 1, completion, max_cost: 100 },
  }) as Model;

function makeDeps(modelsByNode: Record<string, Model[]>) {
  const discoveryAdapter = {
    getModelIdMappings: () => null,
    setModelIdMappings: () => {},
    getModelIdMappingsEvent: () => null,
    setModelIdMappingsEvent: () => {},
    getCachedModels: () => modelsByNode,
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
  } as DiscoveryAdapter;
  return {
    discoveryAdapter,
    walletAdapter: {
      getActiveMintUrl: () => "https://mint.example/",
      getBalances: async () => ({}),
    } as never,
    storageAdapter: {} as never,
    modelManager: {
      getBaseUrls: () => Object.keys(modelsByNode),
      getAllCachedModels: () => modelsByNode,
    } as never,
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { location: { hostname: "example.com" } });
  clearModelPathsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveRequestContext model-path selection", () => {
  it.each([undefined, false])("defaults to normal provider ranking when opt-in is %s", async (autoModelPath) => {
    const fetchMock = stubPathsFetch({});
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel(2)],
      [`${NODE_B}/`]: [makeModel(1)],
    });
    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath,
      ...deps,
    });
    expect(ctx.baseUrl).toBe(`${NODE_B}/`);
    expect(ctx.modelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not auto-pin a forced node without opt-in", async () => {
    const fetchMock = stubPathsFetch({});
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel()] });
    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      forcedProvider: NODE_A,
      ...deps,
    });
    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the cheapest whitelisted node's preferred route for deepseek-v4.1-flash", async () => {
    stubPathsFetch({
      [NODE_A]: pathsPayload([
        { path: DEEPSEEK_SELECTOR, completion: 0.0013 },
        { path: FIREWORKS_SELECTOR, completion: 0.0007 },
      ]),
      [NODE_B]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0004 }]),
    });
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
      [`${NODE_B}/`]: [makeModel()],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      ...deps,
    });

    expect(ctx.baseUrl).toBe(`${NODE_B}/`);
    expect(ctx.modelPath).toEqual({
      selector: DEEPSEEK_SELECTOR,
      satsPricing: { prompt: 0.001, completion: 0.0004, max_cost: 700 },
      autoPinned: true,
    });
  });

  it("auto-pins when the request names the model by a mapped spelling", async () => {
    // "deepseek-v4-1-flash" maps to deepseek-v4.1-flash. The gate used to
    // compare the raw requested id, so this request silently lost auto-pinning
    // while still routing to the same model.
    stubPathsFetch({
      [NODE_A]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0004 }]),
    });
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel()] });

    const ctx = await resolveRequestContext({
      modelId: "deepseek-v4-1-flash",
      autoModelPath: true,
      ...deps,
    });

    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath).toEqual({
      selector: DEEPSEEK_SELECTOR,
      satsPricing: { prompt: 0.001, completion: 0.0004, max_cost: 700 },
      autoPinned: true,
    });
  });

  it("auto-pins a route advertised only under a mapped spelling", async () => {
    // The node files the model under the variant spelling alone and puts the
    // whitelisted route there. Resolution must still find it, otherwise the
    // node drops out of model-path ranking entirely.
    const VARIANT_DEEPSEEK_SELECTOR =
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4-1-flash&endpoint=deepseek";
    stubPathsFetch({
      [NODE_A]: {
        data: [
          {
            id: "deepseek-v4-1-flash",
            paths: [
              {
                path: VARIANT_DEEPSEEK_SELECTOR,
                model: {
                  sats_pricing: {
                    prompt: 0.001,
                    completion: 0.0004,
                    max_cost: 700,
                  },
                },
              },
            ],
          },
        ],
        updated_at: null,
      },
    });
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel()] });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      ...deps,
    });

    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath).toEqual({
      selector: VARIANT_DEEPSEEK_SELECTOR,
      satsPricing: { prompt: 0.001, completion: 0.0004, max_cost: 700 },
      autoPinned: true,
    });
  });

  it("pins the forced node's own selector when the caller forces a whitelisted node", async () => {
    const fetchMock = stubPathsFetch({
      [NODE_A]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0013 }]),
      [NODE_B]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0004 }]),
    });
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
      [`${NODE_B}/`]: [makeModel()],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      forcedProvider: NODE_A,
      ...deps,
    });

    // NODE_A is pricier, but the caller forced it: pin NODE_A's own paths.
    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath?.selector).toBe(DEEPSEEK_SELECTOR);
    // Only the forced node's paths are fetched.
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain(NODE_A);
    }
  });

  it("does not pin when the caller forced a non-whitelisted node", async () => {
    const fetchMock = stubPathsFetch({});
    const deps = makeDeps({
      "https://other.example/": [makeModel()],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      forcedProvider: "https://other.example/",
      ...deps,
    });

    expect(ctx.baseUrl).toBe("https://other.example/");
    expect(ctx.modelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a caller-pinned request unpinned", async () => {
    const fetchMock = stubPathsFetch({});
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      inputHeaders: { "X-Routstr-Model-Path": PPQ_SELECTOR },
      ...deps,
    });

    expect(ctx.modelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades to the normal price ranking when no model-path node is usable", async () => {
    stubPathsFetch({
      [NODE_A]: new Error("offline"),
      [NODE_B]: new Error("offline"),
    });
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
      [`${NODE_B}/`]: [makeModel()],
      "https://cheap.example/": [makeModel(0.5)],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      ...deps,
    });

    expect(ctx.baseUrl).toBe("https://cheap.example/");
    expect(ctx.modelPath).toBeUndefined();
  });

  it("keeps Tor-mode requests on the onion-only price ranking, unpinned", async () => {
    const fetchMock = stubPathsFetch({
      [NODE_A]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0004 }]),
      [NODE_B]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0004 }]),
    });
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
      [`${NODE_B}/`]: [makeModel()],
      "http://hidden.onion/": [makeModel(0.5)],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      torMode: true,
      ...deps,
    });

    // The clearnet model-path nodes are cheaper but forbidden in Tor mode:
    // degrade to the normal onion-only ranking, unpinned, without even
    // fetching their /v1/models/paths.
    expect(ctx.baseUrl).toBe("http://hidden.onion/");
    expect(ctx.modelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes other models through the normal price ranking", async () => {
    const fetchMock = stubPathsFetch({});
    const otherModel = { ...makeModel(), id: "glm-5.2" } as Model;
    const deps = makeDeps({
      [`${NODE_A}/`]: [otherModel],
    });

    const ctx = await resolveRequestContext({ modelId: "glm-5.2", ...deps });

    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("routeRequests model-path passthrough", () => {
  it("sends the pinned selector and marks the request as auto-pinned", async () => {
    const { resolveRequestContext: mockedResolve } = await import(
      "../../client/resolveRequestContext"
    );
    const client = { routeRequest: vi.fn().mockResolvedValue(new Response("ok")) };
    vi.mocked(mockedResolve).mockResolvedValueOnce({
      client,
      baseUrl: `${NODE_A}/`,
      mintUrl: "https://mint.example/",
      selectedModel: makeModel(),
      modelPath: {
        selector: DEEPSEEK_SELECTOR,
        satsPricing: { prompt: 0.001, completion: 0.0013, max_cost: 700 },
        autoPinned: true,
      },
    } as never);

    await routeRequests({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      requestBody: { messages: [] },
      walletAdapter: {} as never,
      storageAdapter: {} as never,
      discoveryAdapter: {} as never,
    });

    expect(client.routeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { [MODEL_PATH_HEADER]: DEEPSEEK_SELECTOR },
        autoModelPath: {
          selector: DEEPSEEK_SELECTOR,
          satsPricing: { prompt: 0.001, completion: 0.0013, max_cost: 700 },
        },
      })
    );
  });

  it("forwards opt-in to the shared resolver", async () => {
    const { resolveRequestContext: mockedResolve } = await import(
      "../../client/resolveRequestContext"
    );
    const client = { routeRequest: vi.fn().mockResolvedValue(new Response("ok")) };
    vi.mocked(mockedResolve).mockResolvedValueOnce({
      client,
      baseUrl: `${NODE_A}/`,
      mintUrl: "https://mint.example/",
      selectedModel: makeModel(),
    } as never);
    await routeRequests({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      autoModelPath: true,
      requestBody: { messages: [] },
      walletAdapter: {} as never,
      storageAdapter: {} as never,
      discoveryAdapter: {} as never,
    });
    expect(vi.mocked(mockedResolve)).toHaveBeenCalledWith(
      expect.objectContaining({ autoModelPath: true })
    );
  });

  it("keeps a caller-supplied provider and path untouched", async () => {
    const { resolveRequestContext: mockedResolve } = await import(
      "../../client/resolveRequestContext"
    );
    const client = { routeRequest: vi.fn().mockResolvedValue(new Response("ok")) };
    vi.mocked(mockedResolve).mockResolvedValueOnce({
      client,
      baseUrl: "https://other.example/",
      mintUrl: "https://mint.example/",
      selectedModel: makeModel(),
    } as never);

    await routeRequests({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
      requestBody: { messages: [] },
      forcedProvider: "https://other.example/",
      headers: { "x-routstr-model-path": PPQ_SELECTOR },
      walletAdapter: {} as never,
      storageAdapter: {} as never,
      discoveryAdapter: {} as never,
    });

    const call = client.routeRequest.mock.calls[0][0];
    expect(call.headers[MODEL_PATH_HEADER]).toBe(PPQ_SELECTOR);
    expect(call.autoModelPath).toBeUndefined();
  });
});


describe("runtime model-path policies", () => {
  const routes = MODEL_PATH_BOOTSTRAP[DEEPSEEK_AUTO_MODEL_ID].routes;
  it.each([undefined, [], [NODE_A], [NODE_B]])("forced provider honors optional nodes %j", async nodes => {
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel()] });
    deps.discoveryAdapter.getModelPathWhitelist = () => ({ [DEEPSEEK_AUTO_MODEL_ID]: { routes, nodes } });
    const fetch = stubPathsFetch({ [NODE_A]: pathsPayload([{ path: DEEPSEEK_SELECTOR }]) });
    const ctx = await resolveRequestContext({ modelId: DEEPSEEK_AUTO_MODEL_ID,
      forcedProvider: NODE_A, autoModelPath: true, ...deps });
    expect(ctx.pinnedProvider).toBe(true);
    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath?.selector).toBe(nodes?.[0] === NODE_B ? undefined : DEEPSEEK_SELECTOR);
    expect(fetch.mock.calls.length > 0).toBe(nodes?.[0] !== NODE_B);
  });

  it("preserves policy node priority for equal-cost ranking and excludes disabled nodes", async () => {
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel()], [`${NODE_B}/`]: [makeModel()] });
    deps.discoveryAdapter.getModelPathWhitelist = () => ({ [DEEPSEEK_AUTO_MODEL_ID]: { routes, nodes: [NODE_B, NODE_A] } });
    stubPathsFetch({ [NODE_A]: pathsPayload([{ path: DEEPSEEK_SELECTOR }]),
      [NODE_B]: pathsPayload([{ path: DEEPSEEK_SELECTOR }]) });
    const manager = new ProviderManager(deps.discoveryAdapter);
    expect((await manager.getModelPathProviderRanking(DEEPSEEK_AUTO_MODEL_ID)).map(r => r.baseUrl))
      .toEqual([`${NODE_B}/`, `${NODE_A}/`]);
    deps.discoveryAdapter.getDisabledProviders = () => [`${NODE_B}/`];
    expect((await manager.getModelPathProviderRanking(DEEPSEEK_AUTO_MODEL_ID)).map(r => r.baseUrl))
      .toEqual([`${NODE_A}/`]);
    expect((await manager.warmModelPathCaches()).filter(r => !r.reason).map(r => r.baseUrl)).toEqual([`${NODE_A}/`]);
    await expect(resolveRequestContext({ modelId: DEEPSEEK_AUTO_MODEL_ID,
      forcedProvider: NODE_B, autoModelPath: true, ...deps })).rejects.toThrow();
  });

  it("forced allowlists preserve provider path and query case", async () => {
    const allowed = "https://gateway.example/Approved/?Key=Value/";
    const denied = "https://gateway.example/approved/?Key=value/";
    const deps = makeDeps({ [denied]: [makeModel()] });
    deps.discoveryAdapter.getModelPathWhitelist = () => ({ [DEEPSEEK_AUTO_MODEL_ID]: { routes, nodes: [allowed] } });
    const fetch = stubPathsFetch({});
    const ctx = await resolveRequestContext({ modelId: DEEPSEEK_AUTO_MODEL_ID,
      forcedProvider: denied, autoModelPath: true, ...deps });
    expect(ctx.pinnedProvider).toBe(true);
    expect(ctx.modelPath).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes a case-sensitive mapped canonical ID through a variant-keyed policy", async () => {
    const deps = makeDeps({ [`${NODE_A}/`]: [{ ...makeModel(), id: "variant" }] });
    deps.discoveryAdapter.getModelIdMappings = () => ({ variant: "Canonical" });
    deps.discoveryAdapter.getModelPathWhitelist = () => ({ variant: { routes: [{ url: "https://case.example/v1" }] } });
    const selector = "url=https%3A%2F%2Fcase.example%2Fv1&model-id=variant";
    stubPathsFetch({ [NODE_A]: { data: [{ id: "variant", paths: [{ path: selector }] }] } });
    const ctx = await resolveRequestContext({ modelId: "Canonical", forcedProvider: NODE_A,
      autoModelPath: true, ...deps });
    expect(ctx.modelPath?.selector).toBe(selector);
    expect(ctx.pinnedProvider).toBe(true);
    const manager = new ProviderManager(deps.discoveryAdapter);
    expect((await manager.getModelPathProviderRanking("Canonical"))[0].selectors).toEqual([selector]);
  });

  it("kill switch prevents ranking and warming HTTP, even with explicit modelIds", async () => {
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel()] });
    deps.discoveryAdapter.getModelPathWhitelist = () => ({});
    const fetch = stubPathsFetch({});
    const manager = new ProviderManager(deps.discoveryAdapter);
    expect(await manager.getModelPathProviderRanking(DEEPSEEK_AUTO_MODEL_ID)).toEqual([]);
    expect(await manager.warmModelPathCaches()).toEqual([]);
    expect(await manager.warmModelPathCaches({ modelIds: [DEEPSEEK_AUTO_MODEL_ID] })).toEqual([]);
    const ctx = await resolveRequestContext({ modelId: DEEPSEEK_AUTO_MODEL_ID,
      forcedProvider: NODE_A, autoModelPath: true, ...deps });
    expect(ctx.pinnedProvider).toBe(true);
    expect(ctx.modelPath).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("warms and ranks multiple models using current policy routes, optional nodes, and removal", async () => {
    const other = { ...makeModel(), id: "second-model" };
    const deps = makeDeps({ [`${NODE_A}/`]: [makeModel(), other], [`${NODE_B}/`]: [makeModel(), other] });
    const secondSelector = "url=https%3A%2F%2Fsecond-upstream.example%2Fv1&model-id=second-model";
    let whitelist: ModelPathWhitelist = {
      [DEEPSEEK_AUTO_MODEL_ID]: { routes, nodes: [NODE_A] },
      "second-model": { routes: [{ url: "https://second-upstream.example/v1" }], nodes: [] },
    };
    deps.discoveryAdapter.getModelPathWhitelist = () => whitelist;
    const fetch = stubPathsFetch({ [NODE_A]: { data: [
      ...pathsPayload([{ path: DEEPSEEK_SELECTOR }]).data,
      { id: "second-model", paths: [{ path: secondSelector }] },
    ] }, [NODE_B]: { data: [{ id: "second-model", paths: [{ path: secondSelector }] }] } });
    const manager = new ProviderManager(deps.discoveryAdapter);
    const warm = await manager.warmModelPathCaches({ torMode: false });
    expect(warm.map(r => [r.baseUrl, r.modelId, r.whitelisted])).toEqual([
      [`${NODE_A}/`, DEEPSEEK_AUTO_MODEL_ID, 1], [`${NODE_A}/`, "second-model", 1], [`${NODE_B}/`, "second-model", 1],
    ]);
    const ranking = await manager.getModelPathProviderRanking("second-model", { torMode: false });
    expect(ranking).toHaveLength(2);
    expect(ranking[0].selectors).toEqual([secondSelector]);
    expect(ranking[0].satsPricing).toEqual([null]); // existing metadata-less fallback
    whitelist = { "second-model": { routes: [{ url: "https://second-upstream.example/v1" }], nodes: [NODE_B] } };
    fetch.mockClear();
    expect((await manager.warmModelPathCaches({ torMode: false })).map(r => r.baseUrl)).toEqual([`${NODE_B}/`]);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith(NODE_B))).toBe(true);
    expect(await manager.getModelPathProviderRanking(DEEPSEEK_AUTO_MODEL_ID)).toEqual([]);
  });
});
