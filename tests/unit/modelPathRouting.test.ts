import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URL,
  MODEL_PATH_HEADER,
  parseModelPathsPayload,
  resolveDeepSeekModelPathSelectors,
} from "../../utils/modelPaths";

// routeRequests is mocked: these tests cover selection and header wiring,
// not the routing/transport pipeline itself.
vi.mock("../../routeRequests", () => ({ routeRequests: vi.fn() }));
import { routeRequests } from "../../routeRequests";
import {
  clearModelPathsCache,
  routeRequestsWithModelPath,
} from "../../modelPathRouting";

const mockedRouteRequests = vi.mocked(routeRequests);

// Byte-exact advertised selectors from ai.redsh1ft.com /v1/models/paths.
const OFFICIAL_API_SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&provider-id=5&model-id=deepseek-v4.1-flash";
const OPENROUTER_DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash&endpoint=deepseek";
// Non-whitelisted routes the node also advertises for the same model.
const PPQ_SELECTOR =
  "url=https%3A%2F%2Fapi.ppq.ai&provider-id=6&model-id=deepseek-v4.1-flash";
const OPENROUTER_DEEPINFRA_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash&endpoint=deepinfra%2Ffp8";

/** The node's /v1/models/paths payload shape (subset for deepseek-v4.1-flash). */
function makeNodePayload() {
  return {
    data: [
      {
        id: "accounts/fireworks/models/glm-5p1",
        paths: [
          {
            path: "url=https%3A%2F%2Fapi.fireworks.ai%2Finference%2Fv1&provider-id=4&model-id=accounts%2Ffireworks%2Fmodels%2Fglm-5p1",
            provider: { id: 4, slug: "generic-3", type: "generic" },
            endpoint: null,
          },
        ],
      },
      {
        id: DEEPSEEK_AUTO_MODEL_ID,
        paths: [
          {
            path: PPQ_SELECTOR,
            provider: { id: 6, slug: "ppqai", type: "ppqai" },
            endpoint: null,
          },
          {
            path: OFFICIAL_API_SELECTOR,
            provider: { id: 5, slug: "generic-4", type: "generic" },
            endpoint: null,
          },
          {
            path: OPENROUTER_DEEPSEEK_SELECTOR,
            provider: { id: 8, slug: "openrouter", type: "openrouter" },
            endpoint: { tag: "deepseek", name: "DeepSeek" },
          },
          {
            path: OPENROUTER_DEEPINFRA_SELECTOR,
            provider: { id: 8, slug: "openrouter", type: "openrouter" },
            endpoint: { tag: "deepinfra/fp8", name: "DeepInfra" },
          },
        ],
      },
    ],
    updated_at: 1789466999,
  };
}

/** Install a global fetch stub serving the node payload. */
function stubNodeFetch(payload: unknown = makeNodePayload()) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function baseOptions() {
  return {
    modelId: DEEPSEEK_AUTO_MODEL_ID,
    requestBody: { messages: [] },
    walletAdapter: {} as never,
    storageAdapter: {} as never,
    discoveryAdapter: {} as never,
  };
}

beforeEach(() => {
  clearModelPathsCache();
  mockedRouteRequests.mockReset();
  mockedRouteRequests.mockResolvedValue(new Response("ok"));
});

describe("parseModelPathsPayload", () => {
  it("keeps the advertised selector strings and updated_at", () => {
    const parsed = parseModelPathsPayload(makeNodePayload());
    expect(parsed).not.toBeNull();
    expect(parsed!.updatedAt).toBe(1789466999);
    expect(parsed!.data.find((m) => m.id === DEEPSEEK_AUTO_MODEL_ID)!.paths).toContain(
      OFFICIAL_API_SELECTOR
    );
  });

  it("rejects malformed payloads", () => {
    expect(parseModelPathsPayload(null)).toBeNull();
    expect(parseModelPathsPayload({})).toBeNull();
    expect(parseModelPathsPayload({ data: "nope" })).toBeNull();
  });
});

describe("resolveDeepSeekModelPathSelectors", () => {
  it("resolves both whitelisted selectors verbatim and skips the rest", () => {
    const parsed = parseModelPathsPayload(makeNodePayload())!;
    const selectors = resolveDeepSeekModelPathSelectors(
      parsed,
      DEEPSEEK_AUTO_MODEL_ID
    );
    expect(selectors).toEqual({
      officialApi: OFFICIAL_API_SELECTOR,
      openrouter: OPENROUTER_DEEPSEEK_SELECTOR,
    });
  });

  it("returns null when the node does not list the model", () => {
    const parsed = parseModelPathsPayload(makeNodePayload())!;
    expect(
      resolveDeepSeekModelPathSelectors(parsed, "some-other-model")
    ).toBeNull();
  });

  it("leaves a route unset when the node does not advertise it", () => {
    const parsed = parseModelPathsPayload({
      data: [
        {
          id: DEEPSEEK_AUTO_MODEL_ID,
          paths: [PPQ_SELECTOR, OPENROUTER_DEEPINFRA_SELECTOR],
        },
      ],
    })!;
    expect(
      resolveDeepSeekModelPathSelectors(parsed, DEEPSEEK_AUTO_MODEL_ID)
    ).toEqual({ officialApi: null, openrouter: null });
  });
});

describe("routeRequestsWithModelPath", () => {
  it("routes deepseek-v4.1-flash through the pinned node with the official-API selector by default", async () => {
    const fetchMock = stubNodeFetch();
    await routeRequestsWithModelPath(baseOptions());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${DEEPSEEK_AUTO_NODE_URL}/v1/models/paths`
    );
    expect(mockedRouteRequests).toHaveBeenCalledOnce();
    const call = mockedRouteRequests.mock.calls[0][0];
    expect(call.forcedProvider).toBe(DEEPSEEK_AUTO_NODE_URL);
    expect(call.headers[MODEL_PATH_HEADER]).toBe(OFFICIAL_API_SELECTOR);
  });

  it("honours prefer-openrouter and pinning a different node", async () => {
    const fetchMock = stubNodeFetch();
    await routeRequestsWithModelPath({
      ...baseOptions(),
      strategy: "prefer-openrouter",
      forcedProvider: "https://routstr.example.com",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://routstr.example.com/v1/models/paths"
    );
    const call = mockedRouteRequests.mock.calls[0][0];
    expect(call.forcedProvider).toBe("https://routstr.example.com");
    expect(call.headers[MODEL_PATH_HEADER]).toBe(OPENROUTER_DEEPSEEK_SELECTOR);
  });

  it("caches the node's paths within the TTL", async () => {
    const fetchMock = stubNodeFetch();
    await routeRequestsWithModelPath(baseOptions());
    await routeRequestsWithModelPath(baseOptions());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes other models straight through with no pinning", async () => {
    const fetchMock = stubNodeFetch();
    await routeRequestsWithModelPath({
      ...baseOptions(),
      modelId: "glm-5.2",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedRouteRequests.mock.calls[0][0]).not.toHaveProperty(
      "forcedProvider"
    );
    expect(mockedRouteRequests.mock.calls[0][0].headers).toBeUndefined();
  });

  it("respects a caller-supplied selector over automatic selection", async () => {
    const fetchMock = stubNodeFetch();
    const callerSelector =
      "url=https%3A%2F%2Fapi.ppq.ai&provider-id=6&model-id=deepseek-v4.1-flash";
    await routeRequestsWithModelPath({
      ...baseOptions(),
      headers: { "X-Routstr-Model-Path": callerSelector },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const call = mockedRouteRequests.mock.calls[0][0];
    expect(call.headers).toEqual({
      "X-Routstr-Model-Path": callerSelector,
    });
  });

  it("routes without a pinned path when the node advertises neither route", async () => {
    stubNodeFetch({
      data: [
        { id: DEEPSEEK_AUTO_MODEL_ID, paths: [PPQ_SELECTOR] },
      ],
      updated_at: 1,
    });
    await routeRequestsWithModelPath(baseOptions());
    const call = mockedRouteRequests.mock.calls[0][0];
    expect(call.forcedProvider).toBe(DEEPSEEK_AUTO_NODE_URL);
    expect(call.headers?.[MODEL_PATH_HEADER]).toBeUndefined();
  });

  it("routes without a pinned path when the paths fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    await routeRequestsWithModelPath(baseOptions());
    const call = mockedRouteRequests.mock.calls[0][0];
    expect(call.forcedProvider).toBe(DEEPSEEK_AUTO_NODE_URL);
    expect(call.headers?.[MODEL_PATH_HEADER]).toBeUndefined();
  });

  it("falls back to the other route on a retryable failure in failover mode", async () => {
    stubNodeFetch();
    mockedRouteRequests
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValueOnce(new Response("ok"));

    const response = await routeRequestsWithModelPath({
      ...baseOptions(),
      strategy: "failover",
    });

    expect(response.status).toBe(200);
    expect(mockedRouteRequests).toHaveBeenCalledTimes(2);
    expect(mockedRouteRequests.mock.calls[0][0].headers[MODEL_PATH_HEADER]).toBe(
      OFFICIAL_API_SELECTOR
    );
    expect(mockedRouteRequests.mock.calls[1][0].headers[MODEL_PATH_HEADER]).toBe(
      OPENROUTER_DEEPSEEK_SELECTOR
    );
  });

  it("does not retry payment, auth, or 4xx failures in failover mode", async () => {
    stubNodeFetch();
    const { InsufficientBalanceError } = await import("../../core/errors");

    for (const error of [
      new InsufficientBalanceError("payment required"),
      new Error("Authentication failed: 401 Unauthorized"),
      new Error("400 Bad Request"),
    ]) {
      mockedRouteRequests.mockReset();
      mockedRouteRequests.mockRejectedValueOnce(error);
      await expect(
        routeRequestsWithModelPath({ ...baseOptions(), strategy: "failover" })
      ).rejects.toThrow();
      expect(mockedRouteRequests).toHaveBeenCalledOnce();
    }
  });

  it("does not retry in non-failover strategies", async () => {
    stubNodeFetch();
    mockedRouteRequests.mockRejectedValueOnce(new Error("502 Bad Gateway"));
    await expect(
      routeRequestsWithModelPath({ ...baseOptions(), strategy: "prefer-official" })
    ).rejects.toThrow("502");
    expect(mockedRouteRequests).toHaveBeenCalledOnce();
  });
});
