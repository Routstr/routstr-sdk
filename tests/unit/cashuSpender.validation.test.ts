import { describe, expect, it } from "vitest";
import { CashuSpender } from "../../wallet/CashuSpender";
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
  touchApiKeyLastUsed: () => {},
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

/**
 * Most basic wallet test — CashuSpender input validation.
 *
 * Before any token spending or refund logic, the spender must reject
 * invalid input. This is the simplest guard with zero external dependencies.
 */
describe("wallet: CashuSpender input validation", () => {
  it("rejects NaN amount by throwing a clear error", async () => {
    const spender = new CashuSpender(createWallet(), createStorage());

    await expect(
      spender.spend({
        mintUrl: "https://mint.example.com",
        amount: NaN,
        baseUrl: "https://provider.example.com",
      })
    ).rejects.toThrow("Please enter a valid amount");
  });

  it("rejects zero amount by throwing a clear error", async () => {
    const spender = new CashuSpender(createWallet(), createStorage());

    await expect(
      spender.spend({
        mintUrl: "https://mint.example.com",
        amount: 0,
        baseUrl: "https://provider.example.com",
      })
    ).rejects.toThrow("Please enter a valid amount");
  });
});
