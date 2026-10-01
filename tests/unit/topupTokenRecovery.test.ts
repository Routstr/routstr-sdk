import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import {
  createMemoryDriver,
  createSdkStore,
  createStorageAdapterFromStore,
} from "../../storage";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { WalletAdapter } from "../../wallet/interfaces";

const PROVIDER = "https://provider.example.com/";
const MINT = "https://mint.example.com";
const TOPUP_TOKEN = "cashuB_topup_token";

const discovery = {
  getCachedMints: () => ({ [PROVIDER]: [MINT] }),
} as unknown as DiscoveryAdapter;

async function setup(receiveToken: WalletAdapter["receiveToken"]) {
  const driver = createMemoryDriver();
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  const wallet = { receiveToken } as unknown as WalletAdapter;
  const manager = new BalanceManager(wallet, storage, discovery);
  vi.spyOn(manager, "createProviderToken").mockResolvedValue({
    success: true,
    token: TOPUP_TOKEN,
    selectedMintUrl: MINT,
  });
  const storedOnDisk = async () => {
    const reloaded = createSdkStore({ driver });
    await reloaded.hydrate;
    return createStorageAdapterFromStore(reloaded.store)
      .getXcashuTokensForBaseUrl(PROVIDER)
      .map((entry) => entry.token);
  };
  const topUp = () =>
    manager.topUp({ mintUrl: MINT, baseUrl: PROVIDER, amount: 10, token: "api-key" });
  return { storage, storedOnDisk, topUp };
}

const received = async () => ({ success: true, amount: 10, unit: "sat" as const });
const unreachable = async () => ({
  success: false,
  amount: 0,
  unit: "sat" as const,
  message: "fetch failed",
});

describe("top-up token recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the token stored when the top-up and its recovery both fail", async () => {
    const t = await setup(unreachable);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const result = await t.topUp();

    expect(result).toMatchObject({ success: false, recoveredToken: false });
    expect(await t.storedOnDisk()).toEqual([TOPUP_TOKEN]);
    expect(t.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("does not cache a thrown mint-fetch failure in a second store", async () => {
    const t = await setup(async () => { throw new Error("Failed to fetch mint"); });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await t.topUp();
    expect(await t.storedOnDisk()).toEqual([TOPUP_TOKEN]);
    expect(t.storage.getCachedReceiveTokens()).toEqual([]);
  });

  it("stores the token before the POST and removes it after the top-up succeeds", async () => {
    const t = await setup(unreachable);
    const storedDuringPost: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      storedDuringPost.push(await t.storedOnDisk());
      return Response.json({ ok: true });
    }));

    const result = await t.topUp();

    expect(result.success).toBe(true);
    expect(storedDuringPost).toEqual([[TOPUP_TOKEN]]);
    expect(await t.storedOnDisk()).toEqual([]);
  });

  it.each([
    {
      outcome: "the wallet receives it back",
      receiveToken: received,
      response: () => Response.json({ detail: "upstream error" }, { status: 502 }),
    },
    {
      outcome: "the provider reports it already spent",
      receiveToken: unreachable,
      response: () =>
        Response.json(
          {
            error: {
              type: "token_already_spent",
              code: "cashu_token_already_spent",
              message: "Cashu token already spent",
            },
          },
          { status: 400 }
        ),
    },
  ])("removes the token when $outcome", async ({ receiveToken, response }) => {
    const t = await setup(receiveToken);
    vi.stubGlobal("fetch", vi.fn(async () => response()));

    const result = await t.topUp();

    expect(result.success).toBe(false);
    expect(await t.storedOnDisk()).toEqual([]);
  });
});
