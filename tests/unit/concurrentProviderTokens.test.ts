import { describe, expect, it } from "vitest";
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
});
