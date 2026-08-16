/**
 * Behavior tests for the apikeys-bootstrap + `cashu_mint_unreachable` case.
 *
 * Scenario: in apikeys mode the very first request to a provider is made with
 * a bootstrap Cashu token (created by `_spendToken` and stored via
 * `setApiKey` — i.e. the canonical API key swap has not happened yet). If that
 * request fails with 503 `cashu_mint_unreachable`, the provider never consumed
 * the proofs, so the SDK receives the bootstrap token back into the wallet and
 * — because the failure identifies the mint, not the provider — retries the
 * same provider with the failed mint excluded.
 *
 * The fixes under test:
 *
 * - `RoutstrClient._handleErrorResponse` purges the stored bootstrap API key
 *   (which is now permanently dead) when the token is restored, instead of
 *   leaving a zombie `apiKeys[]` entry. It preserves a concurrently-swapped
 *   canonical key.
 * - `RoutstrClient._handleErrorResponse` treats `mint_unreachable` as retryable
 *   and re-spends from another mint against the same provider (no provider
 *   failover) when one is available.
 * - `RoutstrClient._spendToken` validates a stored cashu-prefixed key before
 *   reuse and recreates it when the provider reports it dead.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://provider.example.com/";
const SECOND_BASE_URL = "https://provider2.example.com/";
const MINT_URL = "https://mint.example.com";
const BOOTSTRAP_TOKEN = "cashu_bootstrap_token_123";
const MINT_UNREACHABLE_BODY = JSON.stringify({
  error: {
    type: "mint_unreachable",
    code: "cashu_mint_unreachable",
    message: "Cashu mint is unreachable",
  },
  request_id: "req-503",
});

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 3945, unit: "sat" }),
  ...overrides,
});

/**
 * Stateful storage mock: mirrors real store semantics for the single API key
 * per baseUrl (setApiKey replaces, removeApiKey clears, getApiKey reflects the
 * current value) so the flow under test behaves like production.
 */
const createStorage = (
  initialKey: string | null = BOOTSTRAP_TOKEN
): StorageAdapter & {
  removedApiKeys: string[];
  removedXcashu: Array<[string, string]>;
  setApiKeys: string[];
} => {
  let storedKey: string | null = initialKey;
  const removedApiKeys: string[] = [];
  const removedXcashu: Array<[string, string]> = [];
  const setApiKeys: string[] = [];

  const storage = {
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: (baseUrl: string, token: string) => {
      removedXcashu.push([baseUrl, token]);
    },
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    getApiKeyDistribution: () =>
      storedKey ? [{ baseUrl: BASE_URL, amount: 0 }] : [],
    removeApiKey: (baseUrl: string) => {
      removedApiKeys.push(baseUrl);
      storedKey = null;
    },
    saveProviderInfo: () => {},
    getProviderInfo: () => null,
    getApiKey: (baseUrl: string) =>
      storedKey
        ? { key: storedKey, baseUrl: BASE_URL, balance: 0, lastUsed: Date.now() }
        : null,
    setApiKey: (_baseUrl: string, key: string) => {
      setApiKeys.push(key);
      storedKey = key;
    },
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
  } as StorageAdapter;

  return Object.assign(storage, { removedApiKeys, removedXcashu, setApiKeys });
};

const createDiscovery = (
  overrides?: Partial<DiscoveryAdapter>
): DiscoveryAdapter => ({
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
});

const makeModel = (): Model =>
  ({
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

const errorParams = (token: string) => ({
  path: "/v1/chat/completions",
  method: "POST",
  body: { messages: [] },
  selectedModel: makeModel(),
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token,
  requiredSats: 100,
  headers: {},
  baseHeaders: {},
  tinfoilEnabled: false,
});

const failoverProviderManager = () => {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set<string>(),
    findNextBestProvider: vi.fn(() => SECOND_BASE_URL),
    getModelForProvider: vi.fn(async () => makeModel()),
    getRequiredSatsForModel: vi.fn(() => 100),
  } as any;
  return providerManager;
};

describe("RoutstrClient._handleErrorResponse — apikeys bootstrap, 503 mint_unreachable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("restores the bootstrap token, removes the dead API key, skips refundApiKey, and retries the same provider with the failed mint excluded", async () => {
    const storage = createStorage(BOOTSTRAP_TOKEN);
    const providerManager = failoverProviderManager();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys",
      { providerManager }
    );
    const receiveSpy = vi.spyOn(client.getCashuSpender(), "receiveToken");
    const getBalanceSpy = vi.spyOn(
      client.getBalanceManager(),
      "getTokenBalance"
    );
    const refundSpy = vi.spyOn(client.getBalanceManager(), "refundApiKey");
    const spendSpy = vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_failover_token",
      tokenBalance: 1000,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
      selectedMintUrl: "https://fallback-mint.example.com",
    });
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      errorParams(BOOTSTRAP_TOKEN),
      BOOTSTRAP_TOKEN,
      503,
      "req-503",
      undefined, // no x-cashu refund header for mint_unreachable
      MINT_UNREACHABLE_BODY,
      0
    );

    expect(response.status).toBe(200);
    // Sats reclaimed by receiving the bootstrap token directly.
    expect(receiveSpy).toHaveBeenCalledOnce();
    expect(receiveSpy).toHaveBeenCalledWith(BOOTSTRAP_TOKEN);
    // Stale bootstrap key purged from the apiKeys store.
    expect(storage.removedApiKeys).toEqual([BASE_URL]);
    // The xcashu store is untouched in apikeys mode — the bootstrap token was
    // never an xcashu IOU, so removeXcashuToken must not be called.
    expect(storage.removedXcashu).toEqual([]);
    // The 503 refund branch is short-circuited — no refund round-trip.
    expect(getBalanceSpy).not.toHaveBeenCalled();
    expect(refundSpy).not.toHaveBeenCalled();
    // mint_unreachable is retryable: the failure identified the mint, not the
    // provider, so the failed mint is excluded and the SAME provider is
    // retried with a fresh token from another mint — no provider failover.
    expect(spendSpy).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: BASE_URL,
      excludeMints: [MINT_URL],
    });
    expect(providerManager.markFailed).not.toHaveBeenCalled();
    expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
    expect(makeRequestSpy).toHaveBeenCalledOnce();
    const retryParams = makeRequestSpy.mock.calls[0][0];
    expect(retryParams.baseUrl).toBe(BASE_URL);
    expect(retryParams.token).toBe("cashu_fresh_failover_token");
    expect(retryParams.excludeMints).toEqual([MINT_URL]);
    expect(retryParams.selectedMintUrl).toBe(
      "https://fallback-mint.example.com"
    );
  });

  it("preserves a canonical API key swapped in while the 503 response was in flight", async () => {
    const storage = createStorage("canonical-api-key");
    const providerManager = failoverProviderManager();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys",
      { providerManager }
    );
    const receiveSpy = vi.spyOn(client.getCashuSpender(), "receiveToken");
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_failover_token",
      tokenBalance: 1000,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      errorParams(BOOTSTRAP_TOKEN),
      BOOTSTRAP_TOKEN,
      503,
      "req-503",
      undefined,
      MINT_UNREACHABLE_BODY,
      0
    );

    expect(response.status).toBe(200);
    // Sats are still restored...
    expect(receiveSpy).toHaveBeenCalledWith(BOOTSTRAP_TOKEN);
    // ...but the live canonical key must NOT be deleted.
    expect(storage.removedApiKeys).toEqual([]);
  });

  it("xcashu mode: same restore, removes the xcashu IOU, never touches apiKeys (regression guard)", async () => {
    const storage = createStorage(null);
    const providerManager = failoverProviderManager();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "xcashu",
      { providerManager }
    );
    const receiveSpy = vi.spyOn(client.getCashuSpender(), "receiveToken");
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_failover_token",
      tokenBalance: 1000,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await (client as any)._handleErrorResponse(
      errorParams(BOOTSTRAP_TOKEN),
      BOOTSTRAP_TOKEN,
      503,
      "req-503",
      undefined,
      MINT_UNREACHABLE_BODY,
      0
    );

    expect(response.status).toBe(200);
    expect(receiveSpy).toHaveBeenCalledWith(BOOTSTRAP_TOKEN);
    expect(storage.removedXcashu).toEqual([[BASE_URL, BOOTSTRAP_TOKEN]]);
    expect(storage.removedApiKeys).toEqual([]);
  });
});

describe("RoutstrClient._spendToken — apikeys bootstrap key validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("detects a dead bootstrap key (proofs already spent) and recreates it", async () => {
    const storage = createStorage(BOOTSTRAP_TOKEN);
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys"
    );
    vi.spyOn(
      client.getBalanceManager(),
      "getTokenBalance"
    ).mockResolvedValue({
      amount: 0,
      reserved: 0,
      unit: "sat",
      apiKey: "",
      isInvalidApiKey: true,
      balanceUnknown: false,
    });
    vi.spyOn(client.getCashuSpender(), "spend").mockResolvedValue({
      success: true,
      token: "cashu_fresh_key",
      balance: 100,
      unit: "sat",
    });

    const result = await (client as any)._spendToken({
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: BASE_URL,
    });

    // The zombie key was purged and a fresh bootstrap key created in its place.
    expect(storage.removedApiKeys).toEqual([BASE_URL]);
    expect(storage.setApiKeys).toEqual(["cashu_fresh_key"]);
    expect(result.token).toBe("cashu_fresh_key");
  });

  it("keeps a live bootstrap key when the balance check succeeds", async () => {
    const storage = createStorage(BOOTSTRAP_TOKEN);
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys"
    );
    vi.spyOn(
      client.getBalanceManager(),
      "getTokenBalance"
    ).mockResolvedValue({
      amount: 5000,
      reserved: 0,
      unit: "msat",
      apiKey: "",
      isInvalidApiKey: false,
      balanceUnknown: false,
    });

    const result = await (client as any)._spendToken({
      mintUrl: MINT_URL,
      amount: 100,
      baseUrl: BASE_URL,
    });

    expect(storage.removedApiKeys).toEqual([]);
    expect(storage.setApiKeys).toEqual([]);
    expect(result.token).toBe(BOOTSTRAP_TOKEN);
  });
});
