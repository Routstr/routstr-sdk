/**
 * A refund claim is a one-way door for an API key.
 *
 * The node dispatches the payout before it answers, so a client timeout or a
 * lost response can leave a refund token persisted on the node while the SDK
 * only saw a failure. The node re-serves that token on a later refund request
 * **only while the key's balance is zero**. Topping the key up makes the next
 * refund claim the new deposit instead, stranding the earlier payout until the
 * node's sweep — and replacing the key loses the only credential that can
 * claim it.
 *
 * So: a refund attempt quarantines the key from funding until the claim is
 * resolved (token received) or the node proves nothing is owed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import {
  createMemoryDriver,
  createSdkStore,
  createStorageAdapterFromStore,
} from "../../storage";

const MINT = "https://mint.example.com";
const PROVIDER = "https://provider.example.com/";
const KEY = "sk-live";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface ApiKeyRecord {
  key: string;
  balance: number;
  lastUsed: number | null;
  refundPendingAt?: number;
}

const createStatefulStorage = (seeds?: {
  apiKeys?: Record<string, ApiKeyRecord>;
}) => {
  const apiKeys = new Map<string, ApiKeyRecord>();
  for (const [baseUrl, record] of Object.entries(seeds?.apiKeys ?? {})) {
    apiKeys.set(baseUrl, { ...record });
  }

  // Deliberately a custom adapter without the optional refund-marker methods:
  // the in-process fallback must keep the key quarantined too.
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

  return { adapter, apiKeys };
};

const createWallet = (overrides?: Partial<WalletAdapter>) => {
  const sendToken = vi.fn(async () => "cashu-fresh");
  const wallet: WalletAdapter = {
    getBalances: async () => ({ [MINT]: 1000 }),
    getMintUnits: () => ({ [MINT]: "sat" }),
    getActiveMintUrl: () => MINT,
    sendToken,
    receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
    ...overrides,
  };
  return { wallet, sendToken };
};

const refundResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("an unresolved refund blocks funding for its key", () => {
  it("quarantines the key after a network failure and refuses to top it up", async () => {
    const { adapter, apiKeys } = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: KEY, balance: 0, lastUsed: Date.now() - 60_000 },
      },
    });
    const { wallet, sendToken } = createWallet();
    const manager = new BalanceManager(wallet, adapter);

    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: KEY,
      forceRefund: true,
    });
    expect(refund.success).toBe(false);
    expect(manager.isApiKeyRefundPending(PROVIDER, KEY)).toBe(true);

    const topUp = await manager.ensureBalance({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      token: KEY,
      requiredSats: 100,
      targetSats: 100,
    });

    expect(topUp.success).toBe(false);
    expect(topUp.refundPending).toBe(true);
    expect(sendToken).not.toHaveBeenCalled();
    // The credential that can still claim the node-side payout is kept.
    expect(apiKeys.get(PROVIDER)?.key).toBe(KEY);
  });

  it.each([0, 11_000])("shares the quarantine with another manager %i ms after a refund", async (elapsed) => {
    vi.useFakeTimers({ now: Date.now() });
    const { adapter } = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: KEY, balance: 0, lastUsed: Date.now() - 60_000 },
      },
    });
    const { wallet, sendToken } = createWallet();
    const manager = new BalanceManager(wallet, adapter);

    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;

    await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: KEY,
      forceRefund: true,
    });
    vi.setSystemTime(Date.now() + elapsed);

    const peer = new BalanceManager(wallet, adapter);
    const topUp = await peer.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 100,
    });

    expect(topUp.success).toBe(false);
    expect(topUp.refundPending).toBe(true);
    expect(sendToken).not.toHaveBeenCalled();
    expect(new BalanceManager(wallet, createStatefulStorage().adapter).isApiKeyRefundPending(PROVIDER, KEY)).toBe(false);
    expect(peer.isApiKeyRefundPending(PROVIDER.slice(0, -1), KEY)).toBe(true);
    expect(peer.isApiKeyRefundPending(PROVIDER + "/", KEY)).toBe(false);
    peer.clearApiKeyRefundPending(PROVIDER, KEY);
    expect(manager.isApiKeyRefundPending(PROVIDER, KEY)).toBe(false);
  });

  it("lifts the quarantine when the node proves no payout was dispatched", async () => {
    const { adapter, apiKeys } = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: KEY, balance: 15, lastUsed: Date.now() - 60_000 },
      },
    });
    const { wallet } = createWallet();
    const manager = new BalanceManager(wallet, adapter);

    globalThis.fetch = (async () =>
      refundResponse(400, {
        error: {
          message: "Cannot refund key. There are ongoing requests for this api key.",
          type: "invalid_request_error",
          code: "refund_ongoing_requests",
        },
      })) as typeof fetch;

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: KEY,
      forceRefund: true,
    });

    expect(refund.success).toBe(false);
    expect(manager.isApiKeyRefundPending(PROVIDER, KEY)).toBe(false);
    expect(apiKeys.get(PROVIDER)?.key).toBe(KEY);
  });

  const dust = "Balance too small to refund";
  const ongoing = "Cannot refund key. There are ongoing requests for this api key.";
  it.each([
    { status: 400, body: { detail: dust }, pending: false },
    { status: 400, body: { detail: ongoing }, pending: false },
    { status: 400, body: { detail: `${ongoing} Retry later.` }, pending: true },
    { status: 500, body: { detail: dust }, pending: true },
    { status: 400, body: { error: { code: "refund_unresolved", message: dust } }, pending: true },
  ])("classifies a legacy refusal by status and exact message: $status $body", async ({ status, body, pending }) => {
    const { adapter } = createStatefulStorage();
    adapter.setApiKey(PROVIDER, KEY);
    const manager = new BalanceManager(createWallet().wallet, adapter);
    globalThis.fetch = async () => refundResponse(status, body);

    const result = await manager.refundApiKey({ mintUrl: MINT, baseUrl: PROVIDER, apiKey: KEY, forceRefund: true });
    expect(result.success).toBe(false);
    expect(manager.isApiKeyRefundPending(PROVIDER, KEY)).toBe(pending);
    expect(adapter.getApiKey(PROVIDER)?.key).toBe(KEY);
  });

  it("lifts the quarantine once the payout token is durably ours", async () => {
    const { adapter, apiKeys } = createStatefulStorage({
      apiKeys: {
        [PROVIDER]: { key: KEY, balance: 15, lastUsed: Date.now() - 60_000 },
      },
    });
    const { wallet } = createWallet();
    const manager = new BalanceManager(wallet, adapter);

    globalThis.fetch = (async () =>
      refundResponse(200, { token: "cashu-refund" })) as typeof fetch;

    const refund = await manager.refundApiKey({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      apiKey: KEY,
      forceRefund: true,
    });

    expect(refund.success).toBe(true);
    expect(manager.isApiKeyRefundPending(PROVIDER, KEY)).toBe(false);
    expect(apiKeys.get(PROVIDER)).toBeUndefined();
  });
});

describe("the refund marker survives a restart", () => {
  it.each([
    { succeeds: true, wasPending: false },
    { succeeds: false, wasPending: false },
    { succeeds: false, wasPending: true },
  ])("waits for the quarantine write before dispatch ($succeeds, previously pending: $wasPending)", async ({ succeeds, wasPending }) => {
    const first = createSdkStore({ driver: createMemoryDriver() });
    await first.hydrate;
    const storage = createStorageAdapterFromStore(first.store);
    storage.setApiKey(PROVIDER, KEY);
    const manager = new BalanceManager(createWallet().wallet, storage);
    if (wasPending) manager.markApiKeyRefundPending(PROVIDER, KEY);
    let finishWrite!: () => void;
    const write = new Promise<void>((resolve, reject) => {
      finishWrite = succeeds ? resolve : () => reject(new Error("storage unavailable"));
    });
    const flush = vi.spyOn(storage, "flush").mockImplementationOnce(() => write);
    const request = vi.spyOn(manager, "fetchRefundToken").mockResolvedValue({ success: false });
    const refund = manager.refundApiKey({ mintUrl: MINT, baseUrl: PROVIDER, apiKey: KEY, forceRefund: true });
    expect(flush).toHaveBeenCalledOnce();
    expect(storage.getApiKey(PROVIDER)?.refundPendingAt).toBeDefined();
    expect(request).not.toHaveBeenCalled();
    finishWrite();
    const result = await refund;
    if (!succeeds) expect(result.skipped).toBe(true);
    expect(request).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    expect(manager.isApiKeyRefundPending(PROVIDER, KEY)).toBe(succeeds || wasPending);
  });

  it.each(["not sent", "in flight", "ambiguous"] as const)("a failed write does not undo another manager's claim: %s", async (otherState) => {
    const sdk = createSdkStore({ driver: createMemoryDriver() });
    await sdk.hydrate;
    const storage = createStorageAdapterFromStore(sdk.store);
    storage.setApiKey(PROVIDER, KEY);
    const wallet = createWallet().wallet;
    const first = new BalanceManager(wallet, storage);
    const second = new BalanceManager(wallet, storage);
    const opts = { mintUrl: MINT, baseUrl: PROVIDER, apiKey: KEY, forceRefund: true };
    let failFirst!: () => void;
    const flush = vi.spyOn(storage, "flush").mockImplementationOnce(() => new Promise<void>((_, reject) => {
      failFirst = () => reject(new Error("first write failed"));
    }));
    const firstRequest = vi.spyOn(first, "fetchRefundToken").mockResolvedValue({ success: false });
    const a = first.refundApiKey(opts);

    let finishSecond!: () => void;
    const wait = new Promise<void>(resolve => { finishSecond = resolve; });
    if (otherState === "not sent") {
      flush.mockImplementationOnce(async () => { await wait; throw new Error("second write failed"); });
    }
    let dispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
    const secondRequest = vi.spyOn(second, "fetchRefundToken").mockImplementation(async () => {
      dispatch();
      await wait;
      return { success: false, error: "response lost" };
    });
    const b = second.refundApiKey(opts);
    if (otherState !== "not sent") await dispatched;
    if (otherState === "ambiguous") { finishSecond(); await b; }
    failFirst();
    await a;
    expect(firstRequest).not.toHaveBeenCalled();
    expect(second.isApiKeyRefundPending(PROVIDER, KEY)).toBe(true);
    finishSecond();
    await b;
    expect(secondRequest).toHaveBeenCalledTimes(otherState === "not sent" ? 0 : 1);
    expect(first.isApiKeyRefundPending(PROVIDER, KEY)).toBe(otherState !== "not sent");
  });

  it("persists on the key record and follows a credential swap", async () => {
    const driver = createMemoryDriver();
    const first = createSdkStore({ driver });
    await first.hydrate;
    const storage = createStorageAdapterFromStore(first.store);

    storage.setApiKey(PROVIDER, "cashu_bootstrap");
    storage.markApiKeyRefundPending!(PROVIDER, "cashu_bootstrap");

    const reloaded = createSdkStore({ driver });
    await reloaded.hydrate;
    const afterRestart = createStorageAdapterFromStore(reloaded.store);
    expect(afterRestart.getApiKey(PROVIDER)?.refundPendingAt).toBeTypeOf("number");

    // The node resolves the bootstrap token and its canonical `sk-` form to
    // the same key row, so the marker must survive the promotion.
    afterRestart.replaceApiKey!(PROVIDER, "sk-canonical");
    const promoted = afterRestart.getApiKey(PROVIDER);
    expect(promoted?.key).toBe("sk-canonical");
    expect(promoted?.refundPendingAt).toBeTypeOf("number");

    afterRestart.clearApiKeyRefundPending!(PROVIDER, "sk-canonical");
    expect(afterRestart.getApiKey(PROVIDER)?.refundPendingAt).toBeUndefined();
  });
});
