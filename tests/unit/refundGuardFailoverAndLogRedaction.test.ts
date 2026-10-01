import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { SdkLogger, Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://first.example/";
const nextUrl = "https://second.example/";
const mintUrl = "https://mint.example/";
const credential = "cashu-DO-NOT-LOG-THIS-SECRET";
const model = { id: "test-model", sats_pricing: { prompt: 1, completion: 1, max_cost: 100 } } as Model;

function setup() {
  const messages: string[] = [];
  const logger: SdkLogger = {
    log: (...args) => { messages.push(args.map(String).join(" ")); },
    warn: (...args) => { messages.push(args.map(String).join(" ")); },
    error: (...args) => { messages.push(args.map(String).join(" ")); },
    debug: (...args) => { messages.push(args.map(String).join(" ")); },
    child() { return this; },
  };
  const wallet = {
    getBalances: async () => ({}), getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl, sendToken: async () => credential,
    receiveToken: async () => ({ success: false, message: "proofs already spent" }),
  } as WalletAdapter;
  const removeApiKey = vi.fn();
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl, balance: 399, lastUsed: null }),
    removeApiKey,
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    markFailed: vi.fn(), getFailedProviders: () => new Set([baseUrl]),
    findNextBestProvider: vi.fn(() => nextUrl),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(wallet, storage, {} as DiscoveryAdapter,
    "max", "apikeys", { providerManager: providerManager as any, logger });
  client.setDebugLevel("DEBUG");
  const balanceManager = client.getBalanceManager();
  vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
    amount: 399_000, reserved: 0, unit: "msat", apiKey: credential,
  });
  const refund = vi.spyOn(balanceManager, "refundApiKey");
  const spend = vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: "safe-next-key", tokenBalance: 200, tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const retry = vi.spyOn(client as any, "_makeRequest")
    .mockResolvedValue(new Response("ok", { status: 200 }));
  return { client, messages, refund, spend, retry, providerManager, removeApiKey };
}

const params = {
  path: "/v1/messages", method: "POST", body: { model: model.id, messages: [] },
  selectedModel: model, baseUrl, mintUrl, token: credential, requiredSats: 100,
  headers: {}, baseHeaders: {}, tinfoilEnabled: false,
};

const upstreamError = JSON.stringify({ error: { type: "upstream_error", code: 500,
  message: "missing upstream API key" } });

describe("500 refund guard and credential logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "Provider wallet operation locked; recent topup completed 1s ago",
    "Provider wallet operation locked; topup in progress",
  ])("preserves a guarded key and fails over: %s", async (reason) => {
    const { client, refund, spend, retry, providerManager, removeApiKey } = setup();
    refund.mockResolvedValue({ success: false, message: reason });
    const response = await (client as any)._handleErrorResponse(
      params, credential, 500, "req-500", undefined, upstreamError, 0);
    expect(response.status).toBe(200);
    expect(removeApiKey).not.toHaveBeenCalled();
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      baseUrl, expect.stringContaining("status=500"), model.id, undefined);
    expect(providerManager.findNextBestProvider).toHaveBeenCalledWith(model.id, baseUrl, expect.any(Set));
    expect(spend).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: nextUrl }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: nextUrl }));
  });

  it("does not silently fail over on an unrelated refund failure", async () => {
    const { client, refund, providerManager } = setup();
    refund.mockResolvedValue({ success: false, message: "unrelated wallet failure" });
    await expect((client as any)._handleErrorResponse(
      params, credential, 500, "req-500", undefined, upstreamError, 0))
      .rejects.toThrow("unrelated wallet failure");
    expect(providerManager.findNextBestProvider).not.toHaveBeenCalled();
  });

  it("redacts credentials in error and spend logs, including balance debug output", async () => {
    const { client, refund, messages } = setup();
    refund.mockResolvedValue({ success: false,
      message: "Provider wallet operation locked; recent topup completed 1s ago" });
    await (client as any)._handleErrorResponse(
      params, credential, 500, "req-500", undefined, upstreamError, 0);
    expect(messages.join("\n")).toContain("[REDACTED]");
    expect(messages.join("\n")).not.toContain(credential);

    vi.mocked((client as any)._spendToken).mockRestore();
    const storage = (client as any).storageAdapter as StorageAdapter;
    vi.spyOn(storage, "getApiKey").mockReturnValue({
      key: credential, baseUrl, balance: 399, lastUsed: null,
    });
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 399_000, reserved: 0, unit: "msat", apiKey: credential,
    });
    await (client as any)._spendToken({ baseUrl, mintUrl, amount: 10 });
    expect(messages.join("\n")).not.toContain(credential);
  });
});
