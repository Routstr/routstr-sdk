import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { SdkLogger, Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://first.example/";
const nextUrl = "https://second.example/";
const mintUrl = "https://mint.example/";
const credential = "sk-test-key";

const model = {
  id: "test-model",
  name: "Test Model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

/** The real production rejection: a client-side field the upstream refuses. */
const webSearchOptionsBody = JSON.stringify({
  error: {
    message:
      "Upstream error via litellm: litellm.BadRequestError: OpenAIException - Error code: 400 - {'details': {'_errors': [\"Unrecognized key(s) in object: 'web_search_options'\"]}, 'error': 'Invalid request parameters'}",
    type: "upstream_error",
    code: 400,
  },
  request_id: "04aee611-2e54-4151-8be4-4ef6c7e9523b",
});

const tokenAlreadySpentBody = JSON.stringify({
  error: {
    type: "token_already_spent",
    code: "cashu_token_already_spent",
    message: "Token has already been spent",
  },
});

function setup(mode: "apikeys" | "xcashu" = "apikeys") {
  const paymentToken = mode === "xcashu" ? "cashu-original" : credential;
  const logger: SdkLogger = {
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    },
  };
  const wallet = {
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl,
    sendToken: async () => credential,
    receiveToken: async () => ({
      success: false,
      message: "proofs already spent",
    }),
  } as unknown as WalletAdapter;
  const removeApiKey = vi.fn();
  const removeXcashuToken = vi.fn();
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl, balance: 399, lastUsed: null }),
    removeApiKey,
    removeXcashuToken,
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    recordSuccess: vi.fn(),
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([baseUrl]),
    findNextBestProvider: vi.fn((_model, current, attempted) => current === baseUrl && !attempted?.has(nextUrl) ? nextUrl : null),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(
    wallet,
    storage,
    {} as DiscoveryAdapter,
    "max",
    mode,
    { providerManager: providerManager as any, logger }
  );
  // Everything before/after the transport is irrelevant here: only the error
  // handling under test should be observable.
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  const spend = vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    // Same value the storage mock holds, so the token_already_spent identity
    // guard recognises the spent key as the current one.
    token: paymentToken,
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const balanceManager = client.getBalanceManager();
  vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
    amount: 399_000,
    reserved: 0,
    unit: "msat",
    apiKey: credential,
  });
  const refund = vi
    .spyOn(balanceManager, "refundApiKey")
    .mockResolvedValue({ success: true, message: "refunded", amount: 399 } as any);
  const finalize = vi
    .spyOn(client as any, "_handlePostResponseBalanceUpdate")
    .mockResolvedValue(0);
  return { client, providerManager, refund, spend, removeApiKey, removeXcashuToken, finalize };
}

/** `_makeRequest` is real here; only the transport is stubbed. */
function stubFetch(
  first: { status: number; statusText: string; body: string; headers?: Record<string, string> },
  second?: Response
) {
  let calls = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    calls += 1;
    if (calls > 1 && second) return second.clone();
    return new Response(first.body, {
      status: first.status,
      statusText: first.statusText,
      headers: {
        "content-type": "application/json",
        "x-routstr-request-id": "04aee611-2e54-4151-8be4-4ef6c7e9523b",
        "transfer-encoding": "chunked",
        ...(first.headers ?? {}),
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const okResponse = () =>
  new Response('{"ok":true}', {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });

function routeRequest(client: RoutstrClient) {
  return client.routeRequest({
    path: "/v1/messages",
    method: "POST",
    body: {
      model: model.id,
      messages: [{ role: "user", content: "hi" }],
      web_search_options: {},
    },
    baseUrl,
    mintUrl,
    modelId: model.id,
    headers: {},
  });
}

describe("upstream request errors keep the key, fail over, and aggregate at exhaustion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("walks three real provider candidates once and groups duplicate errors", async () => {
    const thirdUrl = "https://third.example/";
    const { client, refund } = setup();
    const registry = {
      getCachedModels: () => ({ [baseUrl]: [model], [nextUrl]: [model], [thirdUrl]: [model] }),
      getDisabledProviders: () => [],
    } as unknown as DiscoveryAdapter;
    const manager = new ProviderManager(registry);
    (client as any).providerManager = manager;
    const markFailed = vi.spyOn(manager, "markFailed");
    const fetchMock = vi.fn(async (url: string) => {
      const last = url.startsWith(thirdUrl);
      return Response.json({ error: { type: "upstream_error", code: "unsupported", message: last ? "Different rejection" : "Same rejection" }, request_id: url }, { status: last ? 422 : 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await routeRequest(client);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}v1/messages`, `${nextUrl}v1/messages`, `${thirdUrl}v1/messages`,
    ]);
    expect(refund).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
    expect((await response.json()).error.errors).toEqual([
      { status: 400, type: "upstream_error", code: "unsupported", message: "Same rejection", providers: [baseUrl, nextUrl] },
      { status: 422, type: "upstream_error", code: "unsupported", message: "Different rejection", providers: [thirdUrl] },
    ]);
  });

  it("retains earlier errors when the final provider has a network failure", async () => {
    const { client } = setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith(nextUrl)) throw new TypeError("Failed to fetch");
      return Response.json({ error: { type: "invalid_model", message: "Model not found" } }, { status: 400 });
    }));
    const response = await routeRequest(client);
    expect(response.status).toBe(502);
    expect((await response.json()).error.errors.map((error: any) => error.status)).toEqual([400, -1]);
  });

  it("redacts payment proofs and credentials from the aggregate", async () => {
    const { client } = setup();
    stubFetch({ status: 400, statusText: "Bad Request", body: JSON.stringify({ error: { type: "upstream_error", message: `${credential} cashuBabc123 Bearer secret-key`, refund_token: "cashuBrefund123" } }), headers: { "x-cashu": "cashuBrefund123" } });
    const response = await routeRequest(client);
    const text = await response.text();
    expect(text).not.toContain(credential);
    expect(text).not.toContain("cashuB");
    expect(text).not.toContain("secret-key");
    expect(response.headers.get("x-cashu")).toBeNull();
  });

  it("keeps histories isolated between requests on the same client", async () => {
    const { client, providerManager } = setup();
    providerManager.findNextBestProvider.mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      await Promise.resolve();
      return Response.json({ error: { type: "upstream_error", message: body.marker } }, { status: 400 });
    }));
    const request = (marker: string) => client.routeRequest({ path: "/v1/messages", method: "POST", body: { model: model.id, marker }, baseUrl, mintUrl, modelId: model.id });
    const responses = await Promise.all([request("first"), request("second")]);
    expect((await responses[0].json()).error.errors.map((error: any) => error.message)).toEqual(["first"]);
    expect((await responses[1].json()).error.errors.map((error: any) => error.message)).toEqual(["second"]);
  });

  it("does not fail a caller-pinned request over after a 400", async () => {
    const { client, providerManager } = setup();
    const fetchMock = stubFetch({ status: 400, statusText: "Bad Request", body: webSearchOptionsBody });
    const response = await client.routeRequest({ path: "/v1/messages", method: "POST", body: { model: model.id }, baseUrl, mintUrl, modelId: model.id, headers: { "x-routstr-model-path": "pinned-route" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it.each([400, 422])("keeps the key and retries on upstream %i, returning success from the next node", async (status) => {
    const { client, providerManager, refund, spend } = setup();
    const fetchMock = stubFetch({ status, statusText: "Rejected", body: webSearchOptionsBody }, okResponse());
    const response = await routeRequest(client);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refund).not.toHaveBeenCalled();
    expect(spend).toHaveBeenCalledTimes(2);
    expect(providerManager.markFailed).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("deduplicates identical rejections across providers", async () => {
    const { client, providerManager, refund, spend, finalize } = setup();
    const fetchMock = stubFetch({ status: 400, statusText: "Bad Request", body: webSearchOptionsBody });
    const response = await routeRequest(client);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refund).not.toHaveBeenCalled();
    expect(spend).toHaveBeenCalledTimes(2);
    expect(providerManager.markFailed).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect((response as any).passthrough).toBe(true);
    const body = await response.json();
    expect(body.error.type).toBe("all_providers_failed");
    expect(body.error.errors).toHaveLength(1);
    expect(body.error.errors[0].providers).toEqual([baseUrl, nextUrl]);
    expect(body.error.errors[0].message).toContain("web_search_options");
  });

  it.each([400, 422])("recovers X-Cashu refunds on %i at exhaustion", async (status) => {
    const { client, providerManager, spend, refund, removeXcashuToken, finalize } = setup("xcashu");
    providerManager.findNextBestProvider.mockReturnValue(null);
    const receive = vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: true, amount: 100, unit: "sat" });
    const fetchMock = stubFetch({ status, statusText: "Rejected", body: webSearchOptionsBody, headers: { "x-cashu": "cashu-refund" } });

    const response = await routeRequest(client);

    expect(receive).toHaveBeenCalledExactlyOnceWith("cashu-refund");
    expect(removeXcashuToken).toHaveBeenCalledExactlyOnceWith(baseUrl, "cashu-original");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    expect(providerManager.markFailed).not.toHaveBeenCalled();
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(response.status).toBe(status);
    expect((await response.json()).error.errors[0].message).toContain("web_search_options");
  });

  it("recovers an unredeemed original X-Cashu token when no refund is returned", async () => {
    const { client, removeXcashuToken, providerManager } = setup("xcashu");
    providerManager.findNextBestProvider.mockReturnValue(null);
    const receive = vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: true, amount: 100, unit: "sat" });
    stubFetch({ status: 400, statusText: "Bad Request", body: webSearchOptionsBody });
    await routeRequest(client);
    expect(receive).toHaveBeenCalledExactlyOnceWith("cashu-original");
    expect(removeXcashuToken).toHaveBeenCalledWith(baseUrl, "cashu-original");
  });

  it("preserves failed refund proofs and the original IOU for later recovery", async () => {
    const { client, removeXcashuToken, providerManager } = setup("xcashu");
    providerManager.findNextBestProvider.mockReturnValue(null);
    const receive = vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 100, unit: "sat", message: "mint unavailable" });
    const cache = vi.spyOn(client.getCashuSpender(), "cacheReceiveToken").mockImplementation(() => {});
    stubFetch({ status: 400, statusText: "Bad Request", body: webSearchOptionsBody, headers: { "x-cashu": "cashu-refund" } });
    const response = await routeRequest(client);
    expect(receive.mock.calls).toEqual([["cashu-refund"], ["cashu-original"]]);
    expect(cache).toHaveBeenCalledExactlyOnceWith("cashu-refund");
    expect(removeXcashuToken).not.toHaveBeenCalled();
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("does not receive identical refund and original proofs twice", async () => {
    const { client, removeXcashuToken, providerManager } = setup("xcashu");
    providerManager.findNextBestProvider.mockReturnValue(null);
    const receive = vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 100, unit: "sat" });
    vi.spyOn(client.getCashuSpender(), "cacheReceiveToken").mockImplementation(() => {});
    stubFetch({ status: 400, statusText: "Bad Request", body: webSearchOptionsBody, headers: { "x-cashu": "cashu-original" } });
    await routeRequest(client);
    expect(receive).toHaveBeenCalledExactlyOnceWith("cashu-original");
    expect(removeXcashuToken).not.toHaveBeenCalled();
  });

  it("fails an X-Cashu unknown-path 404 over without a strike, keeping an unredeemed token", async () => {
    const { client, removeXcashuToken, providerManager, spend } = setup("xcashu");
    const receive = vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 100, unit: "sat", message: "mint unavailable" });
    const cache = vi.spyOn(client.getCashuSpender(), "cacheReceiveToken").mockImplementation(() => {});
    const fetchMock = stubFetch(
      {
        status: 404,
        statusText: "Not Found",
        body: JSON.stringify({ error: { type: "not_found", message: "Path '/v1/messages' not found", code: 404 } }),
        headers: { "x-cashu": "cashu-refund" },
      },
      okResponse()
    );

    const response = await routeRequest(client);

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([`${baseUrl}v1/messages`, `${nextUrl}v1/messages`]);
    expect(receive.mock.calls).toEqual([["cashu-refund"], ["cashu-original"]]);
    expect(cache).toHaveBeenCalledExactlyOnceWith("cashu-refund");
    expect(removeXcashuToken).not.toHaveBeenCalled();
    expect(spend).toHaveBeenCalledTimes(2);
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("does not inspect or finalize a passthrough event-stream error", async () => {
    const { client, finalize } = setup();
    const body = "data: error\n\n";
    stubFetch({ status: 400, statusText: "Bad Request", body, headers: { "content-type": "text/event-stream" } });
    const response = await routeRequest(client);
    expect((response as any).passthrough).toBe(true);
    expect((response as any).finalize).toBeUndefined();
    expect((response as any).usagePromise).toBeUndefined();
    expect((await response.json()).error.errors[0].message).toBe(body);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("still cleans up and fails over on a routstr-core token_already_spent", async () => {
    const { client, providerManager, spend, removeApiKey } = setup();
    const fetchMock = stubFetch(
      {
        status: 400,
        statusText: "Bad Request",
        body: tokenAlreadySpentBody,
      },
      okResponse()
    );

    const response = await routeRequest(client);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(removeApiKey).toHaveBeenCalledWith(baseUrl);
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      baseUrl,
      expect.stringContaining("type=token_already_spent"),
      model.id,
      undefined
    );
    expect(providerManager.findNextBestProvider).toHaveBeenCalledWith(
      model.id,
      baseUrl,
      expect.any(Set)
    );
    expect(spend).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect((response as any).passthrough).toBeUndefined();
  });

  it.each([401, 429])("still fails over on %i", async (status) => {
    const { client, providerManager, refund, spend } = setup();
    const fetchMock = stubFetch(
      {
        status,
        statusText: status === 401 ? "Unauthorized" : "Too Many Requests",
        body: JSON.stringify({ error: { message: "nope" } }),
      },
      okResponse()
    );

    const response = await routeRequest(client);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerManager.markFailed).toHaveBeenCalled();
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
    // The key was reclaimed before failing over — the existing behaviour.
    expect(refund).toHaveBeenCalled();
    expect(spend).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect((response as any).passthrough).toBeUndefined();
  });
});

describe("isUpstreamRequestError classification", () => {
  it("excludes routstr-core wallet types and non-4xx-request statuses", async () => {
    const { isUpstreamRequestError } = await import("../../core/errorTypes");
    expect(isUpstreamRequestError(400, { type: "upstream_error", raw: false })).toBe(true);
    expect(isUpstreamRequestError(400, { type: "invalid_request_error", raw: false })).toBe(true);
    // The fallback when the envelope has no recognizable type at all.
    expect(isUpstreamRequestError(400, { raw: true })).toBe(true);
    expect(isUpstreamRequestError(422, { raw: true })).toBe(true);

    expect(isUpstreamRequestError(400, { type: "token_already_spent", raw: false })).toBe(false);
    expect(isUpstreamRequestError(400, { type: "invalid_token", raw: false })).toBe(false);
    expect(isUpstreamRequestError(422, { type: "mint_error", raw: false })).toBe(false);
    expect(isUpstreamRequestError(402, { raw: true })).toBe(false);
    expect(isUpstreamRequestError(401, { raw: true })).toBe(false);
    expect(isUpstreamRequestError(403, { raw: true })).toBe(false);
    expect(isUpstreamRequestError(404, { raw: true })).toBe(false);
    expect(isUpstreamRequestError(429, { raw: true })).toBe(false);
    expect(isUpstreamRequestError(500, { raw: true })).toBe(false);
    expect(isUpstreamRequestError(-1, { raw: true })).toBe(false);
  });
});
