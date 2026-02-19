import { describe, expect, it } from "vitest";
import { CashuSpender } from "../wallet/CashuSpender";
import type { StorageAdapter, WalletAdapter } from "../wallet/interfaces";

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
  getToken: () => null,
  setToken: () => {},
  removeToken: () => {},
  getPendingTokenDistribution: () => [],
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
  ...overrides,
});

describe("CashuSpender", () => {
  it("fails with invalid amount", async () => {
    const spender = new CashuSpender(createWallet(), createStorage());

    const result = await spender.spend({
      mintUrl: "https://mint.example.com",
      amount: NaN,
      baseUrl: "https://provider.example.com",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Please enter a valid amount");
  });

  it("reuses stored token when pending balance is sufficient", async () => {
    const spender = new CashuSpender(
      createWallet({
        getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      }),
      createStorage({
        getToken: () => "stored-token",
        getPendingTokenDistribution: () => [
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
    expect(result.token).toBe("stored-token");
    expect(result.balance).toBe(42);
  });

  it("returns insufficient balance error with available total", async () => {
    const spender = new CashuSpender(
      createWallet({
        getBalances: async () => ({ "https://mint.example.com": 5 }),
        getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      }),
      createStorage({ getPendingTokenDistribution: () => [] })
    );

    const result = await spender.spend({
      mintUrl: "https://mint.example.com",
      amount: 10,
      baseUrl: "https://provider.example.com",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Insufficient balance");
    expect(result.error).toContain("need 10 sats");
  });
});
