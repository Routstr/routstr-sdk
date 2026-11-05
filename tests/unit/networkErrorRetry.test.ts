/**
 * Same-provider retry after a transient socket failure.
 *
 * Bug: `_makeRequest` classified a network error and immediately walked to
 * `_handleErrorResponse`, which cools the provider down and fails over to the
 * next one. For a socket that dies *after* it was established — a provider
 * closing an idle keep-alive connection exactly as we reuse it, a provider
 * restart, a mesh/VPN hiccup — the identical request sent over a fresh
 * connection typically succeeds within milliseconds. Paying a cross-provider
 * failover (re-price, new cashu token / API key reservation, possibly a more
 * expensive node, maybe "all providers failed") for that class of failure is
 * what these tests pin down:
 *
 *   1. transient socket error       -> retry the same provider once
 *   2. retry also fails             -> then fail over (unchanged behavior)
 *   3. "could not connect at all"   -> fail over immediately, no retry
 *   4. caller-forced provider       -> still retries the same provider, but
 *                                      never fails over (pin is absolute)
 */

import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://provider-a.test/";
const NEXT_URL = "https://provider-b.test/";
const MINT_URL = "https://mint.example.com";
const TOKEN = "cashu_token_123";

const BUN_SOCKET_RESET =
  "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const BUN_UNREACHABLE =
  "Unable to connect. Is the computer able to access the url?";

const createWallet = (): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
});

const createStorage = (): StorageAdapter =>
  ({
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: () => {},
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    getApiKeyDistribution: () => [],
    removeApiKey: () => {},
    saveProviderInfo: () => {},
    getProviderInfo: () => null,
    getApiKey: () => null,
    setApiKey: () => {},
    updateApiKeyBalance: () => {},
    touchApiKeyLastUsed: () => {},
    getAllApiKeys: () => [],
    getChildKey: () => null,
    setChildKey: () => {},
    updateChildKeyBalance: () => {},
    removeChildKey: () => {},
    getAllChildKeys: () => [],
    getCachedReceiveTokens: () => [],
    setCachedReceiveTokens: () => {},
  }) as StorageAdapter;

const createDiscovery = (): DiscoveryAdapter =>
  ({
    getModelIdMappings: () => null,
    setModelIdMappings: () => {},
    getModelIdMappingsEvent: () => null,
    setModelIdMappingsEvent: () => {},
    getCachedModels: () => ({}),
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
    setBaseUrlsList: () => [],
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  }) as DiscoveryAdapter;

const makeModel = (): Model =>
  ({
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

const requestParams = (overrides?: Record<string, unknown>) => ({
  path: "/v1/chat/completions",
  method: "POST",
  body: { model: "deepseek-v4.1-flash", messages: [] },
  selectedModel: makeModel(),
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token: TOKEN,
  requiredSats: 100,
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  baseHeaders: { Authorization: `Bearer ${TOKEN}` },
  tinfoilEnabled: false,
  ...overrides,
});

function makeClient() {
  return new RoutstrClient(
    createWallet(),
    createStorage(),
    createDiscovery(),
    "ERROR",
    "apikeys"
  );
}

const okResponse = () =>
  new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RoutstrClient transient socket retry", () => {
  it("retries the same provider once and returns the successful retry", async () => {
    const client = makeClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(BUN_SOCKET_RESET))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const handleError = vi.spyOn(client as any, "_handleErrorResponse");
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    const response = await (client as any)._makeRequest(requestParams());

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    // Two attempts, both against the same provider URL.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0];
    const [secondUrl, secondInit] = fetchMock.mock.calls[1];
    expect(firstUrl).toBe(`${BASE_URL}v1/chat/completions`);
    expect(secondUrl).toBe(firstUrl);
    // Same credentials and body: the retry is a byte-identical re-send.
    expect(secondInit.headers).toEqual(firstInit.headers);
    expect(secondInit.body).toBe(firstInit.body);
    // No failover, no cooldown walk.
    expect(handleError).not.toHaveBeenCalled();
    expect(findNext).not.toHaveBeenCalled();
  });

  it("fails over only after the same-provider retry is also reset", async () => {
    const client = makeClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError(BUN_SOCKET_RESET));
    vi.stubGlobal("fetch", fetchMock);
    const handled = new Response("handled", { status: 200 });
    const handleError = vi
      .spyOn(client as any, "_handleErrorResponse")
      .mockResolvedValue(handled);

    const response = await (client as any)._makeRequest(requestParams());

    expect(response).toBe(handled);
    // Exactly one retry (MAX_NETWORK_RETRIES_PER_PROVIDER = 1), then failover.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handleError).toHaveBeenCalledTimes(1);
    const [params, , status, , , body] = handleError.mock.calls[0];
    expect(params.baseUrl).toBe(BASE_URL);
    expect(status).toBe(-1);
    expect(body).toBe(BUN_SOCKET_RESET);
  });

  it("does not retry a provider that could not be connected to at all", async () => {
    const client = makeClient();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(BUN_UNREACHABLE));
    vi.stubGlobal("fetch", fetchMock);
    const handled = new Response("handled", { status: 200 });
    const handleError = vi
      .spyOn(client as any, "_handleErrorResponse")
      .mockResolvedValue(handled);

    const response = await (client as any)._makeRequest(requestParams());

    expect(response).toBe(handled);
    // DNS/refused/TLS failures are not self-healing: straight to failover.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
  });

  it("still retries a caller-pinned provider without failing over", async () => {
    const client = makeClient();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(BUN_SOCKET_RESET))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    const response = await (client as any)._makeRequest(
      requestParams({ pinnedProvider: true })
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
    expect(findNext).not.toHaveBeenCalled();
  });

  it("classifies by error code when the runtime reworded its message", async () => {
    const client = makeClient();
    // Same failure, unfamiliar text: only the structured code identifies it.
    const resetWithUnknownText = Object.assign(new TypeError("network boom"), {
      code: "ECONNRESET",
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(resetWithUnknownText)
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const handleError = vi.spyOn(client as any, "_handleErrorResponse");

    const response = await (client as any)._makeRequest(requestParams());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handleError).not.toHaveBeenCalled();
  });

  it("gives the failover target its own retry budget", async () => {
    const client = makeClient();
    // provider A: reset twice (retry + failover trigger)
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(BUN_SOCKET_RESET))
      .mockRejectedValueOnce(new TypeError(BUN_SOCKET_RESET))
      // provider B: reset once, then succeed on its own retry
      .mockRejectedValueOnce(new TypeError(BUN_SOCKET_RESET))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    // Re-enter _makeRequest for provider B the way _handleErrorResponse does:
    // fresh token/baseUrl and networkRetryCount reset to 0.
    vi.spyOn(client as any, "_handleErrorResponse").mockImplementation(
      async (params: any) =>
        await (client as any)._makeRequest({
          ...params,
          baseUrl: NEXT_URL,
          networkRetryCount: 0,
        })
    );

    const response = await (client as any)._makeRequest(requestParams());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toBe(`${NEXT_URL}v1/chat/completions`);
    expect(fetchMock.mock.calls[3][0]).toBe(`${NEXT_URL}v1/chat/completions`);
  });
});

describe("RoutstrClient transient socket retry over real networking", () => {
  it("recovers when a real server resets the first connection", async () => {
    // No fetch stub: the server accepts the connection and destroys the socket
    // before writing a response, which is what the incident's provider did.
    let connections = 0;
    const server = createServer((req, res) => {
      connections++;
      if (connections === 1) {
        req.socket.destroy();
        return;
      }
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const client = makeClient();
      const response = await (client as any)._makeRequest(
        requestParams({ baseUrl: `http://127.0.0.1:${port}/` })
      );

      expect(response.status).toBe(200);
      expect(connections).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
