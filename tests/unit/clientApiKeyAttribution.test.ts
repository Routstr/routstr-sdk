/**
 * Client-key attribution across transports.
 *
 * Usage rows record which configured client made a request, by matching the
 * key the client sent against the store's client list. That key arrives in a
 * transport-specific header:
 *
 * - OpenAI-style clients (and every OpenAI SDK) send
 *   `Authorization: Bearer <key>`.
 * - Anthropic-style clients send `x-api-key: <key>` — the Anthropic SDKs put
 *   `apiKey` there and reserve `Authorization` for an OAuth `authToken`
 *   (verified against @anthropic-ai/sdk 0.91.1: only `x-api-key` is sent).
 *
 * Only the first spelling used to be read, so a model routed over the
 * Anthropic transport was recorded with no client at all and rendered as
 * `unknown` in usage views, while every other model of the same client was
 * attributed correctly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

const BASE_URL = "https://provider.example.com/";
const MINT_URL = "https://mint.example.com";
const CLIENT_KEY = "sk-7ed89be90e107620974a5aec7ee4c7c76e631e8f361ee724";

const model = {
  id: "claude-opus-5.5",
  name: "Claude Opus 5.5",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

const createDiscovery = (): DiscoveryAdapter =>
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
  }) as unknown as DiscoveryAdapter;

const createWallet = (): WalletAdapter =>
  ({
    getBalances: async () => ({}),
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
    setCachedReceiveTokens: () => [],
  }) as unknown as StorageAdapter;

/** A client with every collaborator stubbed, built without running the ctor. */
function makeClient(deps: { usageTrackingDriver?: unknown; sdkStore?: unknown } = {}) {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = "apikeys";
  client.debugLevel = "ERROR";
  client.logger = {
    log: () => {},
    warn: () => {},
    error: () => {},
    child() {
      return this;
    },
  };
  client.storageAdapter = createStorage();
  client.walletAdapter = createWallet();
  client.discoveryAdapter = createDiscovery();
  client.usageTrackingDriver = deps.usageTrackingDriver;
  client.sdkStore = deps.sdkStore;
  client._log = vi.fn();
  client._checkBalance = vi.fn().mockResolvedValue(undefined);
  client._headerSatsCost = vi.fn().mockReturnValue(0);
  client.balanceManager = {
    getTokenBalance: vi
      .fn()
      .mockResolvedValue({ amount: 1000, reserved: 0, unit: "sat" }),
  };
  client.providerManager = {
    getModelForProvider: vi.fn().mockResolvedValue(model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  return client;
}

/** Route one request up to the transport boundary and return what was sent. */
async function routeToTransportBoundary(
  client: any,
  headers: Record<string, string>
) {
  client._spendToken = vi.fn().mockResolvedValue({
    token: "sdk-payment-key",
    tokenBalance: 1000,
    tokenBalanceUnit: "sat",
  });
  client._topUpIfNeeded = vi.fn();
  const stop = new Error("transport boundary reached");
  client._makeRequest = vi.fn().mockRejectedValue(stop);

  await expect(
    client.routeRequest({
      path: "/v1/messages",
      method: "POST",
      body: { model: model.id, max_tokens: 16, messages: [] },
      modelId: model.id,
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      headers,
    })
  ).rejects.toBe(stop);

  return client._makeRequest.mock.calls[0][0] as {
    headers: Record<string, string>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("_extractClientApiKey", () => {
  const extract = (headers: Record<string, string>) =>
    makeClient()._extractClientApiKey(headers);

  it("reads the OpenAI spelling", () => {
    expect(extract({ Authorization: `Bearer ${CLIENT_KEY}` })).toBe(CLIENT_KEY);
  });

  it("reads the Anthropic spelling, which is what pi sends on /v1/messages", () => {
    // Node lower-cases inbound header names, so this is the real shape.
    expect(extract({ "x-api-key": CLIENT_KEY })).toBe(CLIENT_KEY);
  });

  it("reads a mixed-case x-api-key from a caller-built map", () => {
    expect(extract({ "X-API-Key": CLIENT_KEY })).toBe(CLIENT_KEY);
  });

  it("prefers Authorization when both are present", () => {
    expect(
      extract({ Authorization: "Bearer auth-key", "x-api-key": "anthropic-key" })
    ).toBe("auth-key");
  });

  it("returns undefined when neither header carries a usable key", () => {
    expect(extract({})).toBeUndefined();
    expect(extract({ Authorization: "Basic abc" })).toBeUndefined();
    expect(extract({ Authorization: "Bearer " })).toBeUndefined();
    expect(extract({ "x-api-key": "   " })).toBeUndefined();
  });
});

describe("client attribution for Anthropic-transport requests", () => {
  it("reads the client key from the inbound headers, not the upstream ones", async () => {
    const client = makeClient();
    const headers = { "x-api-key": CLIENT_KEY, "content-type": "application/json" };
    const extractSpy = vi.spyOn(client, "_extractClientApiKey");

    const sent = await routeToTransportBoundary(client, headers);

    expect(extractSpy).toHaveBeenCalledWith(headers);
    // The caller's key never reaches the node: the upstream request carries
    // only the SDK's own payment credential (`_buildBaseHeaders` deliberately
    // does not spread inbound headers).
    expect(sent.headers["Authorization"]).toBe("Bearer sdk-payment-key");
    expect(JSON.stringify(sent.headers)).not.toContain(CLIENT_KEY);
  });

  /** Record one usage row through the real tracking path and return it. */
  async function recordedUsageRow(inboundHeaders: Record<string, string>) {
    const entries: Array<Record<string, unknown>> = [];
    const client = makeClient({
      usageTrackingDriver: {
        append: async (entry: Record<string, unknown>) => {
          entries.push(entry);
        },
      },
      sdkStore: {
        getState: () => ({
          clientIds: [{ clientId: "pi-agent", apiKey: CLIENT_KEY }],
        }),
      },
    });

    // Exactly the wiring routeRequest uses: the client key is resolved from
    // the inbound headers and handed to usage tracking.
    const clientApiKey = client._extractClientApiKey(inboundHeaders);

    await client._trackResponseUsage({
      token: "provider-key",
      baseUrl: BASE_URL,
      response: Response.json({ usage: {} }),
      modelId: model.id,
      satsSpent: 5,
      requestId: "req-1",
      /**
       * -1 prompt tokens is a sentinel: usage-tracking records are the only
       * thing under test here, and a fake id keeps them out of any store.
       */
      usage: { promptTokens: -1, completionTokens: 0, totalTokens: -1, cost: 0, satsCost: 5 },
      clientApiKey,
    });

    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  it("records the client on the usage row when the key arrives via x-api-key", async () => {
    const row = await recordedUsageRow({ "x-api-key": CLIENT_KEY });
    expect(row.client).toBe("pi-agent");
  });

  it("records the client when the key arrives via Authorization", async () => {
    const row = await recordedUsageRow({ Authorization: `Bearer ${CLIENT_KEY}` });
    expect(row.client).toBe("pi-agent");
  });

  it("is unattributed only when no key was sent at all", async () => {
    const row = await recordedUsageRow({});
    expect(row.client).toBeUndefined();
  });
});

describe("provider attribution from response headers", () => {
  async function record(response: Response, usage?: Record<string, unknown>) {
    const append = vi.fn();
    const client = makeClient({
      usageTrackingDriver: { append },
      sdkStore: { getState: () => ({ clientIds: [] }) },
    });
    await client._trackResponseUsage({
      token: "provider-key",
      baseUrl: BASE_URL,
      response,
      modelId: model.id,
      satsSpent: 5,
      usage,
      requestId: usage ? "req-stream" : undefined,
    });
    expect(append).toHaveBeenCalledTimes(1);
    return append.mock.calls[0][0];
  }

  it("falls back to the header for Anthropic JSON without a provider", async () => {
    const row = await record(Response.json(
      { id: "req-json", usage: { input_tokens: 10, output_tokens: 2 } },
      { headers: { "X-Routstr-Provider": "anthropic:upstream" } }
    ));
    expect(row.provider).toBe("anthropic:upstream");
  });

  it("preserves the body provider when a header is also present", async () => {
    const row = await record(Response.json(
      { id: "req-json", provider: "body-provider", usage: { input_tokens: 10 } },
      { headers: { "x-routstr-provider": "header-provider" } }
    ));
    expect(row.provider).toBe("body-provider");
  });

  it("uses the header for already-captured streaming usage", async () => {
    const row = await record(new Response("data: [DONE]\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "x-routstr-provider": "stream-provider",
      },
    }), { promptTokens: 10, completionTokens: 2, totalTokens: 12, cost: 0, satsCost: 5 });
    expect(row.provider).toBe("stream-provider");
  });

  it.each([undefined, "   "])("leaves provider undefined for an absent/blank header (%s)", async (provider) => {
    const row = await record(Response.json(
      { id: "req-json", usage: { input_tokens: 10 } },
      { headers: provider === undefined ? {} : { "x-routstr-provider": provider } }
    ));
    expect(row.provider).toBeUndefined();
  });
});
