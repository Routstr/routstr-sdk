import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { noopLogger } from "../../core/types";
import {
  createDiscoveryAdapterFromStore,
  createMemoryDriver,
  createSdkStore,
  createStorageAdapterFromStore,
} from "../../storage";
import type { WalletAdapter } from "../../wallet/interfaces";

const BASE_URL = "https://provider.example/";
const MINT_URL = "https://mint.example";
const TOKEN = "cashu-unspent";
const RETRY_INTERVAL_MS = 2 * 60 * 1000;
const request = {
  path: "/v1/chat/completions", method: "POST", body: { messages: [] },
  baseUrl: BASE_URL, mintUrl: MINT_URL, failover: false,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(mode: "apikeys" | "xcashu" = "apikeys") {
  const driver = createMemoryDriver();
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  const discovery = createDiscoveryAdapterFromStore(store);
  discovery.setCachedMints({ [BASE_URL]: [MINT_URL] });
  const receiveToken = vi.fn<WalletAdapter["receiveToken"]>().mockResolvedValue({
    success: false, amount: 0, unit: "sat", message: "Mint unavailable",
  });
  const wallet: WalletAdapter = {
    getBalances: async () => ({ [MINT_URL]: 100 }),
    getMintUnits: () => ({ [MINT_URL]: "sat" }),
    getActiveMintUrl: () => MINT_URL,
    sendToken: async (_mint, _amount, _pubkey, persist) => {
      await persist?.(TOKEN);
      return TOKEN;
    },
    receiveToken,
  };
  const client = new RoutstrClient(wallet, storage, discovery, "min", mode, { logger: noopLogger });
  const manager = client.getBalanceManager();
  const spender = client.getCashuSpender();
  const balanceQuery = vi.spyOn(manager, "getTokenBalance").mockResolvedValue({
    amount: 7, reserved: 0, unit: "sat",
  });
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ detail: "Refund not found" }, { status: 404 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return { driver, storage, wallet, receiveToken, client, manager, spender, balanceQuery, fetchMock };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cashu refund recovery", () => {
  it("recovers a saved failed top-up token when the provider has no refund", async () => {
    const f = await fixture();
    f.storage.setApiKey(BASE_URL, "sk-funded");
    f.fetchMock.mockRejectedValueOnce(new Error("Provider unreachable"));
    const topUp = await f.manager.topUp({
      baseUrl: BASE_URL, mintUrl: MINT_URL, amount: 7,
    });
    expect(topUp.success).toBe(false);
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toMatchObject([{ token: TOKEN }]);

    f.receiveToken.mockClear().mockResolvedValue({ success: true, amount: 7, unit: "sat" });
    f.fetchMock.mockClear();
    vi.useFakeTimers();
    const results = await f.spender.refundXcashuTokens(MINT_URL);
    expect(results).toEqual([{ baseUrl: BASE_URL, token: TOKEN, success: true }]);
    expect(f.fetchMock).toHaveBeenCalledWith(`${BASE_URL}v1/wallet/refund`, expect.objectContaining({
      headers: expect.objectContaining({ "X-Cashu": TOKEN }),
    }));
    expect(f.receiveToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
    await f.storage.flush?.();
    const reloaded = createSdkStore({ driver: f.driver });
    await reloaded.hydrate;
    expect(createStorageAdapterFromStore(reloaded.store).getXcashuTokensForBaseUrl(BASE_URL)).toEqual([]);
  });

  it.each(["returns false", "throws"])("preserves the original after automatic retries when receiving %s", async (failure) => {
    const f = await fixture();
    if (failure === "throws") f.receiveToken.mockRejectedValue(new Error("Mint unavailable"));
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    vi.useFakeTimers();

    await f.spender.refundXcashuTokens(MINT_URL);
    await vi.advanceTimersByTimeAsync(4 * RETRY_INTERVAL_MS);
    await f.storage.flush?.();
    const reloaded = createSdkStore({ driver: f.driver });
    await reloaded.hydrate;
    expect(createStorageAdapterFromStore(reloaded.store).getXcashuTokensForBaseUrl(BASE_URL)).toMatchObject([
      { token: TOKEN, tryCount: 3 },
    ]);
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    expect(f.receiveToken).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    f.receiveToken.mockResolvedValue({ success: true, amount: 7, unit: "sat" });
    await expect(f.spender.refundXcashuTokens(MINT_URL)).resolves.toEqual([
      { baseUrl: BASE_URL, token: TOKEN, success: true },
    ]);
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toEqual([]);
  });

  it("skips exhausted tokens while another refund remains pending, but permits manual recovery", async () => {
    const f = await fixture();
    const pendingToken = "cashu-pending";
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    f.storage.updateXcashuTokenTryCount(TOKEN, 2);
    f.storage.addXcashuToken(BASE_URL, pendingToken);
    vi.useFakeTimers();
    await f.spender.refundXcashuTokens(MINT_URL);

    f.fetchMock.mockClear().mockImplementation(async (_url, init) => {
      const pending = new Headers(init?.headers).get("X-Cashu") === pendingToken;
      return Response.json({ detail: pending ? "Refund is pending" : "Refund not found" }, {
        status: pending ? 425 : 404,
      });
    });
    f.receiveToken.mockClear();
    await vi.advanceTimersByTimeAsync(3 * RETRY_INTERVAL_MS);
    expect(f.fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Cashu"))).toEqual([
      pendingToken, pendingToken, pendingToken,
    ]);
    expect(f.receiveToken).not.toHaveBeenCalled();
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toMatchObject([
      { token: TOKEN, tryCount: 3 }, { token: pendingToken, tryCount: 1 },
    ]);

    f.receiveToken.mockResolvedValue({ success: true, amount: 7, unit: "sat" });
    expect(await f.spender.refundXcashuTokens(MINT_URL)).toMatchObject([
      { token: TOKEN, success: true }, { token: pendingToken, success: false },
    ]);
    expect(f.receiveToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toMatchObject([{ token: pendingToken }]);
  });

  it.each(["topup", "apikeys", "xcashu"] as const)("does not reclaim a live %s token while its send is finishing", async (operation) => {
    const f = await fixture(operation === "xcashu" ? "xcashu" : "apikeys");
    const persisted = deferred();
    const finishSend = deferred();
    f.wallet.sendToken = async (_mint, _amount, _pubkey, persist) => {
      await persist?.(TOKEN);
      persisted.resolve();
      await finishSend.promise;
      return TOKEN;
    };
    f.receiveToken.mockResolvedValue({ success: true, amount: 7, unit: "sat" });
    f.fetchMock.mockImplementation(async (url) => url.endsWith("/refund")
      ? Response.json({ detail: "Refund not found" }, { status: 404 })
      : Response.json({ choices: [] }));
    if (operation === "topup") f.storage.setApiKey(BASE_URL, "sk-funded");
    vi.useFakeTimers();
    const payment = operation === "topup"
      ? f.manager.topUp({ baseUrl: BASE_URL, mintUrl: MINT_URL, amount: 7 })
      : f.client.routeRequest(request);
    await persisted.promise;
    await f.spender.refundXcashuTokens(MINT_URL);
    const pending = f.storage.getXcashuTokensForBaseUrl(BASE_URL);
    finishSend.resolve();
    expect(await payment).toMatchObject(operation === "topup" ? { success: true } : { status: 200 });
    expect(f.receiveToken).not.toHaveBeenCalled();
    expect(pending).toMatchObject([{ token: TOKEN, tryCount: 0 }]);
  });

  it("leaves the original alone when a bootstrap request starts during the refund lookup", async () => {
    const f = await fixture();
    const refundStarted = deferred();
    const finishRefundLookup = deferred();
    const requestStarted = deferred();
    const finishValidation = deferred();
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    f.receiveToken.mockResolvedValue({ success: true, amount: 7, unit: "sat" });
    f.balanceQuery.mockImplementation(async () => {
      requestStarted.resolve();
      await finishValidation.promise;
      return { amount: 7, reserved: 0, unit: "sat" };
    });
    f.fetchMock.mockImplementation(async (url) => {
      if (!url.endsWith("/refund")) return Response.json({ choices: [] });
      refundStarted.resolve();
      await finishRefundLookup.promise;
      return Response.json({ detail: "Refund not found" }, { status: 404 });
    });
    vi.useFakeTimers();
    const sweep = f.spender.refundXcashuTokens(MINT_URL);
    await refundStarted.promise;
    const payment = f.client.routeRequest(request);
    await requestStarted.promise;
    finishRefundLookup.resolve();
    await sweep;
    const pending = f.storage.getXcashuTokensForBaseUrl(BASE_URL);
    finishValidation.resolve();
    await expect(payment).resolves.toMatchObject({ status: 200 });
    expect(f.receiveToken).not.toHaveBeenCalled();
    expect(pending).toMatchObject([{ token: TOKEN, tryCount: 0 }]);
  });

  it("uses fresh funds without adopting a bootstrap token being recovered", async () => {
    const f = await fixture();
    const receiveStarted = deferred();
    const finishReceive = deferred();
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    f.receiveToken.mockImplementation(async () => {
      receiveStarted.resolve();
      await finishReceive.promise;
      return { success: true, amount: 7, unit: "sat" };
    });
    const sendToken = vi.fn<WalletAdapter["sendToken"]>(async (_mint, _amount, _pubkey, persist) => {
      await persist?.("cashu-fresh");
      return "cashu-fresh";
    });
    f.wallet.sendToken = sendToken;
    f.fetchMock.mockImplementation(async (url) => url.endsWith("/refund")
      ? Response.json({ detail: "Refund not found" }, { status: 404 })
      : Response.json({ choices: [] }));
    vi.useFakeTimers();
    const sweep = f.spender.refundXcashuTokens(MINT_URL);
    await receiveStarted.promise;
    let settled = false;
    const payment = f.client.routeRequest(request).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const completedDuringRecovery = settled;
    const pendingDuringRecovery = f.storage.getXcashuTokensForBaseUrl(BASE_URL);
    const queriedOriginal = f.balanceQuery.mock.calls.some(([token]) => token === TOKEN);
    finishReceive.resolve();
    await sweep;
    await expect(payment).resolves.toMatchObject({ status: 200 });
    expect(completedDuringRecovery).toBe(true);
    expect(queriedOriginal).toBe(false);
    expect(pendingDuringRecovery).toMatchObject([{ token: TOKEN }]);
    expect(sendToken).toHaveBeenCalledTimes(1);
    expect(f.fetchMock).toHaveBeenCalledWith(`${BASE_URL}v1/chat/completions`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer cashu-fresh" }),
    }));
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toEqual([]);
  });

  it.each(["request", "topup", "create-token"])("allows an unrelated %s while recovery is pending", async (operation) => {
    const f = await fixture();
    const receiveStarted = deferred();
    const finishReceive = deferred();
    f.storage.setApiKey(BASE_URL, "sk-funded");
    f.storage.updateApiKeyBalance(BASE_URL, 100);
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    f.wallet.getBalances = async () => ({ [MINT_URL]: operation === "request" ? 0 : 100 });
    f.wallet.sendToken = async (_mint, _amount, _pubkey, persist) => {
      await persist?.("cashu-fresh");
      return "cashu-fresh";
    };
    f.receiveToken.mockImplementation(async () => {
      receiveStarted.resolve();
      await finishReceive.promise;
      return { success: true, amount: 7, unit: "sat" };
    });
    f.fetchMock.mockImplementation(async (url) => url.endsWith("/refund")
      ? Response.json({ error: { type: "token_consumed", code: "cashu_token_consumed", message: "Token consumed" } }, { status: 500 })
      : Response.json({ choices: [] }));
    vi.useFakeTimers();
    const sweep = f.spender.refundXcashuTokens(MINT_URL);
    await receiveStarted.promise;
    const options = { baseUrl: BASE_URL, mintUrl: MINT_URL, amount: 7 };
    let settled = false;
    const payment = (operation === "request" ? f.client.routeRequest(request)
      : operation === "topup" ? f.manager.topUp(options)
      : f.manager.createProviderToken(options)).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const completedDuringRecovery = settled;
    finishReceive.resolve();
    await sweep;
    expect(await payment).toMatchObject(operation === "request" ? { status: 200 } : { success: true });
    expect(completedDuringRecovery).toBe(true);
    expect(f.storage.getApiKey(BASE_URL)?.key).toBe("sk-funded");
    expect(f.receiveToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it.each(["request", "topup", "reuse"])("does not use a saved recovering key for %s", async (operation) => {
    const f = await fixture();
    const receiveStarted = deferred();
    const finishReceive = deferred();
    f.storage.setApiKey(BASE_URL, TOKEN);
    f.storage.updateApiKeyBalance(BASE_URL, 100);
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    f.wallet.getBalances = async () => ({ [MINT_URL]: 0 });
    f.receiveToken.mockImplementation(async () => {
      receiveStarted.resolve();
      await finishReceive.promise;
      return { success: false, amount: 0, unit: "sat", message: "Mint unavailable" };
    });
    f.fetchMock.mockImplementation(async (url) => url.endsWith("/refund")
      ? Response.json({ detail: "Refund not found" }, { status: 404 })
      : Response.json({ choices: [] }));
    vi.useFakeTimers();
    const sweep = f.spender.refundXcashuTokens(MINT_URL);
    await receiveStarted.promise;
    const options = { baseUrl: BASE_URL, mintUrl: MINT_URL, amount: 7, reuseToken: true };
    let result: unknown;
    const payment = (operation === "request" ? f.client.routeRequest(request)
      : operation === "topup" ? f.manager.topUp(options) : f.spender.spend(options))
      .then((value) => { result = value; }, (error) => { result = error; });
    await vi.advanceTimersByTimeAsync(0);
    const resultDuringRecovery = result;
    const queriesDuringRecovery = f.balanceQuery.mock.calls.length;
    const requestsDuringRecovery = f.fetchMock.mock.calls.filter(([url]) => !url.endsWith("/refund"));
    finishReceive.resolve();
    await sweep;
    await payment;
    if (operation === "topup") {
      expect(resultDuringRecovery).toMatchObject({ success: false, message: expect.stringContaining("recovery is in progress") });
    } else {
      expect(resultDuringRecovery).toBeInstanceOf(Error);
      expect((resultDuringRecovery as Error).message).toContain("recovery is in progress");
    }
    expect(queriesDuringRecovery).toBe(0);
    expect(requestsDuringRecovery).toEqual([]);
    expect(f.storage.getApiKey(BASE_URL)?.key).toBe(TOKEN);
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toMatchObject([{ token: TOKEN }]);
    f.balanceQuery.mockClear();
    await expect(f.client.routeRequest(request)).resolves.toMatchObject({ status: 200 });
    expect(f.balanceQuery).toHaveBeenCalledWith(TOKEN, BASE_URL);
  });

  it("retries a deferred orphan after the active payment finishes", async () => {
    const f = await fixture();
    const requestStarted = deferred();
    const finishRequest = deferred();
    f.storage.setApiKey(BASE_URL, "sk-funded");
    f.storage.updateApiKeyBalance(BASE_URL, 100);
    f.storage.addXcashuToken(BASE_URL, TOKEN);
    f.receiveToken.mockResolvedValue({ success: true, amount: 7, unit: "sat" });
    f.fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/refund")) return Response.json({ detail: "Refund not found" }, { status: 404 });
      requestStarted.resolve();
      await finishRequest.promise;
      return Response.json({ choices: [] });
    });
    vi.useFakeTimers();
    const payment = f.client.routeRequest(request);
    await requestStarted.promise;
    await f.spender.refundXcashuTokens(MINT_URL);
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toMatchObject([{ token: TOKEN, tryCount: 0 }]);
    expect(f.receiveToken).not.toHaveBeenCalled();
    finishRequest.resolve();
    await expect(payment).resolves.toMatchObject({ status: 200 });
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    expect(f.fetchMock.mock.calls.filter(([url]) => url.endsWith("/refund"))).toHaveLength(2);
    expect(f.receiveToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(f.storage.getXcashuTokensForBaseUrl(BASE_URL)).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
