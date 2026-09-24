/**
 * fetchAIResponse shares resolveRequestContext with routeRequests, so an
 * SDK auto-pinned model path must be threaded through both ways: the
 * resolver needs the caller's headers (a caller-supplied
 * x-routstr-model-path suppresses auto-pinning), and the resolved selector
 * must reach client.routeRequest (header + autoModelPath marker). Dropping
 * either sends the request out unpinned — or worse, sends the caller's
 * selector to a node that never advertised it (404 invalid_model_path,
 * with failover disabled because it looks caller-pinned).
 *
 * These tests drive the real resolveRequestContext + fetchAIResponse
 * seam; only the transport (routeRequest / fetch) is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URLS,
  MODEL_PATH_HEADER,
  clearModelPathsCache,
} from "../../utils/modelPaths";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StreamingCallbacks } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

// fetchAIResponse resolves its provider context through resolveRequestContext;
// wrap the real one in a spy so tests can assert what it received while
// selection still runs for real.
vi.mock("../../client/resolveRequestContext", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../client/resolveRequestContext")>();
  return {
    ...original,
    resolveRequestContext: vi.fn(original.resolveRequestContext),
  };
});
import { fetchAIResponse } from "../../client/fetchAIResponse";
import { resolveRequestContext } from "../../client/resolveRequestContext";

const [NODE_A, NODE_B] = DEEPSEEK_AUTO_NODE_URLS;

const DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
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

const makeLogger = () => {
  const logger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
  logger.child = () => logger;
  return logger;
};

const makeCallbacks = () =>
  ({
    onStreamingUpdate: vi.fn(),
    onThinkingUpdate: vi.fn(),
    onMessageAppend: vi.fn(),
    onBalanceUpdate: vi.fn(),
    onTransactionUpdate: vi.fn(),
  }) as unknown as StreamingCallbacks;

const makeFetchDeps = () =>
  ({
    alertLevel: "min",
    logger: makeLogger(),
    getPendingCashuTokenAmount: () => 0,
  }) as never;

beforeEach(() => {
  vi.stubGlobal("window", { location: { hostname: "example.com" } });
  clearModelPathsCache();
  vi.mocked(resolveRequestContext).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchAIResponse model-path pinning", () => {
  it("threads the auto-pinned selector and per-route pricing into the request", async () => {
    stubPathsFetch({
      [NODE_A]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0013 }]),
      [NODE_B]: pathsPayload([{ path: DEEPSEEK_SELECTOR, completion: 0.0004 }]),
    });
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
      [`${NODE_B}/`]: [makeModel()],
    });
    const routeRequest = vi
      .spyOn(RoutstrClient.prototype, "routeRequest")
      .mockResolvedValue(new Response("data: [DONE]\n\n"));

    await fetchAIResponse(
      {
        modelId: DEEPSEEK_AUTO_MODEL_ID,
        messageHistory: [],
        ...deps,
      },
      makeCallbacks(),
      makeFetchDeps()
    );

    expect(routeRequest).toHaveBeenCalledOnce();
    const call = routeRequest.mock.calls[0][0];
    // The real resolver picked the cheaper node and pinned its selector.
    expect(call.baseUrl).toBe(`${NODE_B}/`);
    expect(call.headers).toEqual({ [MODEL_PATH_HEADER]: DEEPSEEK_SELECTOR });
    expect(call.autoModelPath).toEqual({
      selector: DEEPSEEK_SELECTOR,
      satsPricing: { prompt: 0.001, completion: 0.0004, max_cost: 700 },
    });
  });

  it("leaves a caller-pinned request on its own selector, unpinned by the SDK", async () => {
    // The nodes WOULD auto-pin if consulted — the caller's header must
    // suppress that entirely, so /v1/models/paths is never fetched and the
    // caller's selector reaches routeRequest untouched (and never fails
    // over).
    const fetchMock = stubPathsFetch({
      [NODE_A]: pathsPayload([
        { path: DEEPSEEK_SELECTOR, completion: 0.0004 },
      ]),
    });
    const deps = makeDeps({
      [`${NODE_A}/`]: [makeModel()],
    });
    const routeRequest = vi
      .spyOn(RoutstrClient.prototype, "routeRequest")
      .mockResolvedValue(new Response("data: [DONE]\n\n"));

    await fetchAIResponse(
      {
        modelId: DEEPSEEK_AUTO_MODEL_ID,
        messageHistory: [],
        headers: { "x-routstr-model-path": PPQ_SELECTOR },
        ...deps,
      },
      makeCallbacks(),
      makeFetchDeps()
    );

    const call = routeRequest.mock.calls[0][0];
    expect(call.headers).toEqual({
      "x-routstr-model-path": PPQ_SELECTOR,
    });
    expect(call.autoModelPath).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a resolved pin into routeRequest on the pre-resolved-free path", async () => {
    // Wiring-only: pin the resolver result and assert its modelPath (with
    // per-route pricing) rides into routeRequest.
    const { resolveRequestContext: mockedResolve } = await import(
      "../../client/resolveRequestContext"
    );
    const client = {
      routeRequest: vi.fn().mockResolvedValue(new Response("data: [DONE]\n\n")),
    };
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

    await fetchAIResponse(
      {
        modelId: DEEPSEEK_AUTO_MODEL_ID,
        messageHistory: [],
        ...makeDeps({}),
      },
      makeCallbacks(),
      makeFetchDeps()
    );

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
});
