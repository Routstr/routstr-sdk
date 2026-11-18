import { afterEach, describe, expect, it, vi } from "vitest";
import { CashuSpender } from "../../wallet/CashuSpender";
import { RoutstrClient } from "../../client/RoutstrClient";
import { createMemoryDriver, createSdkStore } from "../../storage";
import { createStorageAdapterFromStore } from "../../storage/store";
import type { RecoveryCredential, WalletAdapter, StorageAdapter } from "../../wallet/interfaces";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const baseUrl = "https://provider.example/";
const xcashu: RecoveryCredential = { mode: "xcashu", baseUrl, token: "cashu-original" };
const bootstrap: RecoveryCredential = { mode: "apikeys", baseUrl, token: "cashu-bootstrap" };
const success = { success: true, amount: 7, unit: "sat" as const };
const transient = { success: false, amount: 7, unit: "sat" as const, message: "mint unavailable" };

function setup() {
  let cached: any[] = [];
  const late = gate<any>();
  const receiveToken = vi.fn(() => late.promise);
  const storage = {
    getCachedReceiveTokens: () => cached,
    setCachedReceiveTokens: (value: any[]) => { cached = value; },
    flush: vi.fn(async () => {}),
    removeXcashuToken: vi.fn(),
  } as unknown as StorageAdapter;
  const wallet = { receiveToken } as unknown as WalletAdapter;
  const spender = new CashuSpender(wallet, storage);
  return { spender, storage, late, receiveToken };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("payment recovery foreground deadline", () => {
  it("bounds a hung receive, preserves its token, deduplicates retries and settles late", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const result = ctx.spender.receiveTokenForRecovery("cashu-test", undefined, xcashu);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ success: false, message: expect.stringContaining("timed out") });
    expect(ctx.storage.getCachedReceiveTokens()).toHaveLength(1);
    await ctx.spender.recoverCachedReceiveTokens();
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
    const retry = ctx.spender.receiveTokenForRecovery("cashu-test");
    ctx.late.resolve({ success: true, amount: 7, unit: "sat" });
    expect(await retry).toMatchObject({ success: true });
    expect(ctx.storage.removeXcashuToken).toHaveBeenCalledExactlyOnceWith(baseUrl, xcashu.token);
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
  });

  it("stops awaiting on abort but observes late settlement", async () => {
    const ctx = setup();
    const controller = new AbortController();
    const result = ctx.spender.receiveTokenForRecovery("cashu-test", controller.signal, xcashu);
    await vi.waitFor(() => expect(ctx.receiveToken).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.storage.getCachedReceiveTokens()).toHaveLength(1);
    ctx.late.resolve({ success: true, amount: 7, unit: "sat" });
    await vi.waitFor(() => expect(ctx.storage.removeXcashuToken).toHaveBeenCalledExactlyOnceWith(baseUrl, xcashu.token));
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("does not start recovery for an already aborted request", async () => {
    const ctx = setup();
    const controller = new AbortController(); controller.abort();
    await expect(ctx.spender.receiveTokenForRecovery("cashu-test", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.receiveToken).not.toHaveBeenCalled();
  });

  it("shares a receive already started by cached recovery", async () => {
    const ctx = setup();
    ctx.spender.cacheReceiveToken("cashu-test");
    const background = ctx.spender.recoverCachedReceiveTokens();
    const foreground = ctx.spender.receiveTokenForRecovery("cashu-test");
    await vi.waitFor(() => expect(ctx.receiveToken).toHaveBeenCalledTimes(1));
    ctx.late.resolve({ success: true, amount: 7, unit: "sat" });
    await background; await foreground;
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("keeps shared recovery alive when its first caller aborts during the flush", async () => {
    const ctx = setup();
    const flush = gate<void>();
    vi.mocked(ctx.storage.flush!).mockImplementationOnce(() => flush.promise);
    const controller = new AbortController();
    const first = ctx.spender.receiveTokenForRecovery("cashu-test", controller.signal);
    const second = ctx.spender.receiveTokenForRecovery("cashu-test");
    await Promise.resolve();
    expect(ctx.receiveToken).not.toHaveBeenCalled();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    flush.resolve();
    ctx.late.resolve(success);
    await expect(second).resolves.toMatchObject({ success: true });
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
  });

  it("preserves distinct refund proofs even when already aborted", async () => {
    const ctx = setup();
    const controller = new AbortController(); controller.abort();
    const flush = gate<void>();
    vi.mocked(ctx.storage.flush!).mockReturnValueOnce(flush.promise);
    const client = Object.create(RoutstrClient.prototype);
    client.mode = "xcashu";
    client.cashuSpender = ctx.spender;
    client.storageAdapter = ctx.storage;
    const params = { signal: controller.signal, baseUrl, token: xcashu.token };
    await expect(client._handleErrorResponse(params, xcashu.token, 500, undefined, "cashu-refund")).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.storage.getCachedReceiveTokens()).toMatchObject([{ token: "cashu-refund", cleanup: [xcashu] }]);
    expect(ctx.storage.flush).toHaveBeenCalledOnce();
    expect(ctx.receiveToken).not.toHaveBeenCalled();
    flush.resolve();
  });

  it.each(["cashu-refund", xcashu.token])("cleans up the original IOU when a cached retry succeeds after restart (%s)", async (refund) => {
    const driver = createMemoryDriver({});
    const initial = createSdkStore({ driver });
    await initial.hydrate;
    const storage = createStorageAdapterFromStore(initial.store);
    storage.addXcashuToken(baseUrl, xcashu.token);
    storage.addXcashuToken(baseUrl, "cashu-other");
    const receiveToken = vi.fn().mockResolvedValueOnce(transient).mockResolvedValueOnce(success);
    const wallet = { receiveToken } as unknown as WalletAdapter;
    const spender = new CashuSpender(wallet, storage);
    await expect(spender.receiveTokenForRecovery(refund, undefined, xcashu)).resolves.toEqual(transient);
    expect(storage.getCachedReceiveTokens()).toMatchObject([{ token: refund, cleanup: [xcashu] }]);

    const reloaded = createSdkStore({ driver });
    await reloaded.hydrate;
    const reloadedStorage = createStorageAdapterFromStore(reloaded.store);
    const restarted = new CashuSpender(wallet, reloadedStorage);
    await expect(restarted.recoverCachedReceiveTokens()).resolves.toEqual([{ token: refund, success: true }]);
    expect(reloadedStorage.getCachedReceiveTokens()).toEqual([]);
    await reloadedStorage.flush!();
    const settled = createSdkStore({ driver });
    await settled.hydrate;
    const settledStorage = createStorageAdapterFromStore(settled.store);
    expect(settledStorage.getCachedReceiveTokens()).toEqual([]);
    expect(settledStorage.getXcashuTokensForBaseUrl(baseUrl).map(entry => entry.token)).toEqual(["cashu-other"]);
  });

  it.each([false, true])("cleans up a recovered bootstrap only if it is current (replacement=%s)", async (replaced) => {
    const { store, hydrate } = createSdkStore({ driver: createMemoryDriver({}) });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(baseUrl, bootstrap.token);
    const receiveToken = vi.fn().mockResolvedValueOnce(transient).mockResolvedValueOnce(success);
    const spender = new CashuSpender({ receiveToken } as unknown as WalletAdapter, storage);
    await spender.receiveTokenForRecovery(bootstrap.token, undefined, bootstrap);
    if (replaced) {
      storage.removeApiKey(baseUrl);
      storage.setApiKey(baseUrl, "canonical-new");
    }
    await spender.recoverCachedReceiveTokens();
    expect(storage.getApiKey(baseUrl)?.key).toBe(replaced ? "canonical-new" : undefined);
    expect(storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("prunes conclusive malformed-token errors but retains ambiguous mint errors", async () => {
    const ctx = setup();
    ctx.receiveToken.mockResolvedValueOnce({ ...transient, message: "Invalid token" });
    await ctx.spender.receiveTokenForRecovery("cashu-invalid");
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
    ctx.receiveToken.mockResolvedValueOnce(transient);
    await ctx.spender.receiveTokenForRecovery("cashu-unknown");
    expect(ctx.storage.getCachedReceiveTokens()).toMatchObject([{ token: "cashu-unknown" }]);
    ctx.receiveToken.mockResolvedValueOnce({ ...transient, message: "Invalid token: missing proofs" });
    await ctx.spender.recoverCachedReceiveTokens();
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("error handling stops before funding or dispatch when aborted", async () => {
    const controller = new AbortController(); controller.abort();
    const spend = vi.fn();
    const dispatch = vi.fn();
    const client = Object.create(RoutstrClient.prototype);
    client._spendToken = spend;
    client._makeRequest = dispatch;
    await expect(client._handleErrorResponse({ signal: controller.signal }, "cashu-test", -1)).rejects.toMatchObject({ name: "AbortError" });
    expect(spend).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
