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
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
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
    expect(sendToken).toHaveBeenCalledWith(
      MINT_B,
      10,
      undefined,
      expect.any(Function)
    );
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

  it("retries a topup rejected as untrusted_mint with that mint excluded", async () => {
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
    const postSpy = vi
      .spyOn(manager as any, "_postTopUp")
      .mockResolvedValueOnce({
        success: false,
        error: "Source mint not trusted",
        parsedError: {
          type: "untrusted_mint",
          code: "cashu_untrusted_source_mint",
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
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(createTokenSpy).toHaveBeenNthCalledWith(2, {
      mintUrl: MINT_A,
      baseUrl: PROVIDER,
      amount: 10,
      excludeMints: [MINT_A],
    });
  });
});

describe("topup recovery spending invariant", () => {
  it("calls sendToken once when recovery fails and preserves the emitted token", async () => {
    const tokens: string[] = [];
    let cached: ReturnType<StorageAdapter["getCachedReceiveTokens"]> = [];
    const sendToken = vi.fn(async (mint: string) => `token:${mint}`);
    const manager = new BalanceManager({
      ...wallet(sendToken),
      receiveToken: async () => ({ success: false, amount: 10, unit: "sat" }),
    }, {
      ...storage,
      addXcashuToken: (_baseUrl, token) => { if (!tokens.includes(token)) tokens.push(token); },
      getCachedReceiveTokens: () => cached,
      setCachedReceiveTokens: (entries) => {
        cached = entries.map((entry) => ({ ...entry, createdAt: entry.createdAt ?? Date.now() }));
      },
    }, discovery);
    const create = vi.spyOn(manager, "createProviderToken");
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({
      success: false,
      parsedError: { type: "mint_unreachable", code: "cashu_mint_unreachable", raw: false },
    });
    const result = await manager.topUp({ mintUrl: MINT_A, baseUrl: PROVIDER, amount: 10, token: "api-key" });
    expect(sendToken).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: false, recoveredToken: false });
    expect(tokens).toEqual([`token:${MINT_A}`]);
    expect(cached).toEqual([]);
  });
});
