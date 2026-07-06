import { describe, expect, it } from "vitest";
import { CashuSpender } from "../../wallet/CashuSpender";
import { InsufficientBalanceError } from "../../core";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 0, unit: "sat" }),
  ...overrides,
});

const createStorage = (
  overrides?: Partial<StorageAdapter>
): StorageAdapter => ({
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

describe("CashuSpender", () => {
  it("reuses stored API key when pending balance is sufficient", async () => {
    const spender = new CashuSpender(
      createWallet({
        getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      }),
      createStorage({
        getApiKey: () => ({
          key: "stored-api-key",
          baseUrl: "https://provider.example.com/",
          balance: 42,
          lastUsed: null,
        }),
        getApiKeyDistribution: () => [
          { baseUrl: "https://provider.example.com", amount: 42 },
        ],
      })
    );

    const result = await spender.spend({
      mintUrl: "https://mint.example.com",
      amount: 10,
      baseUrl: "https://provider.example.com",
      reuseToken: true,
    });

    expect(result.status).toBe("success");
    expect(result.token).toBe("stored-api-key");
    expect(result.balance).toBe(42);
  });

  it("returns insufficient balance error with available total", async () => {
    const spender = new CashuSpender(
      createWallet({
        getBalances: async () => ({ "https://mint.example.com": 5 }),
        getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      }),
      createStorage()
    );

    await expect(
      spender.spend({
        mintUrl: "https://mint.example.com",
        amount: 10,
        baseUrl: "https://provider.example.com",
      })
    ).rejects.toThrow(InsufficientBalanceError);
  });
});
