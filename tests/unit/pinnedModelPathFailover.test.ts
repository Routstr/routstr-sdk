/**
 * A pinned x-routstr-model-path selector is only guaranteed valid on the node
 * that advertised it, so failing a pinned request over to a different
 * provider would send a selector the new node may not accept and get 404
 * invalid_model_path back (observed against a live node:
 * "Model 'deepseek-v4.1-flash' is not routable through provider 5").
 *
 * These tests pin that behavior on RoutstrClient._handleErrorResponse.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import {
  clearModelPathsCache,
  DEEPSEEK_AUTO_NODE_URLS,
  modelPathCandidateKey,
} from "../../utils/modelPaths";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://ai.redsh1ft.com/";
const MINT_URL = "https://mint.example.com";
const TOKEN = "cashu_token_123";
const SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&model-id=deepseek-v4.1-flash";
const INVALID_MODEL_PATH_BODY = JSON.stringify({
  error: {
    message: "Model 'deepseek-v4.1-flash' is not routable through provider 5",
    type: "invalid_model_path",
    code: 404,
  },
  request_id: "req-1",
});

// Whitelisted upstream routes, as advertised on GET /v1/models/paths.
const DEEPSEEK_SEL =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
const FIREWORKS_SEL =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks";

const pathsPayload = (selectors: string[]) => ({
  data: [
    {
      id: "deepseek-v4.1-flash",
      paths: selectors.map((path) => ({
        path,
        provider: { slug: "openrouter", type: "openrouter" },
        endpoint: null,
        model: {
          sats_pricing: { prompt: 0.001, completion: 0.001, max_cost: 700 },
        },
      })),
    },
  ],
  updated_at: null,
});

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

const createDiscovery = (
  overrides?: Partial<DiscoveryAdapter>
): DiscoveryAdapter =>
  ({
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
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
    ...overrides,
  }) as DiscoveryAdapter;

const makeModel = (): Model =>
  ({
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

const errorParams = (baseHeaders: Record<string, string>) => ({
  path: "/v1/chat/completions",
  method: "POST",
  body: { messages: [] },
  selectedModel: makeModel(),
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token: TOKEN,
  requiredSats: 100,
  headers: {},
  baseHeaders,
  tinfoilEnabled: false,
});

function makeClient(discovery?: DiscoveryAdapter) {
  return new RoutstrClient(
    createWallet(),
    createStorage(),
    discovery ?? createDiscovery(),
    "ERROR",
    "xcashu"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RoutstrClient pinned model-path failover", () => {
  it("never fails a pinned request over to another provider", async () => {
    const client = makeClient();
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    await expect(
      (client as any)._handleErrorResponse(
        errorParams({ "x-routstr-model-path": SELECTOR }),
        TOKEN,
        404,
        "req-1",
        undefined,
        INVALID_MODEL_PATH_BODY
      )
    ).rejects.toThrow();

    expect(findNext).not.toHaveBeenCalled();
  });

  it("cools down the pinned path on the provider, not the model or provider", async () => {
    const client = makeClient();
    const markFailed = vi.spyOn(
      (client as any).providerManager,
      "markFailed"
    );

    await expect(
      (client as any)._handleErrorResponse(
        errorParams({ "x-routstr-model-path": SELECTOR }),
        TOKEN,
        404,
        "req-1",
        undefined,
        INVALID_MODEL_PATH_BODY
      )
    ).rejects.toThrow();

    expect(markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=invalid_model_path"),
      "deepseek-v4.1-flash",
      // canonical path identity of SELECTOR
      "url=https%3A%2F%2Fapi.deepseek.com&model-id=deepseek-v4.1-flash"
    );
  });

  it("fails an auto-pinned request over to the next model-path node with a swapped selector", async () => {
    const NEXT_SELECTOR =
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
    const client = makeClient();
    const ranking = vi
      .spyOn((client as any).providerManager, "getModelPathProviderRanking")
      .mockResolvedValue([
        {
          baseUrl: "https://routstr.otrta.me/",
          selectors: [NEXT_SELECTOR],
          satsPricing: [null],
          model: makeModel(),
        },
      ]);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "fresh_token",
      selectedMintUrl: MINT_URL,
      tokenBalance: 100,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const makeRequest = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok"));

    const params = {
      ...errorParams({ "x-routstr-model-path": SELECTOR }),
      autoModelPath: { selector: SELECTOR },
    };
    const response = await (client as any)._handleErrorResponse(
      params,
      TOKEN,
      404,
      "req-1",
      undefined,
      INVALID_MODEL_PATH_BODY
    );

    expect(response.status).toBe(200);
    // A route-scoped failure keeps the node's other routes in play: only
    // the failed candidate is excluded from the chain, never the whole
    // node.
    const [, rankingOptions] = ranking.mock.calls[0];
    expect([...(rankingOptions.excludeModelPaths ?? [])]).toEqual([
      modelPathCandidateKey(BASE_URL, SELECTOR),
    ]);
    expect(rankingOptions.excludeBaseUrl).toBeUndefined();
    const retry = makeRequest.mock.calls[0][0];
    expect(retry.triedModelPaths).toEqual([
      modelPathCandidateKey(BASE_URL, SELECTOR),
    ]);
    expect(retry.baseUrl).toBe("https://routstr.otrta.me/");
    // The retry pins the NEW node's selector; the failed node's selector is
    // never forwarded.
    expect(retry.baseHeaders["x-routstr-model-path"]).toBe(NEXT_SELECTOR);
    expect(retry.autoModelPath).toEqual({
      selector: NEXT_SELECTOR,
      satsPricing: undefined,
    });
    expect(
      new Headers(retry.headers).get("x-routstr-model-path")
    ).toBe(NEXT_SELECTOR);
  });

  it("surfaces the error when an auto-pinned request has no model-path node left", async () => {
    const client = makeClient();
    vi.spyOn(
      (client as any).providerManager,
      "getModelPathProviderRanking"
    ).mockResolvedValue([]);

    await expect(
      (client as any)._handleErrorResponse(
        {
          ...errorParams({ "x-routstr-model-path": SELECTOR }),
          autoModelPath: { selector: SELECTOR },
        },
        TOKEN,
        404,
        "req-1",
        undefined,
        INVALID_MODEL_PATH_BODY
      )
    ).rejects.toThrow();
  });

  it("keeps the auto-pin marker through routeRequest so failover is reachable", async () => {
    // Regression: routeRequest() used to drop autoModelPath before the initial
    // _makeRequest, so _handleErrorResponse mistook every SDK auto-pin for a
    // caller pin and never failed over. Drive the real
    // routeRequest -> _makeRequest -> _handleErrorResponse seam; only the
    // payment/accounting boundaries and transport are stubbed.
    const NEXT_SELECTOR =
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
    const NEXT_BASE_URL = "https://routstr.otrta.me/";
    const client = makeClient();
    // _checkBalance needs a funded wallet to get past the request preamble.
    (client as any).walletAdapter.getBalances = async () => ({
      [MINT_URL]: 500,
    });
    // The xcashu recovery preamble only reclaims tokens with a `cashu`
    // prefix (RoutstrClient._handleErrorResponse), so the mocked spend must
    // return one — like the real _spendToken does.
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_token",
      selectedMintUrl: MINT_URL,
      tokenBalance: 500,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(
      0
    );
    vi.spyOn(
      (client as any).providerManager,
      "getModelForProvider"
    ).mockResolvedValue(makeModel());
    const ranking = vi
      .spyOn((client as any).providerManager, "getModelPathProviderRanking")
      .mockResolvedValue([
        {
          baseUrl: NEXT_BASE_URL,
          selectors: [NEXT_SELECTOR],
          satsPricing: [null],
          model: makeModel(),
        },
      ]);
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(BASE_URL)) {
        return new Response(INVALID_MODEL_PATH_BODY, {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      headers: { "x-routstr-model-path": SELECTOR },
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      modelId: "deepseek-v4.1-flash",
      autoModelPath: { selector: SELECTOR },
    });

    expect(response.status).toBe(200);
    // The auto-pin marker survived into _handleErrorResponse: the model-path
    // failover branch ran (a caller-pinned request would never get here).
    const [, rankingOptions] = ranking.mock.calls[0];
    expect([...(rankingOptions.excludeModelPaths ?? [])]).toEqual([
      modelPathCandidateKey(BASE_URL, SELECTOR),
    ]);
    expect(findNext).not.toHaveBeenCalled();
    // First attempt failed on BASE_URL; the retry went to the next node.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(NEXT_BASE_URL);
    // The failed node's selector is never forwarded; the retry pins the new
    // node's own selector.
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).get(
        "x-routstr-model-path"
      )
    ).toBe(NEXT_SELECTOR);
  });

  it("walks the node-major chain and never retries a candidate that failed", async () => {
    // Regression: failover used to exclude the whole failed node (skipping
    // node1:fireworks) and, since one strike does not cool a route down,
    // later hops could revisit candidates that already failed within the
    // request. Drive the real routeRequest -> _makeRequest ->
    // _handleErrorResponse seam with the REAL model-path ranking; only the
    // payment/accounting boundaries, discovery cache and transport are
    // stubbed.
    const [NODE_A, NODE_B] = DEEPSEEK_AUTO_NODE_URLS;
    clearModelPathsCache();
    const client = makeClient(
      createDiscovery({
        getCachedModels: () => ({
          [`${NODE_A}/`]: [makeModel()],
          [`${NODE_B}/`]: [makeModel()],
        }),
      })
    );
    (client as any).walletAdapter.getBalances = async () => ({
      [MINT_URL]: 500,
    });
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_token",
      selectedMintUrl: MINT_URL,
      tokenBalance: 500,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(
      0
    );
    vi.spyOn(
      (client as any).providerManager,
      "getModelForProvider"
    ).mockResolvedValue(makeModel());

    const attempts: Array<{ url: string; selector: string | null }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/models/paths")) {
        return new Response(
          JSON.stringify(pathsPayload([DEEPSEEK_SEL, FIREWORKS_SEL])),
          { headers: { "content-type": "application/json" } }
        );
      }
      attempts.push({
        url,
        selector: new Headers(init?.headers).get("x-routstr-model-path"),
      });
      if (attempts.length < 3) {
        return new Response(INVALID_MODEL_PATH_BODY, {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      headers: { "x-routstr-model-path": DEEPSEEK_SEL },
      baseUrl: `${NODE_A}/`,
      mintUrl: MINT_URL,
      modelId: "deepseek-v4.1-flash",
      autoModelPath: { selector: DEEPSEEK_SEL },
    });

    expect(response.status).toBe(200);
    // Node-major chain: every route of the cheaper node before the next
    // node, and no candidate is ever attempted twice.
    expect(attempts).toEqual([
      { url: `${NODE_A}/v1/chat/completions`, selector: DEEPSEEK_SEL },
      { url: `${NODE_A}/v1/chat/completions`, selector: FIREWORKS_SEL },
      { url: `${NODE_B}/v1/chat/completions`, selector: DEEPSEEK_SEL },
    ]);
  });

  it("jumps straight to the next node after a provider-wide failure", async () => {
    // A network failure is provider-wide (the host is down), matching the
    // cooldown scope rules: the node's other routes share the host, so the
    // chain must not burn a paid retry on them.
    const [NODE_A, NODE_B] = DEEPSEEK_AUTO_NODE_URLS;
    clearModelPathsCache();
    const client = makeClient(
      createDiscovery({
        getCachedModels: () => ({
          [`${NODE_A}/`]: [makeModel()],
          [`${NODE_B}/`]: [makeModel()],
        }),
      })
    );
    (client as any).walletAdapter.getBalances = async () => ({
      [MINT_URL]: 500,
    });
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_token",
      selectedMintUrl: MINT_URL,
      tokenBalance: 500,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(
      0
    );
    vi.spyOn(
      (client as any).providerManager,
      "getModelForProvider"
    ).mockResolvedValue(makeModel());

    const attempts: Array<{ url: string; selector: string | null }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/models/paths")) {
        return new Response(
          JSON.stringify(pathsPayload([DEEPSEEK_SEL, FIREWORKS_SEL])),
          { headers: { "content-type": "application/json" } }
        );
      }
      attempts.push({
        url,
        selector: new Headers(init?.headers).get("x-routstr-model-path"),
      });
      if (attempts.length === 1) {
        throw new Error("Failed to fetch");
      }
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      headers: { "x-routstr-model-path": DEEPSEEK_SEL },
      baseUrl: `${NODE_A}/`,
      mintUrl: MINT_URL,
      modelId: "deepseek-v4.1-flash",
      autoModelPath: { selector: DEEPSEEK_SEL },
    });

    expect(response.status).toBe(200);
    expect(attempts).toEqual([
      { url: `${NODE_A}/v1/chat/completions`, selector: DEEPSEEK_SEL },
      { url: `${NODE_B}/v1/chat/completions`, selector: DEEPSEEK_SEL },
    ]);
  });

  it("never fails a caller-pinned request over through the real request seam", async () => {
    const client = makeClient();
    (client as any).walletAdapter.getBalances = async () => ({
      [MINT_URL]: 500,
    });
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_token",
      selectedMintUrl: MINT_URL,
      tokenBalance: 500,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    vi.spyOn(
      (client as any).providerManager,
      "getModelForProvider"
    ).mockResolvedValue(makeModel());
    const ranking = vi.spyOn(
      (client as any).providerManager,
      "getModelPathProviderRanking"
    );
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response(INVALID_MODEL_PATH_BODY, {
          status: 404,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    // Caller pins its own selector and does NOT set autoModelPath.
    await expect(
      client.routeRequest({
        path: "/v1/chat/completions",
        method: "POST",
        body: { messages: [] },
        headers: { "x-routstr-model-path": SELECTOR },
        baseUrl: BASE_URL,
        mintUrl: MINT_URL,
        modelId: "deepseek-v4.1-flash",
      })
    ).rejects.toThrow();

    expect(ranking).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still fails over when no path is pinned", async () => {
    const client = makeClient();
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    await expect(
      (client as any)._handleErrorResponse(
        errorParams({}),
        TOKEN,
        404,
        "req-1",
        undefined,
        INVALID_MODEL_PATH_BODY
      )
    ).rejects.toThrow();

    expect(findNext).toHaveBeenCalledOnce();
  });
});
