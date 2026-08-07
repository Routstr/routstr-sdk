/**
 * Behavior tests for the `mint_error` (HTTP 422) handling across the SDK.
 *
 * The parser (`parseCoreError`) and `shouldFailoverToAnotherMint` have their own
 * unit tests — these cover the *actual* behavior changes from the
 * handle-core-error-codes task:
 *
 * - `RoutstrClient._handleErrorResponse` detects `mint_error`, does NOT treat
 *   the token as spent (it was never consumed — the mint rejected the melt),
 *   lets the xcashu reclaim path restore the sats, skips the pointless refund
 *   against the same failing mint, fails over to the next provider, and
 *   throws `MintError` (not a generic `ProviderError`/`FailoverError`) when
 *   every provider is exhausted.
 * - `MintError` class carries the base URL, 422 status, mint URL, stable
 *   code, parsed error, and request ID.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { MintError } from "../../core/errors";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://provider.example.com/";
const SECOND_BASE_URL = "https://provider2.example.com/";
const MINT_URL = "https://mint.example.com";
const API_KEY = "stored-api-key";
const MINT_ERROR_BODY = JSON.stringify({
  error: {
    type: "mint_error",
    code: "cashu_foreign_mint_swap_failed",
    message: "Foreign mint swap failed",
  },
  request_id: "req-422",
});
const FEES_EXCEED_BODY = JSON.stringify({
  error: {
    type: "mint_error",
    code: "cashu_token_swap_fees_exceed_amount",
    message: "Swap fees exceed token amount",
  },
  request_id: "req-422b",
});

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  ...overrides,
});

const createStorage = (overrides?: Partial<StorageAdapter>) => {
  const removedXcashu: Array<[string, string]> = [];
  const removedApiKeys: string[] = [];
  return {
    storage: {
      getXcashuTokens: () => ({}),
      getXcashuTokensForBaseUrl: () => [],
      addXcashuToken: () => {},
      removeXcashuToken: (baseUrl: string, token: string) => {
        removedXcashu.push([baseUrl, token]);
      },
      clearXcashuTokensForBaseUrl: () => {},
      updateXcashuTokenTryCount: () => {},
      getApiKeyDistribution: () => [],
      removeApiKey: (baseUrl: string) => {
        removedApiKeys.push(baseUrl);
      },
      saveProviderInfo: () => {},
      getProviderInfo: () => null,
      getApiKey: (baseUrl: string) =>
        baseUrl === BASE_URL
          ? { key: API_KEY, baseUrl: BASE_URL, balance: 42, lastUsed: null }
          : null,
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
      ...overrides,
    },
    removedXcashu,
    removedApiKeys,
  };
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

describe("RoutstrClient._handleErrorResponse — mint_error (422)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("xcashu mode: reclaims the (unspent) token, does not treat it as spent, throws MintError when exhausted", async () => {
    const { storage, removedXcashu } = createStorage();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "xcashu"
    );
    // Failover is exhausted because discovery has no cached models.
    const receiveSpy = vi.spyOn(
      client.getCashuSpender(),
      "receiveToken"
    );

    const token = "cashu_mint_error_token_123";
    const promise = (client as any)._handleErrorResponse(
      errorParams(token),
      token,
      422,
      "req-422",
      undefined, // no refund header needed — the token was never consumed
      MINT_ERROR_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(MintError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 422,
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      code: "cashu_foreign_mint_swap_failed",
      requestId: "req-422",
    });
    // The reclaim path MUST run for mint_error (unlike token_already_spent):
    // the mint rejected the melt, so the original token is still spendable
    // and the sats should be restored to the wallet.
    expect(receiveSpy).toHaveBeenCalledWith(token);
    // The IOU is dropped because the token was received back into the wallet
    // (reclaim success path), NOT because it was spent.
    expect(removedXcashu).toEqual([[BASE_URL, token]]);
  });

  it("xcashu mode: if the reclaim fails, throws MintError (not a generic ProviderError)", async () => {
    const { storage, removedXcashu } = createStorage();
    const client = new RoutstrClient(
      createWallet({
        receiveToken: async () => ({
          success: false,
          error: "could not receive",
        }),
      }),
      storage,
      createDiscovery(),
      "ERROR",
      "xcashu"
    );

    const token = "cashu_mint_error_unreclaimable";
    const promise = (client as any)._handleErrorResponse(
      errorParams(token),
      token,
      422,
      "req-422",
      undefined,
      MINT_ERROR_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(MintError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 422,
      code: "cashu_foreign_mint_swap_failed",
    });
    // Nothing was reclaimed, so the IOU stays in storage for a later sweep.
    expect(removedXcashu).toEqual([]);
  });

  it("apikeys mode: does not remove the key and skips the refund against the failing mint", async () => {
    const { storage, removedApiKeys } = createStorage();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys"
    );
    const balanceManager = (client as any).balanceManager;
    const getTokenBalanceSpy = vi
      .spyOn(balanceManager, "getTokenBalance")
      .mockResolvedValue({
        balanceUnknown: true,
        isInvalidApiKey: false,
        amount: 0,
        unit: "sat",
      });
    const refundSpy = vi
      .spyOn(balanceManager, "refundApiKey")
      .mockResolvedValue({ success: true });

    const promise = (client as any)._handleErrorResponse(
      errorParams(API_KEY),
      API_KEY,
      422,
      "req-422",
      undefined,
      MINT_ERROR_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(MintError);
    // The key's balance is intact (mint rejected the melt) — keep it.
    expect(removedApiKeys).toEqual([]);
    // A refund would melt at the same failing mint → skip it entirely.
    expect(getTokenBalanceSpy).not.toHaveBeenCalled();
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it("apikeys mode: does not remove the key for fee-exceeds-amount either (sats are intact)", async () => {
    const { storage, removedApiKeys } = createStorage();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys"
    );

    const promise = (client as any)._handleErrorResponse(
      errorParams(API_KEY),
      API_KEY,
      422,
      "req-422b",
      undefined,
      FEES_EXCEED_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(MintError);
    expect(removedApiKeys).toEqual([]);
  });

  it("fails over to the next provider with a fresh token when available", async () => {
    const { storage } = createStorage();
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set<string>(),
      findNextBestProvider: vi.fn(() => SECOND_BASE_URL),
      getModelForProvider: vi.fn(async () => makeModel()),
      getRequiredSatsForModel: vi.fn(() => 100),
    } as any;
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "xcashu",
      { providerManager }
    );
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_failover_token",
      tokenBalance: 1000,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const makeRequestSpy = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const token = "cashu_mint_error_token_456";
    const response = await (client as any)._handleErrorResponse(
      errorParams(token),
      token,
      422,
      "req-789",
      undefined,
      MINT_ERROR_BODY,
      0
    );

    expect(response.status).toBe(200);
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=mint_error")
    );
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
    // Retry went to the failover provider with a fresh token.
    expect(makeRequestSpy).toHaveBeenCalledOnce();
    const retryParams = makeRequestSpy.mock.calls[0][0];
    expect(retryParams.baseUrl).toBe(SECOND_BASE_URL);
    expect(retryParams.token).toBe("cashu_fresh_failover_token");
  });
});

describe("MintError class", () => {
  it("defaults statusCode to 422 and carries code/parsed error/request ID", () => {
    const parsedError = {
      type: "mint_error",
      code: "cashu_foreign_mint_swap_failed",
      message: "Foreign mint swap failed",
      raw: false,
    };
    const err = new MintError({
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      code: parsedError.code,
      parsedError,
      requestId: "req-422",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MintError");
    expect(err.statusCode).toBe(422);
    expect(err.baseUrl).toBe(BASE_URL);
    expect(err.mintUrl).toBe(MINT_URL);
    expect(err.code).toBe("cashu_foreign_mint_swap_failed");
    expect(err.requestId).toBe("req-422");
    expect(err.message).toContain("Foreign mint swap failed");
  });

  it("falls back to a stable default message when no message is provided", () => {
    const err = new MintError({ baseUrl: BASE_URL });
    expect(err.message).toContain("Cashu mint rejected the token");
    expect(err.statusCode).toBe(422);
  });
});
