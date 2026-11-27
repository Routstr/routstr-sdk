import { createMemoryRequestLifecycleDriver } from "../../storage/requestLifecycle";
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

function createClient(
  findNext: (current: string) => string | null,
  storage = createStorage(),
  wallet = createWallet()
) {
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
    wallet,
    storage,
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
    const driver = createMemoryRequestLifecycleDriver();
    (client as any).requestLifecycleDriver = driver;
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
    const [row] = await driver.list();
    const trace = await driver.getTrace(row.requestId);
    expect(row).toMatchObject({ outcome: "failed", attemptCount: 0 });
    expect(trace?.events.some(event => event.type === "preflight_funding_failed")).toBe(true);
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
      baseUrl: NEXT_URL, model, selector: "next-selector", satsPricing: pricing,
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

  it("degrades to ordinary provider routing, unpinned, once automatic paths are exhausted", async () => {
    // An auto-pin is an SDK preference, not a caller constraint: initial
    // selection already degrades to the generic ranking when no model-path
    // route is available, and failover must do the same instead of failing
    // a request other providers can serve.
    const { client, providerManager } = createClient(() => NEXT_URL);
    providerManager.getModelPathProviderRanking = vi.fn(async () => []);
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
      autoModelPath: {selector: "old-selector"},
    } as any);
    expect(providerManager.findNextBestProvider).toHaveBeenCalled();
    const call = request.mock.calls[0][0] as any;
    expect(call.baseUrl).toBe(NEXT_URL);
    expect(call.autoModelPath).toBeUndefined();
    const headerNames = Object.keys(call.baseHeaders ?? {}).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("x-routstr-model-path");
  });

  it("still surfaces the shortfall when neither paths nor ordinary providers remain", async () => {
    const { client, providerManager } = createClient(() => null);
    providerManager.getModelPathProviderRanking = vi.fn(async () => []);
    vi.spyOn(client as any, "_spendToken").mockRejectedValue(
      new ProviderMintBalanceError(100, 500, BASE_URL, [MINT_A])
    );
    await expect(client.routeRequest({
      ...routeParams, autoModelPath: {selector: "old-selector"},
    } as any)).rejects.toBeInstanceOf(ProviderMintBalanceError);
  });

});

// Use the real _spendToken and both routing loops. Only the balance probe and
// inference transport are simulated; no provider is contacted or wallet funded.
describe("routing around a dead bootstrap key with a pending refund", () => {
  const third = "https://third.example/";
  const bootstrap = "cashu-quarantined";

  function setup(quarantined: string) {
    const storage = createStorage();
    const key = (baseUrl: string) => baseUrl === quarantined ? bootstrap : "sk-working";
    vi.spyOn(storage, "getApiKey").mockImplementation(baseUrl => ({
      key: key(baseUrl), balance: 500, lastUsed: null,
      refundPendingAt: baseUrl === quarantined ? 1 : undefined,
    }));
    vi.spyOn(storage, "getApiKeyDistribution").mockReturnValue(
      [BASE_URL, NEXT_URL, third].map(baseUrl => ({baseUrl, amount: 500}))
    );
    const remove = vi.spyOn(storage, "removeApiKey");
    const wallet = createWallet();
    const send = vi.spyOn(wallet, "sendToken");
    const { client, providerManager } = createClient(() => null, storage, wallet);
    providerManager.recordSuccess = vi.fn();
    providerManager.findNextBestProvider.mockImplementation(
      (_model: string, _current: string, excluded: Set<string>) =>
        [BASE_URL, NEXT_URL, third].find(url => !excluded.has(url)) ?? null
    );
    const probe = vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 0, reserved: 0, unit: "sat", apiKey: bootstrap, isInvalidApiKey: true, readSeq: 1,
    });
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      if (String(url).startsWith(BASE_URL) && quarantined === NEXT_URL) {
        return Response.json({error: {message: "Body too large"}}, {status: 413});
      }
      return Response.json({ok: true});
    });
    return { client, providerManager, storage, fetch, probe, remove, send };
  }

  afterEach(() => vi.restoreAllMocks());

  it.each([BASE_URL, NEXT_URL])("skips a quarantined candidate (%s) without spending or deleting its key", async url => {
    const { client, fetch, remove, send } = setup(url);
    const response = await client.routeRequest(routeParams as any);
    expect(response.status).toBe(200);
    const requests = fetch.mock.calls.map(([input]) => new URL(String(input)).origin + "/");
    expect(requests).toEqual(url === BASE_URL ? [NEXT_URL] : [BASE_URL, third]);
    expect(remove).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("replaces an SDK-selected path when its provider is quarantined", async () => {
    const { client, providerManager, fetch } = setup(BASE_URL);
    providerManager.getModelPathProviderRanking = vi.fn(async () => [{
      baseUrl: NEXT_URL, model, selector: "next-selector",
    }]);
    await client.routeRequest({ ...routeParams,
      headers: { "X-Routstr-Model-Path": "old-selector" },
      autoModelPath: { selector: "old-selector" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(new URL(routeParams.path, NEXT_URL).href,
      expect.objectContaining({ headers: expect.objectContaining({ "x-routstr-model-path": "next-selector" }) }));
  });

  it.each([{pinnedProvider: true}, {headers: {"X-Routstr-Model-Path": "caller-selector"}}])(
    "respects caller pin %j", async pin => {
      const { client, providerManager, fetch, remove, send } = setup(BASE_URL);
      await expect(client.routeRequest({...routeParams, ...pin} as any)).rejects.toMatchObject({
        name: "RefundPendingKeyError",
      });
      expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("preserves the replacement when an old bootstrap probe reports invalid", async () => {
    const { client, storage, probe, fetch, remove, send } = setup(BASE_URL);
    vi.mocked(storage.getApiKey).mockReturnValue({key: "cashu-old", balance: 500, lastUsed: null});
    probe.mockImplementationOnce(async apiKey => {
      vi.mocked(storage.getApiKey).mockReturnValue({key: "sk-replacement", balance: 500, lastUsed: null, refundPendingAt: 1});
      return {amount: 0, reserved: 0, unit: "sat", apiKey, isInvalidApiKey: true, readSeq: 1};
    });
    await client.routeRequest(routeParams as any);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({Authorization: "Bearer sk-replacement"});
    expect(remove).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
