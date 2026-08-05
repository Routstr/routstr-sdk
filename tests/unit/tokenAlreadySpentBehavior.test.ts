/**
 * Behavior tests for the `token_already_spent` handling across the SDK.
 *
 * The parser (`parseCoreError`) and `TokenAlreadySpentError` class have their
 * own unit tests — these cover the *actual* behavior changes from the
 * handle-core-error-codes task:
 *
 * - `RoutstrClient._handleErrorResponse` detects `token_already_spent`,
 *   cleans up the spent token/API key from storage, skips refund/receive
 *   attempts, and either fails over to a fresh token or throws
 *   `TokenAlreadySpentError` when every provider is exhausted.
 * - `BalanceManager._refundApiKeyImpl` removes an API key whose proofs are
 *   spent instead of leaving it for repeated refund sweeps.
 * - `BalanceManager._topUpImpl` skips `_recoverFailedTopUp` for a spent
 *   topup token (it can never be received back).
 * - `CashuSpender.refundXcashuTokens` removes a spent xcashu token
 *   immediately instead of burning MAX_REFUND_RETRIES attempts on it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { BalanceManager } from "../../wallet/BalanceManager";
import { CashuSpender } from "../../wallet/CashuSpender";
import { TokenAlreadySpentError } from "../../core/errors";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://provider.example.com/";
const SECOND_BASE_URL = "https://provider2.example.com/";
const MINT_URL = "https://mint.example.com";
const API_KEY = "stored-api-key";
const SPENT_BODY = JSON.stringify({
  error: {
    type: "token_already_spent",
    code: "cashu_token_already_spent",
    message: "Token already spent",
  },
  request_id: "req-123",
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

describe("RoutstrClient._handleErrorResponse — token_already_spent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("xcashu mode: removes the spent token, skips refund, throws TokenAlreadySpentError when exhausted", async () => {
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

    const token = "cashu_spent_token_123";
    const promise = (client as any)._handleErrorResponse(
      errorParams(token),
      token,
      400,
      "req-123",
      undefined, // core deliberately withholds the refund header for spent tokens
      SPENT_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(TokenAlreadySpentError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 400,
      baseUrl: BASE_URL,
      requestId: "req-123",
    });
    expect(removedXcashu).toEqual([[BASE_URL, token]]);
    // Refund receive must NOT be attempted — the token is permanently gone.
    expect(receiveSpy).not.toHaveBeenCalled();
  });

  it("propagates a request ID found only in the response body", async () => {
    const { storage } = createStorage();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "xcashu"
    );

    const promise = (client as any)._handleErrorResponse(
      errorParams("cashu_spent_token_body_request_id"),
      "cashu_spent_token_body_request_id",
      400,
      undefined,
      undefined,
      SPENT_BODY,
      0
    );

    await expect(promise).rejects.toMatchObject({
      requestId: "req-123",
    });
  });

  it("apikeys mode: removes the spent API key and throws TokenAlreadySpentError when exhausted", async () => {
    const { storage, removedApiKeys } = createStorage();
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys"
    );

    const token = API_KEY;
    const promise = (client as any)._handleErrorResponse(
      errorParams(token),
      token,
      400,
      "req-456",
      undefined,
      SPENT_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(TokenAlreadySpentError);
    expect(removedApiKeys).toEqual([BASE_URL]);
  });

  it("apikeys mode: preserves a replacement key when a stale spent response arrives", async () => {
    const { storage, removedApiKeys } = createStorage({
      getApiKey: (baseUrl: string) =>
        baseUrl === BASE_URL
          ? {
              key: "replacement-api-key",
              baseUrl: BASE_URL,
              balance: 42,
              lastUsed: null,
            }
          : null,
    });
    const client = new RoutstrClient(
      createWallet(),
      storage,
      createDiscovery(),
      "ERROR",
      "apikeys"
    );

    const promise = (client as any)._handleErrorResponse(
      errorParams("stale-spent-api-key"),
      "stale-spent-api-key",
      400,
      "req-stale",
      undefined,
      SPENT_BODY,
      0
    );

    await expect(promise).rejects.toBeInstanceOf(TokenAlreadySpentError);
    expect(removedApiKeys).toEqual([]);
  });

  it("xcashu mode: fails over to the next provider with a fresh token when available", async () => {
    const { storage, removedXcashu } = createStorage();
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

    const token = "cashu_spent_token_456";
    const response = await (client as any)._handleErrorResponse(
      errorParams(token),
      token,
      400,
      "req-789",
      undefined,
      SPENT_BODY,
      0
    );

    expect(response.status).toBe(200);
    expect(removedXcashu).toEqual([[BASE_URL, token]]);
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=token_already_spent")
    );
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
    // Retry went to the failover provider with a fresh token, not the spent one.
    expect(makeRequestSpy).toHaveBeenCalledOnce();
    const retryParams = makeRequestSpy.mock.calls[0][0];
    expect(retryParams.baseUrl).toBe(SECOND_BASE_URL);
    expect(retryParams.token).toBe("cashu_fresh_failover_token");
  });
});

describe("BalanceManager.refundApiKey — spent API key", () => {
  it("removes the API key and skips receiveToken", async () => {
    const { storage, removedApiKeys } = createStorage();
    const cashuSpender = { receiveToken: vi.fn() } as any;
    const manager = new BalanceManager(
      createWallet(),
      storage,
      createDiscovery(),
      cashuSpender
    );
    vi.spyOn(manager, "fetchRefundToken").mockResolvedValue({
      success: false,
      status: 400,
      requestId: "req-refund",
      error: "Token already spent: nope",
      parsedError: {
        type: "token_already_spent",
        code: "cashu_token_already_spent",
        message: "nope",
        raw: false,
      },
    });

    const result = await manager.refundApiKey({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      forceRefund: true,
    });

    expect(result.success).toBe(false);
    expect(removedApiKeys).toEqual([BASE_URL]);
    expect(cashuSpender.receiveToken).not.toHaveBeenCalled();
  });
});

describe("BalanceManager.refundApiKey — stale spent response", () => {
  it("preserves a replacement key stored while the refund was in flight", async () => {
    const { storage, removedApiKeys } = createStorage({
      getApiKey: (baseUrl: string) =>
        baseUrl === BASE_URL
          ? {
              key: "replacement-api-key",
              baseUrl: BASE_URL,
              balance: 42,
              lastUsed: null,
            }
          : null,
    });
    const cashuSpender = { receiveToken: vi.fn() } as any;
    const manager = new BalanceManager(
      createWallet(),
      storage,
      createDiscovery(),
      cashuSpender
    );
    vi.spyOn(manager, "fetchRefundToken").mockResolvedValue({
      success: false,
      status: 400,
      error: "Token already spent: nope",
      parsedError: {
        type: "token_already_spent",
        code: "cashu_token_already_spent",
        message: "nope",
        raw: false,
      },
    });

    const result = await manager.refundApiKey({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      forceRefund: true,
    });

    expect(result.success).toBe(false);
    expect(removedApiKeys).toEqual([]);
    expect(cashuSpender.receiveToken).not.toHaveBeenCalled();
  });
});

describe("BalanceManager.topUp — spent topup token", () => {
  it("skips _recoverFailedTopUp for an already-spent token (recoveredToken=false)", async () => {
    const { storage } = createStorage();
    const manager = new BalanceManager(
      createWallet(),
      storage,
      createDiscovery()
    );
    vi.spyOn(manager, "createProviderToken").mockResolvedValue({
      success: true,
      token: "cashu_topup_token",
    });
    const postTopUpSpy = vi
      .spyOn(manager as any, "_postTopUp")
      .mockResolvedValue({
        success: false,
        error: "Token already spent: nope",
        requestId: "req-topup",
        parsedError: {
          type: "token_already_spent",
          code: "cashu_token_already_spent",
          message: "nope",
          raw: false,
        },
      });
    const recoverSpy = vi
      .spyOn(manager as any, "_recoverFailedTopUp")
      .mockResolvedValue(undefined);

    const result = await manager.topUp({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 100,
      token: API_KEY,
    });

    expect(result.success).toBe(false);
    expect(result.recoveredToken).toBe(false);
    expect(recoverSpy).not.toHaveBeenCalled();
    expect(postTopUpSpy).toHaveBeenCalledWith(
      BASE_URL,
      API_KEY,
      "cashu_topup_token"
    );
  });

  it("still recovers the token for generic topup failures (regression guard)", async () => {
    const { storage } = createStorage();
    const manager = new BalanceManager(
      createWallet(),
      storage,
      createDiscovery()
    );
    vi.spyOn(manager, "createProviderToken").mockResolvedValue({
      success: true,
      token: "cashu_topup_token",
    });
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({
      success: false,
      error: "Mint unreachable",
      requestId: "req-topup",
      parsedError: { type: "mint_unreachable", raw: false },
    });
    const recoverSpy = vi
      .spyOn(manager as any, "_recoverFailedTopUp")
      .mockResolvedValue(undefined);

    const result = await manager.topUp({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 100,
      token: API_KEY,
    });

    expect(result.recoveredToken).toBe(true);
    expect(recoverSpy).toHaveBeenCalledWith("cashu_topup_token");
  });
});

describe("CashuSpender.refundXcashuTokens — spent xcashu token", () => {
  it("removes the spent token immediately instead of retrying", async () => {
    const token = "cashu_spent_xcashu_token";
    const { storage, removedXcashu } = createStorage({
      getXcashuTokens: () => ({ [BASE_URL]: [{ token, tryCount: 0 }] }),
      getXcashuTokensForBaseUrl: () => [{ token, tryCount: 0 }],
    });
    const updateTryCount = vi.spyOn(
      storage,
      "updateXcashuTokenTryCount"
    );
    const balanceManager = {
      fetchRefundToken: vi.fn().mockResolvedValue({
        success: false,
        status: 400,
        error: "Token already spent: nope",
        parsedError: {
          type: "token_already_spent",
          code: "cashu_token_already_spent",
          message: "nope",
          raw: false,
        },
      }),
    } as any;
    const spender = new CashuSpender(
      createWallet(),
      storage,
      createDiscovery(),
      balanceManager
    );

    const results = await spender.refundXcashuTokens(MINT_URL);

    expect(results).toEqual([
      { baseUrl: BASE_URL, token, success: false, error: "Token already spent: nope" },
    ]);
    expect(removedXcashu).toEqual([[BASE_URL, token]]);
    // No retry bookkeeping for a permanently-spent token.
    expect(updateTryCount).not.toHaveBeenCalled();
  });
});
