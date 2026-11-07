import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient, type RoutstrResponse } from "../../client/RoutstrClient";
import { FailoverError, InsufficientBalanceError } from "../../core/errors";
import { routeRequests } from "../../routeRequests";
import * as requestContext from "../../client/resolveRequestContext";
import type { Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://reserved-wait.example/";
const MINT_URL = "https://mint.example/";
const API_KEY = "sk-reserved-wait";
const REQUIRED_SATS = 100;
const model = {
  id: "reserved-wait-model",
  name: "Reserved wait model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: REQUIRED_SATS },
} as Model;
const insufficientBody = JSON.stringify({
  detail: { error: {
    message: "Insufficient balance: 100 sats required; 20 sats available.",
    type: "insufficient_quota",
    code: "insufficient_balance",
  } },
});
const fundingFailure = {
  success: false,
  message: "Insufficient balance: need 112 sats, have 30 sats available.",
};

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
  getApiKey: () => ({ key: API_KEY, baseUrl: BASE_URL, balance: 0, lastUsed: null }),
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
  getRoutstr21Models: () => [],
  setRoutstr21Models: () => {},
  getRoutstr21ModelsLastUpdate: () => null,
  setRoutstr21ModelsLastUpdate: () => {},
});

type Balance = {
  amount: number;
  reserved: number;
  unit: string;
  apiKey: string;
  balanceUnknown?: boolean;
  isInvalidApiKey?: boolean;
};
type RequestOverrides = {
  baseUrl?: string;
  signal?: AbortSignal;
  reservedBalanceWaitMs?: number;
};

// Yield through the real event loop without advancing the reservation deadline.
// All I/O in this suite is mocked; this drains the SSE inspector/accounting too.
async function flush() {
  for (let i = 0; i < 4; i++) await setImmediate();
}

function observe<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void promise.then(
    (value) => { outcome.settled = true; outcome.value = value; },
    (error) => { outcome.settled = true; outcome.error = error; },
  );
  return outcome;
}

describe("reserved-balance inference waits", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let balance: Balance;
  let controllers: AbortController[];
  let requests: Promise<RoutstrResponse>[];
  let responses: RoutstrResponse[];
  let closeStreams: (() => void)[];

  beforeEach(() => {
    balance = { amount: 20, reserved: 450, unit: "sat", apiKey: API_KEY };
    controllers = [];
    requests = [];
    responses = [];
    closeStreams = [];
    fetchMock = vi.fn(async () => Response.json({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    // A failed assertion must not leave module-level holds behind for later tests.
    controllers.forEach((controller) => controller.abort());
    closeStreams.forEach((close) => close());
    await Promise.allSettled(requests);
    await Promise.allSettled(responses.map(async (response) => {
      if (!response.bodyUsed && !response.body?.locked) await response.text();
      await response.finalize?.();
    }));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createClient(token = API_KEY) {
    // Deliberately allocate a different wallet for every client. Inference
    // reservations belong to the provider/key, not to the wallet that funds it.
    const wallet = createWallet();
    const providerManager = {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set([BASE_URL]),
      findNextBestProvider: vi.fn(() => null),
      getModelForProvider: vi.fn(async () => model),
      getRequiredSatsForModel: vi.fn(() => REQUIRED_SATS),
      recordSuccess: vi.fn(),
    } as any;
    const client = new RoutstrClient(wallet, createStorage(), createDiscovery(), "ERROR", "apikeys", { providerManager });
    vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_spendToken").mockResolvedValue({
      token, tokenBalance: 20, tokenBalanceUnit: "sat",
    });
    const accounting = vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
    const manager = client.getBalanceManager();
    const getBalance = vi.spyOn(manager, "getTokenBalance").mockImplementation(async () => ({ ...balance, apiKey: token }));
    const ensureBalance = vi.spyOn(manager, "ensureBalance").mockResolvedValue(fundingFailure);
    return { client, wallet, providerManager, getBalance, ensureBalance, accounting };
  }

  function route(client: RoutstrClient, overrides: RequestOverrides = {}) {
    const controller = new AbortController();
    controllers.push(controller);
    const request = {
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, messages: [] },
      modelId: model.id,
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      signal: controller.signal,
      ...overrides,
    };
    const pending = client.routeRequest(request).then((response) => {
      responses.push(response);
      return response;
    });
    requests.push(pending);
    // Several tests inspect a pending request before awaiting its rejection.
    void pending.catch(() => {});
    return pending;
  }

  async function openHold(options: { baseUrl?: string; token?: string } = {}) {
    const fixture = createClient(options.token);
    let close!: () => void;
    let closed = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        close = () => {
          if (closed) return;
          closed = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
    });
    closeStreams.push(close);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const response = await route(fixture.client, { baseUrl: options.baseUrl ?? BASE_URL });
    return {
      ...fixture,
      response,
      close,
      async settle() {
        close();
        await response.text();
        await response.finalize?.();
        await flush();
      },
    };
  }

  function rejectNextRequest(onFetch?: () => void) {
    fetchMock.mockImplementationOnce(async () => {
      onFetch?.();
      return new Response(insufficientBody, { status: 402 });
    });
  }

  it("fails immediately when no inference request of ours holds the key", async () => {
    const waiter = createClient();
    rejectNextRequest();
    await expect(route(waiter.client)).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(waiter.providerManager.markFailed).not.toHaveBeenCalled();
  });

  it("coordinates normalized provider/key holds across different wallet adapters, after attempting funding", async () => {
    balance = { ...balance, amount: 20_000, reserved: 450_000, unit: "msat" };
    const hold = await openHold({ baseUrl: `${BASE_URL}//` });
    const waiter = createClient();
    expect(waiter.wallet).not.toBe(hold.wallet);
    rejectNextRequest();
    const result = observe(route(waiter.client, { baseUrl: BASE_URL.replace(/\/+$/, "") }));
    await flush();
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
    expect(result.settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    balance.amount = 100_000;
    balance.reserved = 0;
    await hold.settle();
    expect(result.value?.status).toBe(200);
    expect(waiter.getBalance).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-reads after more than three sequential settlements and never retries on gross balance alone", async () => {
    const holds = [];
    for (let i = 0; i < 4; i++) holds.push(await openHold());
    const waiter = createClient();
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
    const readsBeforeSettlement = waiter.getBalance.mock.calls.length;

    for (let i = 0; i < holds.length; i++) {
      balance.amount = 40 + i * 20;
      balance.reserved = (3 - i) * 100;
      await holds[i].settle();
      expect(waiter.getBalance).toHaveBeenCalledTimes(readsBeforeSettlement + i + 1);
      if (i < 3) {
        expect(result.settled).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(5);
      }
    }
    expect(result.value?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
  });

  it("stops waiting when actual charges leave gross funds insufficient, even with another hold open", async () => {
    const first = await openHold();
    const second = await openHold();
    const waiter = createClient();
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();
    expect(result.settled).toBe(false);

    // The first request consumed most of its reservation, rather than refunding
    // it. The remaining request cannot release enough money to cover admission.
    balance.amount = 30;
    balance.reserved = 40;
    await first.settle();
    expect(result.error).toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(second.accounting).not.toHaveBeenCalled();
    await second.settle();
  });

  it("does not retry on a stale reserved balance when the last tracked hold has settled", async () => {
    const hold = await openHold();
    const waiter = createClient();
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();
    expect(result.settled).toBe(false);

    // The balance endpoint can lag settlement. No remaining local hold can
    // wake this request, and gross coverage alone must not replay inference.
    await hold.settle();
    expect(result.error).toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not miss a hold settling during the fresh balance read", async () => {
    const hold = await openHold();
    const waiter = createClient();
    let finishRead!: (value: Balance) => void;
    waiter.getBalance
      .mockResolvedValueOnce({ ...balance })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();
    expect(waiter.getBalance).toHaveBeenCalledTimes(2);
    expect(result.settled).toBe(false);

    balance.amount = REQUIRED_SATS;
    balance.reserved = 0;
    await hold.settle();
    finishRead({ ...balance, amount: 20, reserved: 450 });
    await flush();
    expect(result.value?.status).toBe(200);
    expect(waiter.getBalance).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["unknown", { balanceUnknown: true }],
    ["invalid", { isInvalidApiKey: true }],
    ["non-finite", { amount: Number.NaN }],
  ])("does not retry using a fresh balance that is %s after settlement", async (_label, invalidBalance) => {
    const hold = await openHold();
    const waiter = createClient();
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();
    expect(result.settled).toBe(false);
    Object.assign(balance, { amount: 100, reserved: 0 }, invalidBalance);
    await hold.settle();
    expect(result.error).toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the default 120-second budget and falls through to the existing insufficient-balance error", async () => {
    vi.useFakeTimers();
    const hold = await openHold();
    const waiter = createClient();
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(119_999);
    await flush();
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(result.error).toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A wait deadline belongs to the waiter, not to the inference holding funds.
    expect(hold.accounting).not.toHaveBeenCalled();
    await hold.settle();
  });

  it("uses ordinary provider failover when the reservation wait expires", async () => {
    vi.useFakeTimers();
    const hold = await openHold();
    const waiter = createClient();
    const nextProvider = "https://fallback-provider.example/";
    waiter.providerManager.findNextBestProvider.mockReturnValue(nextProvider);
    rejectNextRequest();
    const result = observe(route(waiter.client, { reservedBalanceWaitMs: 25 }));
    await flush();
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await flush();
    expect(result.value?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("fallback-provider.example");
    expect(waiter.providerManager.markFailed).not.toHaveBeenCalled();
    await hold.settle();
  });

  it("bounds a stalled fresh balance read by the same reservation deadline", async () => {
    vi.useFakeTimers();
    const hold = await openHold();
    const waiter = createClient();
    waiter.getBalance
      .mockResolvedValueOnce({ ...balance })
      .mockImplementationOnce(() => new Promise(() => {}));
    rejectNextRequest();
    const result = observe(route(waiter.client, { reservedBalanceWaitMs: 25 }));
    await flush();
    expect(waiter.getBalance).toHaveBeenCalledTimes(2);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await flush();
    expect(result.error).toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await hold.settle();
  });

  it("disables waiting with a zero budget without skipping the normal funding attempt", async () => {
    const hold = await openHold();
    const waiter = createClient();
    rejectNextRequest();
    await expect(route(waiter.client, { reservedBalanceWaitMs: 0 })).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await hold.settle();
  });

  it("aborts a waiter with AbortError without releasing or cancelling another request's hold", async () => {
    const hold = await openHold();
    const waiter = createClient();
    const controller = new AbortController();
    controllers.push(controller);
    rejectNextRequest();
    const pending = route(waiter.client, { signal: controller.signal });
    const result = observe(pending);
    await flush();
    expect(result.settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hold.accounting).not.toHaveBeenCalled();
    await hold.settle();
  });

  it.each([
    ["token", { token: "sk-different-key" }],
    ["provider", { baseUrl: "https://different-provider.example/" }],
  ])("does not wait on an unrelated %s", async (_label, otherKey) => {
    const hold = await openHold(otherKey);
    const waiter = createClient();
    rejectNextRequest();
    await expect(route(waiter.client)).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await hold.settle();
  });

  it("retries immediately when the wallet can fund, even while the same key has an open hold", async () => {
    const hold = await openHold();
    const waiter = createClient();
    waiter.ensureBalance.mockResolvedValue({ success: true, toppedUpAmount: 112, message: "funded" });
    rejectNextRequest();
    const response = await route(waiter.client);
    expect(response.status).toBe(200);
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hold.accounting).not.toHaveBeenCalled();
    await hold.settle();
  });

  it("preserves provider-mint-shortfall failover instead of waiting for inference reservations", async () => {
    const hold = await openHold();
    const waiter = createClient();
    waiter.ensureBalance.mockResolvedValue({
      success: false,
      providerMintsShort: true,
      required: 100,
      available: 30,
      providerBaseUrl: BASE_URL,
      acceptedMints: [MINT_URL],
      message: fundingFailure.message,
    });
    rejectNextRequest();
    await expect(route(waiter.client)).rejects.toMatchObject({ name: "ProviderMintBalanceError" });
    expect(waiter.providerManager.findNextBestProvider).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hold.accounting).not.toHaveBeenCalled();
    await hold.settle();
  });

  it("does not consume provider retries when other requests reserve funds again before admission", async () => {
    const holds = [];
    for (let i = 0; i < 4; i++) holds.push(await openHold());
    const waiter = createClient();
    const makeRequest = vi.spyOn(waiter.client as any, "_makeRequest");
    rejectNextRequest();
    const result = observe(route(waiter.client));
    await flush();

    for (let i = 0; i < holds.length; i++) {
      if (i < holds.length - 1) {
        // Another admission wins the race after our sufficient balance read.
        rejectNextRequest(() => {
          balance.amount = 20;
          balance.reserved = (3 - i) * 150;
        });
      }
      balance.amount = REQUIRED_SATS;
      balance.reserved = (3 - i) * 150;
      await holds[i].settle();
      if (i < holds.length - 1) {
        expect(result.settled).toBe(false);
        expect(waiter.ensureBalance).toHaveBeenCalledTimes(i + 2);
      }
    }
    expect(result.value?.status).toBe(200);
    expect(makeRequest).toHaveBeenCalledTimes(5);
    expect(makeRequest.mock.calls.map(([request]) => request.retryCount ?? 0)).toEqual([0, 0, 0, 0, 0]);
  });

  it("retries when the last hold settles during failed funding before reservation waiting begins", async () => {
    const hold = await openHold();
    const waiter = createClient();
    const makeRequest = vi.spyOn(waiter.client as any, "_makeRequest");
    waiter.ensureBalance.mockImplementationOnce(async () => {
      // Funding can take long enough for inference to finish. By the time it
      // fails there are no live holds, but this request observed the settlement.
      balance.amount = REQUIRED_SATS;
      balance.reserved = 0;
      await hold.settle();
      return fundingFailure;
    });
    rejectNextRequest();

    const response = await route(waiter.client);
    expect(response.status).toBe(200);
    expect(hold.accounting).toHaveBeenCalledOnce();
    expect(waiter.ensureBalance).toHaveBeenCalledOnce();
    expect(waiter.getBalance).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(makeRequest.mock.calls.map(([request]) => request.retryCount ?? 0)).toEqual([0, 0]);
  });

  it("retains the ordinary retry cap when fresh reads become sufficient without any hold settling", async () => {
    const hold = await openHold();
    const waiter = createClient();
    const makeRequest = vi.spyOn(waiter.client as any, "_makeRequest");
    let reads = 0;
    waiter.getBalance.mockImplementation(async () => ({
      ...balance,
      // Each 402 validation sees a shortfall; the helper's immediate fresh
      // read then sees enough funds. No inference settlement earned a retry.
      amount: ++reads % 2 === 1 ? 20 : REQUIRED_SATS,
    }));
    for (let i = 0; i < 3; i++) rejectNextRequest();

    const result = observe(route(waiter.client));
    await flush();
    expect(result.error).toBeInstanceOf(FailoverError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // One holder + three waiter attempts.
    expect(makeRequest).toHaveBeenCalledTimes(3);
    expect(makeRequest.mock.calls.map(([request]) => request.retryCount ?? 0)).toEqual([0, 1, 2]);
    expect(waiter.ensureBalance).toHaveBeenCalledTimes(3);
    expect(waiter.getBalance).toHaveBeenCalledTimes(6);
    expect(hold.accounting).not.toHaveBeenCalled();
    await hold.settle();
  });

  it.each([0, 37, undefined])("forwards reservedBalanceWaitMs=%s through routeRequests", async (reservedBalanceWaitMs) => {
    const fixture = createClient();
    const response = Response.json({ choices: [] }) as RoutstrResponse;
    const routeRequest = vi.spyOn(fixture.client, "routeRequest").mockResolvedValue(response);
    vi.spyOn(requestContext, "resolveRequestContext").mockResolvedValue({
      client: fixture.client,
      baseUrl: BASE_URL,
      mintUrl: MINT_URL,
      selectedModel: model,
      requestedModelId: model.id,
    });

    const result = await routeRequests({
      modelId: model.id,
      requestBody: { messages: [] },
      walletAdapter: fixture.wallet,
      storageAdapter: createStorage(),
      discoveryAdapter: createDiscovery(),
      trackLifecycle: false,
      reservedBalanceWaitMs,
    });
    responses.push(result);
    expect(result).toBe(response);
    expect(routeRequest).toHaveBeenCalledOnce();
    expect(routeRequest).toHaveBeenCalledWith(expect.objectContaining({ reservedBalanceWaitMs }));
  });

  it("keeps one absolute deadline across multiple reservation retry races", async () => {
    vi.useFakeTimers();
    const first = await openHold();
    const second = await openHold();
    const third = await openHold();
    const waiter = createClient();
    rejectNextRequest();
    const result = observe(route(waiter.client, { reservedBalanceWaitMs: 100 }));
    await flush();
    expect(result.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(40);
    rejectNextRequest(() => { balance.amount = 20; balance.reserved = 450; });
    balance.amount = REQUIRED_SATS;
    balance.reserved = 450;
    await first.settle();
    expect(waiter.ensureBalance).toHaveBeenCalledTimes(2);
    expect(result.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(30);
    rejectNextRequest(() => { balance.amount = 20; balance.reserved = 450; });
    balance.amount = REQUIRED_SATS;
    await second.settle();
    expect(waiter.ensureBalance).toHaveBeenCalledTimes(3);
    expect(result.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(29);
    await flush();
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(result.error).toBeInstanceOf(InsufficientBalanceError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(third.accounting).not.toHaveBeenCalled();
    await third.settle();
  });
});
