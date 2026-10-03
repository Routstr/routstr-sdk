/**
 * A caller-forced provider (`forcedProvider` in resolveRequestContext, set by
 * routstrd from `x-routstr-provider` / `?provider=` / the `provider` config)
 * is a pin: the caller asked for that one node, so a failed request must never
 * be silently re-sent to a different provider. Failover across providers would
 * leak the prompt and a fresh payment to a node the caller did not choose.
 *
 * These tests pin that behavior on RoutstrClient._handleErrorResponse. The
 * `pinnedProvider` marker is threaded resolveRequestContext -> routeRequests /
 * fetchAIResponse -> RouteRequestParams -> _makeRequest -> _handleErrorResponse.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://api.nostrmodels.top/";
const MINT_URL = "https://mint.example.com";
const TOKEN = "cashu_token_123";
const UPSTREAM_ERROR_BODY = JSON.stringify({
  error: {
    message: "system: text content blocks must contain non-whitespace text",
    type: "upstream_error",
  },
  request_id: "req-1",
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
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

const errorParams = (overrides?: { pinnedProvider?: boolean }) => ({
  path: "/v1/chat/completions",
  method: "POST",
  body: { messages: [] },
  selectedModel: makeModel(),
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token: TOKEN,
  requiredSats: 100,
  headers: {},
  baseHeaders: {},
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RoutstrClient pinned-provider failover", () => {
  it("never fails a forced provider over to another provider", async () => {
    const client = makeClient();
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    const response = await (client as any)._handleErrorResponse(
      errorParams({ pinnedProvider: true }),
      TOKEN,
      400,
      "req-1",
      undefined,
      UPSTREAM_ERROR_BODY
    );

    expect(response).toBeInstanceOf(Response);
    expect(findNext).not.toHaveBeenCalled();
  });

  it("still fails over when no provider is forced", async () => {
    const client = makeClient();
    const findNext = vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    );

    const response = await (client as any)._handleErrorResponse(
      errorParams(),
      TOKEN,
      400,
      "req-1",
      undefined,
      UPSTREAM_ERROR_BODY
    );

    expect(response).toBeInstanceOf(Response);
    expect(findNext).toHaveBeenCalledOnce();
  });
});
