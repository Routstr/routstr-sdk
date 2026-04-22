import { describe, expect, it } from "vitest";
import { BalanceManager } from "../wallet/BalanceManager";
import type { StorageAdapter, WalletAdapter } from "../wallet/interfaces";

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  ...overrides,
});

const createStorage = (
  overrides?: Partial<StorageAdapter>
): StorageAdapter => ({
  getToken: () => null,
  setToken: () => {},
  removeToken: () => {},
  updateTokenBalance: () => {},
  getCachedTokenDistribution: () => [],
  getApiKeyDistribution: () => [],
  removeApiKey: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
  getApiKey: () => null,
  setApiKey: () => {},
  updateApiKeyBalance: () => {},
  getAllApiKeys: () => [],
  getChildKey: () => null,
  setChildKey: () => {},
  updateChildKeyBalance: () => {},
  removeChildKey: () => {},
  getAllChildKeys: () => [],
  getCachedReceiveTokens: () => [],
  setCachedReceiveTokens: () => {},
  ...overrides,
});

describe("BalanceManager", () => {
  it("returns early when no apiKey to refund", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());

    const result = await manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: "https://provider.example.com",
      apiKey: "",
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("No API key to refund");
  });

  it("rejects invalid top up amount", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());

    const result = await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: "https://provider.example.com",
      amount: 0,
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Invalid top up amount");
  });

  it("fails top up when no stored token", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());

    const result = await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: "https://provider.example.com",
      amount: 10,
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("No API key available for top up");
  });

  it("succeeds when mint balance is sufficient for the model cost", async () => {
    const walletBalance = 1000;
    const modelCost = 500;

    const manager = new BalanceManager(
      createWallet({
        getBalances: async () => ({
          "https://mint.example.com": walletBalance,
        }),
        getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      }),
      createStorage()
    );

    const result = await manager.createProviderToken({
      mintUrl: "https://mint.example.com",
      baseUrl: "https://provider.example.com",
      amount: modelCost,
    });

    expect(result.success).toBe(true);
  });
});

describe("BalanceManager provider wallet collision guard", () => {
  const BASE_URL = "https://provider.example.com";

  it("blocks topup while refund is in-flight for the same provider", async () => {
    let refundResolve!: () => void;
    const refundPromise = new Promise<void>((resolve) => {
      refundResolve = resolve;
    });

    const wallet = createWallet({
      getBalances: async () => ({ "https://mint.example.com": 1000 }),
      getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      sendToken: async () => "token",
    });
    const storage = createStorage({
      getApiKey: () => ({
        key: "test-key",
        baseUrl: BASE_URL,
        balance: 100,
        lastUsed: null,
      }),
    });
    const manager = new BalanceManager(wallet, storage);

    // Patch fetch so refund hangs until we resolve it
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      await refundPromise;
      return new Response(JSON.stringify({ token: "cashu-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const refundResultPromise = manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      apiKey: "test-key",
    });

    // Attempt topup while refund is in-flight
    const topUpResult = await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      amount: 10,
    });

    expect(topUpResult.success).toBe(false);
    expect(topUpResult.message).toContain("locked");
    expect(topUpResult.message).toContain("refund");

    refundResolve();
    await refundResultPromise;
    globalThis.fetch = originalFetch;
  });

  it("blocks refund while topup is in-flight for the same provider", async () => {
    let topupResolve!: () => void;
    const topupPromise = new Promise<void>((resolve) => {
      topupResolve = resolve;
    });

    const wallet = createWallet({
      getBalances: async () => ({ "https://mint.example.com": 1000 }),
      getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      sendToken: async () => "token",
    });
    const storage = createStorage({
      getApiKey: () => ({
        key: "test-key",
        baseUrl: BASE_URL,
        balance: 100,
        lastUsed: null,
      }),
    });
    const manager = new BalanceManager(wallet, storage);

    // Patch fetch so topup hangs
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      await topupPromise;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const topUpResultPromise = manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      amount: 10,
    });

    // Attempt refund while topup is in-flight
    const refundResult = await manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      apiKey: "test-key",
    });

    expect(refundResult.success).toBe(false);
    expect(refundResult.message).toContain("locked");
    expect(refundResult.message).toContain("topup");

    topupResolve();
    await topUpResultPromise;
    globalThis.fetch = originalFetch;
  });

  it("allows same-type operations to overlap (not blocked)", async () => {
    const wallet = createWallet({
      getBalances: async () => ({ "https://mint.example.com": 1000 }),
      getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      sendToken: async () => "token",
    });
    const storage = createStorage({
      getApiKey: () => ({
        key: "test-key",
        baseUrl: BASE_URL,
        balance: 100,
        lastUsed: null,
      }),
    });
    const manager = new BalanceManager(wallet, storage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ token: "cashu-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const r1 = manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      apiKey: "test-key",
    });

    // second refund should be allowed since same type
    const r2 = await manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      apiKey: "test-key",
    });

    // r2 should not be blocked by guard (same type), but may fail for other reasons
    expect(r2.message ?? "").not.toContain("locked");

    await r1;
    globalThis.fetch = originalFetch;
  });

  it("blocks opposite operation within 10s after completion", async () => {
    const wallet = createWallet({
      getBalances: async () => ({ "https://mint.example.com": 1000 }),
      getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      sendToken: async () => "token",
    });
    const storage = createStorage({
      getApiKey: () => ({
        key: "test-key",
        baseUrl: BASE_URL,
        balance: 100,
        lastUsed: null,
      }),
    });
    const manager = new BalanceManager(wallet, storage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ token: "cashu-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    // Run refund
    await manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      apiKey: "test-key",
    });

    // Immediately try topup — should be blocked by cooldown
    const topUpResult = await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      amount: 10,
    });

    expect(topUpResult.success).toBe(false);
    expect(topUpResult.message).toContain("locked");
    expect(topUpResult.message).toContain("refund");

    globalThis.fetch = originalFetch;
  });

  it("does not permanently lock after operation failure", async () => {
    const wallet = createWallet();
    const storage = createStorage();
    const manager = new BalanceManager(wallet, storage);

    // topUp fails immediately because no api key
    const result1 = await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      amount: 10,
    });
    expect(result1.success).toBe(false);

    // A second topUp should still fail, but NOT because of a permanent lock
    const result2 = await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      amount: 10,
    });
    expect(result2.success).toBe(false);
    expect(result2.message).toBe("No API key available for top up");
    expect(result2.message).not.toContain("locked");
  });
});
