/**
 * Regression tests for a skipped refund arming the provider-wallet cooldown.
 *
 * Production incident 2026-11-11 06:43:55Z: the scheduled refund sweep reached
 * a provider whose key had been used 30s earlier, so `refundApiKey` returned
 * early with "API key was used recently, skipping refund" — no funds moved and
 * the provider was never contacted. Because `refundApiKey` wrapped the
 * implementation in try/finally and `_endProviderWalletOperation` stamped
 * `endTime` unconditionally, the no-op still looked like a completed wallet
 * mutation. The next top-up for that provider — the exact recovery a 402
 * insufficient_balance needs — was then refused for the full 10s cooldown:
 *
 *   refundApiKey: skipping .../ - used 30s ago
 *   Skipping topup for .../ - Provider wallet operation locked; recent refund completed 0s ago
 *   _handleErrorResponse: Topup failed with non-insufficient-balance error, will try next provider
 *
 * The guard from commit 5715e4e exists to keep concurrent top-up/refund fund
 * movements on one provider apart. A refund that returns before touching the
 * provider must therefore arm nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import { CashuSpender } from "../../wallet/CashuSpender";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const MINT = "https://mint.example.com";
const PROVIDER = "https://provider.example.com/";

const createWallet = (overrides?: Partial<WalletAdapter>): WalletAdapter => ({
  getBalances: async () => ({ [MINT]: 1000 }),
  getMintUnits: () => ({ [MINT]: "sat" }),
  getActiveMintUrl: () => MINT,
  sendToken: async () => "cashu-token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
  ...overrides,
});

interface ApiKeyRecord {
  key: string;
  balance: number;
  lastUsed: number | null;
}

const createStatefulStorage = (seeds?: {
  apiKeys?: Record<string, ApiKeyRecord>;
}) => {
  const apiKeys = new Map<string, ApiKeyRecord>();
  for (const [baseUrl, record] of Object.entries(seeds?.apiKeys ?? {})) {
    apiKeys.set(baseUrl, { ...record });
  }

  const adapter: StorageAdapter = {
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: () => {},
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    saveProviderInfo: () => {},
    getProviderInfo: () => null,
    getApiKey: (baseUrl) => apiKeys.get(baseUrl) ?? null,
    setApiKey: (baseUrl, key) => {
      apiKeys.set(baseUrl, { key, balance: 0, lastUsed: Date.now() });
    },
    updateApiKeyBalance: (baseUrl, balance) => {
      const entry = apiKeys.get(baseUrl);
      if (entry) entry.balance = balance;
    },
    touchApiKeyLastUsed: (baseUrl) => {
      const entry = apiKeys.get(baseUrl);
      if (entry) entry.lastUsed = Date.now();
    },
    removeApiKey: (baseUrl) => {
      apiKeys.delete(baseUrl);
    },
    getAllApiKeys: () =>
      [...apiKeys.entries()].map(([baseUrl, entry]) => ({ ...entry, baseUrl })),
    getChildKey: () => null,
    setChildKey: () => {},
    updateChildKeyBalance: () => {},
    removeChildKey: () => {},
    getAllChildKeys: () => [],
    getCachedReceiveTokens: () => [],
    setCachedReceiveTokens: () => {},
    getApiKeyDistribution: () =>
      [...apiKeys.entries()].map(([baseUrl, entry]) => ({
        baseUrl,
        amount: entry.balance,
      })),
  };

  return adapter;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("skipped refunds do not arm the provider wallet cooldown", () => {
  it("a refund skipping on the recent-use guard leaves the next top-up free to run", async () => {
    const storage = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: "sk-live", balance: 15, lastUsed: Date.now() - 30_000 },
      },
    });
    const manager = new BalanceManager(createWallet(), storage);

    // Neither operation should reach the network: the refund skips on
    // lastUsed, and the top-up must get past the guard to be attempted.
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: "sk-live",
    });

    expect(refund.success).toBe(false);
    expect(refund.skipped).toBe(true);
    expect(refund.message).toBe("API key was used recently, skipping refund");
    expect(fetchCalls).toEqual([]);

    const topUp = await manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 130,
    });

    expect(topUp.message ?? "").not.toContain("locked");
    expect(topUp.success).toBe(true);
    expect(fetchCalls.some((url) => url.includes("v1/wallet/topup"))).toBe(true);
  });

  it("a refund skipped because there is no key leaves the next top-up free to run", async () => {
    const storage = createStatefulStorage();
    const manager = new BalanceManager(createWallet(), storage);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: "",
    });
    expect(refund.skipped).toBe(true);
    expect(refund.message).toBe("No API key to refund");

    // No stored key, so the top-up fails on its own merits — but it must not
    // be reported as a provider-wallet lock.
    const topUp = await manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 130,
    });
    expect(topUp.message).toBe("No API key available for top up");
    expect(topUp.message).not.toContain("locked");
  });

  it("a real refund that reached the provider still arms the cooldown", async () => {
    const storage = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: "sk-idle", balance: 40, lastUsed: Date.now() - 10 * 60_000 },
      },
    });
    const manager = new BalanceManager(createWallet(), storage);

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("v1/wallet/refund")) {
        return new Response(JSON.stringify({ token: "cashu-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: "sk-idle",
    });
    expect(refund.skipped).toBeUndefined();

    // The guard must keep doing its actual job.
    const topUp = await manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 130,
    });
    expect(topUp.success).toBe(false);
    expect(topUp.message).toContain("locked");
    expect(topUp.message).toContain("recent refund completed");
  });

  it("a refund rejected by the guard does not re-arm or extend the block", async () => {
    const storage = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: "sk-live", balance: 15, lastUsed: Date.now() - 30_000 },
      },
    });
    const manager = new BalanceManager(createWallet(), storage);

    let topUpResolve!: () => void;
    const topUpGate = new Promise<void>((resolve) => {
      topUpResolve = resolve;
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    // Hold a top-up in flight so the refund is refused by the guard.
    const pendingTopUp = manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 130,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: "sk-live",
      forceRefund: true,
    });
    expect(refund.skipped).toBe(true);
    expect(refund.message).toContain("locked");

    topUpResolve();
    await topUpGate;
    await pendingTopUp;

    // The refused refund must not have taken ownership of the tracking entry:
    // the top-up's own completion is what stamps the cooldown, so an opposite
    // operation (a refund) is what the lock blocks.
    const blockedRefund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: "sk-live",
      forceRefund: true,
    });
    expect(blockedRefund.skipped).toBe(true);
    expect(blockedRefund.message).toContain("recent topup completed");
  });

  it("refundProviders does not arm the cooldown for a provider it only skipped", async () => {
    const storage = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: "sk-live", balance: 15, lastUsed: Date.now() - 30_000 },
      },
    });
    const wallet = createWallet();
    const manager = new BalanceManager(wallet, storage);
    const spender = new CashuSpender(wallet, storage, undefined, manager);

    globalThis.fetch = (async (input: string | URL | Request) => {
      // Only the balance refresh should hit the network.
      if (String(input).includes("v1/wallet/topup")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ balance: 15, reserved: 0, unit: "msat" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const results = await spender.refundProviders(MINT);
    expect(results).toEqual([{ baseUrl: PROVIDER, success: false }]);

    const topUp = await manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 130,
    });
    expect(topUp.message ?? "").not.toContain("recent refund completed");
  });
});
