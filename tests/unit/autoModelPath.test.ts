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

// Byte-exact advertised selectors from a node's /v1/models/paths.
const OPENROUTER_DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
const OPENROUTER_FIREWORKS_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks";
const PPQ_SELECTOR =
  "url=https%3A%2F%2Fapi.ppq.ai&model-id=deepseek-v4.1-flash";
// No longer whitelisted: the official DeepSeek API route.
const OFFICIAL_API_SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&model-id=deepseek-v4.1-flash";

function makeNodePayload() {
  return {
    data: [
      {
        id: DEEPSEEK_AUTO_MODEL_ID,
        paths: [
          { path: PPQ_SELECTOR, provider: { slug: "ppq", type: "generic" }, endpoint: null },
          { path: OFFICIAL_API_SELECTOR, provider: { slug: "deepseek", type: "generic" }, endpoint: null },
          {
            // Fireworks is listed before deepseek on purpose: the node's
            // order must not matter, the whitelist preference does.
            path: OPENROUTER_FIREWORKS_SELECTOR,
            provider: { slug: "openrouter", type: "openrouter" },
            endpoint: { tag: "fireworks", name: "Fireworks" },
          },
          {
            path: OPENROUTER_DEEPSEEK_SELECTOR,
            provider: { slug: "openrouter", type: "openrouter" },
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
  it("pins the preferred whitelisted route (OpenRouter deepseek) for deepseek-v4.1-flash", async () => {
    stubNodeFetch();
    await expect(autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID)).resolves.toEqual({
      forcedProvider: DEEPSEEK_AUTO_NODE_URL,
      headers: { [MODEL_PATH_HEADER]: OPENROUTER_DEEPSEEK_SELECTOR },
    });
  });

  it("falls back to OpenRouter fireworks when the node has no deepseek route", async () => {
    stubNodeFetch({
      data: [
        {
          id: DEEPSEEK_AUTO_MODEL_ID,
          paths: [
            {
              path: OPENROUTER_FIREWORKS_SELECTOR,
              provider: { slug: "openrouter", type: "openrouter" },
              endpoint: { tag: "fireworks", name: "Fireworks" },
            },
          ],
        },
      ],
    });
    await expect(autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID)).resolves.toEqual({
      forcedProvider: DEEPSEEK_AUTO_NODE_URL,
      headers: { [MODEL_PATH_HEADER]: OPENROUTER_FIREWORKS_SELECTOR },
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

  it("does nothing when the caller forced a different node", async () => {
    const fetchMock = stubNodeFetch();
    for (const other of [
      "https://routstr.otrta.me/",
      "https://routstr.otrta.me",
      "https://api.routstr.com/",
    ]) {
      await expect(
        autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID, undefined, other)
      ).resolves.toEqual({});
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still pins when the caller forces the auto node itself", async () => {
    stubNodeFetch();
    await expect(
      autoModelPathFor(DEEPSEEK_AUTO_MODEL_ID, undefined, "https://ai.redsh1ft.com/")
    ).resolves.toEqual({
      forcedProvider: DEEPSEEK_AUTO_NODE_URL,
      headers: { [MODEL_PATH_HEADER]: OPENROUTER_DEEPSEEK_SELECTOR },
    });
  });

  it("does nothing when the node lists no whitelisted route", async () => {
    stubNodeFetch({
      data: [
        { id: DEEPSEEK_AUTO_MODEL_ID, paths: [{ path: PPQ_SELECTOR, provider: { slug: "ppq", type: "generic" }, endpoint: null }] },
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
  it("pins the node and sends the OpenRouter deepseek selector for that model", async () => {
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
        headers: { [MODEL_PATH_HEADER]: OPENROUTER_DEEPSEEK_SELECTOR },
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

  it("does not attach a selector when the caller forced a different node", async () => {
    // Live failure this guards: a selector resolved from ai.redsh1ft.com was
    // sent to routstr.otrta.me -> 404 invalid_model_path.
    const fetchMock = stubNodeFetch();
    mockedResolve.mockResolvedValue({
      client: makeClient(),
      baseUrl: "https://routstr.otrta.me/",
      mintUrl: "https://mint.example/",
      selectedModel: { id: DEEPSEEK_AUTO_MODEL_ID },
    } as never);

    await routeRequests(
      routeOptions(DEEPSEEK_AUTO_MODEL_ID, {
        forcedProvider: "https://routstr.otrta.me/",
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedResolve.mock.calls[0][0].forcedProvider).toBe(
      "https://routstr.otrta.me/"
    );
    const resolved = await mockedResolve.mock.results[0].value;
    const call = (resolved as { client: ReturnType<typeof makeClient> }).client
      .routeRequest.mock.calls[0][0];
    expect(call.headers?.[MODEL_PATH_HEADER]).toBeUndefined();
  });
});