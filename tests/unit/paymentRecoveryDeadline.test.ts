import { afterEach, describe, expect, it, vi } from "vitest";
import { CashuSpender } from "../../wallet/CashuSpender";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { WalletAdapter, StorageAdapter } from "../../wallet/interfaces";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  let cached: any[] = [];
  const late = gate<any>();
  const receiveToken = vi.fn(() => late.promise);
  const storage = {
    getCachedReceiveTokens: () => cached,
    setCachedReceiveTokens: (value: any[]) => { cached = value; },
    flush: vi.fn(async () => {}),
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
    const cleanup = vi.fn();
    const result = ctx.spender.receiveTokenForRecovery("cashu-test", undefined, cleanup);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ success: false, message: expect.stringContaining("timed out") });
    expect(ctx.storage.getCachedReceiveTokens()).toHaveLength(1);
    await ctx.spender.recoverCachedReceiveTokens();
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
    const retry = ctx.spender.receiveTokenForRecovery("cashu-test");
    ctx.late.resolve({ success: true, amount: 7, unit: "sat" });
    expect(await retry).toMatchObject({ success: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(ctx.storage.getCachedReceiveTokens()).toEqual([]);
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
  });

  it("stops awaiting on abort but observes late settlement", async () => {
    const ctx = setup();
    const controller = new AbortController();
    const cleanup = vi.fn();
    const result = ctx.spender.receiveTokenForRecovery("cashu-test", controller.signal, cleanup);
    await vi.waitFor(() => expect(ctx.receiveToken).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.storage.getCachedReceiveTokens()).toHaveLength(1);
    ctx.late.resolve({ success: true, amount: 7, unit: "sat" });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
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

  it("deduplicates while the recovery cache is being flushed", async () => {
    const ctx = setup();
    const flush = gate<void>();
    vi.mocked(ctx.storage.flush!).mockImplementationOnce(() => flush.promise);
    const first = ctx.spender.receiveTokenForRecovery("cashu-test");
    const second = ctx.spender.receiveTokenForRecovery("cashu-test");
    await Promise.resolve();
    expect(ctx.receiveToken).not.toHaveBeenCalled();
    flush.resolve();
    ctx.late.resolve({ success: true, amount: 7, unit: "sat" });
    await first; await second;
    expect(ctx.receiveToken).toHaveBeenCalledTimes(1);
  });

  it("preserves distinct refund proofs even when already aborted", async () => {
    const ctx = setup();
    const controller = new AbortController(); controller.abort();
    const client = Object.create(RoutstrClient.prototype);
    client.cashuSpender = ctx.spender;
    client.storageAdapter = ctx.storage;
    await expect(client._handleErrorResponse({ signal: controller.signal }, "original", 500, undefined, "cashu-refund")).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.storage.getCachedReceiveTokens()).toMatchObject([{ token: "cashu-refund" }]);
    expect(ctx.receiveToken).not.toHaveBeenCalled();
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
