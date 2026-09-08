import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, TopUpResult } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example.com/";
const MINT_URL = "https://mint.example.com";
const API_KEY = "sk-test-key";

const createWallet = (): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => MINT_URL,
  sendToken: async () => "cashu-token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
});

const createStorage = (): StorageAdapter => ({
  getXcashuTokens: () => ({}),
  getXcashuTokensForBaseUrl: () => [],
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  clearXcashuTokensForBaseUrl: () => {},
  updateXcashuTokenTryCount: () => {},
  getApiKeyDistribution: () => [],
  getApiKey: () => ({
    key: API_KEY,
    baseUrl: BASE_URL,
    balance: 0,
    lastUsed: null,
  }),
  setApiKey: () => {},
  updateApiKeyBalance: () => {},
  touchApiKeyLastUsed: () => {},
  removeApiKey: () => {},
  getAllApiKeys: () => [],
  getChildKey: () => null,
  setChildKey: () => {},
  updateChildKeyBalance: () => {},
  removeChildKey: () => {},
  getAllChildKeys: () => [],
  getCachedReceiveTokens: () => [],
  setCachedReceiveTokens: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
});

const createDiscovery = (): DiscoveryAdapter => ({
  getCachedModels: () => ({}),
  setCachedModels: () => {},
  getCachedMints: () => ({}),
  setCachedMints: () => {},
  getCachedProviderInfo: () => ({}),
  setCachedProviderInfo: () => {},
  getProviderLastUpdate: () => null,
  setProviderLastUpdate: () => {},
  getLastUsedModel: () => null,
  setLastUsedModel: () => {},
  getDisabledProviders: () => [],
  setDisabledProviders: () => {},
  getBaseUrlsList: () => [],
  setBaseUrlsList: () => {},
  getBaseUrlsLastUpdate: () => null,
  setBaseUrlsList: () => {},
  setBaseUrlsLastUpdate: () => {},
  getRoutstr21Models: () => [],
  setRoutstr21Models: () => {},
  getRoutstr21ModelsLastUpdate: () => null,
  setRoutstr21ModelsLastUpdate: () => {},
});

const model = {
  id: "gpt-test",
  name: "GPT Test",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

const localInsufficientBalanceBody = JSON.stringify({
  detail: {
    error: {
      message: "Insufficient balance: 100 sats required; 20 sats available.",
      type: "insufficient_quota",
      code: "insufficient_balance",
    },
  },
});

function createClient(
  storageOverrides: Partial<StorageAdapter> = {},
  providerManagerOverrides: Record<string, unknown> = {},
  mode: "apikeys" | "xcashu" = "apikeys"
) {
  const updateApiKeyBalance = vi.fn();
  const storage = {
    ...createStorage(),
    updateApiKeyBalance,
    ...storageOverrides,
  } as StorageAdapter;
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(() => null),
    ...providerManagerOverrides,
  } as any;
  const client = new RoutstrClient(
    createWallet(),
    storage,
    createDiscovery(),
    "ERROR",
    mode,
    { providerManager }
  );
  return { client, providerManager, updateApiKeyBalance };
}

/** Call _spinOffTopupIfNeeded with a balance snapshot. */
function spinOff(
  client: RoutstrClient,
  snapshot: Partial<{
    token: string;
    baseUrl: string;
    mintUrl: string;
    requiredSats: number;
    tokenBalance: number;
    tokenReserved: number;
    tokenBalanceUnit: "sat" | "msat";
    tokenBalanceUnknown: boolean;
  }> = {}
) {
  (client as any)._spinOffTopupIfNeeded({
    token: API_KEY,
    baseUrl: BASE_URL,
    mintUrl: MINT_URL,
    requiredSats: 100,
    tokenBalance: 20, // sat — below the 100-sat requirement
    tokenReserved: 0,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
    ...snapshot,
  });
}

describe("RoutstrClient proactive (pre-request) topup spin-off", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("spins off a background topup when the snapshot balance is below the required sats", async () => {
    const { client, updateApiKeyBalance } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000, // 20 sat — fresh check still short
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({ success: true, toppedUpAmount: 112, message: "ok" });

    spinOff(client);

    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());
    // shortfall = 100 - 20 = 80 → 80 * TOPUP_MARGIN(1.4)
    expect(topUp).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 80 * 1.4,
      token: API_KEY,
    });
    // After a successful topup the refreshed balance is persisted so the
    // stored snapshot does not stay stale-low.
    await vi.waitFor(() =>
      expect(updateApiKeyBalance).toHaveBeenCalledWith(BASE_URL, 20, 0)
    );
  });

  it("triggers from stored reserved balance even when stored total covers the request", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 120_000, // 120 sat total
      reserved: 30_000, // 30 sat reserved → 90 sat available
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({ success: true, message: "ok" });

    // Total alone covers 100 sats, but the stored reserved snapshot makes
    // only 90 sats available and must trigger the proactive path.
    spinOff(client, { tokenBalance: 120, tokenReserved: 30 });

    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());
    expect(topUp).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      // Fresh shortfall is 10, so the 21-sat floor applies, then 1.4 margin.
      amount: 21 * 1.4,
      token: API_KEY,
    });
  });

  it("accounts for reserved funds in the fresh balance re-check", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000, // 20 sat total
      reserved: 10_000, // 10 sat reserved → 10 sat available
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({ success: true, toppedUpAmount: 126, message: "ok" });

    spinOff(client, { tokenBalance: 20 });

    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());
    // available = 20 - 10 = 10 → shortfall = 90 → 90 * 1.4
    expect(topUp).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 90 * 1.4,
      token: API_KEY,
    });
  });

  it("applies the 0.21-floor when the shortfall is tiny", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 99_000, // 99 sat → shortfall = 1 sat < 0.21 * 100
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({ success: true, message: "ok" });

    spinOff(client, { tokenBalance: 99 });

    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());
    // floor = 0.21 * 100 = 21 → 21 * 1.4
    expect(topUp).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 21 * 1.4,
      token: API_KEY,
    });
  });

  it("skips the topup when the fresh balance is already sufficient (stale snapshot)", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    // Snapshot says 20 sat, but the fresh provider check says plenty.
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 150_000,
      reserved: 10_000,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi.spyOn(balanceManager, "topUp");

    spinOff(client);
    await new Promise((r) => setTimeout(r, 10));

    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not spin off when the snapshot balance is already sufficient", async () => {
    const { client } = createClient();
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");

    spinOff(client, { tokenBalance: 200 }); // ≥ required
    await new Promise((r) => setTimeout(r, 10));

    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not spin off when the balance snapshot is unknown", async () => {
    const { client } = createClient();
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");

    spinOff(client, { tokenBalanceUnknown: true, tokenBalance: 0 });
    await new Promise((r) => setTimeout(r, 10));

    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not spin off in xcashu mode", async () => {
    const { client } = createClient({}, {}, "xcashu");
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");

    spinOff(client);
    await new Promise((r) => setTimeout(r, 10));

    expect(topUp).not.toHaveBeenCalled();
  });

  it("swallows background topup failures without unhandled rejections", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({
        success: false,
        message: "Insufficient balance: need 500 have 96",
      });

    spinOff(client);

    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());
    // Nothing threw to the caller (spinOff is sync void) and no unhandled
    // rejection surfaced — vitest fails the run on those by default.
  });

  it("allows a new proactive attempt as soon as the previous one settles (no cooldown)", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({ success: true, message: "ok" });

    spinOff(client);
    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());

    // The first attempt settled, so a new low-balance snapshot may start
    // another one immediately — the in-flight guard is the only
    // concurrency control.
    spinOff(client);
    await vi.waitFor(() => expect(topUp).toHaveBeenCalledTimes(2));
  });

  it("shares one in-flight topup between concurrent spin-offs", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockImplementation(
        () => new Promise<TopUpResult>((r) => setTimeout(() =>
          r({ success: true, message: "ok" }), 5))
      );

    spinOff(client);
    spinOff(client); // a concurrent request with the same low snapshot
    await new Promise((r) => setTimeout(r, 20));

    expect(topUp).toHaveBeenCalledOnce();
  });

  it("the 402 handler joins an in-flight proactive topup instead of stacking a second deposit", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000, // 20 sat — 402 validation still sees a shortfall
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    let resolveTopUp!: (r: TopUpResult) => void;
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockImplementation(
        () =>
          new Promise<TopUpResult>((res) => {
            resolveTopUp = res;
          })
      );
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    // Pre-request spin-off — its topUp stays in flight.
    spinOff(client);
    await vi.waitFor(() => expect(topUp).toHaveBeenCalledOnce());

    // The same request 402s while the proactive topup is still running.
    const handled = (client as any)._handleErrorResponse(
      {
        path: "/v1/chat/completions",
        method: "POST",
        body: { model: model.id, messages: [] },
        selectedModel: model,
        baseUrl: BASE_URL,
        mintUrl: MINT_URL,
        token: API_KEY,
        requiredSats: 100,
        headers: {},
        baseHeaders: {},
        tinfoilEnabled: false,
      },
      API_KEY,
      402,
      "req-402",
      undefined,
      localInsufficientBalanceBody,
      0
    );

    resolveTopUp({ success: true, toppedUpAmount: 112, message: "ok" });
    const response = await handled;

    expect(response.status).toBe(200);
    // Exactly one deposit — the 402 handler joined the proactive topup.
    expect(topUp).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("spins off the topup before the request goes out and does not block it", async () => {
    const { client } = createClient(
      {
        getApiKeyDistribution: () => [
          { baseUrl: BASE_URL, amount: 120, reserved: 30 },
        ],
      },
      {
        getModelForProvider: async () => model,
        getRequiredSatsForModel: () => 100,
      }
    );
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 120_000, // 120 sat total
      reserved: 30_000, // 90 sat available — below the 100-sat request
      unit: "msat",
      apiKey: API_KEY,
    });
    let topUpStarted = false;
    const topUp = vi.spyOn(balanceManager, "topUp").mockImplementation(
      async () => {
        topUpStarted = true;
        return { success: true, toppedUpAmount: 21 * 1.4, message: "ok" };
      }
    );

    // Hold the actual HTTP request in flight so we can observe ordering.
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<Response>((res) => {
            resolveFetch = res;
          })
      );
    vi.stubGlobal("fetch", fetchMock);

    const prepared = (client as any)._prepareRoutedRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, messages: [] },
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      modelId: model.id,
    });

    // While the request is still in flight, the background topup already
    // started — proving the spin-off runs concurrently, not after.
    await vi.waitFor(() => expect(topUpStarted).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const ctx = await prepared;

    expect(ctx.response.status).toBe(200);
    expect(topUp).toHaveBeenCalledOnce();
  });
});
