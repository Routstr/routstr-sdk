import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example.com/";
const OTHER_URL = "https://other.example.com/";
const MINT_URL = "https://mint.example.com";
const API_KEY = "sk-test-key";

const createWallet = (): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => MINT_URL,
  sendToken: async () => "cashu-token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
});

const createStorage = (): StorageAdapter => ({
  getXcashuTokens: () => ({}),
  getXcashuTokensForBaseUrl: () => [],
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  clearXcashuTokensForBaseUrl: () => {},
  updateXcashuTokenTryCount: () => {},
  getApiKeyDistribution: () => [],
  getApiKey: () => ({
    key: API_KEY,
    baseUrl: BASE_URL,
    balance: 0,
    lastUsed: null,
  }),
  setApiKey: () => {},
  updateApiKeyBalance: () => {},
  touchApiKeyLastUsed: () => {},
  removeApiKey: () => {},
  getAllApiKeys: () => [],
  getChildKey: () => null,
  setChildKey: () => {},
  updateChildKeyBalance: () => {},
  removeChildKey: () => {},
  getAllChildKeys: () => [],
  getCachedReceiveTokens: () => [],
  setCachedReceiveTokens: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
});

const createDiscovery = (): DiscoveryAdapter => ({
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
});

const model = {
  id: "gpt-test",
  name: "GPT Test",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

const params = {
  path: "/v1/chat/completions",
  method: "POST",
  body: { model: model.id, messages: [] },
  selectedModel: model,
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token: API_KEY,
  requiredSats: 100,
  headers: {},
  baseHeaders: {},
  tinfoilEnabled: false,
};

/** Verbatim routstr-core reply for a body over `max_request_body_bytes`. */
const CORE_BYTE_LIMIT_BODY = JSON.stringify({
  error: {
    message: "Request body exceeds the 20971520 byte limit",
    type: "invalid_request",
    code: 413,
  },
  request_id: "node-request-id",
});

/** What nginx in front of a provider returns. */
const NGINX_BODY =
  "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n" +
  "<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n" +
  "<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>\r\n";

function createClient(nextProvider: string | null = null) {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(() => nextProvider),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 5),
  } as any;
  const client = new RoutstrClient(
    createWallet(),
    createStorage(),
    createDiscovery(),
    "ERROR",
    "apikeys",
    { providerManager }
  );
  return { client, providerManager };
}

async function handle413(
  client: RoutstrClient,
  body: string
) {
  return (client as any)._handleErrorResponse(
    params,
    API_KEY,
    413,
    "req-413",
    undefined,
    body
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("_handleErrorResponse with an oversized body", () => {
  it("retries the same provider zero times", async () => {
    const { client } = createClient();
    const retry = vi.spyOn(client as any, "_makeRequest");
    const getBalance = vi.spyOn(client.getBalanceManager(), "getTokenBalance");

    const response = await handle413(client, CORE_BYTE_LIMIT_BODY);
    expect(response.status).toBe(413);
    expect(retry).not.toHaveBeenCalled();
    // The key is fine; reading its balance is pure overhead.
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("does not cool the provider or its model path down", async () => {
    const { client, providerManager } = createClient();

    await handle413(client, CORE_BYTE_LIMIT_BODY);
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("does not refund a key that was never charged", async () => {
    const { client } = createClient();
    const refund = vi.spyOn(client.getBalanceManager(), "refundApiKey");

    await handle413(client, NGINX_BODY);
    expect(refund).not.toHaveBeenCalled();
  });

  it("fails over to a candidate that accepts the body", async () => {
    const { client, providerManager } = createClient(OTHER_URL);
    providerManager.findNextBestProvider = vi.fn(() => OTHER_URL);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "sk-next",
      selectedMintUrl: MINT_URL,
      tokenBalance: 50,
      tokenBalanceUnit: "sat",
    });
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await handle413(client, CORE_BYTE_LIMIT_BODY);

    expect(response.status).toBe(200);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: OTHER_URL, retryCount: 0 })
    );
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a Core ingress cap", scope: undefined, expectAlternatePath: false },
    { name: "an upstream cap", scope: "upstream", expectAlternatePath: true },
  ])("keeps the correct node exclusion across failover after $name", async ({
    scope,
    expectAlternatePath,
  }) => {
    const { client, providerManager } = createClient();
    const initial = { baseUrl: BASE_URL, selector: "openai:gpt-test" };
    const alternate = { baseUrl: BASE_URL, selector: "anthropic:gpt-test" };
    const other = { baseUrl: OTHER_URL, selector: "openai:gpt-test" };
    providerManager.getModelPathProviderRanking = vi.fn(async (_modelId, options) =>
      [other, alternate].filter(candidate =>
        !options.excludeBaseUrls?.has(candidate.baseUrl) &&
        !new Set(options.excludeModelPaths).has(`${candidate.baseUrl}|${candidate.selector}`)
      )
    );
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "sk-next",
      tokenBalance: 50,
      tokenBalanceUnit: "sat",
    });
    const makeRequest = vi.spyOn(client as any, "_makeRequest").mockImplementation(
      async (next: any) => next.baseUrl === OTHER_URL
        ? (client as any)._handleErrorResponse(
            next, next.token, 413, undefined, undefined, NGINX_BODY
          )
        : new Response("{}", { status: 200 })
    );

    const response = await (client as any)._handleErrorResponse(
      { ...params, autoModelPath: initial, baseHeaders: { "x-routstr-model-path": initial.selector } },
      API_KEY, 413, undefined, undefined, CORE_BYTE_LIMIT_BODY, 0,
      { status: 413, headers: scope ? { "x-routstr-error-scope": scope } : {} }
    );

    expect(makeRequest.mock.calls.map(([next]: any[]) => next.baseUrl)).toEqual(
      expectAlternatePath ? [OTHER_URL, BASE_URL] : [OTHER_URL]
    );
    expect(response.status).toBe(expectAlternatePath ? 200 : 413);
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it.each([CORE_BYTE_LIMIT_BODY, NGINX_BODY, ""])("surfaces a 413 as a payload rejection (%s)", async (body) => {
    const { client } = createClient();

    const response = await handle413(client, body);

    expect(response.status).toBe(413);
    const aggregate = await response.json();
    expect(aggregate.error.type).toBe("all_providers_failed");
    expect(aggregate.error.errors[0].status).toBe(413);
  });
});
