import { localStorageDriver } from "../../storage/drivers/localStorage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { noopLogger as logger } from "../../core/types";
import {
  SDK_STORAGE_KEYS,
  createDiscoveryAdapterFromStore,
  createMemoryDriver,
  createSdkStore,
  createStorageAdapterFromStore,
} from "../../storage";
import type { StorageDriver } from "../../storage";
import type { WalletAdapter } from "../../wallet/interfaces";

const PROVIDER = "https://provider.example.com/";

const storedKey = async (driver: ReturnType<typeof createMemoryDriver>) => {
  const reloaded = createSdkStore({ driver });
  await reloaded.hydrate;
  return createStorageAdapterFromStore(reloaded.store).getApiKey(PROVIDER)?.key;
};

describe("credential and token writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("flush waits until a pending API key write reaches storage", async () => {
    const disk = createMemoryDriver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { store, hydrate } = createSdkStore({
      driver: {
        ...disk,
        setItem: async (key, value) => {
          await gate;
          await disk.setItem(key, value);
        },
      },
    });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setApiKey(PROVIDER, "cashu_bootstrap");
    let flushed = false;
    const flush = storage.flush!().then(() => (flushed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flushed).toBe(false);

    release();
    await flush;
    expect(await storedKey(disk)).toBe("cashu_bootstrap");
  });

  it("flush retries a failed write and rejects until storage works again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const disk = createMemoryDriver();
    let broken = true;
    const { store, hydrate } = createSdkStore({
      driver: {
        ...disk,
        setItem: async (key, value) => {
          if (broken && key === SDK_STORAGE_KEYS.API_KEYS) {
            throw new Error("QuotaExceededError");
          }
          await disk.setItem(key, value);
        },
      },
    });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.setApiKey(PROVIDER, "cashu_bootstrap");
    await expect(storage.flush!()).rejects.toThrow("QuotaExceededError");
    await expect(storage.flush!()).rejects.toThrow("QuotaExceededError");
    expect(await storedKey(disk)).toBeUndefined();

    broken = false;
    await storage.flush!();
    expect(await storedKey(disk)).toBe("cashu_bootstrap");
  });

  it("an aborted IndexedDB write rejects instead of hanging", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const quota = new DOMException("quota", "QuotaExceededError");
    const transaction = () => {
      const tx: any = {
        error: null,
        objectStore: () => ({
          put: () =>
            setTimeout(() => {
              tx.error = quota;
              tx.onabort?.();
            }),
        }),
      };
      return tx;
    };
    vi.stubGlobal("indexedDB", {
      open: () => {
        const request: any = {
          result: { objectStoreNames: { contains: () => true }, transaction },
        };
        setTimeout(() => request.onsuccess?.());
        return request;
      },
    });
    const { createIndexedDBDriver } = await import(
      "../../storage/drivers/indexedDB"
    );

    const write = createIndexedDBDriver().setItem(SDK_STORAGE_KEYS.API_KEYS, []);
    const outcome = await Promise.race([
      write.then(
        () => "resolved",
        (error) => error
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    expect(outcome).toBe(quota);
  });
});

const MINT = "https://mint.example.com";
const TOKEN = "cashuB_fresh_deposit";

// A driver whose writes of one key wait for `release`, or fail while `broken`.
function controlledDriver(key: string) {
  const disk = createMemoryDriver();
  let release!: () => void;
  const control = {
    disk,
    broken: false,
    gate: new Promise<void>((resolve) => (release = resolve)),
    release: () => release(),
  };
  const driver: StorageDriver = {
    ...disk,
    setItem: async (k, value) => {
      if (k === key) {
        if (control.broken) throw new Error("QuotaExceededError");
        await control.gate;
      }
      await disk.setItem(k, value);
    },
  };
  return { control, driver };
}

async function client(driver: StorageDriver) {
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  const discovery = createDiscoveryAdapterFromStore(store);
  discovery.setCachedMints({ [PROVIDER]: [MINT] });
  const wallet = {
    getBalances: async () => ({ [MINT]: 100 }),
    getMintUnits: () => ({ [MINT]: "sat" }),
    getActiveMintUrl: () => MINT,
    sendToken: vi.fn<WalletAdapter["sendToken"]>(async () => TOKEN),
    receiveToken: vi.fn(async () => ({ success: true, amount: 10, unit: "sat" })),
  } satisfies WalletAdapter;
  const routstr = new RoutstrClient(wallet, storage, discovery, "min", "apikeys", {
    logger,
  });
  vi.spyOn(routstr.getBalanceManager(), "getTokenBalance").mockResolvedValue({
    amount: 10,
    reserved: 0,
    unit: "sat",
    apiKey: TOKEN,
  });
  const request = () =>
    routstr.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { messages: [] },
      baseUrl: PROVIDER,
      mintUrl: MINT,
    });
  return { routstr, storage, wallet, request };
}

describe("paying with stored credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not pay when the actual localStorage driver hits quota", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", { localStorage: {
      getItem: () => null, removeItem: () => {},
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
    } });
    const c = await client(localStorageDriver);
    const network = vi.fn(async () => Response.json({ choices: [] }));
    vi.stubGlobal("fetch", network);
    await expect(c.request()).rejects.toThrow("full");
    expect(network).not.toHaveBeenCalled();
    expect(c.wallet.receiveToken).toHaveBeenCalledWith(TOKEN);
  });

  it("does not pay with a new API key until it is stored", async () => {
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.API_KEYS);
    const c = await client(driver);
    const network = vi.fn(async () => Response.json({ choices: [] }));
    vi.stubGlobal("fetch", network);

    const pending = c.request();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(c.wallet.sendToken).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();

    control.release();
    await pending;
    expect(network).toHaveBeenCalledOnce();
  });

  it("gives a new API key's token back to the wallet when it cannot be stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.API_KEYS);
    control.broken = true;
    const c = await client(driver);
    const network = vi.fn(async () => Response.json({ choices: [] }));
    vi.stubGlobal("fetch", network);

    await expect(c.request()).rejects.toThrow("QuotaExceededError");

    expect(network).not.toHaveBeenCalled();
    expect(c.wallet.receiveToken).toHaveBeenCalledWith(TOKEN);
    expect(c.storage.getApiKey(PROVIDER)).toBeNull();
  });

  it("does not post a top-up token until it is stored", async () => {
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    const c = await client(driver);
    const manager = c.routstr.getBalanceManager();
    vi.spyOn(manager, "createProviderToken").mockResolvedValue({
      success: true,
      token: TOKEN,
    });
    const network = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", network);

    const pending = manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 10,
      token: "api-key",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(network).not.toHaveBeenCalled();

    control.release();
    expect((await pending).success).toBe(true);
    expect(network).toHaveBeenCalledOnce();
  });

  it("gives a top-up token back to the wallet when it cannot be stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    control.broken = true;
    const c = await client(driver);
    const manager = c.routstr.getBalanceManager();
    vi.spyOn(manager, "createProviderToken").mockResolvedValue({
      success: true,
      token: TOKEN,
    });
    const network = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", network);

    const result = await manager.topUp({
      mintUrl: MINT,
      baseUrl: PROVIDER,
      amount: 10,
      token: "api-key",
    });

    expect(result.success).toBe(false);
    expect(network).not.toHaveBeenCalled();
    expect(c.wallet.receiveToken).toHaveBeenCalledWith(TOKEN);
    expect(c.storage.getXcashuTokensForBaseUrl(PROVIDER)).toEqual([]);
  });
});

describe("swapping a bootstrap key for the provider's key", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Every value written for api_keys, in order.
  function recordingDriver() {
    const disk = createMemoryDriver();
    const writes: Array<Array<{ baseUrl: string; key: string }>> = [];
    const driver: StorageDriver = {
      ...disk,
      setItem: async (key, value) => {
        if (key === SDK_STORAGE_KEYS.API_KEYS) writes.push(value as any);
        await disk.setItem(key, value);
      },
    };
    return { driver, writes };
  }

  it("replaceApiKey swaps the key in a single write", async () => {
    const { driver, writes } = recordingDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(PROVIDER, "cashu_bootstrap");
    writes.length = 0;

    storage.replaceApiKey!(PROVIDER, "sk-canonical");

    expect(writes).toEqual([
      [expect.objectContaining({ baseUrl: PROVIDER, key: "sk-canonical" })],
    ]);
  });

  it("never stores an empty key list while swapping after a request", async () => {
    const { driver, writes } = recordingDriver();
    const c = await client(driver);
    vi.spyOn(c.routstr.getBalanceManager(), "getTokenBalance").mockResolvedValue({
      amount: 10,
      reserved: 0,
      unit: "sat",
      apiKey: "sk-canonical",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));

    await c.request();

    expect(c.storage.getApiKey(PROVIDER)?.key).toBe("sk-canonical");
    expect(writes.map((keys) => keys.map((entry) => entry.key))).not.toContainEqual([]);
  });
});

describe("handing a token over from the wallet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const onDisk = async (disk: ReturnType<typeof createMemoryDriver>) => {
    const reloaded = createSdkStore({ driver: disk });
    await reloaded.hydrate;
    return createStorageAdapterFromStore(reloaded.store)
      .getXcashuTokensForBaseUrl(PROVIDER)
      .map((entry) => entry.token);
  };

  it("stores the token before the wallet drops its own copy", async () => {
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    control.release();
    const c = await client(driver);
    let storedAtHandoff: string[] = [];
    c.wallet.sendToken.mockImplementation(async (_mint, _amount, _pubkey, persistToken) => {
      await persistToken?.(TOKEN);
      storedAtHandoff = await onDisk(control.disk);
      return TOKEN;
    });

    const result = await c.routstr
      .getBalanceManager()
      .createProviderToken({ mintUrl: MINT, baseUrl: PROVIDER, amount: 10 });

    expect(result.success).toBe(true);
    expect(storedAtHandoff).toEqual([TOKEN]);
  });

  it("refuses the handover when the token cannot be stored, so the wallet keeps it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    control.broken = true;
    const c = await client(driver);
    let walletKeptCopy = false;
    c.wallet.sendToken.mockImplementation(async (_mint, _amount, _pubkey, persistToken) => {
      try {
        await persistToken?.(TOKEN);
      } catch (error) {
        walletKeptCopy = true;
        throw error;
      }
      return TOKEN;
    });
    const network = vi.fn(async () => Response.json({ choices: [] }));
    vi.stubGlobal("fetch", network);

    await expect(c.request()).rejects.toThrow("QuotaExceededError");

    expect(walletKeptCopy).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(c.wallet.receiveToken).not.toHaveBeenCalled();
    expect(c.storage.getXcashuTokensForBaseUrl(PROVIDER)).toEqual([]);
  });

  it("drops the handover copy once a new API key holding it is stored", async () => {
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    control.release();
    const c = await client(driver);
    c.wallet.sendToken.mockImplementation(async (_mint, _amount, _pubkey, persistToken) => {
      await persistToken?.(TOKEN);
      return TOKEN;
    });
    const storedDuringRequest: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      storedDuringRequest.push(await onDisk(control.disk));
      return Response.json({ choices: [] });
    }));

    await c.request();

    expect(c.storage.getApiKey(PROVIDER)?.key).toBe(TOKEN);
    expect(storedDuringRequest).toEqual([[]]);
  });

  it("drops the handover copy when a new API key is given back to the wallet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.API_KEYS);
    control.broken = true;
    const c = await client(driver);
    c.wallet.sendToken.mockImplementation(async (_mint, _amount, _pubkey, persistToken) => {
      await persistToken?.(TOKEN);
      return TOKEN;
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));

    await expect(c.request()).rejects.toThrow("QuotaExceededError");

    expect(c.wallet.receiveToken).toHaveBeenCalledWith(TOKEN);
    expect(c.storage.getApiKey(PROVIDER)).toBeNull();
    expect(c.storage.getXcashuTokensForBaseUrl(PROVIDER)).toEqual([]);
  });

  it("drops the losing handover copy when two requests create a key at once", async () => {
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    control.release();
    const c = await client(driver);
    let sends = 0;
    let bothSent!: () => void;
    const bothStarted = new Promise<void>((resolve) => (bothSent = resolve));
    c.wallet.sendToken.mockImplementation(async (_mint, _amount, _pubkey, persistToken) => {
      const token = `cashuB_race_${++sends}`;
      if (sends === 2) bothSent();
      await bothStarted;
      await persistToken?.(token);
      return token;
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [] })));

    await Promise.all([c.request(), c.request()]);

    const winner = c.storage.getApiKey(PROVIDER)?.key;
    expect(c.wallet.receiveToken).toHaveBeenCalledOnce();
    expect(c.wallet.receiveToken.mock.calls[0][0]).not.toBe(winner);
    expect(c.storage.getXcashuTokensForBaseUrl(PROVIDER)).toEqual([]);
  });

  it("keeps a single stored copy of an xcashu token", async () => {
    const { control, driver } = controlledDriver(SDK_STORAGE_KEYS.XCASHU_TOKENS);
    control.release();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);

    storage.addXcashuToken(PROVIDER, TOKEN);
    storage.addXcashuToken(PROVIDER, TOKEN);

    expect(storage.getXcashuTokensForBaseUrl(PROVIDER).map((e) => e.token)).toEqual([TOKEN]);
  });
});
