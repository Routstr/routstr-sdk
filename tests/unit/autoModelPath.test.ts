import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URL,
  MODEL_PATH_HEADER,
  autoModelPathFor,
  clearModelPathsCache,
} from "../../utils/modelPaths";

// routeRequests() resolves its provider context through this module; mock it
// so the integration tests exercise the model-path wiring without discovery,
// wallet, or transport.
vi.mock("../../client/resolveRequestContext", () => ({
  resolveRequestContext: vi.fn(),
}));
import { resolveRequestContext } from "../../client/resolveRequestContext";
import { routeRequests } from "../../routeRequests";

const mockedResolve = vi.mocked(resolveRequestContext);

// Byte-exact advertised selectors from ai.redsh1ft.com /v1/models/paths.
const OFFICIAL_API_SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&provider-id=5&model-id=deepseek-v4.1-flash";
const OPENROUTER_DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash&endpoint=deepseek";
const PPQ_SELECTOR =
  "url=https%3A%2F%2Fapi.ppq.ai&provider-id=6&model-id=deepseek-v4.1-flash";

function makeNodePayload() {
  return {
    data: [
      {
        id: DEEPSEEK_AUTO_MODEL_ID,
        paths: [
          { path: PPQ_SELECTOR, provider: { id: 6 }, endpoint: null },
          { path: OFFICIAL_API_SELECTOR, provider: { id: 5 }, endpoint: null },
          {
            path: OPENROUTER_DEEPSEEK_SELECTOR,
            provider: { id: 8 },
            endpoint: { tag: "deepseek", name: "DeepSeek" },
          },
        ],
      },
    ],
    updated_at: 1789466999,
  };
}

function stubNodeFetch(payload: unknown = makeNodePayload()) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeClient() {
  return { routeRequest: vi.fn().mockResolvedValue(new Response("ok")) };
}

beforeEach(() => {
  clearModelPathsCache();
  mockedResolve.mockReset();
  const client = makeClient();
  const selectedModel = { id: DEEPSEEK_AUTO_MODEL_ID };
  mockedResolve.mockResolvedValue({
    client,
    baseUrl: "https://ai.redsh1ft.com/",
    mintUrl: "https://mint.example/",
    selectedModel,
  } as never);
});

function routeOptions(modelId: string, extra: Record<string, unknown> = {}) {
  return {
    modelId,
    requestBody: { messages: [] },
    walletAdapter: {} as never,
    storageAdapter: {} as never,
    discoveryAdapter: {} as never,
    ...extra,
  };
}

describe("autoModelPathFor", () => {
  it("pins the official DeepSeek route for deepseek-v4.1-flash", async () => {
    stubNodeFetch();
    await expect(autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID)).resolves.toEqual({
      forcedProvider: DEEPSEEK_AUTO_NODE_URL,
      headers: { [MODEL_PATH_HEADER]: OFFICIAL_API_SELECTOR },
    });
  });

  it("uses the OpenRouter route when the node has no official path", async () => {
    stubNodeFetch({
      data: [
        {
          id: DEEPSEEK_AUTO_MODEL_ID,
          paths: [
            {
              path: OPENROUTER_DEEPSEEK_SELECTOR,
              provider: { id: 8 },
              endpoint: { tag: "deepseek", name: "DeepSeek" },
            },
          ],
        },
      ],
    });
    await expect(autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID)).resolves.toEqual({
      forcedProvider: DEEPSEEK_AUTO_NODE_URL,
      headers: { [MODEL_PATH_HEADER]: OPENROUTER_DEEPSEEK_SELECTOR },
    });
  });

  it("does nothing for other models", async () => {
    const fetchMock = stubNodeFetch();
    await expect(autoModelPathFor("glm-5.2")).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a caller-supplied selector alone", async () => {
    const fetchMock = stubNodeFetch();
    await expect(
      autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID, {
        "X-Routstr-Model-Path": PPQ_SELECTOR,
      })
    ).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the node lists no whitelisted route", async () => {
    stubNodeFetch({
      data: [
        { id: DEEPSEEK_AUTO_MODEL_ID, paths: [{ path: PPQ_SELECTOR, provider: { id: 6 }, endpoint: null }] },
      ],
    });
    await expect(autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID)).resolves.toEqual({});
  });

  it("does nothing when the paths fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID)).resolves.toEqual({});
  });

  it("caches the node's paths", async () => {
    const fetchMock = stubNodeFetch();
    await autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID);
    await autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${DEEPSEEK_AUTO_NODE_URL}/v1/models/paths`
    );
  });
});

describe("routeRequests deepseek-v4.1-flash pinning", () => {
  it("pins the node and sends the official-API selector for that model", async () => {
    stubNodeFetch();
    await routeRequests(routeOptions(DEEPSEEK_AUTO_MODEL_ID));

    expect(mockedResolve.mock.calls[0][0].forcedProvider).toBe(
      DEEPSEEK_AUTO_NODE_URL
    );
    const client = await mockedResolve.mock.results[0].value;
    expect(
      (client as { client: ReturnType<typeof makeClient> }).client.routeRequest
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { [MODEL_PATH_HEADER]: OFFICIAL_API_SELECTOR },
      })
    );
  });

  it("leaves other models untouched", async () => {
    const fetchMock = stubNodeFetch();
    await routeRequests(routeOptions("glm-5.2"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedResolve.mock.calls[0][0].forcedProvider).toBeUndefined();
    const resolved = await mockedResolve.mock.results[0].value;
    const call = (resolved as { client: ReturnType<typeof makeClient> }).client
      .routeRequest.mock.calls[0][0];
    expect(call.headers?.[MODEL_PATH_HEADER]).toBeUndefined();
  });

  it("keeps a caller-supplied provider and path", async () => {
    stubNodeFetch();
    await routeRequests(
      routeOptions(DEEPSEEK_AUTO_MODEL_ID, {
        forcedProvider: "https://other.example/",
        headers: { "x-routstr-model-path": PPQ_SELECTOR },
      })
    );

    expect(mockedResolve.mock.calls[0][0].forcedProvider).toBe(
      "https://other.example/"
    );
    const resolved = await mockedResolve.mock.results[0].value;
    const call = (resolved as { client: ReturnType<typeof makeClient> }).client
      .routeRequest.mock.calls[0][0];
    expect(call.headers[MODEL_PATH_HEADER]).toBe(PPQ_SELECTOR);
  });
});