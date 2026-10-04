/**
 * Unit tests: provider-mint shortfall classification.
 *
 * When the wallet holds enough sats in total, but none on a mint the target
 * provider advertises, `createProviderToken` must NOT report total wallet
 * exhaustion (the contradictory "need 100, have 497" 402). It must return a
 * provider-mint shortfall signal so routing fails over to a provider that
 * accepts a funded mint.
 */

import { describe, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import { CashuSpender } from "../../wallet/CashuSpender";
import { ProviderMintBalanceError } from "../../core/errors";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const PROVIDER = "https://routstr.cypherpunk.today/";
const MINIBITS = "https://mint.minibits.cash/Bitcoin";
const CUBABITCOIN = "https://mint.cubabitcoin.org";
const CASHU_CZ = "https://cashu.cz";

const storage = {
  getApiKey: () => null,
  getApiKeyDistribution: () => [],
  getAllApiKeys: () => [],
  getXcashuTokens: () => ({}),
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  getCachedReceiveTokens: () => [],
  setCachedReceiveTokens: () => {},
  flush: async () => {},
} as unknown as StorageAdapter;

// cypherpunk does not accept minibits — the wallet's largest mint.
const discovery = {
  getCachedMints: () => ({
    [PROVIDER]: [CUBABITCOIN, CASHU_CZ],
  }),
} as unknown as DiscoveryAdapter;

function wallet(sendToken = vi.fn(async (mint: string) => `token:${mint}`)) {
  const balances = { [MINIBITS]: 434, [CUBABITCOIN]: 63 };
  return {
    getBalances: async () => balances,
    getMintUnits: () => ({ [MINIBITS]: "sat", [CUBABITCOIN]: "sat" }),
    getActiveMintUrl: () => MINIBITS,
    sendToken,
  } as unknown as WalletAdapter;
}

describe("BalanceManager provider-mint shortfall", () => {
  it("never spends the funded mint the provider does not advertise", async () => {
    const sendToken = vi.fn(async (mint: string) => `token:${mint}`);
    const manager = new BalanceManager(wallet(sendToken), storage, discovery);

    const result = await manager.createProviderToken({
      mintUrl: MINIBITS,
      baseUrl: PROVIDER,
      amount: 105,
    });

    expect(sendToken).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.providerMintsShort).toBe(true);
    expect(result.acceptedMints).toEqual([CUBABITCOIN, CASHU_CZ]);
    expect(result.maxMintBalance).toBe(63);
    expect(result.maxMintUrl).toBe(CUBABITCOIN);
    expect(result.error).toContain(PROVIDER);
    expect(result.error).not.toContain("have 497");
  });

  it("spends an accepted funded mint when one can cover the amount", async () => {
    const sendToken = vi.fn(async (mint: string) => `token:${mint}`);
    const manager = new BalanceManager(wallet(sendToken), storage, discovery);

    const result = await manager.createProviderToken({
      mintUrl: MINIBITS,
      baseUrl: PROVIDER,
      amount: 50,
    });

    expect(result.success).toBe(true);
    expect(result.selectedMintUrl).toBe(CUBABITCOIN);
    expect(sendToken).toHaveBeenCalledWith(
      CUBABITCOIN,
      50,
      undefined,
      expect.any(Function)
    );
  });

  it("reports genuine wallet exhaustion when no mint anywhere covers the amount", async () => {
    const sendToken = vi.fn(async (mint: string) => `token:${mint}`);
    const manager = new BalanceManager(wallet(sendToken), storage, discovery);

    const result = await manager.createProviderToken({
      mintUrl: MINIBITS,
      baseUrl: PROVIDER,
      amount: 10_000,
    });

    expect(sendToken).not.toHaveBeenCalled();
    expect(result.providerMintsShort).toBeFalsy();
    expect(result.error).toContain("Insufficient balance");
  });

  it("propagates the shortfall through topUp()", async () => {
    const manager = new BalanceManager(wallet(), storage, discovery);
    const result = await manager.topUp({
      mintUrl: MINIBITS,
      baseUrl: PROVIDER,
      amount: 105,
      token: "api-key",
    });

    expect(result.success).toBe(false);
    expect(result.providerMintsShort).toBe(true);
    expect(result.acceptedMints).toEqual([CUBABITCOIN, CASHU_CZ]);
  });
});

describe("CashuSpender provider-mint shortfall", () => {
  it("throws a typed ProviderMintBalanceError instead of a generic 402", async () => {
    const manager = new BalanceManager(wallet(), storage, discovery);
    const spender = new CashuSpender(
      wallet(),
      storage,
      discovery,
      manager
    );

    // spend() wraps _spendInternal; drive it through the real BalanceManager.
    await expect(
      spender.spend({ mintUrl: MINIBITS, amount: 105, baseUrl: PROVIDER })
    ).rejects.toBeInstanceOf(ProviderMintBalanceError);
  });
});
