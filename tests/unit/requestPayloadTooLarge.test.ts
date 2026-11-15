import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import {
  isRequestPayloadTooLargeError,
  parseCoreError,
} from "../../core/errorTypes";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

/**
 * A 413 has two meanings in the routstr fleet and they need opposite handling.
 *
 * routstr-core answers 413 for an API-key balance shortfall, which is
 * repairable: refresh the key and retry. Every other 413 is the conventional
 * "request entity too large" — routstr-core's `max_request_body_bytes` cap,
 * nginx in front of a provider, or an OpenAI-style `Payload Too Large`. Those
 * cannot be repaired by retrying: the same bytes are re-sent to the same node.
 * Before this split the SDK re-sent the body twice per provider and cooled the
 * model path down, so one oversized prompt walked the whole fleet in 285 s and
 * left healthy routes on a 210 s cooldown.
 */

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

const CORE_BALANCE_BODY = JSON.stringify({
  error: {
    type: "insufficient_quota",
    code: "insufficient_balance",
    message: "Insufficient balance: 100 sats required; 20 sats available.",
  },
});

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
  body: string,
  retryCount = 0
) {
  return (client as any)._handleErrorResponse(
    params,
    API_KEY,
    413,
    "req-413",
    undefined,
    body,
    retryCount
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isRequestPayloadTooLargeError", () => {
  const classify = (body: string, status = 413) =>
    isRequestPayloadTooLargeError(status, parseCoreError(body, status));

  it("recognizes a routstr-core byte-limit rejection", () => {
    expect(classify(CORE_BYTE_LIMIT_BODY)).toBe(true);
  });

  it("recognizes an HTML 413 from a provider's own proxy", () => {
    expect(classify(NGINX_BODY)).toBe(true);
  });

  it.each([
    JSON.stringify({ error: { message: "Payload Too Large" } }),
    JSON.stringify({ error: { message: "Content Too Large" } }),
    JSON.stringify({ error: { type: "invalid_request", message: "request entity too large" } }),
    // A bare 413 with no envelope at all is still a rejected body: nothing in
    // it describes a balance, so retrying the same bytes cannot help.
    "",
  ])("recognizes a generic oversized-body surface %s", (body) => {
    expect(classify(body)).toBe(true);
  });

  it("does not claim the routstr-core insufficient-balance 413", () => {
    expect(classify(CORE_BALANCE_BODY)).toBe(false);
  });

  it("does not claim a legacy 413 that only says 'Insufficient balance'", () => {
    expect(classify("Insufficient balance: 5 sats required")).toBe(false);
  });

  it("keeps a minimum-balance 413 out of the payload class", () => {
    expect(
      classify(
        JSON.stringify({
          error: { type: "minimum_balance_required", code: "minimum_balance_required" },
        })
      )
    ).toBe(false);
  });

  it.each([400, 402, 422, 500])("is limited to 413 (not %i)", (status) => {
    expect(
      isRequestPayloadTooLargeError(
        status,
        parseCoreError(CORE_BYTE_LIMIT_BODY, status)
      )
    ).toBe(false);
  });
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

  it("surfaces a uniform payload rejection as 413, not a generic 502", async () => {
    const { client } = createClient();

    const response = await handle413(client, CORE_BYTE_LIMIT_BODY);

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.type).toBe("all_providers_failed");
    expect(JSON.stringify(body)).toContain("20971520 byte limit");
  });

  it("keeps the refresh-and-retry path for the balance 413", async () => {
    const { client } = createClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await handle413(client, CORE_BALANCE_BODY);

    expect(response.status).toBe(200);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: BASE_URL, retryCount: 1 })
    );
  });
});
