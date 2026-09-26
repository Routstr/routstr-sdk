/**
 * A pinned x-routstr-model-path route prices itself: the node advertises
 * per-route sats pricing alongside the selector, and that pricing replaces
 * the model's aggregate rates AND its max_cost envelope — routes of one
 * model can differ sharply (e.g. 348 vs 682 sats of envelope on one live
 * node), so the model-level aggregate can under- or over-reserve.
 *
 * These tests pin getRequiredSatsForModel's per-route override and its use
 * through the real routeRequest seam.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://ai.redsh1ft.com/";
const MINT_URL = "https://mint.example.com";
const SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";

const createRegistry = (): DiscoveryAdapter =>
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
  }) as DiscoveryAdapter;

const createWallet = (): WalletAdapter =>
  ({
    getBalances: async () => ({ [MINT_URL]: 5000 }),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT_URL,
    sendToken: async () => "token",
    receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  }) as unknown as WalletAdapter;

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
  }) as unknown as StorageAdapter;

/** The model's AGGREGATE pricing: envelope 100 sats across all routes. */
const makeModel = (): Model =>
  ({
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("per-route model-path pricing", () => {
  describe("getRequiredSatsForModel", () => {
    it("reserves the route's max_cost envelope, not the model's aggregate", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "deepseek-v4.1-flash",
        name: "test",
        sats_pricing: {
          prompt: 0.5,
          completion: 0.6,
          max_completion_cost: 200,
          max_cost: 300,
        } as any,
      };

      // The pinned route advertises a larger envelope (e.g. otrta's
      // fireworks route: 682 sats vs the aggregate). The huge prompt
      // estimate blows past both envelopes; the deposit must cap at the
      // ROUTE's.
      const cost = manager.getRequiredSatsForModel(
        model,
        [],
        undefined,
        {},
        { prompt: 0.5, completion: 0.6, max_cost: 700 }
      );
      expect(cost).toBe(700);
    });

    it("reserves the route envelope when the model has no max_completion_cost", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "deepseek-v4.1-flash",
        name: "test",
        sats_pricing: { prompt: 0.5, completion: 0.6, max_cost: 42 } as any,
      };

      // Without max_completion_cost the deposit is the full envelope —
      // which for a pinned route is the ROUTE's envelope (e.g. otrta's
      // deepseek route: 348 sats), not the model aggregate.
      const cost = manager.getRequiredSatsForModel(
        model,
        [],
        undefined,
        {},
        { prompt: 0.5, completion: 0.6, max_cost: 348 }
      );
      expect(cost).toBe(348);
    });

    it("prices prompt and completion from the route", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "deepseek-v4.1-flash",
        name: "test",
        // No max_cost: the node-gate estimate must not interfere with the
        // component formula asserted below.
        sats_pricing: {
          prompt: 1,
          completion: 1,
          max_completion_cost: 500,
        } as any,
      };
      const messages = [{ role: "user", content: "hello" }];

      // textChars "hello" = 5 -> ceil(5 / 2.84) = 2 prompt tokens.
      // prompt 3 * 2 + completion 0.5 * maxTokens 100 = 56, * 1.05.
      const cost = manager.getRequiredSatsForModel(
        model,
        messages,
        100,
        { messages },
        { prompt: 3, completion: 0.5 }
      );
      expect(cost).toBeCloseTo(56 * 1.05, 5);
    });

    it("keeps the model's rates and envelope when the route advertises no overrides", () => {
      const manager = new ProviderManager(createRegistry());
      const model: Model = {
        id: "deepseek-v4.1-flash",
        name: "test",
        sats_pricing: { prompt: 0.5, completion: 0.6, max_cost: 42 } as any,
      };

      expect(manager.getRequiredSatsForModel(model, [], undefined, {}, {})).toBe(
        42
      );
    });
  });

  describe("routeRequest deposit sizing", () => {
    it("sizes the spend from the pinned route's pricing through routeRequest", async () => {
      // Real routeRequest seam: only the payment/accounting boundaries and
      // transport are stubbed. The model's aggregate envelope is 100 sats;
      // the pinned route advertises 700 — the spend must reserve the route's.
      const client = new RoutstrClient(
        createWallet(),
        createStorage(),
        createRegistry(),
        "ERROR",
        "xcashu"
      );
      const spendArgs: Array<{ amount: number }> = [];
      vi.spyOn(client as any, "_spendToken").mockImplementation(
        async (args: { amount: number }) => {
          spendArgs.push(args);
          return {
            token: "cashu_fresh_token",
            selectedMintUrl: MINT_URL,
            tokenBalance: 5000,
            tokenBalanceUnit: "sat",
            tokenBalanceUnknown: false,
          };
        }
      );
      vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(
        0
      );
      vi.spyOn(
        (client as any).providerManager,
        "getModelForProvider"
      ).mockResolvedValue(makeModel());
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("ok"))
      );

      await client.routeRequest({
        path: "/v1/chat/completions",
        method: "POST",
        body: { messages: [] },
        headers: { "x-routstr-model-path": SELECTOR },
        baseUrl: BASE_URL,
        mintUrl: MINT_URL,
        modelId: "deepseek-v4.1-flash",
        autoModelPath: {
          selector: SELECTOR,
          satsPricing: { prompt: 1, completion: 1, max_cost: 700 },
        },
      });

      expect(spendArgs).toEqual([
        expect.objectContaining({ amount: 700, baseUrl: BASE_URL }),
      ]);
    });
  });
});


describe("route-level allowances replace the model aggregate", () => {
  // Live-shape numbers (ai.redsh1ft.com, fireworks route vs the model
  // aggregate): the route's envelope is ~2x the aggregate, so mixing the
  // route's max_cost with the aggregate allowances mis-sizes the deposit
  // in both directions.
  const AGGREGATE = {
    prompt: 0.000187,
    completion: 0.000747,
    request: 0.001,
    max_prompt_cost: 196,
    max_completion_cost: 287,
    max_cost: 411,
  };
  const ROUTE = {
    prompt: 0.000274,
    completion: 0.000822,
    request: 0.001,
    max_prompt_cost: 287,
    max_completion_cost: 775,
    max_cost: 804,
  };
  const makeModel = (): Model =>
    ({
      id: "deepseek-v4.1-flash",
      name: "test",
      sats_pricing: { ...AGGREGATE },
      context_length: 1_048_576,
    }) as unknown as Model;
  const messages = [{ role: "user", content: "hello ".repeat(200) }];
  const expected = (pathPricing: any, maxTokens?: number) =>
    new ProviderManager(createRegistry()).getRequiredSatsForModel(
      { ...makeModel(), sats_pricing: { ...ROUTE } } as Model,
      messages,
      maxTokens,
      maxTokens === undefined ? {} : { messages, max_tokens: maxTokens },
      pathPricing
    );

  it("does not under-reserve when the request has no max_tokens", () => {
    const manager = new ProviderManager(createRegistry());
    const mixed = manager.getRequiredSatsForModel(
      makeModel(),
      messages,
      undefined,
      { messages },
      ROUTE as any
    );
    const routeOnly = expected(ROUTE);
    expect(mixed).toBe(routeOnly);
    // Guard the regression: the route's own allowances matter.
    expect(mixed).toBeGreaterThan(600);
  });

  it("does not over-reserve when the request declares max_tokens", () => {
    const manager = new ProviderManager(createRegistry());
    const body = { messages, max_tokens: 4000 };
    const mixed = manager.getRequiredSatsForModel(
      makeModel(),
      messages,
      4000,
      body,
      ROUTE as any
    );
    const routeOnly = expected(ROUTE, 4000);
    expect(mixed).toBe(routeOnly);
    // The route's max_completion_cost allowance (775) unlocks the full
    // max_tokens discount; the aggregate's (287) capped it and reserved
    // ~60x the true cost.
    expect(mixed).toBeLessThan(20);
  });

  it("parsePathMetadata keeps the full advertised sats_pricing", async () => {
    const { parseModelPathsPayload } = await import("../../utils/modelPaths");
    const payload = {
      data: [
        {
          id: "deepseek-v4.1-flash",
          paths: [
            {
              path: "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks",
              model: { sats_pricing: { ...ROUTE, image: 0 } },
            },
          ],
        },
      ],
      updated_at: null,
    };
    const parsed = parseModelPathsPayload(payload);
    expect(parsed?.data[0]?.paths[0]?.model?.sats_pricing).toMatchObject({
      max_cost: 804,
      max_prompt_cost: 287,
      max_completion_cost: 775,
      request: 0.001,
    });
  });
});
