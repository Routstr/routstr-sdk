import { getEncodedToken } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import { CashuSpender } from "../../wallet/CashuSpender";
import { BalanceManager } from "../../wallet/BalanceManager";
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
    const token = getEncodedToken({
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

describe("cached receive recovery", () => {
  it("removes successful tokens, keeps failures, and preserves concurrently cached entries", async () => {
    let cached = ["good", "bad"].map((token) => ({ token, amount: 10, unit: "sat" as const, createdAt: 1 }));
    const spender = new CashuSpender(createWallet({
      receiveToken: async (token) => {
        if (token === "good") {
          spender.cacheReceiveToken("new");
          return { success: true, amount: 10, unit: "sat" };
        }
        throw new Error("mint unavailable");
      },
    }), createStorage({
      getCachedReceiveTokens: () => cached,
      setCachedReceiveTokens: (entries) => { cached = entries.map((entry) => ({ ...entry, createdAt: entry.createdAt ?? 1 })); },
    }));
    expect(await spender.recoverCachedReceiveTokens()).toEqual([
      { token: "good", success: true }, { token: "bad", success: false },
    ]);
    expect(cached.map((entry) => entry.token)).toEqual(["bad", "new"]);
  });
});

describe("CashuSpender refund sweep", () => {
  const Provider = "https://llm.satsandsports.cash/";

  it("drops a key the provider proves empty instead of re-sweeping it forever", async () => {
    const apiKeys = new Map([
      [Provider, { key: "sk-empty", balance: 0, lastUsed: null as number | null }],
    ]);
    const touched: string[] = [];
    const storage = createStorage({
      getApiKeyDistribution: () =>
        [...apiKeys.entries()].map(([baseUrl, entry]) => ({
          baseUrl,
          amount: entry.balance,
        })),
      getApiKey: (baseUrl) => apiKeys.get(baseUrl) ?? null,
      removeApiKey: (baseUrl) => {
        apiKeys.delete(baseUrl);
      },
      touchApiKeyLastUsed: (baseUrl) => {
        touched.push(baseUrl);
      },
    });
    const balanceManager = new BalanceManager(createWallet(), storage);
    const spender = new CashuSpender(
      createWallet(),
      storage,
      undefined,
      balanceManager
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/wallet/refund")) {
        // Pre-routstr-core#805 body: a bare detail string with no code.
        return new Response(
          JSON.stringify({
            detail: "No balance to refund",
            request_id: "req-no-balance",
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(
        JSON.stringify({ balance: 0, reserved: 0, api_key: "sk-empty" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const results = await spender.refundProviders(
        "https://mint.example.com"
      );

      expect(results).toEqual([{ baseUrl: Provider, success: true }]);
      // The dead key is gone, so the next sweep has nothing to retry...
      expect(apiKeys.has(Provider)).toBe(false);
      // ...and it is no longer rate-limited via lastUsed, which is what made
      // the bug self-perpetuating: one 400 every five minutes, forever.
      expect(touched).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
