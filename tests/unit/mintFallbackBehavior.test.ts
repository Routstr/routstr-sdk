import { describe, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const PROVIDER = "https://provider.example.com/";
const MINT_A = "https://mint-a.example.com";
const MINT_B = "https://mint-b.example.com";
const UNSUPPORTED_MINT = "https://mint-unsupported.example.com";

const storage = {
  getApiKey: () => null,
  getApiKeyDistribution: () => [],
  getXcashuTokens: () => ({}),
  getAllApiKeys: () => [],
} as unknown as StorageAdapter;

const discovery = {
  getCachedMints: () => ({ [PROVIDER]: [MINT_A, MINT_B] }),
} as unknown as DiscoveryAdapter;

function wallet(sendToken = vi.fn(async (mint: string) => `token:${mint}`)) {
  return {
    getBalances: async () => ({
      [MINT_A]: 100,
      [MINT_B]: 100,
      [UNSUPPORTED_MINT]: 100,
    }),
    getMintUnits: () => ({
      [MINT_A]: "sat",
      [MINT_B]: "sat",
      [UNSUPPORTED_MINT]: "sat",
    }),
    sendToken,
  } as unknown as WalletAdapter;
}

describe("BalanceManager request-scoped mint selection", () => {
  it("excludes the failed mint and selects another provider-supported mint", async () => {
    const sendToken = vi.fn(async (mint: string) => `token:${mint}`);
    const manager = new BalanceManager(wallet(sendToken), storage, discovery);

    const result = await manager.createProviderToken({
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      excludeMints: [MINT_A],
    });

    expect(result).toMatchObject({
      success: true,
      selectedMintUrl: MINT_B,
      token: `token:${MINT_B}`,
    });
    expect(sendToken).toHaveBeenCalledWith(MINT_B, 10, undefined);
  });

  it("never falls back to a funded mint the provider does not advertise", async () => {
    const sendToken = vi.fn(async (mint: string) => `token:${mint}`);
    const onlyMintADiscovery = {
      getCachedMints: () => ({ [PROVIDER]: [MINT_A] }),
    } as unknown as DiscoveryAdapter;
    const manager = new BalanceManager(
      wallet(sendToken),
      storage,
      onlyMintADiscovery
    );

    const result = await manager.createProviderToken({
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      excludeMints: [MINT_A],
    });

    expect(result.success).toBe(false);
    expect(sendToken).not.toHaveBeenCalled();
  });

  it("does not retry topup network failures as mint fallback", async () => {
    const manager = new BalanceManager(wallet(), storage, discovery);
    const createTokenSpy = vi
      .spyOn(manager, "createProviderToken")
      .mockResolvedValue({
        success: true,
        token: "token-a",
        selectedMintUrl: MINT_A,
      });
    vi.spyOn(manager as any, "_recoverFailedTopUp").mockResolvedValue(true);
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({
      success: false,
      error: "network unavailable",
    });

    const result = await manager.topUp({
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      token: "api-key",
    });

    expect(result).toMatchObject({
      success: false,
      message: "network unavailable",
    });
    expect(createTokenSpy).toHaveBeenCalledOnce();
  });

  it("retries a topup with the rejected source mint excluded", async () => {
    const manager = new BalanceManager(wallet(), storage, discovery);
    const createTokenSpy = vi
      .spyOn(manager, "createProviderToken")
      .mockResolvedValueOnce({
        success: true,
        token: "token-a",
        selectedMintUrl: MINT_A,
      })
      .mockResolvedValueOnce({
        success: true,
        token: "token-b",
        selectedMintUrl: MINT_B,
      });
    vi.spyOn(manager as any, "_recoverFailedTopUp").mockResolvedValue(true);
    vi.spyOn(manager as any, "_postTopUp")
      .mockResolvedValueOnce({
        success: false,
        error: "Foreign mint swap failed",
        parsedError: {
          type: "mint_error",
          code: "cashu_foreign_mint_swap_failed",
          raw: false,
        },
      })
      .mockResolvedValueOnce({ success: true });

    const result = await manager.topUp({
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      token: "api-key",
    });

    expect(result.success).toBe(true);
    expect(createTokenSpy).toHaveBeenNthCalledWith(1, {
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      excludeMints: [],
    });
    expect(createTokenSpy).toHaveBeenNthCalledWith(2, {
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      excludeMints: [MINT_A],
    });
  });
});
