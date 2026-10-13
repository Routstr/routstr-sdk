/**
 * A confidential request that fails on one node may only fail over to a node
 * that advertises confidential sessions for the model, and no token is spent
 * on a node before its signed offer qualifies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient, setConfidentialTransport } from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const A = "https://a.example/";
const PLAIN = "https://plain.example/";
const C = "https://c.example/";
const MINT = "https://mint.example";
const MODEL = "m-1";

const cu = { v: 2, offer_url: "/v1/confidential/offer" };
const entry = (completion: number, extra: Partial<Model> = {}): Model =>
  ({
    id: MODEL,
    name: MODEL,
    sats_pricing: { prompt: 1, completion, max_cost: 100, max_prompt_cost: 60, max_completion_cost: 40 },
    ...extra,
  }) as Model;

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

const TRANSPORT = Symbol.for("@routstr/sdk/confidentialTransport");
const QUALIFIER = Symbol.for("@routstr/sdk/confidentialQualifier");

function setup(opts: { qualify?: (baseUrl: string) => void } = {}) {
  const models: Record<string, Model[]> = {
    [A]: [entry(1, { confidential_upstream: cu })],
    // Cheaper than C but serves the model in plaintext only.
    [PLAIN]: [entry(2)],
    [C]: [entry(3, { confidential_upstream: cu })],
  };
  const registry = {
    getCachedModels: () => models,
    getModelIdMappings: () => ({}),
    getDisabledProviders: () => [],
    getCachedMints: () => ({}),
    getCachedProviderInfo: () => ({}),
  } as unknown as DiscoveryAdapter;
  const manager = new ProviderManager(registry, undefined, logger);
  const wallet = {
    getBalances: async () => ({ [MINT]: 1000 }),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT,
    sendToken: async () => "cashu-test",
    receiveToken: async () => ({ success: false, message: "n/a" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => null,
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const client = new RoutstrClient(wallet, storage, registry, "max", "apikeys", {
    providerManager: manager,
    logger,
  });
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  const spent: { baseUrl: string; amount: number }[] = [];
  vi.spyOn(client as any, "_spendToken").mockImplementation(async (...args: unknown[]) => {
    const p = args[0] as { baseUrl: string; amount: number };
    spent.push({ baseUrl: p.baseUrl, amount: p.amount });
    return { token: `sk-${spent.length}`, tokenBalance: 200, tokenBalanceUnit: "sat", tokenBalanceUnknown: false };
  });
  const bm = client.getBalanceManager();
  vi.spyOn(bm, "getTokenBalance").mockResolvedValue({ amount: 0, reserved: 0, unit: "msat", apiKey: "sk-1" });
  vi.spyOn(bm, "refundApiKey").mockResolvedValue({ success: true, message: "ok", amount: 0 } as any);
  vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);

  const sessions: string[] = [];
  const qualified: string[] = [];
  setConfidentialTransport(
    async ({ baseUrl }) => {
      sessions.push(baseUrl);
      if (baseUrl === A) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async (baseUrl) => {
      qualified.push(baseUrl);
      opts.qualify?.(baseUrl);
    },
  );
  return { client, spent, sessions, qualified };
}

const route = (client: RoutstrClient) =>
  client.routeRequest({
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    baseUrl: A,
    mintUrl: MINT,
    modelId: MODEL,
    confidential: {},
  });

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[TRANSPORT];
  delete (globalThis as Record<symbol, unknown>)[QUALIFIER];
});

describe("confidential failover", () => {
  it("skips nodes without confidential sessions and qualifies before spending", async () => {
    const { client, spent, sessions, qualified } = setup();
    const res = await route(client);
    expect(res.status).toBe(200);
    expect(sessions).toEqual([A, C]);
    expect(spent.map((s) => s.baseUrl)).toEqual([A, C]);
    expect(spent.some((s) => s.baseUrl === PLAIN)).toBe(false);
    // Each node qualified before its spend.
    expect(qualified).toEqual([A, C]);
    // The failover deposit covers the confidential reservation (full-context
    // prompt + max_tokens), not the plaintext estimate.
    expect(spent[1]!.amount).toBeGreaterThanOrEqual(60);
  });

  it("never spends on a failover node whose offer does not qualify", async () => {
    const { client, spent, sessions } = setup({
      qualify: (baseUrl) => {
        if (baseUrl === C) throw new Error("offer unavailable");
      },
    });
    // No qualifying node left: the failure comes back, nothing else is spent.
    const res = await route(client);
    expect(res.ok).toBe(false);
    expect(spent.map((s) => s.baseUrl)).toEqual([A]);
    expect(sessions).toEqual([A]);
  });

  it("does not spend on the first node when its offer does not qualify", async () => {
    const { client, spent, sessions } = setup({
      qualify: () => {
        throw new Error("offer unavailable");
      },
    });
    await expect(route(client)).rejects.toThrow(/offer unavailable/);
    expect(spent).toEqual([]);
    expect(sessions).toEqual([]);
  });
});
