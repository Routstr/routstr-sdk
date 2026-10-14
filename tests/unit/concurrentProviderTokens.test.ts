import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import { InsufficientBalanceError } from "../../core/errors";
import { noopLogger } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const MINT = "https://mint.example.com";
const PROVIDER = "https://provider.example.com";

const splitIntoDenominations = (amount: number): number[] => {
  const out: number[] = [];
  for (let bit = 1; bit <= amount; bit *= 2) {
    if (amount & bit) out.push(bit);
  }
  return out;
};

/**
 * A wallet that behaves like coco: a send reserves its input proofs while
 * the swap is at the mint, and getBalances reports only unreserved proofs.
 */
const createReservingWallet = (total: number, swapMs: number) => {
  const proofs = splitIntoDenominations(total).map((amount) => ({
    amount,
    reserved: false,
  }));

  const wallet: WalletAdapter = {
    getBalances: async () => ({
      [MINT]: proofs
        .filter((p) => !p.reserved)
        .reduce((sum, p) => sum + p.amount, 0),
    }),
    getMintUnits: () => ({ [MINT]: "sat" }),
    getActiveMintUrl: () => MINT,
    sendToken: async (_mintUrl, amount) => {
      const input = proofs
        .filter((p) => !p.reserved && p.amount >= amount)
        .sort((a, b) => a.amount - b.amount)[0];
      if (!input) throw new InsufficientBalanceError(amount, 0);
      input.reserved = true;
      await new Promise((resolve) => setTimeout(resolve, swapMs));
      proofs.splice(proofs.indexOf(input), 1);
      for (const change of splitIntoDenominations(input.amount - amount)) {
        proofs.push({ amount: change, reserved: false });
      }
      return `cashuB_${amount}`;
    },
    receiveToken: async () => ({ success: true, amount: 0, unit: "sat" }),
  };

  return {
    wallet,
    total: () => proofs.reduce((sum, p) => sum + p.amount, 0),
  };
};

const createStorage = (): StorageAdapter => ({
  getXcashuTokens: () => ({}),
  getXcashuTokensForBaseUrl: () => [],
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  clearXcashuTokensForBaseUrl: () => {},
  updateXcashuTokenTryCount: () => {},
  getApiKeyDistribution: () => [],
  removeApiKey: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
  getApiKey: () => null,
  setApiKey: () => {},
  updateApiKeyBalance: () => {},
  touchApiKeyLastUsed: () => {},
  getAllApiKeys: () => [],
  getChildKey: () => null,
  setChildKey: () => {},
  updateChildKeyBalance: () => {},
  removeChildKey: () => {},
  getAllChildKeys: () => [],
  getCachedReceiveTokens: () => [],
  setCachedReceiveTokens: () => {},
});

describe("concurrent provider tokens on one wallet", () => {
  it("creates every token when requests overlap on a funded wallet", async () => {
    const { wallet, total } = createReservingWallet(2900, 20);
    const storage = createStorage();

    // routstrd builds a new client, and so a new BalanceManager, per request.
    // All of them share the daemon's one wallet adapter.
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        await new Promise((resolve) => setTimeout(resolve, i * 2));
        const manager = new BalanceManager(
          wallet,
          storage,
          undefined,
          undefined,
          noopLogger
        );
        return manager.createProviderToken({
          mintUrl: MINT,
          baseUrl: PROVIDER,
          amount: 3,
        });
      })
    );

    expect(results.filter((r) => !r.success).map((r) => r.error)).toEqual([]);
    expect(total()).toBe(2900 - 20 * 3);
  });

  describe("top-ups of one key", () => {
    let deposits: string[];

    beforeEach(() => {
      deposits = [];
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        deposits.push(JSON.parse(String(init?.body)).cashu_token);
        return new Response("{}", { status: 200 });
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // One request every 2 ms, each with its own BalanceManager, all asking
    // the same key for 11 sats while the wallet's sends take 50 ms.
    const topUpInParallel = (wallet: WalletAdapter, requests: number) => {
      const storage = createStorage();
      return Promise.all(
        Array.from({ length: requests }, async (_, i) => {
          await new Promise((resolve) => setTimeout(resolve, i * 2));
          const manager = new BalanceManager(
            wallet,
            storage,
            undefined,
            undefined,
            noopLogger
          );
          return manager.topUp({
            mintUrl: MINT,
            baseUrl: PROVIDER,
            amount: 11,
            token: "sk-key",
          });
        })
      );
    };

    it("makes one deposit for the top-ups that wait behind a send", async () => {
      const { wallet, total } = createReservingWallet(2900, 50);

      const results = await topUpInParallel(wallet, 10);

      expect(results.every((r) => r.success)).toBe(true);
      // The first top-up goes out alone; the other nine arrive while it is at
      // the mint and leave together.
      expect(deposits).toEqual(["cashuB_11", "cashuB_99"]);
      expect(total()).toBe(2900 - 10 * 11);
    });

    it("tops up alone when the wallet cannot pay the merged deposit", async () => {
      // 32 sats: 11 go out first, leaving 21, short of the merged 22.
      const { wallet, total } = createReservingWallet(32, 50);

      const results = await topUpInParallel(wallet, 3);

      expect(results.map((r) => r.success)).toEqual([true, true, false]);
      expect(deposits).toEqual(["cashuB_11", "cashuB_11"]);
      expect(total()).toBe(32 - 2 * 11);
    });
  });
});
