import { createMemoryRequestLifecycleDriver } from "../../storage/requestLifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { FailoverError, InsufficientBalanceError } from "../../core/errors";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model } from "../../core/types";
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

const params = {
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
};

const localInsufficientBalanceBody = JSON.stringify({
  detail: {
    error: {
      message: "Insufficient balance: 100 sats required; 20 sats available.",
      type: "insufficient_quota",
      code: "insufficient_balance",
    },
  },
});

function createClient(nextProvider: string | null = null) {
  const providerManager = {
    markFailed: vi.fn(),
    getFailedProviders: () => new Set([BASE_URL]),
    findNextBestProvider: vi.fn(() => nextProvider),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 5),
  } as any;
  const client = new RoutstrClient(
    createWallet(),
    createStorage(),
    createDiscovery(),
    "ERROR",
    "apikeys",
    { providerManager }
  );
  return { client, providerManager };
}

async function handle402(client: RoutstrClient, body: string, retryCount = 0) {
  return (client as any)._handleErrorResponse(
    params,
    API_KEY,
    402,
    "req-402",
    undefined,
    body,
    retryCount
  );
}

describe("RoutstrClient 402 top-up validation", () => {
  it.each([402, 413])("tracks actual %i same-provider retry recursion", async (status) => {
    const { client, providerManager } = createClient();
    providerManager.recordSuccess = vi.fn();
    const driver = createMemoryRequestLifecycleDriver();
    (client as any).requestLifecycleDriver = driver;
    vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({ token: API_KEY, tokenBalance: 20, tokenBalanceUnit: "sat" });
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({ amount: 20, reserved: 0, unit: "sat", apiKey: API_KEY });
    vi.spyOn(client.getBalanceManager(), "topUp").mockResolvedValue({ success: true, toppedUpAmount: 112, message: "ok" });
    vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(localInsufficientBalanceBody, { status })).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal("fetch", fetchMock);
    const response = await client.routeRequest({ ...params, modelId: model.id });
    const trace = await driver.getTrace(response.requestId!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trace?.request).toMatchObject({ outcome: "succeeded", attemptCount: 2, retryCount: 1, failoverCount: 0 });
    expect(trace?.attempts.map(a => a.kind)).toEqual(["initial", "same_provider_retry"]);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("tops up only after a structured local insufficient-balance error and a confirmed shortfall", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: true,
      toppedUpAmount: 112,
      message: "ok",
    });
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await handle402(client, localInsufficientBalanceBody);

    expect(response.status).toBe(200);
    expect(topUp).toHaveBeenCalledOnce();
    expect(topUp).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 80 * 1.4,
      token: API_KEY,
    });
    expect(retry).toHaveBeenCalledOnce();
  });

  const structuredDetails = {
    unit: "msat", required_msats: 28989, available_msats: 21000, shortfall_msats: 7989,
    pricing: { base_source: "model_sats_pricing", max_cost_formula: "context_only" },
  };
  const structuredError = {
    type: "insufficient_quota", code: "insufficient_balance",
    message: "Insufficient balance: 15.2208 sats required; 1 sats available.",
    details: structuredDetails,
  };

  it("sizes a top-up using server msats rather than the cached estimate or English message", async () => {
    const { client } = createClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 21000, reserved: 0, unit: "msat", apiKey: API_KEY,
    });
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp").mockResolvedValue({
      success: true, message: "ok",
    });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(Response.json({}));
    await handle402(client, JSON.stringify({ error: structuredError }));
    expect(topUp).toHaveBeenCalledWith(expect.objectContaining({ amount: (28.989 - 21) * 1.4 }));
  });

  it("retains fresh balance validation rather than trusting stale 402 available_msats", async () => {
    const { client } = createClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 30000, reserved: 0, unit: "msat", apiKey: API_KEY,
    });
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");
    const retry = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(Response.json({}));
    await handle402(client, JSON.stringify({ error: structuredError }));
    expect(topUp).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("maps structured top-up shortfalls to sats and exposes pricing after failover exhaustion", async () => {
    const { parseCoreError } = await import("../../core/errorTypes");
    const { client } = createClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 0, reserved: 0, unit: "msat", apiKey: API_KEY,
    });
    const parsedError = parseCoreError(JSON.stringify({ error: structuredError, request_id: "node-id" }), 402);
    vi.spyOn(client.getBalanceManager(), "topUp").mockResolvedValue({
      success: false, message: "no English amount matching required", parsedError,
    });
    await expect(handle402(client, JSON.stringify({ error: structuredError }))).rejects.toMatchObject({
      name: "InsufficientBalanceError", required: 28.989, available: 21,
      parsedError: { pricing: structuredDetails.pricing, requestId: "node-id" },
    });
  });

  it("never tops up less than the minimum deposit", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 2_500,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    const topUp = vi
      .spyOn(balanceManager, "topUp")
      .mockResolvedValue({ success: true, toppedUpAmount: 7, message: "ok" });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response("ok", { status: 200 })
    );

    // shortfall = 3 - 2.5 = 0.5, floored to 0.21 * 3 = 0.63, x1.4 = 0.88.
    await (client as any)._handleErrorResponse(
      { ...params, requiredSats: 3 },
      API_KEY,
      402,
      "req-402",
      undefined,
      localInsufficientBalanceBody,
      0
    );

    expect(topUp).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      mintUrl: MINT_URL,
      baseUrl: BASE_URL,
      amount: 7,
      token: API_KEY,
    });
  });

  it("does not top up a passed-through upstream-provider 402", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    const getBalance = vi.spyOn(balanceManager, "getTokenBalance");
    const topUp = vi.spyOn(balanceManager, "topUp");
    const body = JSON.stringify({
      error: {
        type: "upstream_error",
        code: 402,
        message: "Provider account has insufficient credits",
      },
    });

    await expect(handle402(client, body)).rejects.toBeInstanceOf(FailoverError);
    expect(getBalance).not.toHaveBeenCalled();
    expect(topUp).not.toHaveBeenCalled();
    expect(providerManager.markFailed).toHaveBeenCalledWith(
      BASE_URL,
      expect.stringContaining("type=upstream_error"),
      // model-scoped cooldown: the 402 belongs to this model's request
      "gpt-test",
      // no pinned model path: no path-scoped cooldown
      undefined
    );
  });

  it("does not top up an unknown or unstructured 402", async () => {
    const { client } = createClient();
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");

    await expect(handle402(client, "Payment Required")).rejects.toBeInstanceOf(
      FailoverError
    );
    expect(topUp).not.toHaveBeenCalled();
  });

  // Parallel requests on the key held its balance when the node answered;
  // they have finished by the time the balance is read.
  const sufficientBalance = (client: RoutstrClient) =>
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 150_000,
      reserved: 10_000,
      unit: "msat",
      apiKey: API_KEY,
    });

  it("retries the same provider without a top-up when the API-key balance is already sufficient", async () => {
    const { client } = createClient();
    sufficientBalance(client);
    const topUp = vi.spyOn(client.getBalanceManager(), "topUp");
    const ok = new Response("ok", { status: 200 });
    const retry = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(ok);

    await expect(handle402(client, localInsufficientBalanceBody)).resolves.toBe(ok);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: BASE_URL, retryCount: 1 })
    );
    expect(topUp).not.toHaveBeenCalled();
  });

  it("fails over once retries for an already-sufficient balance run out", async () => {
    const { client } = createClient();
    sufficientBalance(client);
    const retry = vi.spyOn(client as any, "_makeRequest");

    await expect(
      handle402(client, localInsufficientBalanceBody, 2)
    ).rejects.toBeInstanceOf(FailoverError);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not top up when the API-key balance cannot be validated", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 0,
      reserved: 0,
      unit: "sat",
      apiKey: "",
      balanceUnknown: true,
    });
    const topUp = vi.spyOn(balanceManager, "topUp");

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toBeInstanceOf(FailoverError);
    expect(topUp).not.toHaveBeenCalled();
  });

  it("does not top up when a balance limit, rather than available funds, was exceeded", async () => {
    const { client } = createClient();
    const balanceManager = client.getBalanceManager();
    const getBalance = vi.spyOn(balanceManager, "getTokenBalance");
    const topUp = vi.spyOn(balanceManager, "topUp");
    const body = JSON.stringify({
      error: {
        type: "insufficient_quota",
        code: "balance_limit_exceeded",
        message: "Balance limit exceeded",
      },
    });

    await expect(handle402(client, body)).rejects.toBeInstanceOf(FailoverError);
    expect(getBalance).not.toHaveBeenCalled();
    expect(topUp).not.toHaveBeenCalled();
  });


  function walletShortForTopup(client: RoutstrClient) {
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 0, reserved: 0, unit: "msat", apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      message: "Insufficient balance: need 117 sats, have 349 sats available.",
    });
  }

  it("fails over when the wallet cannot fund this provider's top-up", async () => {
    const { client } = createClient("https://other.example.com/");
    walletShortForTopup(client);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "cashu-next", selectedMintUrl: MINT_URL, tokenBalance: 5, tokenBalanceUnit: "sat",
    });
    const retry = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    expect((await handle402(client, localInsufficientBalanceBody)).status).toBe(200);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://other.example.com/" })
    );
  });

  it("still reports insufficient balance when no provider is left", async () => {
    const { client } = createClient();
    walletShortForTopup(client);

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  function keyHeldByOtherRequests(client: RoutstrClient) {
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      message: "Insufficient balance: need 112 sats, have 30 sats available.",
    });
    return vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000, reserved: 450_000, unit: "msat", apiKey: API_KEY,
    });
  }

  it("waits for our in-flight request on the key to settle, then retries the same node", async () => {
    // routeRequests builds a client per call.
    let settled = false;
    const routedClient = () => {
      const { client, providerManager } = createClient();
      providerManager.getRequiredSatsForModel = vi.fn(() => 100);
      providerManager.recordSuccess = vi.fn();
      keyHeldByOtherRequests(client).mockImplementation(async () => ({
        amount: settled ? 150_000 : 20_000, reserved: settled ? 0 : 450_000,
        unit: "msat", apiKey: API_KEY,
      }));
      vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_spendToken").mockResolvedValue({ token: API_KEY, tokenBalance: 20, tokenBalanceUnit: "sat" });
      vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
      return client;
    };
    const encoder = new TextEncoder();
    let endFirst!: () => void;
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        endFirst = () => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(firstBody, { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(localInsufficientBalanceBody, { status: 402 }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await routedClient().routeRequest({ ...params, modelId: model.id });
    const second = routedClient().routeRequest({ ...params, modelId: model.id });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    settled = true;
    endFirst();
    await first.text();
    expect((await second).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("provider.example.com");
  });

  it.each(["locked-stream", "clone-failure", "accounting-failure"])(
    "releases the hold after %s so future unfunded calls do not wait",
    async (failure) => {
      const { client, providerManager } = createClient();
      providerManager.recordSuccess = vi.fn();
      const balance = keyHeldByOtherRequests(client);
      vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_spendToken").mockResolvedValue({
        token: API_KEY, tokenBalance: 20, tokenBalanceUnit: "sat",
      });
      vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockRejectedValue(new Error("accounting failed"));
      let unlock: (() => void) | undefined;
      let response = Response.json({});
      if (failure === "locked-stream") {
        response = new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
          headers: { "content-type": "text/event-stream" },
        });
        const reader = response.body!.getReader();
        unlock = () => reader.releaseLock();
      } else if (failure === "clone-failure") {
        vi.spyOn(response, "clone").mockImplementation(() => { throw new Error("clone failed"); });
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      try {
        const routed = client.routeRequest({ ...params, modelId: model.id, trackLifecycle: false });
        if (failure === "accounting-failure") await (await routed).finalize!();
        else await expect(routed).rejects.toThrow();
        balance.mockClear();
        await expect(handle402(client, localInsufficientBalanceBody)).rejects.toBeInstanceOf(InsufficientBalanceError);
        // One validation read + ensureBalance's read; no reservation-loop read.
        expect(balance).toHaveBeenCalledTimes(2);
      } finally { unlock?.(); }
    }
  );

  it("releases an aborted transport hold even when fetch ignores cancellation", async () => {
    const { client } = createClient();
    const balance = keyHeldByOtherRequests(client);
    vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: API_KEY, tokenBalance: 20, tokenBalanceUnit: "sat",
    });
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const routed = client.routeRequest({ ...params, modelId: model.id, signal: controller.signal, trackLifecycle: false });
    const rejected = expect(routed).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    balance.mockClear();
    await expect(handle402(client, localInsufficientBalanceBody)).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(balance).toHaveBeenCalledTimes(2);
  });

  it("fails at once when the holds belong to another client", async () => {
    const { client } = createClient();
    keyHeldByOtherRequests(client);

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("fails over when the top-up cannot fund any mint the provider accepts", async () => {
    const NEXT_URL = "https://next.example.com/";
    const { client, providerManager } = createClient(NEXT_URL);
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      providerMintsShort: true,
      providerBaseUrl: BASE_URL,
      acceptedMints: ["https://mint.accepted.example"],
      required: 100,
      available: 20,
      maxMintBalance: 0,
      maxMintUrl: "",
      message: "No funded mint accepted by provider",
    });
    const spend = vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token: "tok-next",
      tokenBalance: 1000,
      tokenReserved: 0,
      tokenBalanceUnit: "sat",
      tokenBalanceUnknown: false,
      selectedMintUrl: "https://mint.accepted.example",
    });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(
      new Response("ok", { status: 200 })
    );

    const response = await handle402(client, localInsufficientBalanceBody);

    expect(response.status).toBe(200);
    expect(spend).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: NEXT_URL })
    );
    // A local wallet condition must not cool the provider down.
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("surfaces an honest provider-mint 402 only after every provider is exhausted", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      providerMintsShort: true,
      providerBaseUrl: BASE_URL,
      acceptedMints: ["https://mint.accepted.example"],
      required: 100,
      available: 20,
      maxMintBalance: 5,
      maxMintUrl: "https://mint.accepted.example",
      message: "No funded mint accepted by provider",
    });

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toMatchObject({
      name: "ProviderMintBalanceError",
      required: 100,
      available: 20,
      maxMintBalance: 5,
      maxMintUrl: "https://mint.accepted.example",
      acceptedMints: ["https://mint.accepted.example"],
    });
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("parses decimal balances and the largest-mint hint for a true wallet 402", async () => {
    const { client, providerManager } = createClient();
    const balanceManager = client.getBalanceManager();
    vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
      amount: 20_000,
      reserved: 0,
      unit: "msat",
      apiKey: API_KEY,
    });
    vi.spyOn(balanceManager, "topUp").mockResolvedValue({
      success: false,
      message:
        "Insufficient balance: need 100.5 sats, have 20.25 sats available. Largest mint balance: 15.75 sats from https://mint.small.example",
    });

    await expect(
      handle402(client, localInsufficientBalanceBody)
    ).rejects.toMatchObject({
      name: "InsufficientBalanceError",
      required: 100.5,
      available: 20.25,
      maxMintBalance: 15.75,
      maxMintUrl: "https://mint.small.example",
    });
    expect(providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("continues automatic path failover past an unfundable candidate", async () => {
    const { client, providerManager } = createClient();
    const next = "https://next.example/";
    const last = "https://last.example/";
    providerManager.getModelPathProviderRanking = vi.fn()
      .mockResolvedValueOnce([{baseUrl: next, selector: "next-path", satsPricing: null, model}])
      .mockResolvedValueOnce([{baseUrl: last, selector: "last-path", satsPricing: {prompt: 2, completion: 3}, model}]);
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 20_000, reserved: 0, unit: "msat", apiKey: API_KEY,
    });
    vi.spyOn(client.getBalanceManager(), "topUp").mockResolvedValue({
      success: false, providerMintsShort: true, required: 100,
      acceptedMints: [MINT_URL], providerBaseUrl: BASE_URL,
    });
    vi.spyOn(client as any, "_spendToken").mockImplementation(async ({baseUrl}: any) => {
      if (baseUrl === next) {
        const {ProviderMintBalanceError} = await import("../../core/errors");
        throw new ProviderMintBalanceError(100, 500, next, [MINT_URL]);
      }
      return {token: "last-key", tokenBalance: 100, tokenBalanceUnit: "sat"};
    });
    const request = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(Response.json({ok: true}));
    const response = await (client as any)._handleErrorResponse({
      ...params,
      baseHeaders: {"x-routstr-model-path": "old-path"},
      autoModelPath: {selector: "old-path"},
    }, API_KEY, 402, "req-402", undefined, localInsufficientBalanceBody, 0);
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: last, baseHeaders: {"x-routstr-model-path": "last-path"},
      autoModelPath: {selector: "last-path", satsPricing: {prompt: 2, completion: 3}},
    }));
    expect(providerManager.getModelPathProviderRanking.mock.calls[1][1].excludeBaseUrls.has(next)).toBe(true);
  });

});
