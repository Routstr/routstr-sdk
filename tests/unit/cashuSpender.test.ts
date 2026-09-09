import { getEncodedTokenV4 } from "@cashu/cashu-ts";
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

describe("CashuSpender", () => {
  it("caches the real amount when a short-keyset token fails on an unreachable mint", async () => {
    const shortKeysetId = `01${"11".repeat(32)}`;
    const token = getEncodedTokenV4({
      mint: "https://mint.example.com",
      unit: "msat",
      proofs: [
        {
          id: shortKeysetId,
          amount: 2,
          secret: "synthetic-secret-1",
          C: `02${"22".repeat(32)}`,
        },
        {
          id: shortKeysetId,
          amount: 5,
          secret: "synthetic-secret-2",
          C: `03${"33".repeat(32)}`,
        },
      ],
    });

    const cached: ReturnType<StorageAdapter["getCachedReceiveTokens"]> = [];
    const spender = new CashuSpender(
      createWallet({
        receiveToken: async () => {
          throw new Error("Failed to fetch mint https://mint.example.com");
        },
      }),
      createStorage({
        getCachedReceiveTokens: () => cached,
        setCachedReceiveTokens: (tokens) => {
          cached.splice(0, cached.length, ...tokens);
        },
      })
    );

    const result = await spender.receiveToken(token);

    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({ token, amount: 7, unit: "msat" });
    expect(result).toMatchObject({ success: false, amount: 7, unit: "msat" });
  });

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
