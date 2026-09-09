import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { ProviderError } from "../../core/errors";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore, createDiscoveryAdapterFromStore } from "../../storage";
import type { WalletAdapter } from "../../wallet/interfaces";

const A = "https://a.example/";
const B = "https://b.example/";
const mint = "https://mint.example";
const model = { id: "gpt-4o-mini", name: "GPT-4o Mini", sats_pricing: { prompt: 1, completion: 1, max_cost: 100 } } as any;
const logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => logger };
const request = { path: "/v1/chat/completions", method: "POST", body: { messages: [] }, baseUrl: A, mintUrl: mint, modelId: model.id };

async function fixture(mode: "apikeys" | "xcashu" = "apikeys") {
  const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  const discovery = createDiscoveryAdapterFromStore(store);
  discovery.setCachedModels({ [A]: [model], [B]: [model] });
  discovery.setCachedMints({ [A]: [mint], [B]: [mint] });
  storage.setApiKey(A, "sk-credit-on-a");
  storage.updateApiKeyBalance(A, 200);
  await storage.flush!();
  const send = vi.fn(async (_m: string, _a: number, _p?: string, persist?: (t: string) => Promise<void>) => {
    await persist?.("cashu-new");
    return "cashu-new";
  });
  const wallet: WalletAdapter = {
    getBalances: async () => ({ [mint]: 1000 }),
    getMintUnits: () => ({ [mint]: "sat" }),
    getActiveMintUrl: () => mint,
    sendToken: send,
    receiveToken: async () => ({ success: true, amount: 7, unit: "sat" }),
  };
  const client = new RoutstrClient(wallet, storage, discovery, "min", mode, { logger });
  const manager = client.getBalanceManager();
  vi.spyOn(manager, "getTokenBalance").mockResolvedValue({ amount: 200000, reserved: 0, unit: "msat", apiKey: "sk-credit-on-a" });
  const refund = vi.spyOn(manager, "refundApiKey").mockResolvedValue({ success: true, refundedAmount: 50000 } as any);
  const hits: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    hits.push(url);
    return url.startsWith(A) ? new Response("upstream boom", { status: 500 }) : Response.json({ choices: [] });
  }));
  return { client, storage, send, refund, hits, manager, wallet };
}

describe("selected provider policy", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("failover: false keeps the key and credit and throws the provider status", async () => {
    const f = await fixture();
    const error = await f.client.routeRequest({ ...request, failover: false }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("500");
    expect(f.hits).toEqual([`${A}v1/chat/completions`]);
    expect(f.refund).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.storage.getApiKey(A)).toMatchObject({ key: "sk-credit-on-a", balance: 200 });
    expect(f.storage.getApiKey(B)).toBeNull();
  });

  it("default policy still refunds and fails over to the next provider", async () => {
    const f = await fixture();
    const response = await f.client.routeRequest(request);
    expect(response.status).toBe(200);
    expect(f.refund).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: A, forceRefund: true }));
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.hits[1]).toBe(`${B}v1/chat/completions`);
  });

  it.each([false, undefined])("carries failover: %s into the proactive top-up", async (failover) => {
    const f = await fixture();
    f.storage.updateApiKeyBalance(A, 50);
    const topUp = vi.spyOn(f.manager, "topUp").mockResolvedValue({ success: true, toppedUpAmount: 90, message: "ok" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));

    await f.client.routeRequest({ ...request, failover });

    expect(topUp).toHaveBeenCalledExactlyOnceWith({
      mintUrl: mint,
      baseUrl: A,
      amount: 90,
      token: "sk-credit-on-a",
      refundOtherProviders: failover !== false,
    });
  });

  it("refundOtherProviders: false never pools another provider's credit into a top-up", async () => {
    const f = await fixture();
    f.wallet.getBalances = async () => ({});
    f.storage.updateApiKeyBalance(A, 0);
    f.storage.setApiKey(B, "sk-credit-on-b");
    f.storage.updateApiKeyBalance(B, 50);
    const restricted = await f.manager.createProviderToken({ mintUrl: mint, baseUrl: A, amount: 7, refundOtherProviders: false });
    expect(restricted.success).toBe(false);
    expect(restricted.error).toContain("Insufficient balance");
    expect(f.refund).not.toHaveBeenCalled();
    await f.manager.createProviderToken({ mintUrl: mint, baseUrl: A, amount: 7 });
    expect(f.refund).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: B }));
  });

  it.each(["apikeys", "xcashu"] as const)("failover: false never funds a %s request from another provider", async (mode) => {
    const f = await fixture(mode);
    f.wallet.getBalances = async () => ({ [mint]: 1 });
    f.storage.removeApiKey(A);
    f.storage.setApiKey(B, "sk-credit-on-b");
    f.storage.updateApiKeyBalance(B, 1000);

    await expect(f.client.routeRequest({ ...request, failover: false })).rejects.toThrow("Insufficient balance");

    expect(f.refund).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.storage.getApiKey(B)).toMatchObject({ key: "sk-credit-on-b", balance: 1000 });
  });
});
