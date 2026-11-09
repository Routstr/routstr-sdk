/**
 * A pre-warmed confidential key arms only while its available balance is at
 * least fundsHeadroom × R, so the proactive top-up must keep it above that
 * line (it used to refill only to TOPUP_MARGIN × R, and the pool never armed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import {
  PREWARM_FUNDS_HEADROOM,
  prewarmFundsHeadroom,
  prewarmTopupFactor,
} from "../../client/confidential/prewarmFunds";
import { PREWARM_DEFAULTS } from "../../client/confidential/prewarm";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://node.example/";
const mintUrl = "https://mint.example/";
const model = {
  id: "test-model",
  name: "Test Model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;
const TRANSPORT = Symbol.for("@routstr/sdk/confidentialTransport");

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

function setup() {
  const storage = {
    getApiKey: () => ({ key: "sk-test", baseUrl, balance: 200, lastUsed: null }),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    recordSuccess: vi.fn(),
    markFailed: vi.fn(),
    getFailedProviders: () => new Set(),
    findNextBestProvider: vi.fn(() => null),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(
    { getBalances: async () => ({}), getMintUnits: () => ({}), getActiveMintUrl: () => mintUrl } as unknown as WalletAdapter,
    storage,
    {} as DiscoveryAdapter,
    "max",
    "apikeys",
    { providerManager: providerManager as any, logger }
  );
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: "sk-test",
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const topUp = vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
    Object.assign(new Response("{}", { headers: { "content-type": "application/json" } }), {
      passthrough: true,
    })
  );
  return { client, topUp };
}

function route(client: RoutstrClient, confidential?: Record<string, unknown>) {
  return client.routeRequest({
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: model.id, messages: [{ role: "user", content: "hi" }], max_tokens: 40 },
    baseUrl,
    mintUrl,
    modelId: model.id,
    headers: {},
    confidential: confidential as any,
  });
}

describe("pre-warm funds rule", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<symbol, unknown>)[TRANSPORT];
  });

  it("the pool and the top-up share one default", () => {
    expect(PREWARM_DEFAULTS.fundsHeadroom).toBe(PREWARM_FUNDS_HEADROOM);
    expect(prewarmFundsHeadroom(undefined)).toBe(2);
    expect(prewarmFundsHeadroom({ fundsHeadroom: 3 })).toBe(3);
    expect(prewarmFundsHeadroom({ fundsHeadroom: -1 })).toBe(2);
    expect(prewarmFundsHeadroom({ fundsHeadroom: Number.NaN })).toBe(2);
  });

  it("keeps fundsHeadroom × R plus the request's own margin while pre-warming", () => {
    expect(prewarmTopupFactor(undefined, 1.4)).toBe(1.4);
    expect(prewarmTopupFactor({ enabled: false }, 1.4)).toBe(1.4);
    expect(prewarmTopupFactor({}, 1.4)).toBeCloseTo(2.4);
    expect(prewarmTopupFactor({ fundsHeadroom: 3 }, 1.4)).toBeCloseTo(3.4);
    // Never below the plain margin.
    expect(prewarmTopupFactor({ fundsHeadroom: 0 }, 1.4)).toBe(1.4);
  });

  it("a pre-warmed confidential chat request tops up to the pre-warm line", async () => {
    (globalThis as Record<symbol, unknown>)[TRANSPORT] = vi.fn();
    const { client, topUp } = setup();
    await route(client, { trustedHosts: [], prewarm: { enabled: true, log: () => {} } });
    expect(topUp).toHaveBeenCalledTimes(1);
    expect((topUp.mock.calls[0]![0] as { topupFactor: number }).topupFactor).toBeCloseTo(2.4);
  });

  it("without pre-warming, and for plain requests, the margin is unchanged", async () => {
    (globalThis as Record<symbol, unknown>)[TRANSPORT] = vi.fn();
    for (const confidential of [undefined, { trustedHosts: [] }]) {
      const { client, topUp } = setup();
      await route(client, confidential);
      expect((topUp.mock.calls[0]![0] as { topupFactor: number }).topupFactor).toBe(1.4);
      vi.restoreAllMocks();
    }
  });

  it("the proactive top-up asks the balance manager for the scaled target", async () => {
    const { client } = setup();
    const ensure = vi
      .spyOn(client.getBalanceManager(), "ensureBalance")
      .mockResolvedValue({ success: true } as any);
    await (client as any)._runProactiveTopup({
      token: "sk-test",
      baseUrl,
      mintUrl,
      requiredSats: 100,
      topupFactor: 2.4,
      tokenBalance: 150,
      tokenBalanceUnit: "sat",
    });
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ requiredSats: 100, targetSats: 240 }));
  });
});
