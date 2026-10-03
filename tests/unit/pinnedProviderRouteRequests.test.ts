/**
 * Routing-level regression for the forced-provider pin.
 *
 * `pinnedProviderFailover.test.ts` calls `_handleErrorResponse` directly, so it
 * would still pass if `routeRequests` stopped forwarding the marker from
 * `forcedProvider` down to the client. These tests go through the public
 * `routeRequests({ forcedProvider })` entrypoint with the real
 * resolveRequestContext (no mocking of the marker), stub only the network and
 * wallet seams, and assert that a failed request never reaches provider B and
 * never mints a second payment.
 *
 * Both the ordinary route and the DeepSeek `autoModelPath` combination are
 * covered: even an SDK auto-pinned selector must not walk the model-path chain
 * away from a caller-forced provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelPathsCache,
  modelPathCandidateKey,
} from "../../utils/modelPaths";
import { routeRequests } from "../../routeRequests";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

// Forced provider; also the first whitelisted DeepSeek auto-selection node.
const PROVIDER_A = "https://ai.redsh1ft.com/";
// Must never receive the request or a deposit.
const PROVIDER_B = "https://routstr.otrta.me/";
const MINT_URL = "https://mint.example/";
const MODEL_ID = "deepseek-v4.1-flash";
const SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";

const model = {
  id: MODEL_ID,
  name: "DeepSeek V4.1 Flash",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

// What provider A advertises on GET /v1/models/paths.
const pathsPayload = {
  data: [
    {
      id: MODEL_ID,
      paths: [
        {
          path: SELECTOR,
          provider: { slug: "openrouter", type: "openrouter" },
          endpoint: null,
          model: { sats_pricing: { prompt: 0.001, completion: 0.001, max_cost: 700 } },
        },
      ],
    },
  ],
  updated_at: null,
};

const upstreamBody = JSON.stringify({
  error: {
    message: "Upstream rejected the request",
    type: "upstream_error",
    code: 400,
  },
  request_id: "req-1",
});

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

function makeHarness() {
  const wallet = {
    getBalances: async () => ({ [MINT_URL]: 500 }),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT_URL,
    sendToken: async () => "sk-test",
    receiveToken: async () => ({ success: false, message: "no refund" }),
  } as unknown as WalletAdapter;

  const storage = {
    getApiKey: () => ({ key: "sk-test", baseUrl: PROVIDER_A, balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;

  const discovery = {
    getDisabledProviders: () => [],
    getCachedMints: () => ({ [PROVIDER_A]: [MINT_URL] }),
    getModelIdMappings: () => null,
  } as unknown as DiscoveryAdapter;

  // Provider B is reachable in this harness: failover, if it fired, would
  // resolve it. That is what makes the negative assertions meaningful.
  // Honor the exclusion sets the client passes so a failover attempt is
  // bounded: a regression (marker not forwarded) fails on an assertion
  // instead of looping forever.
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set<string>(),
    findNextBestProvider: vi.fn(
      (_modelId: string, _current: string, attempted?: ReadonlySet<string>) =>
        attempted?.has(PROVIDER_B) ? null : PROVIDER_B
    ),
    getModelPathProviderRanking: vi.fn(
      async (
        _modelId: string,
        opts?: { excludeModelPaths?: string[]; excludeBaseUrl?: string }
      ) => {
        if (opts?.excludeBaseUrl === PROVIDER_B) return [];
        const excluded = new Set(opts?.excludeModelPaths ?? []);
        if (excluded.has(modelPathCandidateKey(PROVIDER_B, SELECTOR))) return [];
        return [
          {
            baseUrl: PROVIDER_B,
            model,
            selectors: [SELECTOR],
            satsPricing: [undefined],
          },
        ];
      }
    ),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };

  const client = new RoutstrClient(
    wallet,
    storage,
    discovery,
    "ERROR",
    "apikeys",
    { providerManager: providerManager as any, logger }
  );
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  const spend = vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: "sk-fresh",
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
    selectedMintUrl: MINT_URL,
  });
  const balanceManager = client.getBalanceManager();
  vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
    amount: 399_000,
    reserved: 0,
    unit: "msat",
    apiKey: "sk-test",
  } as any);
  vi.spyOn(balanceManager, "refundApiKey").mockResolvedValue({
    success: true,
    message: "refunded",
    amount: 399,
  } as any);

  // Real resolveRequestContext reads these off the provided ModelManager.
  const modelManager = {
    getBaseUrls: () => [PROVIDER_A],
    getAllCachedModels: () => ({ [PROVIDER_A]: [model] }),
  };

  return { client, providerManager, spend, wallet, storage, discovery, modelManager };
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v1/models/paths")) {
      return new Response(JSON.stringify(pathsPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(upstreamBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes("/v1/chat/completions")
  );
}

async function routeThrough(
  harness: ReturnType<typeof makeHarness>,
  autoModelPath: boolean
) {
  return routeRequests({
    modelId: MODEL_ID,
    requestBody: { messages: [{ role: "user", content: "hi" }] },
    path: "/v1/chat/completions",
    forcedProvider: PROVIDER_A,
    autoModelPath,
    walletAdapter: harness.wallet,
    storageAdapter: harness.storage,
    discoveryAdapter: harness.discovery,
    modelManager: harness.modelManager as any,
    client: harness.client,
    mode: "apikeys",
    logger,
  });
}

beforeEach(() => {
  clearModelPathsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("routeRequests forced-provider pin", () => {
  it("never reaches provider B on an upstream error (ordinary route)", async () => {
    const harness = makeHarness();
    const fetchMock = stubFetch();

    const response = await routeThrough(harness, false);

    expect(chatCalls(fetchMock)).toHaveLength(1);
    expect(String(chatCalls(fetchMock)[0]![0])).toContain("ai.redsh1ft.com");
    expect(harness.providerManager.findNextBestProvider).not.toHaveBeenCalled();
    expect(
      harness.providerManager.getModelPathProviderRanking
    ).not.toHaveBeenCalled();
    // One spend only: no fresh deposit for a second node.
    expect(harness.spend).toHaveBeenCalledOnce();
    // Contract: a strict-pin upstream error keeps the provider's status (400)
    // but returns the SDK all_providers_failed envelope, not the verbatim body.
    // The node's own complaint is preserved inside errors[].message.
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("all_providers_failed");
    expect(body).toContain("Upstream rejected the request");
  });

  it("never leaves the forced provider even with autoModelPath (DeepSeek chain)", async () => {
    const harness = makeHarness();
    const fetchMock = stubFetch();

    const response = await routeThrough(harness, true);

    // The resolver did auto-pin a selector from A's own advertised paths...
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/v1/models/paths"))
    ).toBe(true);

    // ...but the pin still wins: no model-path chain walk, no provider B.
    expect(
      harness.providerManager.getModelPathProviderRanking
    ).not.toHaveBeenCalled();
    expect(harness.providerManager.findNextBestProvider).not.toHaveBeenCalled();
    expect(chatCalls(fetchMock)).toHaveLength(1);
    expect(String(chatCalls(fetchMock)[0]![0])).toContain("ai.redsh1ft.com");
    expect(harness.spend).toHaveBeenCalledOnce();
    expect(response.status).toBe(400);
  });

  it("control: the same client DOES fail over when the marker is absent", async () => {
    // Guards the two tests above: provider B is genuinely reachable, so they
    // would fail if routeRequests stopped forwarding pinnedProvider.
    const harness = makeHarness();
    const fetchMock = stubFetch();

    await harness.client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      headers: {},
      baseUrl: PROVIDER_A,
      mintUrl: MINT_URL,
      modelId: MODEL_ID,
      // no pinnedProvider
    });

    expect(harness.providerManager.findNextBestProvider).toHaveBeenCalled();
    // A second chat attempt went to the failover target.
    const urls = chatCalls(fetchMock).map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("routstr.otrta.me"))).toBe(true);
  });
});
