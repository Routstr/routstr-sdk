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

const norm = (url: string) => (url.endsWith("/") ? url : `${url}/`);

interface ApiKeyRecord {
  key: string;
  balance: number;
  lastUsed: number | null;
}

/**
 * Stateful storage fixture where mutations (setApiKey, removeApiKey,
 * updateApiKeyBalance) actually persist.  Tests that assert on multi-step
 * state changes — refund then verify key is gone, force-refund removes
 * providers, etc. — should use this instead of createStorage() closures.
 */
const createStatefulStorage = (seeds?: {
  apiKeys?: Record<string, ApiKeyRecord>;
}) => {
  const apiKeys = new Map<string, ApiKeyRecord>();
  if (seeds?.apiKeys) {
    for (const [baseUrl, record] of Object.entries(seeds.apiKeys)) {
      apiKeys.set(norm(baseUrl), { ...record });
    }
  }

  return createStorage({
    getApiKey: (baseUrl) => apiKeys.get(norm(baseUrl)) ?? null,
    setApiKey: (baseUrl, key) => {
      apiKeys.set(norm(baseUrl), { key, balance: 0, lastUsed: Date.now() });
    },
    removeApiKey: (baseUrl) => {
      apiKeys.delete(norm(baseUrl));
    },
    updateApiKeyBalance: (baseUrl, balance) => {
      const e = apiKeys.get(norm(baseUrl));
      if (e) {
        e.balance = balance;
      }
    },
    touchApiKeyLastUsed: (baseUrl) => {
      const e = apiKeys.get(norm(baseUrl));
      if (e) {
        e.lastUsed = Date.now();
      }
    },
    getAllApiKeys: () =>
      [...apiKeys.entries()].map(([baseUrl, e]) => ({
        ...e,
        baseUrl,
      })),
    getApiKeyDistribution: () =>
      [...apiKeys.entries()].map(([baseUrl, e]) => ({
        baseUrl,
        amount: e.balance,
      })),
  });
};

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
  const SEED_KEY: ApiKeyRecord = {
    key: "test-key",
    balance: 100,
    lastUsed: null,
  };

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
    const storage = createStatefulStorage({
      apiKeys: { [BASE_URL]: SEED_KEY },
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
    const storage = createStatefulStorage({
      apiKeys: { [BASE_URL]: SEED_KEY },
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
    const storage = createStatefulStorage({
      apiKeys: { [BASE_URL]: SEED_KEY },
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

    // r2 should not be blocked by guard (same type)
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
    const storage = createStatefulStorage({
      apiKeys: { [BASE_URL]: SEED_KEY },
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

  it("blocks refund after topup completes (cooldown)", async () => {
    const wallet = createWallet({
      getBalances: async () => ({ "https://mint.example.com": 1000 }),
      getMintUnits: () => ({ "https://mint.example.com": "sat" }),
      sendToken: async () => "token",
    });
    const storage = createStatefulStorage({
      apiKeys: { [BASE_URL]: SEED_KEY },
    });
    const manager = new BalanceManager(wallet, storage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("v1/wallet/topup")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ token: "cashu-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Run topup to completion
    await manager.topUp({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      amount: 10,
    });

    // Immediately try refund — should be blocked by cooldown
    const refundResult = await manager.refundApiKey({
      mintUrl: "https://mint.example.com",
      baseUrl: BASE_URL,
      apiKey: "test-key",
    });

    expect(refundResult.success).toBe(false);
    expect(refundResult.message).toContain("locked");
    expect(refundResult.message).toContain("topup");

    globalThis.fetch = originalFetch;
  });

  it("does not permanently lock after operation failure", async () => {
    const wallet = createWallet();
    const storage = createStatefulStorage();
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

    const storage = createStatefulStorage({
      apiKeys: {
        [ProviderA]: {
          key: "key-provider-a",
          balance: 1500,
          lastUsed: Date.now() - 60_000,
        },
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
      expect(storage.getApiKey(ProviderA)).toBeNull();
      expect(forceRefundUsed).toBe(true);
      expect(refundCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails with InsufficientBalanceError when even force-refund cannot free enough balance", async () => {
    let walletBalance = 500;

    const wallet = createWallet({
      getBalances: async () => ({ [Mint]: walletBalance }),
      getMintUnits: () => ({ [Mint]: "sat" }),
      receiveToken: async () => {
        walletBalance += 1500;
        return { success: true, amount: 1500, unit: "sat" as const };
      },
    });

    const storage = createStatefulStorage({
      apiKeys: {
        [ProviderA]: {
          key: "key-provider-a",
          balance: 1500,
          lastUsed: Date.now() - 60_000,
        },
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
      expect(storage.getApiKey(ProviderA)).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops early after force-refunding only as many providers as needed", async () => {
    let walletBalance = 100;
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
        const amt = amounts[currentRefundProvider.replace(/\/$/, "")] ?? 0;
        walletBalance += amt;
        return { success: true, amount: amt, unit: "sat" as const };
      },
    });

    const storage = createStatefulStorage({
      apiKeys: {
        [ProviderA]: {
          key: "key-a",
          balance: 800,
          lastUsed: Date.now() - 120_000,
        },
        [ProviderC]: {
          key: "key-c",
          balance: 2000,
          lastUsed: Date.now() - 60_000,
        },
      },
    });

    const manager = new BalanceManager(wallet, storage);
    const originalRefund = manager.refundApiKey.bind(manager);
    manager.refundApiKey = async (opts) => {
      refundedProviders.push(opts.baseUrl.replace(/\/$/, ""));
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
      expect(storage.getApiKey(ProviderA)).toBeNull();
      expect(storage.getApiKey(ProviderC)).toBeNull();
      // Both were force-refunded on retryCount=2 (the last 2 calls in the list)
      const forceRefundCalls = refundedProviders.slice(-2);
      expect(forceRefundCalls).toEqual([ProviderA, ProviderC]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not force-refund if soft refund from a naturally-expired provider frees enough balance", async () => {
    let walletBalance = 500;
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

    const storage = createStatefulStorage({
      apiKeys: {
        [ProviderA]: {
          key: "key-a",
          balance: 800,
          lastUsed: Date.now() - 10 * 60_000,
        },
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
      expect(storage.getApiKey(ProviderA)).toBeNull();
      expect(refundCalls).toBe(1);
      expect(forceRefundUsed).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("BalanceManager non-JSON error responses", () => {
  const CLOUDFLARE_502_HTML = `<!DOCTYPE html>
<html lang="en-US">
<head><title>routstr.com | 502: Bad gateway</title></head>
<body><h1>Bad gateway</h1><p>Error code 502</p></body>
</html>`;

  /** Minimal helper to create a fetch mock returning a fixed response. */
  const mockFetchResponse = (
    status: number,
    statusText: string,
    body: string,
    headers: Record<string, string> = {}
  ) => {
    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => body,
      json: async () => JSON.parse(body),
      headers: {
        get: (name: string) => headers[name] ?? null,
      },
    } as unknown as Response;
    return () => Promise.resolve(response);
  };

  it("fetchRefundToken returns concise HTTP status for HTML 502 instead of full page", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchResponse(
      502,
      "Bad gateway",
      CLOUDFLARE_502_HTML
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await manager.fetchRefundToken(
        "https://provider.example.com",
        "test-api-key"
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe("API key refund failed: 502 Bad gateway");
      // The full HTML page must NOT be in the error message
      expect(result.error).not.toContain("<html");
      expect(result.error).not.toContain("DOCTYPE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetchRefundToken propagates a request ID found only in the JSON body", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());
    const originalFetch = globalThis.fetch;
    const jsonBody = JSON.stringify({
      error: {
        type: "token_already_spent",
        code: "cashu_token_already_spent",
        message: "Token already spent",
      },
      request_id: "req-from-body",
    });
    globalThis.fetch = mockFetchResponse(
      400,
      "Bad Request",
      jsonBody
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await manager.fetchRefundToken(
        "https://provider.example.com",
        "test-api-key"
      );

      expect(result.requestId).toBe("req-from-body");
      expect(result.parsedError?.requestId).toBe("req-from-body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetchRefundToken still uses JSON detail field when present", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());
    const originalFetch = globalThis.fetch;
    const jsonBody = JSON.stringify({
      detail: "No balance to refund",
    });
    globalThis.fetch = mockFetchResponse(400, "Bad Request", jsonBody, {
      "x-routstr-request-id": "req-123",
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await manager.fetchRefundToken(
        "https://provider.example.com",
        "test-api-key"
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(result.error).toBe("API key refund failed: No balance to refund");
      expect(result.requestId).toBe("req-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getTokenBalance handles non-JSON (HTML) responses gracefully", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchResponse(
      502,
      "Bad gateway",
      CLOUDFLARE_502_HTML
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await manager.getTokenBalance(
        "test-api-key",
        "https://provider.example.com/"
      );

      expect(result.amount).toBe(0);
      expect(result.balanceUnknown).toBe(true);
      expect(result.isInvalidApiKey).toBeFalsy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getTokenBalance marks 'Key not found' (pre-0.4.5 body) as an invalid API key", async () => {
    const manager = new BalanceManager(createWallet(), createStorage());
    const originalFetch = globalThis.fetch;
    const keyNotFoundBody = JSON.stringify({
      detail:
        "Key not found. Deposit first via /v1/wallet/create before requesting a refund.",
      request_id: "req-key-not-found",
    });
    globalThis.fetch = mockFetchResponse(
      401,
      "Unauthorized",
      keyNotFoundBody
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await manager.getTokenBalance(
        "cashu_dead_bootstrap_key",
        "https://provider.example.com/"
      );

      expect(result.isInvalidApiKey).toBe(true);
      expect(result.balanceUnknown).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refundApiKey removes the key when the refund endpoint replies 'Key not found' (pre-0.4.5 body)", async () => {
    const Provider = "https://provider.example.com/";
    const storage = createStatefulStorage({
      apiKeys: {
        [Provider]: {
          key: "cashu_dead_bootstrap_key",
          balance: 0,
          lastUsed: null,
        },
      },
    });
    const manager = new BalanceManager(createWallet(), storage);
    const originalFetch = globalThis.fetch;
    const keyNotFoundBody = JSON.stringify({
      detail:
        "Key not found. Deposit first via /v1/wallet/create before requesting a refund.",
      request_id: "req-key-not-found",
    });
    globalThis.fetch = mockFetchResponse(
      401,
      "Unauthorized",
      keyNotFoundBody
    ) as unknown as typeof globalThis.fetch;

    try {
      const result = await manager.refundApiKey({
        mintUrl: "https://mint.example.com",
        baseUrl: Provider,
        apiKey: "cashu_dead_bootstrap_key",
        forceRefund: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe("Key not found, removed dead API key");
      expect(storage.getApiKey(Provider)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
