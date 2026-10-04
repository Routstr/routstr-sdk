/**
 * Unit tests: initial-deposit provider-mint failover.
 *
 * The post-key 402 path already fails over (PR #79). Without coverage here,
 * the very first deposit (no stored key) hard-failed with a local 402 even
 * when another provider accepted a funded mint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { ProviderMintBalanceError } from "../../core/errors";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://cheap.example.com/";
const NEXT_URL = "https://next.example.com/";
const MINT_A = "https://mint-a.example.com";
const MINT_B = "https://mint-b.example.com";

const model = {
  id: "gpt-test",
  name: "GPT Test",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

const createWallet = (): WalletAdapter => ({
  getBalances: async () => ({ [MINT_B]: 500 }),
  getMintUnits: () => ({ [MINT_B]: "sat" }),
  getActiveMintUrl: () => MINT_B,
  sendToken: async () => "cashu-token",
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
    getApiKey: () => null,
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
    flush: async () => {},
  }) as unknown as StorageAdapter;

const createDiscovery = (): DiscoveryAdapter =>
  ({
    getCachedModels: () => ({ [BASE_URL]: [model], [NEXT_URL]: [model] }),
    setCachedModels: () => {},
    getCachedMints: () => ({ [BASE_URL]: [MINT_A], [NEXT_URL]: [MINT_B] }),
    setCachedMints: () => {},
    getCachedProviderInfo: () => ({}),
    setCachedProviderInfo: () => {},
    getProviderLastUpdate: () => null,
    setProviderLastUpdate: () => {},
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    setDisabledProviders: () => {},
    getManuallyDisabledProviders: () => [],
    getManuallyEnabledProviders: () => [],
    getBaseUrlsList: () => [],
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  }) as unknown as DiscoveryAdapter;

function createClient(findNext: (current: string) => string | null) {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(
      (_modelId: string, current: string, attempted: ReadonlySet<string>) => {
        const next = findNext(current);
        return next && attempted.has(next) ? null : next;
      }
    ),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
    isOnCooldown: () => false,
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

const spendResultFor = (mintUrl: string) => ({
  token: "cashu-topup-token",
  tokenBalance: 1000,
  tokenReserved: 0,
  tokenBalanceUnit: "sat" as const,
  tokenBalanceUnknown: false,
  selectedMintUrl: mintUrl,
});

const routeParams = {
  path: "/v1/chat/completions",
  method: "POST",
  body: { model: model.id, messages: [] },
  baseUrl: BASE_URL,
  mintUrl: MINT_A,
  modelId: model.id,
};

describe("RoutstrClient initial-deposit provider-mint failover", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails over to a provider that accepts a funded mint", async () => {
    const { client, providerManager } = createClient((current) =>
      current === BASE_URL ? NEXT_URL : null
    );
    const spend = vi
      .spyOn(client as any, "_spendToken")
      .mockImplementation(async ({ baseUrl }: { baseUrl: string }) => {
        if (baseUrl === BASE_URL) {
          throw new ProviderMintBalanceError(
            100,
            500,
            BASE_URL,
            [MINT_A],
            0,
            ""
          );
        }
        return spendResultFor(MINT_B);
      });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.spyOn(
      client as any,
      "_handlePostResponseBalanceUpdate"
    ).mockResolvedValue(0);

    const response = await client.routeRequest(routeParams as any);

    expect(response.status).toBe(200);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(spend.mock.calls[0][0].baseUrl).toBe(BASE_URL);
    expect(spend.mock.calls[1][0].baseUrl).toBe(NEXT_URL);
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
  });

  it("does not fail over when the only provider can be funded", async () => {
    const { client } = createClient(() => null);
    const spend = vi
      .spyOn(client as any, "_spendToken")
      .mockResolvedValue(spendResultFor(MINT_B));
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.spyOn(
      client as any,
      "_handlePostResponseBalanceUpdate"
    ).mockResolvedValue(0);

    const response = await client.routeRequest(routeParams as any);

    expect(response.status).toBe(200);
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it("surfaces the honest provider-mint error when every provider is exhausted", async () => {
    const { client } = createClient(() => null);
    vi.spyOn(client as any, "_spendToken").mockImplementation(async () => {
      throw new ProviderMintBalanceError(100, 500, BASE_URL, [MINT_A], 0, "");
    });

    await expect(client.routeRequest(routeParams as any)).rejects.toMatchObject(
      {
        name: "ProviderMintBalanceError",
        acceptedMints: [MINT_A],
        providerBaseUrl: BASE_URL,
      }
    );
  });

  it.each([
    { headers: { "X-Routstr-Model-Path": "caller-selector" } },
    { pinnedProvider: true },
  ])("keeps caller pins on their node during deposit shortfall: %j", async (pin) => {
    const { client, providerManager } = createClient(() => NEXT_URL);
    vi.spyOn(client as any, "_spendToken").mockRejectedValue(
      new ProviderMintBalanceError(100, 500, BASE_URL, [MINT_A])
    );
    const request = vi.spyOn(client as any, "_makeRequest");
    await expect(client.routeRequest({ ...routeParams, ...pin } as any))
      .rejects.toBeInstanceOf(ProviderMintBalanceError);
    expect(request).not.toHaveBeenCalled();
    expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
  });

  it("re-resolves an automatic selector and pricing on initial-deposit failover", async () => {
    const { client, providerManager } = createClient(() => NEXT_URL);
    const pricing = { prompt: 7, completion: 8 };
    providerManager.getModelPathProviderRanking = vi.fn(async () => [{
      baseUrl: NEXT_URL, model, selectors: ["next-selector"], satsPricing: [pricing],
    }]);
    vi.spyOn(client as any, "_spendToken").mockImplementation(async ({baseUrl}: any) => {
      if (baseUrl === BASE_URL) throw new ProviderMintBalanceError(100, 500, BASE_URL, [MINT_A]);
      return spendResultFor(MINT_B);
    });
    const request = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      Response.json({ok: true})
    );
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
    await client.routeRequest({
      ...routeParams,
      headers: { "X-Routstr-Model-Path": "old-selector" },
      autoModelPath: { selector: "old-selector", satsPricing: {prompt: 1, completion: 1} },
    } as any);
    expect(providerManager.getModelPathProviderRanking).toHaveBeenCalledWith(
      model.id, expect.objectContaining({
        excludeBaseUrls: new Set([BASE_URL]), acceptableMintUrls: [MINT_B],
      })
    );
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: NEXT_URL,
      baseHeaders: expect.objectContaining({"x-routstr-model-path": "next-selector"}),
      autoModelPath: {selector: "next-selector", satsPricing: pricing},
    }));
    expect(providerManager.getRequiredSatsForModel.mock.calls.at(-1)[4]).toEqual(pricing);
  });

  it("exhausts automatic paths without falling back to ordinary provider routing", async () => {
    const { client, providerManager } = createClient(() => NEXT_URL);
    providerManager.getModelPathProviderRanking = vi.fn(async () => []);
    vi.spyOn(client as any, "_spendToken").mockRejectedValue(
      new ProviderMintBalanceError(100, 500, BASE_URL, [MINT_A])
    );
    await expect(client.routeRequest({
      ...routeParams, autoModelPath: {selector: "old-selector"},
    } as any)).rejects.toBeInstanceOf(ProviderMintBalanceError);
    expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
  });

});
