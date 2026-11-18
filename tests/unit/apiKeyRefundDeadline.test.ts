import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://first.example/";
const nextUrl = "https://second.example/";
const mintUrl = "https://mint.example/";
const token = "sk-original";
const model = { id: "test-model", name: "Test Model" } as Model;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const logger: SdkLogger = {
    log: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child() { return this; },
  };
  const receive = deferred<Awaited<ReturnType<WalletAdapter["receiveToken"]>>>();
  const receiveToken = vi.fn(() => receive.promise);
  const wallet = { getBalances: async () => ({}), receiveToken } as unknown as WalletAdapter;
  let cached: ReturnType<StorageAdapter["getCachedReceiveTokens"]> = [];
  const storage = {
    getApiKey: vi.fn(() => ({ baseUrl, key: token, balance: 17, lastUsed: null })),
    removeApiKey: vi.fn(),
    getCachedReceiveTokens: () => cached,
    setCachedReceiveTokens: (tokens: typeof cached) => { cached = tokens; },
  } as unknown as StorageAdapter;
  const client = new RoutstrClient(wallet, storage, {} as DiscoveryAdapter, "max", "apikeys", {
    logger,
    providerManager: {
      markFailed: vi.fn(),
      getFailedProviders: () => new Set([baseUrl]),
      findNextBestProvider: () => nextUrl,
      getModelForProvider: async () => model,
      getRequiredSatsForModel: () => 10,
    } as any,
  });
  const manager = client.getBalanceManager();
  const balance = { amount: 17_000, reserved: 0, unit: "msat" as const, apiKey: token, readSeq: 1 };
  const readBalance = vi.spyOn(manager, "getTokenBalance").mockResolvedValue(balance);
  const fetchRefundToken = vi.spyOn(manager, "fetchRefundToken").mockResolvedValue({ success: true, token: "cashu-refund" });
  const spend = vi.spyOn(client as any, "_spendToken").mockResolvedValue({ token: "sk-next", tokenBalance: 10, tokenBalanceUnit: "sat" });
  const dispatch = vi.spyOn(client as any, "_makeRequest").mockResolvedValue(new Response("ok"));
  const handleError = (status: number, signal?: AbortSignal) => client["_handleErrorResponse"]({
    baseUrl, mintUrl, token, signal, selectedModel: model, requiredSats: 10,
    headers: {}, baseHeaders: {}, method: "POST", path: "/v1/messages",
  }, token, status);
  return { manager, balance, readBalance, fetchRefundToken, receiveToken, receive, storage, spend, dispatch, handleError };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const received = { success: true, amount: 17, unit: "sat" as const };

describe("API-key request refund deadline", () => {
  it("shares one budget between the 401 balance check and an already-started refund", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const balance = deferred<typeof ctx.balance>();
    ctx.readBalance.mockImplementationOnce(() => balance.promise);
    const pending = ctx.handleError(401);
    await vi.advanceTimersByTimeAsync(9_000);
    balance.resolve(ctx.balance);
    await vi.advanceTimersByTimeAsync(999);
    expect(ctx.receiveToken).toHaveBeenCalledOnce();
    expect(ctx.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.dispatch).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(ctx.storage.removeApiKey).not.toHaveBeenCalled();
    await expect(ctx.manager.topUp({ mintUrl, baseUrl, amount: 10 })).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("refund in progress"),
    });
    ctx.receive.resolve(received);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.storage.removeApiKey).toHaveBeenCalledWith(baseUrl);
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it.each([401, 429])("fails over without starting a refund when the %i balance check stalls", async status => {
    vi.useFakeTimers();
    const ctx = setup();
    const balance = deferred<typeof ctx.balance>();
    ctx.readBalance.mockImplementation(() => balance.promise);
    const pending = ctx.handleError(status);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.dispatch).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ status: 200 });
    balance.resolve(ctx.balance);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.fetchRefundToken).not.toHaveBeenCalled();
  });

  it("stops routing on abort while leaving the started refund to settle", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const controller = new AbortController();
    const pending = ctx.handleError(429, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.receiveToken).toHaveBeenCalledOnce();
    const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.spend).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
    await aborted;
    ctx.receive.resolve(received);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.storage.removeApiKey).toHaveBeenCalledWith(baseUrl);
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("keeps a replacement key when the refund settles after the deadline", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const pending = ctx.handleError(429);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.dispatch).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ status: 200 });
    vi.mocked(ctx.storage.getApiKey).mockReturnValue({ baseUrl, key: "sk-replacement", balance: 10, lastUsed: null });
    ctx.receive.resolve(received);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.storage.removeApiKey).not.toHaveBeenCalled();
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("does not delete a replacement key after the original fails the 401 balance check", async () => {
    const ctx = setup();
    vi.mocked(ctx.storage.getApiKey).mockReturnValue({ baseUrl, key: "sk-replacement", balance: 10, lastUsed: null });
    ctx.readBalance.mockResolvedValueOnce({ ...ctx.balance, isInvalidApiKey: true });
    await expect(ctx.handleError(401)).resolves.toMatchObject({ status: 200 });
    expect(ctx.storage.removeApiKey).not.toHaveBeenCalled();
    expect(ctx.fetchRefundToken).not.toHaveBeenCalled();
  });

  it("does not start a refund when the caller aborts during the 401 balance check", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const controller = new AbortController();
    const balance = deferred<typeof ctx.balance>();
    ctx.readBalance.mockImplementation(() => balance.promise);
    const pending = ctx.handleError(401, controller.signal);
    const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.spend).not.toHaveBeenCalled();
    await aborted;
    balance.resolve(ctx.balance);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.fetchRefundToken).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });
});
