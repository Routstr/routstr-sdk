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
  it("returns early when no token to refund", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());

    const result = await manager.refund({
      mintUrl: "https://mint.example.com",
      baseUrl: "https://provider.example.com",
    });

    expect(result.success).toBe(true);
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

  it("succeeds when API key balance alone is sufficient for the model cost", async () => {
    const apiKeyBalance = 520;
    const walletBalance = 400;
    const modelCost = 500;

    const manager = new BalanceManager(
      createWallet({
        getBalances: async () => ({
          "https://mint.example.com": walletBalance,
        }),
        getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      }),
      createStorage({
        getAllApiKeys: () => [
          {
            key: "test-api-key",
            baseUrl: "https://provider.example.com",
            balance: apiKeyBalance,
            lastUsed: null,
          },
        ],
      })
    );

    const result = await manager.createProviderToken({
      mintUrl: "https://mint.example.com",
      baseUrl: "https://provider.example.com",
      amount: modelCost,
    });

    expect(result.success).toBe(true);
  });
});
