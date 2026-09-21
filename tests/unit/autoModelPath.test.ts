import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URLS,
  MODEL_PATH_HEADER,
  clearModelPathsCache,
} from "../../utils/modelPaths";
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
      ...deps,
    });

    expect(ctx.baseUrl).toBe(`${NODE_B}/`);
    expect(ctx.modelPath).toEqual({
      selector: DEEPSEEK_SELECTOR,
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
      forcedProvider: NODE_A,
      ...deps,
    });

    // NODE_A is pricier, but the caller forced it: pin NODE_A's own paths.
    expect(ctx.baseUrl).toBe(`${NODE_A}/`);
    expect(ctx.modelPath?.selector).toBe(DEEPSEEK_SELECTOR);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain(NODE_A);
  });

  it("does not pin when the caller forced a non-whitelisted node", async () => {
    const fetchMock = stubPathsFetch({});
    const deps = makeDeps({
      "https://other.example/": [makeModel()],
    });

    const ctx = await resolveRequestContext({
      modelId: DEEPSEEK_AUTO_MODEL_ID,
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
      ...deps,
    });

    expect(ctx.baseUrl).toBe("https://cheap.example/");
    expect(ctx.modelPath).toBeUndefined();
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
