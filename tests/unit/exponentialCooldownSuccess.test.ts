import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import { canonicalModelPath } from "../../utils/modelPaths";

const BASE_URL = "https://successful-provider.example/";
const MINT_URL = "https://mint.example/";
const REQUESTED = "claude-opus-5.5";
const NATIVE = "claude-opus-5-5";
const model = { id: NATIVE, name: "Claude" } as Model;
const logger: SdkLogger = {
  log: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child() { return this; },
};

function setup() {
  const providerManager = { recordSuccess: vi.fn() };
  const discovery = {
    getModelIdMappings: () => ({ [NATIVE]: REQUESTED }),
  } as unknown as DiscoveryAdapter;
  const client = new RoutstrClient(
    {} as WalletAdapter,
    {} as StorageAdapter,
    discovery,
    "ERROR",
    "apikeys",
    { providerManager: providerManager as any, logger }
  );
  const params = {
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: NATIVE, messages: [] },
    selectedModel: model,
    requestedModelId: REQUESTED,
    baseUrl: BASE_URL,
    mintUrl: MINT_URL,
    token: "sk-test",
    requiredSats: 1,
    headers: {},
    baseHeaders: {},
  };
  return { client, providerManager, params };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("successful model request cooldown reset", () => {
  it("resets the actual provider and canonical requested model rather than the native body id", async () => {
    const { client, providerManager, params } = setup();
    const response = new Response("{}", { headers: { "content-type": "application/json" } });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const actualProvider = "https://failover-provider.example/";

    expect(await (client as any)._makeRequest({ ...params, baseUrl: actualProvider })).toBe(response);
    expect(fetch.mock.calls[0][0]).toBe(`${actualProvider}v1/chat/completions`);
    expect(providerManager.recordSuccess).toHaveBeenCalledExactlyOnceWith(actualProvider, REQUESTED, undefined);
  });

  it("canonicalizes a requested alias and falls back to the selected model when no request id is present", async () => {
    const { client, providerManager, params } = setup();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("{}"))));
    await (client as any)._makeRequest({ ...params, requestedModelId: NATIVE });
    await (client as any)._makeRequest({ ...params, requestedModelId: undefined });
    expect(providerManager.recordSuccess.mock.calls).toEqual([
      [BASE_URL, REQUESTED, undefined],
      [BASE_URL, REQUESTED, undefined],
    ]);
  });

  it("resets only the canonical pinned path on success", async () => {
    const { client, providerManager, params } = setup();
    const selector = "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=42&model-id=claude-opus-5.5&endpoint=anthropic";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await (client as any)._makeRequest({ ...params, baseHeaders: { "X-Routstr-Model-Path": selector } });
    expect(providerManager.recordSuccess).toHaveBeenCalledExactlyOnceWith(BASE_URL, REQUESTED, canonicalModelPath(selector));
  });

  it("counts successful SSE headers immediately without waiting for the stream", async () => {
    const { client, providerManager, params } = setup();
    const response = new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await (client as any)._makeRequest(params)).toBe(response);
    expect(providerManager.recordSuccess).toHaveBeenCalledExactlyOnceWith(BASE_URL, REQUESTED, undefined);
    await response.body?.cancel();
  });

  it("resets successful non-chat model inference such as embeddings", async () => {
    const { client, providerManager, params } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await (client as any)._makeRequest({ ...params, path: "/v1/embeddings", body: { model: NATIVE, input: "hello" } });
    expect(providerManager.recordSuccess).toHaveBeenCalledExactlyOnceWith(BASE_URL, REQUESTED, undefined);
  });

  it("does not reset on a failed HTTP response", async () => {
    const { client, providerManager, params } = setup();
    const failure = new Response("unavailable", { status: 503 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure));
    vi.spyOn(client as any, "_handleErrorResponse").mockResolvedValue(failure);
    expect(await (client as any)._makeRequest(params)).toBe(failure);
    expect(providerManager.recordSuccess).not.toHaveBeenCalled();
  });

  it.each([
    { path: "/v1/models", method: "GET", body: undefined },
    { path: "/v1/wallet/topup", body: {} },
    { selectedModel: undefined },
  ])("does not reset on a non-model request: %j", async (overrides) => {
    const { client, providerManager, params } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await (client as any)._makeRequest({ ...params, ...overrides });
    expect(providerManager.recordSuccess).not.toHaveBeenCalled();
  });
});
