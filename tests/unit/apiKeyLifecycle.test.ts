import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore, createDiscoveryAdapterFromStore } from "../../storage";
import type { WalletAdapter } from "../../wallet/interfaces";

const base = "https://provider.example/";
const mint = "https://mint.example";
const request = { path: "/v1/chat/completions", method: "POST", body: { messages: [] }, baseUrl: base, mintUrl: mint };
const logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => logger };

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

  it("adopts a persisted bootstrap token instead of funding a second one", async () => {
    const f = await fixture();
    f.storage.addXcashuToken(base, "cashu-orphan");
    await f.storage.flush?.();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));
    await f.makeClient().routeRequest(request);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.storage.getApiKey(base)?.key).toBe("canonical-fixture");
    expect(f.storage.getXcashuTokensForBaseUrl(base)).toEqual([]);
  });

  it("drops a dead orphan token before funding again", async () => {
    const f = await fixture();
    f.storage.addXcashuToken(base, "cashu-dead");
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
