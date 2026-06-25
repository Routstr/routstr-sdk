import { describe, expect, it } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

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
    let keyRemoved = false;
    const wallet = createWallet({
      getBalances: async () => ({ "https://mint.example.com": 1000 }),
      getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      sendToken: async () => "token",
    });
    const storage = createStorage({
      getApiKey: () =>
        keyRemoved
          ? null
          : {
              key: "test-key",
              baseUrl: BASE_URL,
              balance: 100,
              lastUsed: null,
            },
      removeApiKey: () => {
        keyRemoved = true;
      },
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

    // r2 should not be blocked by guard (same type), but the key was
    // already removed by r1 so it fails with a clean "no key" error.
    expect(r2.message ?? "").not.toContain("locked");
    expect(r2.success).toBe(false);
    expect(r2.message).toContain("No API key");

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

describe("BalanceManager force-refund escalation", () => {
  const Mint = "https://mint.example.com";
  const ProviderA = "https://provider-a.example.com";
  const ProviderB = "https://provider-b.example.com";

  it("force-refunds a recently-used provider when it is the only way to pay a different provider", async () => {
    let walletBalance = 500;
    let providerARemoved = false;
    let refundCalls = 0;
    let forceRefundUsed = false;

    const wallet = createWallet({
      getBalances: async () => ({ [Mint]: walletBalance }),
      getMintUnits: () => ({ [Mint]: "sat" }),
      sendToken: async (_mintUrl: string, amount: number) => {
        if (walletBalance >= amount) {
          walletBalance -= amount;
          return "new-token-for-provider-b";
        }
        throw new Error("Insufficient balance");
      },
      receiveToken: async () => {
        walletBalance += 1500;
        return { success: true, amount: 1500, unit: "sat" as const };
      },
    });

    const storage = createStorage({
      getApiKeyDistribution: () => {
        if (providerARemoved) return [];
        return [{ baseUrl: ProviderA, amount: 1500 }];
      },
      getAllApiKeys: () => {
        if (providerARemoved) return [];
        return [{
          key: "key-provider-a",
          baseUrl: ProviderA,
          balance: 1500,
          lastUsed: Date.now() - 60_000,
        }];
      },
      getApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA && !providerARemoved) {
          return {
            key: "key-provider-a",
            baseUrl: ProviderA,
            balance: 1500,
            lastUsed: Date.now() - 60_000,
          };
        }
        return null;
      },
      removeApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA) providerARemoved = true;
      },
    });

    const manager = new BalanceManager(wallet, storage);
    const originalRefund = manager.refundApiKey.bind(manager);
    manager.refundApiKey = async (opts) => {
      refundCalls++;
      if (opts.forceRefund) forceRefundUsed = true;
      return originalRefund(opts);
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("provider-a.example.com/v1/wallet/refund")) {
        return new Response(JSON.stringify({ token: "refunded-cashu-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await manager.createProviderToken({
        mintUrl: Mint,
        baseUrl: ProviderB,
        amount: 1400,
      });

      expect(result.success).toBe(true);
      expect(result.token).toBe("new-token-for-provider-b");
      expect(providerARemoved).toBe(true);
      expect(forceRefundUsed).toBe(true);
      expect(refundCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails with InsufficientBalanceError when even force-refund cannot free enough balance", async () => {
    let walletBalance = 500;
    let providerARemoved = false;

    const wallet = createWallet({
      getBalances: async () => ({ [Mint]: walletBalance }),
      getMintUnits: () => ({ [Mint]: "sat" }),
      receiveToken: async () => {
        walletBalance += 1500;
        return { success: true, amount: 1500, unit: "sat" as const };
      },
    });

    const storage = createStorage({
      getApiKeyDistribution: () => {
        if (providerARemoved) return [];
        return [{ baseUrl: ProviderA, amount: 1500 }];
      },
      getAllApiKeys: () => {
        if (providerARemoved) return [];
        return [{
          key: "key-provider-a",
          baseUrl: ProviderA,
          balance: 1500,
          lastUsed: Date.now() - 60_000,
        }];
      },
      getApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA && !providerARemoved) {
          return {
            key: "key-provider-a",
            baseUrl: ProviderA,
            balance: 1500,
            lastUsed: Date.now() - 60_000,
          };
        }
        return null;
      },
      removeApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA) providerARemoved = true;
      },
    });

    const manager = new BalanceManager(wallet, storage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("provider-a.example.com/v1/wallet/refund")) {
        return new Response(JSON.stringify({ token: "refunded-cashu-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await manager.createProviderToken({
        mintUrl: Mint,
        baseUrl: ProviderB,
        amount: 3000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Insufficient balance");
      // Even total (500+1500=2000) < 3000, so the refund is never attempted.
      expect(providerARemoved).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops early after force-refunding only as many providers as needed", async () => {
    let walletBalance = 100;
    const removedProviders = new Set<string>();
    const refundedProviders: string[] = [];
    const ProviderC = "https://provider-c.example.com";

    // Track which provider is being refunded so receiveToken can add the right amount
    let currentRefundProvider = "";

    const wallet = createWallet({
      getBalances: async () => ({ [Mint]: walletBalance }),
      getMintUnits: () => ({ [Mint]: "sat" }),
      sendToken: async (_mintUrl: string, amount: number) => {
        if (walletBalance >= amount) {
          walletBalance -= amount;
          return "token-for-provider-b";
        }
        throw new Error("Insufficient balance");
      },
      receiveToken: async () => {
        const amounts: Record<string, number> = { [ProviderA]: 800, [ProviderC]: 2000 };
        const amt = amounts[currentRefundProvider] ?? 0;
        walletBalance += amt;
        return { success: true, amount: amt, unit: "sat" as const };
      },
    });

    const storage = createStorage({
      getApiKeyDistribution: () => {
        const dist: Array<{ baseUrl: string; amount: number }> = [];
        if (!removedProviders.has(ProviderA)) dist.push({ baseUrl: ProviderA, amount: 800 });
        if (!removedProviders.has(ProviderC)) dist.push({ baseUrl: ProviderC, amount: 2000 });
        return dist;
      },
      getAllApiKeys: () => {
        const keys: Array<{ key: string; baseUrl: string; balance: number; lastUsed: number | null }> = [];
        if (!removedProviders.has(ProviderA)) {
          keys.push({ key: "key-a", baseUrl: ProviderA, balance: 800, lastUsed: Date.now() - 120_000 });
        }
        if (!removedProviders.has(ProviderC)) {
          keys.push({ key: "key-c", baseUrl: ProviderC, balance: 2000, lastUsed: Date.now() - 60_000 });
        }
        return keys;
      },
      getApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA && !removedProviders.has(ProviderA)) {
          return { key: "key-a", baseUrl: ProviderA, balance: 800, lastUsed: Date.now() - 120_000 };
        }
        if (baseUrl === ProviderC && !removedProviders.has(ProviderC)) {
          return { key: "key-c", baseUrl: ProviderC, balance: 2000, lastUsed: Date.now() - 60_000 };
        }
        return null;
      },
      removeApiKey: (baseUrl: string) => {
        removedProviders.add(baseUrl);
      },
    });

    const manager = new BalanceManager(wallet, storage);
    const originalRefund = manager.refundApiKey.bind(manager);
    manager.refundApiKey = async (opts) => {
      refundedProviders.push(opts.baseUrl);
      currentRefundProvider = opts.baseUrl;
      return originalRefund(opts);
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("v1/wallet/refund")) {
        return new Response(JSON.stringify({ token: "refunded-cashu-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await manager.createProviderToken({
        mintUrl: Mint,
        baseUrl: ProviderB,
        amount: 1200,
      });

      expect(result.success).toBe(true);
      // wallet=100, ProviderA=800 → after refund: 900 < 1200, need ProviderC too
      expect(removedProviders.has(ProviderA)).toBe(true);
      expect(removedProviders.has(ProviderC)).toBe(true);
      // Both were force-refunded on retryCount=2 (the last 2 calls in the list)
      const forceRefundCalls = refundedProviders.slice(-2);
      expect(forceRefundCalls).toEqual([ProviderA, ProviderC]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not force-refund if soft refund from a naturally-expired provider frees enough balance", async () => {
    let walletBalance = 500;
    let providerARemoved = false;
    let refundCalls = 0;
    let forceRefundUsed = false;

    const wallet = createWallet({
      getBalances: async () => ({ [Mint]: walletBalance }),
      getMintUnits: () => ({ [Mint]: "sat" }),
      sendToken: async (_mintUrl: string, amount: number) => {
        if (walletBalance >= amount) {
          walletBalance -= amount;
          return "token-for-provider-b";
        }
        throw new Error("Insufficient balance");
      },
      receiveToken: async () => {
        walletBalance += 800;
        return { success: true, amount: 800, unit: "sat" as const };
      },
    });

    const storage = createStorage({
      getApiKeyDistribution: () => {
        if (providerARemoved) return [];
        return [{ baseUrl: ProviderA, amount: 800 }];
      },
      getAllApiKeys: () => {
        if (providerARemoved) return [];
        return [{
          key: "key-a",
          baseUrl: ProviderA,
          balance: 800,
          lastUsed: Date.now() - 10 * 60_000,
        }];
      },
      getApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA && !providerARemoved) {
          return {
            key: "key-a",
            baseUrl: ProviderA,
            balance: 800,
            lastUsed: Date.now() - 10 * 60_000,
          };
        }
        return null;
      },
      removeApiKey: (baseUrl: string) => {
        if (baseUrl === ProviderA) providerARemoved = true;
      },
    });

    const manager = new BalanceManager(wallet, storage);
    const originalRefund = manager.refundApiKey.bind(manager);
    manager.refundApiKey = async (opts) => {
      refundCalls++;
      if (opts.forceRefund) forceRefundUsed = true;
      return originalRefund(opts);
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("v1/wallet/refund")) {
        return new Response(JSON.stringify({ token: "refunded-cashu-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await manager.createProviderToken({
        mintUrl: Mint,
        baseUrl: ProviderB,
        amount: 1000,
      });

      expect(result.success).toBe(true);
      expect(result.token).toBe("token-for-provider-b");
      expect(providerARemoved).toBe(true);
      expect(refundCalls).toBe(1);
      expect(forceRefundUsed).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
