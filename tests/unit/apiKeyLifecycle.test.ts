import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { noopLogger as logger } from "../../core/types";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore, createDiscoveryAdapterFromStore } from "../../storage";
import type { WalletAdapter } from "../../wallet/interfaces";

const base = "https://provider.example/";
const mint = "https://mint.example";
const request = { path: "/v1/chat/completions", method: "POST", body: { messages: [] }, baseUrl: base, mintUrl: mint };

async function fixture() {
  const driver = createMemoryDriver();
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  const discovery = createDiscoveryAdapterFromStore(store);
  discovery.setCachedMints({ [base]: [mint] });
  const send = vi.fn<WalletAdapter["sendToken"]>(async (_mint, _amount, _pubkey, persist) => {
    await persist?.("cashu-fixture");
    return "cashu-fixture";
  });
  const wallet: WalletAdapter = {
    getBalances: async () => ({ [mint]: 100 }),
    getMintUnits: () => ({ [mint]: "sat" }),
    getActiveMintUrl: () => mint,
    sendToken: send,
    receiveToken: async () => ({ success: true, amount: 7, unit: "sat" }),
  };
  const makeClient = (adapter = storage) => {
    const client = new RoutstrClient(wallet, adapter, discovery, "min", "apikeys", { logger });
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({ amount: 7, reserved: 0, unit: "sat", apiKey: "canonical-fixture" });
    return client;
  };
  return { driver, storage, wallet, send, makeClient };
}

describe("direct provider key lifecycle", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("funds once, reuses credit, and reuses the saved credential after reload with an empty wallet", async () => {
    const f = await fixture();
    const auth: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      auth.push(new Headers(init.headers).get("authorization")!);
      return Response.json({ choices: [] });
    }));
    const client = f.makeClient();
    await client.routeRequest(request);
    await f.storage.flush?.();
    await client.routeRequest(request);
    const reloaded = createSdkStore({ driver: f.driver });
    await reloaded.hydrate;
    const storage = createStorageAdapterFromStore(reloaded.store);
    f.wallet.getBalances = async () => ({});
    await f.makeClient(storage).routeRequest(request);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(auth).toEqual(["Bearer cashu-fixture", "Bearer canonical-fixture", "Bearer canonical-fixture"]);
    expect(storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
  });

  it.each([true, false])("cleans up a losing bootstrap token only when recovery succeeds: %s", async (recovered) => {
    const f = await fixture();
    let sends = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    f.send.mockImplementation(async (_mint, _amount, _pubkey, persist) => {
      const token = `cashu-race-${++sends}`;
      if (sends === 2) release();
      await bothStarted;
      await persist?.(token);
      return token;
    });
    const receive = vi.fn<WalletAdapter["receiveToken"]>(async () => ({ success: recovered, amount: recovered ? 7 : 0, unit: "sat" }));
    f.wallet.receiveToken = receive;
    const client = f.makeClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockImplementation(async (token) => ({ amount: 7, reserved: 0, unit: "sat", apiKey: token }));
    const auth: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      auth.push(new Headers(init.headers).get("authorization")!);
      return Response.json({ choices: [] });
    }));

    await Promise.all([client.routeRequest(request), client.routeRequest(request)]);

    expect(f.send).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenCalledOnce();
    const losingToken = receive.mock.calls[0][0];
    const winningToken = f.storage.getApiKey(base)?.key;
    expect(winningToken).toMatch(/^cashu-race-[12]$/);
    expect(winningToken).not.toBe(losingToken);
    expect(auth).toEqual([`Bearer ${winningToken}`, `Bearer ${winningToken}`]);
    const reloaded = createSdkStore({ driver: f.driver });
    await reloaded.hydrate;
    const storage = createStorageAdapterFromStore(reloaded.store);
    expect(storage.getApiKey(base)?.key).toBe(winningToken);
    expect(storage.getXcashuTokensForBaseUrl(base).map((entry) => entry.token)).toEqual(recovered ? [] : [losingToken]);
  });

  it("does not dispatch while the credential write is pending", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { store, hydrate } = createSdkStore({ driver: { ...f.driver, setItem: async (key, value) => { await gate; await f.driver.setItem(key, value); } } });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(base, "saved-fixture");
    const network = vi.fn(async () => Response.json({ choices: [] }));
    vi.stubGlobal("fetch", network);
    const pending = f.makeClient(storage).routeRequest(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(network).not.toHaveBeenCalled();
    release();
    await pending;
    expect(network).toHaveBeenCalledOnce();
  });

  it("persists a top-up token before POST and clears it only after confirmed success", async () => {
    const f = await fixture();
    f.storage.setApiKey(base, "canonical-fixture");
    await f.storage.flush?.();
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(url).toBe(`${base}v1/wallet/topup`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ cashu_token: "cashu-fixture" });
      const loaded = createSdkStore({ driver: f.driver });
      await loaded.hydrate;
      expect(createStorageAdapterFromStore(loaded.store).getXcashuTokensForBaseUrl(base)).toHaveLength(1);
      return Response.json({ ok: true });
    }));
    const result = await f.makeClient().getBalanceManager().topUp({ baseUrl: base, mintUrl: mint, amount: 7 });
    expect(result.success).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
  });

  it("retains the top-up token when the response and wallet recovery both fail", async () => {
    const f = await fixture();
    f.storage.setApiKey(base, "canonical-fixture");
    await f.storage.flush?.();
    f.wallet.receiveToken = async () => ({ success: false, amount: 0, unit: "sat" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const result = await f.makeClient().getBalanceManager().topUp({ baseUrl: base, mintUrl: mint, amount: 7 });
    expect(result.success).toBe(false);
    expect(f.send).toHaveBeenCalledOnce();
    const loaded = createSdkStore({ driver: f.driver });
    await loaded.hydrate;
    expect(createStorageAdapterFromStore(loaded.store).getXcashuTokensForBaseUrl(base)).toHaveLength(1);
  });

  it.each(["accepted", "recovered", "already spent"])("preserves the %s top-up result when the cleanup write fails", async (outcome) => {
    const f = await fixture();
    f.storage.setApiKey(base, "canonical-fixture");
    await f.storage.flush?.();
    const write = f.driver.setItem.bind(f.driver);
    let failCleanup = false;
    vi.spyOn(f.driver, "setItem").mockImplementation(async (key, value) => {
      if (failCleanup && key === "xcashu_tokens") throw new Error("cleanup aborted");
      await write(key, value);
    });
    const receive = vi.fn<WalletAdapter["receiveToken"]>(async () => ({ success: outcome === "recovered", amount: 7, unit: "sat" }));
    f.wallet.receiveToken = receive;
    const error = outcome === "already spent"
      ? { type: "token_already_spent", code: "cashu_token_already_spent", message: "Cashu token already spent" }
      : { type: "mint_error", code: "cashu_token_swap_fees_exceed_amount", message: "Swap fees exceed amount" };
    const network = vi.fn(async () => {
      failCleanup = true;
      return Response.json({ error }, { status: outcome === "accepted" ? 200 : 400, headers: { "x-routstr-request-id": "topup-fixture" } });
    });
    vi.stubGlobal("fetch", network);
    const client = f.makeClient();
    const options = { baseUrl: base, mintUrl: mint, amount: 7 };

    const result = await client.getBalanceManager().topUp(options);

    expect(result).toMatchObject(outcome === "accepted"
      ? { success: true, toppedUpAmount: 7, requestId: "topup-fixture" }
      : { success: false, message: error.message, requestId: "topup-fixture", recoveredToken: outcome === "recovered", parsedError: error });
    expect(receive).toHaveBeenCalledTimes(outcome === "recovered" ? 1 : 0);
    expect(f.storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
    const loaded = createSdkStore({ driver: f.driver });
    await loaded.hydrate;
    const reloaded = createStorageAdapterFromStore(loaded.store);
    expect(reloaded.getApiKey(base)?.key).toBe("canonical-fixture");
    expect(reloaded.getXcashuTokensForBaseUrl(base).map((entry) => entry.token)).toEqual(["cashu-fixture"]);
    await expect(f.storage.flush?.()).rejects.toThrow("cleanup aborted");
    expect((await client.getBalanceManager().topUp(options)).success).toBe(false);
    await expect(client.routeRequest({ ...request, failover: false })).rejects.toThrow("cleanup aborted");
    expect(f.send).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledOnce();
  });

  it("records the provider-confirmed credit and reservation before the request is dispatched", async () => {
    const f = await fixture();
    const balanceAtDispatch: Array<{ balance?: number; reserved?: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const key = f.storage.getApiKey(base);
      balanceAtDispatch.push({ balance: key?.balance, reserved: key?.reserved });
      return Response.json({ choices: [] });
    }));
    const client = f.makeClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({ amount: 7000, reserved: 1500, unit: "msat", apiKey: "cashu-fixture" });
    await client.routeRequest(request);
    expect(balanceAtDispatch).toEqual([{ balance: 7, reserved: 1.5 }]);
  });

  it.each([false, true])("checks persistence before refunding another provider: failed=%s", async (failed) => {
    const f = await fixture();
    const other = "https://other-provider.example/";
    f.storage.setApiKey(other, "other-key");
    f.storage.updateApiKeyBalance(other, 7);
    await f.storage.flush?.();
    let walletBalance = 0;
    f.wallet.getBalances = async () => ({ [mint]: walletBalance });
    const receive = vi.fn<WalletAdapter["receiveToken"]>(async () => {
      walletBalance += 7;
      return { success: true, amount: 7, unit: "sat" };
    });
    f.wallet.receiveToken = receive;
    f.send.mockImplementation(async (_mint, amount, _pubkey, persist) => {
      await persist?.("cashu-fixture");
      walletBalance -= amount;
      return "cashu-fixture";
    });
    const network = vi.fn(async () => Response.json({ token: "cashu-refunded" }));
    vi.stubGlobal("fetch", network);
    if (failed) {
      vi.spyOn(f.driver, "setItem").mockRejectedValue(new Error("storage unavailable"));
      f.storage.addXcashuToken(base, "cashu-pending-fixture");
      await expect(f.storage.flush?.()).rejects.toThrow("storage unavailable");
    }

    const result = await f.makeClient().getBalanceManager().createProviderToken({
      baseUrl: base, mintUrl: mint, amount: 7,
    }).catch((error) => error);

    expect(network).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(receive).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(f.send).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(walletBalance).toBe(0);
    if (failed) expect(result).toEqual(new Error("storage unavailable"));
    else expect(result).toMatchObject({ success: true, token: "cashu-fixture" });
    const loaded = createSdkStore({ driver: f.driver });
    await loaded.hydrate;
    const otherKey = createStorageAdapterFromStore(loaded.store).getApiKey(other);
    if (failed) expect(otherKey).toMatchObject({ key: "other-key", balance: 7 });
    else expect(otherKey).toBeNull();
  });

  it("adopts a persisted bootstrap token after reload with an empty wallet", async () => {
    const f = await fixture();
    f.storage.addXcashuToken(base, "cashu-orphan");
    await f.storage.flush?.();
    const reloaded = createSdkStore({ driver: f.driver });
    await reloaded.hydrate;
    const storage = createStorageAdapterFromStore(reloaded.store);
    f.wallet.getBalances = async () => ({});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));
    await f.makeClient(storage).routeRequest(request);
    expect(f.send).not.toHaveBeenCalled();
    expect(storage.getApiKey(base)?.key).toBe("canonical-fixture");
    expect(storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
  });

  it("does not start a wallet send if another request's write fails during balance reads", async () => {
    const f = await fixture();
    const other = "https://other-provider.example/";
    f.storage.setApiKey(other, "other-key");
    f.storage.updateApiKeyBalance(other, 7);
    await f.storage.flush?.();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let reads = 0;
    f.wallet.getBalances = async () => {
      if (++reads === 1) { reading(); await gate; }
      return { [mint]: 100 };
    };
    const client = f.makeClient();
    const funding = client.getBalanceManager().createProviderToken({ baseUrl: base, mintUrl: mint, amount: 7 });
    await started;
    const network = vi.fn(async () => {
      vi.spyOn(f.driver, "setItem").mockRejectedValue(new Error("settlement write failed"));
      return Response.json({ choices: [] });
    });
    vi.stubGlobal("fetch", network);

    await client.routeRequest({ ...request, baseUrl: other, failover: false });
    await expect(f.storage.flush?.()).rejects.toThrow("settlement write failed");
    resume();

    expect(await funding).toMatchObject({ success: false, error: "settlement write failed" });
    expect(f.send).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledOnce();
  });

  it("reuses a bootstrap adopted while the first wallet send is finishing", async () => {
    const f = await fixture();
    let tokenReady!: () => void;
    const persisted = new Promise<void>((resolve) => { tokenReady = resolve; });
    let resumeSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { resumeSend = resolve; });
    let infoReady!: () => void;
    const validating = new Promise<void>((resolve) => { infoReady = resolve; });
    let resumeInfo!: () => void;
    const infoGate = new Promise<void>((resolve) => { resumeInfo = resolve; });
    let sends = 0;
    f.send.mockImplementation(async (_mint, _amount, _pubkey, persist) => {
      const token = `cashu-race-${++sends}`;
      await persist?.(token);
      tokenReady();
      await sendGate;
      return token;
    });
    const recovered = new Set<string>();
    const deposited = new Set<string>();
    f.wallet.receiveToken = vi.fn(async (token) => {
      if (deposited.has(token)) return { success: false, amount: 0, unit: "sat" };
      recovered.add(token);
      return { success: true, amount: 7, unit: "sat" };
    });
    const client = f.makeClient();
    vi.mocked(client.getBalanceManager().getTokenBalance).mockRestore();
    let infoCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization")!.slice(7).replace(/^sk-/, "");
      if (url.endsWith("/wallet/info")) {
        infoCalls++;
        infoReady();
        await infoGate;
      }
      if (recovered.has(token) && !deposited.has(token)) {
        return Response.json({ detail: { error: { code: "invalid_api_key", message: "proofs already spent" } } }, { status: 401 });
      }
      deposited.add(token);
      return url.endsWith("/wallet/info")
        ? Response.json({ balance: 7000, reserved: 0, api_key: `sk-${token}` })
        : Response.json({ choices: [] });
    }));

    const first = client.routeRequest({ ...request, failover: false }).catch((error) => error);
    await persisted;
    const second = client.routeRequest({ ...request, failover: false }).catch((error) => error);
    await validating;
    resumeSend();
    await vi.waitFor(() => expect(infoCalls).toBe(2));
    resumeInfo();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status ?? result.message)).toEqual([200, 200]);
    expect(f.wallet.receiveToken).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each([false, true])("drops a dead pending token before funding again, saved key: %s", async (savedKey) => {
    const f = await fixture();
    f.storage.addXcashuToken(base, "cashu-dead");
    if (savedKey) f.storage.setApiKey(base, "cashu-dead");
    await f.storage.flush?.();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));
    const client = f.makeClient();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockImplementation(async (token) =>
      token === "cashu-dead"
        ? { amount: 0, reserved: 0, unit: "msat", apiKey: "", isInvalidApiKey: true, balanceUnknown: true }
        : { amount: 7, reserved: 0, unit: "sat", apiKey: "canonical-fixture" });
    await client.routeRequest(request);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
    await f.storage.flush?.();
    const reloaded = createSdkStore({ driver: f.driver });
    await reloaded.hydrate;
    expect(createStorageAdapterFromStore(reloaded.store).getXcashuTokensForBaseUrl(base)).toEqual([]);
  });

  it("drops the top-up token from memory once recovery has returned it to the wallet", async () => {
    const f = await fixture();
    const { store, hydrate } = createSdkStore({ driver: { ...f.driver, setItem: async (key, value) => { if (key === "xcashu_tokens") throw new Error("disk full"); await f.driver.setItem(key, value); } } });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(base, "canonical-fixture");
    await storage.flush?.();
    f.wallet.sendToken = async () => "cashu-fixture"; // older adapter, ignores the handoff
    const manager = f.makeClient(storage).getBalanceManager();
    const post = vi.spyOn(manager as any, "_postTopUp");
    const result = await manager.topUp({ baseUrl: base, mintUrl: mint, amount: 7 });
    expect(result.success).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
  });

  it("does not dispatch or create another token after persistence fails", async () => {
    const f = await fixture();
    const { store, hydrate } = createSdkStore({ driver: { ...f.driver, setItem: async () => { throw new Error("disk full"); } } });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(base, "saved-fixture");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(f.makeClient(storage).routeRequest(request)).rejects.toThrow("disk full");
    expect(network).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
