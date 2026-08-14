import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { BalanceManager } from "../../wallet/BalanceManager";
import { CashuSpender } from "../../wallet/CashuSpender";
import {
  CashuRedemptionError,
  CoreInternalError,
  InvalidTokenError,
  TokenConsumedError,
} from "../../core/errors";
import {
  CoreErrorCode,
  CoreErrorType,
  isCashuRedemptionError,
  isCoreInternalError,
  isHandledRedemptionError,
  isInvalidTokenError,
  isTokenConsumedError,
  parseCoreError,
} from "../../core/errorTypes";

const BASE_URL = "https://provider.example.com/";
const NEXT_URL = "https://next.example.com/";
const MINT_URL = "https://mint.example.com";
const MODEL = {
  id: "gpt-4o-mini",
  name: "GPT-4o Mini",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as any;

const wallet = () =>
  ({
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => null,
    sendToken: async () => "cashu_fresh",
    receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  }) as any;

const storage = () =>
  ({
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: vi.fn(),
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    getApiKeyDistribution: () => [],
    removeApiKey: vi.fn(),
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
  }) as any;

const discovery = () =>
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
  }) as any;

const params = (token: string) => ({
  path: "/v1/chat/completions",
  method: "POST",
  body: { messages: [] },
  selectedModel: MODEL,
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token,
  requiredSats: 100,
  headers: {},
  baseHeaders: {},
  tinfoilEnabled: false,
});

const body = (type: string, code: string) =>
  JSON.stringify({
    error: { type, code, message: `${type} happened` },
    request_id: "req-redemption",
  });

const cases = [
  {
    type: CoreErrorType.INVALID_TOKEN,
    code: CoreErrorCode.INVALID_CASHU_TOKEN,
    ErrorClass: InvalidTokenError,
  },
  {
    type: CoreErrorType.CASHU_ERROR,
    code: CoreErrorCode.CASHU_TOKEN_REDEMPTION_FAILED,
    ErrorClass: CashuRedemptionError,
  },
  {
    type: CoreErrorType.CASHU_ERROR,
    code: CoreErrorCode.CASHU_TOKEN_ZERO_VALUE,
    ErrorClass: CashuRedemptionError,
  },
  {
    type: CoreErrorType.TOKEN_CONSUMED,
    code: CoreErrorCode.CASHU_TOKEN_CONSUMED,
    ErrorClass: TokenConsumedError,
  },
  {
    type: CoreErrorType.API_ERROR,
    code: CoreErrorCode.INTERNAL_ERROR,
    ErrorClass: CoreInternalError,
  },
] as const;

describe("routstr-core redemption classification", () => {
  it.each(cases)("classifies $type/$code", ({ type, code }) => {
    const parsed = parseCoreError(body(type, code), type.includes("token") ? 400 : 500);
    expect(isHandledRedemptionError(parsed)).toBe(true);
  });

  it("does not confuse cashu_error/invalid_api_key with redemption failures", () => {
    const parsed = parseCoreError(
      body(CoreErrorType.CASHU_ERROR, CoreErrorCode.INVALID_API_KEY),
      401
    );
    expect(isCashuRedemptionError(parsed)).toBe(false);
    expect(isHandledRedemptionError(parsed)).toBe(false);
  });

  it("exposes focused helpers", () => {
    expect(isInvalidTokenError(parseCoreError(body("invalid_token", "invalid_cashu_token")))).toBe(true);
    expect(isTokenConsumedError(parseCoreError(body("token_consumed", "cashu_token_consumed")))).toBe(true);
    expect(isCoreInternalError(parseCoreError(body("api_error", "internal_error")))).toBe(true);
  });
});

describe("RoutstrClient redemption recovery and provider failover", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)(
    "surfaces $ErrorClass.name with recovery context after failover exhaustion",
    async ({ type, code, ErrorClass }) => {
      const providerManager = {
        markFailed: vi.fn(),
        getFailedProviders: () => new Set([BASE_URL]),
        findNextBestProvider: vi.fn(() => null),
      } as any;
      const client = new RoutstrClient(
        wallet(),
        storage(),
        discovery(),
        "ERROR",
        "xcashu",
        { providerManager }
      );
      const receive = vi
        .spyOn(client.getCashuSpender(), "receiveToken")
        .mockResolvedValue({ success: false, amount: 0, unit: "sat", message: "nope" });
      const token = `cashu_${code}`;

      const promise = (client as any)._handleErrorResponse(
        params(token),
        token,
        type === CoreErrorType.TOKEN_CONSUMED || type === CoreErrorType.API_ERROR ? 500 : 400,
        undefined,
        token,
        body(type, code),
        0
      );

      await expect(promise).rejects.toBeInstanceOf(ErrorClass);
      await expect(promise).rejects.toMatchObject({
        code,
        requestId: "req-redemption",
        recoveryAttempted: true,
        recoverySucceeded: false,
      });
      expect(receive).toHaveBeenCalledTimes(1);
      expect(providerManager.markFailed).toHaveBeenCalledWith(
        BASE_URL,
        expect.stringContaining(`code=${code}`)
      );
    }
  );

  it("tries a distinct response token first, then the original only after failure", async () => {
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set([BASE_URL]),
      findNextBestProvider: vi.fn(() => null),
    } as any;
    const client = new RoutstrClient(wallet(), storage(), discovery(), "ERROR", "xcashu", { providerManager });
    const receive = vi
      .spyOn(client.getCashuSpender(), "receiveToken")
      .mockResolvedValueOnce({ success: false, amount: 0, unit: "sat", message: "refund failed" })
      .mockResolvedValueOnce({ success: true, amount: 100, unit: "sat" });

    const promise = (client as any)._handleErrorResponse(
      params("cashu_original"),
      "cashu_original",
      400,
      "req-order",
      "cashu_recovery",
      body(CoreErrorType.INVALID_TOKEN, CoreErrorCode.INVALID_CASHU_TOKEN),
      0
    );

    await expect(promise).rejects.toMatchObject({ recoverySucceeded: true });
    expect(receive.mock.calls.map(([token]) => token)).toEqual([
      "cashu_recovery",
      "cashu_original",
    ]);
  });

  it("API-key recovery failure still marks the provider failed and fails over", async () => {
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set([BASE_URL]),
      findNextBestProvider: vi.fn(() => NEXT_URL),
      getModelForProvider: vi.fn(async () => MODEL),
      getRequiredSatsForModel: vi.fn(() => 100),
    } as any;
    const client = new RoutstrClient(wallet(), storage(), discovery(), "ERROR", "apikeys", { providerManager });
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 100,
      balanceUnknown: false,
    } as any);
    vi.spyOn(client.getBalanceManager(), "refundApiKey").mockResolvedValue({
      success: false,
      message: "refund failed",
    });
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "fresh-provider-api-key",
      tokenBalance: 100,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const request = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(new Response("ok"));

    await (client as any)._handleErrorResponse(
      params("canonical-api-key"),
      "canonical-api-key",
      500,
      "req-api-key",
      undefined,
      body(CoreErrorType.API_ERROR, CoreErrorCode.INTERNAL_ERROR),
      0
    );

    expect(client.getBalanceManager().refundApiKey).toHaveBeenCalled();
    expect(providerManager.markFailed).toHaveBeenCalled();
    expect(request.mock.calls[0][0]).toMatchObject({
      baseUrl: NEXT_URL,
      token: "fresh-provider-api-key",
    });
  });

  it("fails over when the provider refund endpoint itself returns a server error", async () => {
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set([BASE_URL]),
      findNextBestProvider: vi.fn(() => NEXT_URL),
      getModelForProvider: vi.fn(async () => MODEL),
      getRequiredSatsForModel: vi.fn(() => 100),
    } as any;
    const client = new RoutstrClient(wallet(), storage(), discovery(), "ERROR", "apikeys", { providerManager });
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 2271555,
      balanceUnknown: false,
    } as any);
    vi.spyOn(client.getBalanceManager(), "refundApiKey").mockResolvedValue({
      success: false,
      message: "API key refund failed: Internal server error, please contact support with the request ID.",
      status: 500,
    });
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "fresh-provider-api-key",
      tokenBalance: 100,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const request = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(new Response("ok"));

    await (client as any)._handleErrorResponse(
      params("canonical-api-key"),
      "canonical-api-key",
      500,
      "req-refund-500",
      undefined,
      JSON.stringify({ detail: "Internal server error, please contact support with the request ID." }),
      0
    );

    expect(client.getBalanceManager().refundApiKey).toHaveBeenCalled();
    expect(providerManager.markFailed).toHaveBeenCalled();
    expect(request.mock.calls[0][0]).toMatchObject({
      baseUrl: NEXT_URL,
      token: "fresh-provider-api-key",
    });
  });

  it("marks the provider failed and retries a different provider with a fresh token", async () => {
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set([BASE_URL]),
      findNextBestProvider: vi.fn(() => NEXT_URL),
      getModelForProvider: vi.fn(async () => MODEL),
      getRequiredSatsForModel: vi.fn(() => 100),
    } as any;
    const client = new RoutstrClient(wallet(), storage(), discovery(), "ERROR", "xcashu", { providerManager });
    vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: true, amount: 100, unit: "sat" });
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu_fresh_provider_token",
      tokenBalance: 100,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
    });
    const request = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(new Response("ok"));

    await (client as any)._handleErrorResponse(
      params("cashu_bad"),
      "cashu_bad",
      400,
      "req-failover",
      undefined,
      body(CoreErrorType.INVALID_TOKEN, CoreErrorCode.INVALID_CASHU_TOKEN),
      0
    );

    expect(providerManager.markFailed).toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({
      baseUrl: NEXT_URL,
      token: "cashu_fresh_provider_token",
    });
  });
});

describe("RoutstrClient purge unusable stored credential on permanent errors", () => {
  afterEach(() => vi.restoreAllMocks());

  const noFailover = { markFailed: vi.fn(), getFailedProviders: () => new Set([BASE_URL]), findNextBestProvider: vi.fn(() => null) } as any;

  it.each([
    [CoreErrorType.INVALID_TOKEN, CoreErrorCode.INVALID_CASHU_TOKEN, "apikeys", "cashu_bad_bootstrap", "api-key"],
    [CoreErrorType.TOKEN_CONSUMED, CoreErrorCode.CASHU_TOKEN_CONSUMED, "apikeys", "cashu_bad_bootstrap", "api-key"],
    [CoreErrorType.CASHU_ERROR, CoreErrorCode.CASHU_TOKEN_ZERO_VALUE, "apikeys", "cashu_bad_bootstrap", "api-key"],
  ])("apikeys: purges bootstrap key on permanent %s", async (type, code, mode, token, stored) => {
    const store = storage();
    store.getApiKey = () => ({
      key: token,
      baseUrl: BASE_URL,
      balance: 100,
      lastUsed: null,
    });
    const client = new RoutstrClient(wallet(), store, discovery(), "ERROR", mode, { providerManager: noFailover });
    vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 0, unit: "sat", message: "nope" } as any);
    vi.spyOn(client.getBalanceManager(), "refundApiKey").mockResolvedValue({ success: false, message: "refund failed" });

    const promise = (client as any)._handleErrorResponse(
      params(token),
      token,
      400,
      "req-purge",
      undefined,
      body(type, code),
      0
    );

    await expect(promise).rejects.toBeTruthy();
    expect(store.removeApiKey).toHaveBeenCalledWith(BASE_URL);
    void stored;
  });

  it("apikeys: preserves replacement key when unusable response is stale", async () => {
    const store = storage();
    store.getApiKey = () => ({
      key: "replacement-key",
      baseUrl: BASE_URL,
      balance: 42,
      lastUsed: null,
    });
    const client = new RoutstrClient(wallet(), store, discovery(), "ERROR", "apikeys", { providerManager: noFailover });
    vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 0, unit: "sat", message: "nope" } as any);
    vi.spyOn(client.getBalanceManager(), "refundApiKey").mockResolvedValue({ success: false, message: "refund failed" });

    const token = "stale-invalid-token";
    const promise = (client as any)._handleErrorResponse(
      params(token),
      token,
      400,
      "req-purge-stale",
      undefined,
      body(CoreErrorType.TOKEN_CONSUMED, CoreErrorCode.CASHU_TOKEN_CONSUMED),
      0
    );

    await expect(promise).rejects.toBeTruthy();
    expect(store.removeApiKey).not.toHaveBeenCalled();
  });

  it("xcashu: purges unusable xcashu token on token_consumed", async () => {
    const store = storage();
    const client = new RoutstrClient(wallet(), store, discovery(), "ERROR", "xcashu", { providerManager: noFailover });
    vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 0, unit: "sat", message: "nope" } as any);

    const token = "cashu_consumed_xyz";
    const promise = (client as any)._handleErrorResponse(
      params(token),
      token,
      500,
      "req-purge-xcashu",
      undefined,
      body(CoreErrorType.TOKEN_CONSUMED, CoreErrorCode.CASHU_TOKEN_CONSUMED),
      0
    );

    await expect(promise).rejects.toBeTruthy();
    expect(store.removeXcashuToken).toHaveBeenCalledWith(BASE_URL, token);
  });

  it.each([
    [CoreErrorType.CASHU_ERROR, CoreErrorCode.CASHU_TOKEN_REDEMPTION_FAILED],
    [CoreErrorType.API_ERROR, CoreErrorCode.INTERNAL_ERROR],
  ])("apikeys: preserves credential for ambiguous %s", async (type, code) => {
    const store = storage();
    const client = new RoutstrClient(wallet(), store, discovery(), "ERROR", "apikeys", { providerManager: noFailover });
    vi.spyOn(client.getCashuSpender(), "receiveToken").mockResolvedValue({ success: false, amount: 0, unit: "sat", message: "nope" } as any);
    vi.spyOn(client.getBalanceManager(), "refundApiKey").mockResolvedValue({ success: false, message: "refund failed" });

    const token = "cashu_ambiguous";
    const promise = (client as any)._handleErrorResponse(
      params(token),
      token,
      type === CoreErrorType.API_ERROR ? 500 : 400,
      "req-ambiguous",
      undefined,
      body(type, code),
      0
    );

    await expect(promise).rejects.toBeTruthy();
    expect(store.removeApiKey).not.toHaveBeenCalled();
  });
});

describe("CashuSpender background redemption recovery", () => {
  it("tries the provider refund first, then receives the stored original token", async () => {
    const token = "cashu_stored_original";
    const store = storage();
    store.getXcashuTokens = () => ({
      [BASE_URL]: [{ token, tryCount: 0 }],
    });
    const balanceManager = {
      fetchRefundToken: vi.fn().mockResolvedValue({
        success: false,
        status: 500,
        error: "consumed",
        parsedError: parseCoreError(
          body(CoreErrorType.TOKEN_CONSUMED, CoreErrorCode.CASHU_TOKEN_CONSUMED),
          500
        ),
      }),
    } as any;
    const spender = new CashuSpender(wallet(), store, discovery(), balanceManager);
    const receive = vi.spyOn(spender, "receiveToken").mockResolvedValue({
      success: true,
      amount: 100,
      unit: "sat",
    });

    const results = await spender.refundXcashuTokens(MINT_URL);

    expect(balanceManager.fetchRefundToken).toHaveBeenCalledWith(
      BASE_URL,
      token,
      true
    );
    expect(receive).toHaveBeenCalledWith(token);
    expect(store.removeXcashuToken).toHaveBeenCalledWith(BASE_URL, token);
    expect(results).toEqual([{ baseUrl: BASE_URL, token, success: true }]);
  });
});

describe("BalanceManager standalone refund recovery", () => {
  it("tries to receive a bootstrap Cashu credential after structured refund failure", async () => {
    const bootstrap = "cashu_bootstrap_key";
    const store = storage();
    store.getApiKey = () => ({
      key: bootstrap,
      baseUrl: BASE_URL,
      balance: 100,
      lastUsed: null,
    });
    const spender = {
      receiveToken: vi.fn().mockResolvedValue({
        success: true,
        amount: 100,
        unit: "sat",
      }),
    } as any;
    const manager = new BalanceManager(wallet(), store, discovery(), spender);
    vi.spyOn(manager, "fetchRefundToken").mockResolvedValue({
      success: false,
      status: 400,
      error: "invalid token",
      parsedError: parseCoreError(
        body(CoreErrorType.INVALID_TOKEN, CoreErrorCode.INVALID_CASHU_TOKEN),
        400
      ),
    });

    const result = await manager.refundApiKey({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      apiKey: bootstrap,
      forceRefund: true,
    });

    expect(spender.receiveToken).toHaveBeenCalledWith(bootstrap);
    expect(store.removeApiKey).toHaveBeenCalledWith(BASE_URL);
    expect(result).toMatchObject({
      success: true,
      refundedAmount: 100_000,
      parsedError: {
        type: CoreErrorType.INVALID_TOKEN,
        code: CoreErrorCode.INVALID_CASHU_TOKEN,
      },
    });
  });
});

describe("BalanceManager structured top-up recovery", () => {
  it("returns the parsed error and actual recovery result", async () => {
    const manager = new BalanceManager(wallet(), storage(), discovery());
    vi.spyOn(manager, "createProviderToken").mockResolvedValue({
      success: true,
      token: "cashu_topup",
      selectedMintUrl: MINT_URL,
    });
    const parsedError = parseCoreError(
      JSON.stringify({
        detail: {
          error: {
            type: CoreErrorType.TOKEN_CONSUMED,
            code: CoreErrorCode.CASHU_TOKEN_CONSUMED,
            message: "consumed",
          },
        },
      }),
      500
    );
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({
      success: false,
      error: "consumed",
      parsedError,
    });
    vi.spyOn(manager as any, "_recoverFailedTopUp").mockResolvedValue(false);

    const result = await manager.topUp({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 100,
      token: "api-key",
    });

    expect(result.recoveredToken).toBe(false);
    expect(result.parsedError).toMatchObject({
      type: CoreErrorType.TOKEN_CONSUMED,
      code: CoreErrorCode.CASHU_TOKEN_CONSUMED,
    });
  });
});
