import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { ProviderManager } from "../../client/ProviderManager";
import { FailoverError, ProviderError } from "../../core/errors";
import { CoreErrorType } from "../../core/errorTypes";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

/**
 * Tests for the cooldown-scope decision: which failures cool down only the
 * selected model on a provider, and which cool down the whole provider.
 *
 * Provider-wide scope (markFailed third arg === undefined) is intentional
 * for failures that cannot be attributed to one model:
 * - network errors (status -1): the provider host itself is unreachable
 * - mint_unreachable: the provider's mint/wallet infrastructure is down
 * - no selected model: the failure cannot be attributed to a model
 *
 * Everything else (4xx/5xx for now — see PR #62 discussion) is model-scoped.
 *
 * Also pins the empty-string modelId edge: "" is a valid model-scoped id,
 * not an alias for the provider-wide key (cooldownKey uses != null).
 */

const BASE_URL = "https://provider.example.com/";
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

function createClient() {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(() => null),
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

describe("_getCooldownScopeModelId", () => {
  it("scopes a model-attributable failure (404) to the selected model", () => {
    const { client } = createClient();
    const scope = (client as any)._getCooldownScopeModelId(
      404,
      { raw: true },
      model
    );
    expect(scope).toBe("gpt-test");
  });

  it("scopes a network error (status -1) provider-wide", () => {
    const { client } = createClient();
    const scope = (client as any)._getCooldownScopeModelId(
      -1,
      { raw: true },
      model
    );
    expect(scope).toBeUndefined();
  });

  it("scopes mint_unreachable provider-wide", () => {
    const { client } = createClient();
    const scope = (client as any)._getCooldownScopeModelId(
      503,
      { type: CoreErrorType.MINT_UNREACHABLE, raw: false },
      model
    );
    expect(scope).toBeUndefined();
  });

  it("scopes provider-wide when no model is selected", () => {
    const { client } = createClient();
    const scope = (client as any)._getCooldownScopeModelId(
      404,
      { raw: true },
      undefined
    );
    expect(scope).toBeUndefined();
  });
});

describe("_handleErrorResponse cooldown scope (provider-wide branches)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks the whole provider failed (no model scope) on a network error", async () => {
    const { client, providerManager } = createClient();

    await expect(
      (client as any)._handleErrorResponse(
        params,
        API_KEY,
        -1, // network error sentinel
        undefined,
        undefined,
        "Failed to fetch",
        0
      )
    ).rejects.toBeInstanceOf(FailoverError);

    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("status=-1"),
      undefined
    );
  });

  it("marks the whole provider failed (no model scope) on mint_unreachable", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    // 503 runs the apikeys refund branch before markFailed; stub it out.
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 0,
      reserved: 0,
      unit: "sat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "refundApiKey").mockResolvedValue({
      success: true,
      message: "ok",
    } as any);
    const body = JSON.stringify({
      error: {
        type: "mint_unreachable",
        code: "cashu_mint_unreachable",
        message: "Cashu mint is unreachable",
      },
    });

    await expect(
      (client as any)._handleErrorResponse(
        params,
        API_KEY,
        503,
        "req-mint",
        undefined,
        body,
        0
      )
    ).rejects.toBeInstanceOf(FailoverError);

    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=mint_unreachable"),
      undefined
    );
  });

  it("marks the whole provider failed (no model scope) when no model is selected", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    // 500 runs the apikeys refund branch before markFailed; stub it out.
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 0,
      reserved: 0,
      unit: "sat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "refundApiKey").mockResolvedValue({
      success: true,
      message: "ok",
    } as any);
    const { selectedModel, ...paramsWithoutModel } = params;

    await expect(
      (client as any)._handleErrorResponse(
        paramsWithoutModel,
        API_KEY,
        500,
        "req-500",
        undefined,
        "Internal Server Error",
        0
      )
    ).rejects.toBeInstanceOf(ProviderError);

    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("status=500"),
      undefined
    );
  });
});

describe("ProviderManager empty-string modelId edge", () => {
  const noopLogger = {
    child: () => noopLogger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;

  it("treats '' as a model-scoped id, not an alias for the provider-wide key", () => {
    const manager = new ProviderManager({} as any, undefined, noopLogger);
    manager.markFailed(BASE_URL, "x", "");
    manager.markFailed(BASE_URL, "x", "");

    // Two strikes on (BASE_URL, "") cool only that model scope...
    expect(manager.isOnCooldown(BASE_URL, "")).toBe(true);
    // ...not the whole provider.
    expect(manager.isOnCooldown(BASE_URL)).toBe(false);
    expect(manager.isOnCooldown(BASE_URL, "other-model")).toBe(false);
    expect(manager.getProvidersOnCooldown()).toEqual([
      { baseUrl: BASE_URL, modelId: "", timestamp: expect.any(Number) },
    ]);
  });

  it("removeFromCooldown(url, '') removes only the '' entry, in memory and on disk", () => {
    // Stateful store stub mirroring the exact-entry semantics of the real store.
    const disk: Array<{ baseUrl: string; modelId?: string; timestamp: number }> =
      [];
    const store = {
      getState: () => ({
        failedProviders: [] as string[],
        lastFailed: {} as Record<string, number>,
        providersOnCooldown: disk,
        setLastFailedTimestamp: (_b: string, _t: number) => {},
        addFailedProvider: (_b: string) => {},
        removeFailedProvider: (_b: string) => {},
        addProviderOnCooldown: (b: string, t: number, m?: string) => {
          if (!disk.some((e) => e.baseUrl === b && e.modelId === m))
            disk.push({ baseUrl: b, modelId: m, timestamp: t });
        },
        removeProviderFromCooldown: (b: string, m?: string) => {
          for (let i = disk.length - 1; i >= 0; i--)
            if (disk[i].baseUrl === b && disk[i].modelId === m)
              disk.splice(i, 1);
        },
        removeAllProviderCooldowns: (b: string) => {
          for (let i = disk.length - 1; i >= 0; i--)
            if (disk[i].baseUrl === b) disk.splice(i, 1);
        },
      }),
    };
    const manager = new ProviderManager({} as any, store as any, noopLogger);

    // Provider-wide cooldown plus a ''-scoped cooldown.
    manager.markFailed(BASE_URL, "x");
    manager.markFailed(BASE_URL, "x");
    manager.markFailed(BASE_URL, "x", "");
    manager.markFailed(BASE_URL, "x", "");
    expect(manager.isOnCooldown(BASE_URL)).toBe(true);
    expect(manager.isOnCooldown(BASE_URL, "")).toBe(true);
    expect(disk).toHaveLength(2);

    manager.removeFromCooldown(BASE_URL, "");

    // Only the '' entry is gone; the provider-wide entry survives in both
    // memory and the store (no memory/disk divergence on restart).
    expect(manager.getProvidersOnCooldown()).toEqual([
      { baseUrl: BASE_URL, modelId: undefined, timestamp: expect.any(Number) },
    ]);
    expect(disk).toEqual([
      { baseUrl: BASE_URL, modelId: undefined, timestamp: expect.any(Number) },
    ]);
  });
});
