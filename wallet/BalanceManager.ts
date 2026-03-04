/**
 * BalanceManager - Handles refunding and topping up tokens from providers
 *
 * Handles:
 * - Fetching refund tokens from provider API
 * - Receiving/storing refunded tokens
 * - Topping up API key balances with cashu tokens
 * - Error handling for various refund/topup failure modes
 *
 * Extracted from utils/cashuUtils.ts
 */

import type {
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
} from "./interfaces";
import type { RefundResult, TopUpResult } from "../core/types";
import { InsufficientBalanceError } from "../core/errors";
import { CashuSpender } from "./CashuSpender";
import {
  getBalanceInSats,
  isNetworkErrorMessage,
  selectMintWithBalance,
} from "./tokenUtils";

/**
 * Options for refunding tokens
 */
export interface RefundOptions {
  /** The mint URL (for NIP-60 wallet operations) */
  mintUrl: string;

  /** The provider base URL */
  baseUrl: string;

  /** Optional specific token to refund (if not provided, uses stored token) */
  token?: string;
}

/**
 * Options for refunding API key balance
 */
export interface RefundApiKeyOptions {
  /** The mint URL (for NIP-60 wallet operations) */
  mintUrl: string;

  /** The provider base URL */
  baseUrl: string;

  /** The API key to use for authentication */
  apiKey: string;
}

/**
 * Options for topping up API key balance
 */
export interface TopUpOptions {
  /** The mint URL to spend from */
  mintUrl: string;

  /** The provider base URL */
  baseUrl: string;

  /** Amount to top up in sats */
  amount: number;

  /** Optional specific API key to top up (if not provided, uses stored token) */
  token?: string;
}

export interface CreateProviderTokenOptions {
  mintUrl: string;
  baseUrl: string;
  amount: number;
  p2pkPubkey?: string;
  excludeMints?: string[];
  retryCount?: number;
}

export interface ProviderTokenResult {
  success: boolean;
  token?: string;
  error?: string;
  selectedMintUrl?: string;
  amountSpent?: number;
}

/**
 * BalanceManager handles token refunds and topups from providers
 */
export class BalanceManager {
  private cashuSpender: CashuSpender;

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private providerRegistry?: ProviderRegistry,
    cashuSpender?: CashuSpender
  ) {
    if (cashuSpender) {
      this.cashuSpender = cashuSpender;
    } else {
      this.cashuSpender = new CashuSpender(
        walletAdapter,
        storageAdapter,
        providerRegistry,
        this
      );
    }
  }

  /**
   * Unified refund - handles both NIP-60 and legacy wallet refunds
   */
  async refund(options: RefundOptions): Promise<RefundResult> {
    const { mintUrl, baseUrl, token: providedToken } = options;

    const storedToken = providedToken || this.storageAdapter.getToken(baseUrl);

    if (!storedToken) {
      console.log("[BalanceManager] No token to refund, returning early");
      return { success: true, message: "No API key to refund" };
    }

    let fetchResult:
      | { success: boolean; token?: string; requestId?: string; error?: string }
      | undefined;

    try {
      // Fetch refund token from provider
      fetchResult = await this._fetchRefundToken(baseUrl, storedToken);

      if (!fetchResult.success) {
        return {
          success: false,
          message: fetchResult.error || "Refund failed",
          requestId: fetchResult.requestId,
        };
      }

      if (!fetchResult.token) {
        return {
          success: false,
          message: "No token received from refund",
          requestId: fetchResult.requestId,
        };
      }

      // Check if this is a "no balance to refund" case
      if (fetchResult.error === "No balance to refund") {
        console.log(
          "[BalanceManager] No balance to refund, removing stored token"
        );
        this.storageAdapter.removeToken(baseUrl);
        return { success: true, message: "No balance to refund" };
      }

      // Receive the refunded token
      const receiveResult = await this.cashuSpender.receiveToken(
        fetchResult.token
      );
      const totalAmountMsat =
        receiveResult.unit === "msat"
          ? receiveResult.amount
          : receiveResult.amount * 1000;

      // Remove the stored token if we used it from storage
      if (!providedToken) {
        this.storageAdapter.removeToken(baseUrl);
      }

      return {
        success: receiveResult.success,
        refundedAmount: totalAmountMsat,
        requestId: fetchResult.requestId,
      };
    } catch (error) {
      console.error("[BalanceManager] Refund error", error);
      return this._handleRefundError(error, mintUrl, fetchResult?.requestId);
    }
  }

  /**
   * Refund API key balance - convert remaining API key balance to cashu token
   */
  async refundApiKey(options: RefundApiKeyOptions): Promise<RefundResult> {
    const { mintUrl, baseUrl, apiKey } = options;

    if (!apiKey) {
      return { success: false, message: "No API key to refund" };
    }

    let fetchResult:
      | { success: boolean; token?: string; requestId?: string; error?: string }
      | undefined;

    try {
      fetchResult = await this._fetchRefundTokenWithApiKey(baseUrl, apiKey);

      if (!fetchResult.success) {
        return {
          success: false,
          message: fetchResult.error || "API key refund failed",
          requestId: fetchResult.requestId,
        };
      }

      if (!fetchResult.token) {
        return {
          success: false,
          message: "No token received from API key refund",
          requestId: fetchResult.requestId,
        };
      }

      if (fetchResult.error === "No balance to refund") {
        return { success: false, message: "No balance to refund" };
      }

      const receiveResult = await this.cashuSpender.receiveToken(
        fetchResult.token
      );
      const totalAmountMsat =
        receiveResult.unit === "msat"
          ? receiveResult.amount
          : receiveResult.amount * 1000;

      if (receiveResult.success) {
        this.storageAdapter.removeApiKey(baseUrl); // TODO: remove this after all nodes upgrade to 0.4.0
      }

      return {
        success: receiveResult.success,
        refundedAmount: totalAmountMsat,
        requestId: fetchResult.requestId,
      };
    } catch (error) {
      console.error("[BalanceManager] API key refund error", error);
      return this._handleRefundError(error, mintUrl, fetchResult?.requestId);
    }
  }

  /**
   * Fetch refund token from provider API using API key authentication
   */
  private async _fetchRefundTokenWithApiKey(
    baseUrl: string,
    apiKey: string
  ): Promise<{
    success: boolean;
    token?: string;
    requestId?: string;
    error?: string;
  }> {
    if (!baseUrl) {
      return {
        success: false,
        error: "No base URL configured",
      };
    }

    const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const url = `${normalizedBaseUrl}v1/wallet/refund`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 60000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const requestId =
        response.headers.get("x-routstr-request-id") || undefined;

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          requestId,
          error: `API key refund failed: ${
            errorData?.detail || response.statusText
          }`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        token: data.token,
        requestId,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      console.error(
        "[BalanceManager._fetchRefundTokenWithApiKey] Fetch error",
        error
      );

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          return {
            success: false,
            error: "Request timed out after 1 minute",
          };
        }
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: false,
        error: "Unknown error occurred during API key refund request",
      };
    }
  }

  /**
   * Top up API key balance with a cashu token
   */
  async topUp(options: TopUpOptions): Promise<TopUpResult> {
    const { mintUrl, baseUrl, amount, token: providedToken } = options;

    if (!amount || amount <= 0) {
      return { success: false, message: "Invalid top up amount" };
    }

    const storedToken = providedToken || this.storageAdapter.getToken(baseUrl);
    if (!storedToken) {
      return { success: false, message: "No API key available for top up" };
    }

    let cashuToken: string | null = null;
    let requestId: string | undefined;

    try {
      const tokenResult = await this.createProviderToken({
        mintUrl,
        baseUrl,
        amount,
      });

      if (!tokenResult.success || !tokenResult.token) {
        return {
          success: false,
          message: tokenResult.error || "Unable to create top up token",
        };
      }

      cashuToken = tokenResult.token;

      const topUpResult = await this._postTopUp(
        baseUrl,
        storedToken,
        cashuToken
      );
      requestId = topUpResult.requestId;
      console.log(topUpResult);

      if (!topUpResult.success) {
        await this._recoverFailedTopUp(cashuToken);
        return {
          success: false,
          message: topUpResult.error || "Top up failed",
          requestId,
          recoveredToken: true,
        };
      }

      return {
        success: true,
        toppedUpAmount: amount,
        requestId,
      };
    } catch (error) {
      if (cashuToken) {
        await this._recoverFailedTopUp(cashuToken);
      }

      return this._handleTopUpError(error, mintUrl, requestId);
    }
  }

  async createProviderToken(
    options: CreateProviderTokenOptions
  ): Promise<ProviderTokenResult> {
    const {
      mintUrl,
      baseUrl,
      amount,
      retryCount = 0,
      excludeMints = [],
      p2pkPubkey,
    } = options;

    const adjustedAmount = Math.ceil(amount);
    if (!adjustedAmount || isNaN(adjustedAmount)) {
      return { success: false, error: "Invalid top up amount" };
    }

    const balances = await this.walletAdapter.getBalances();
    const units = this.walletAdapter.getMintUnits();

    let totalMintBalance = 0;
    for (const url in balances) {
      const unit = units[url];
      const balanceInSats = getBalanceInSats(balances[url], unit);
      totalMintBalance += balanceInSats;
    }

    const pendingDistribution =
      this.storageAdapter.getCachedTokenDistribution();
    const refundablePending = pendingDistribution
      .filter((entry) => entry.baseUrl !== baseUrl)
      .reduce((sum, entry) => sum + entry.amount, 0);

    if (
      totalMintBalance < adjustedAmount &&
      totalMintBalance + refundablePending >= adjustedAmount &&
      retryCount < 1
    ) {
      await this._refundOtherProvidersForTopUp(baseUrl, mintUrl);
      return this.createProviderToken({
        ...options,
        retryCount: retryCount + 1,
      });
    }

    const providerMints =
      baseUrl && this.providerRegistry
        ? this.providerRegistry.getProviderMints(baseUrl)
        : [];

    let requiredAmount = adjustedAmount;
    const supportedMintsOnly = providerMints.length > 0;

    let candidates = this._selectCandidateMints({
      balances,
      units,
      amount: requiredAmount,
      preferredMintUrl: mintUrl,
      excludeMints,
      allowedMints: supportedMintsOnly ? providerMints : undefined,
    });

    if (candidates.length === 0 && supportedMintsOnly) {
      requiredAmount += 2;
      candidates = this._selectCandidateMints({
        balances,
        units,
        amount: requiredAmount,
        preferredMintUrl: mintUrl,
        excludeMints,
      });
    }

    if (candidates.length === 0) {
      let maxBalance = 0;
      let maxMintUrl = "";
      for (const mintUrl in balances) {
        const balance = balances[mintUrl];
        const unit = units[mintUrl];
        const balanceInSats = getBalanceInSats(balance, unit);
        if (balanceInSats > maxBalance) {
          maxBalance = balanceInSats;
          maxMintUrl = mintUrl;
        }
      }

      const error = new InsufficientBalanceError(
        adjustedAmount,
        totalMintBalance,
        maxBalance,
        maxMintUrl
      );

      return { success: false, error: error.message };
    }

    let lastError: string | undefined;
    for (const candidateMint of candidates) {
      try {
        const token = await this.walletAdapter.sendToken(
          candidateMint,
          requiredAmount,
          p2pkPubkey
        );
        return {
          success: true,
          token,
          selectedMintUrl: candidateMint,
          amountSpent: requiredAmount,
        };
      } catch (error) {
        if (error instanceof Error) {
          lastError = error.message;

          if (isNetworkErrorMessage(error.message)) {
            continue;
          }
        }

        return {
          success: false,
          error: lastError || "Failed to create top up token",
        };
      }
    }

    return {
      success: false,
      error:
        lastError || "All candidate mints failed while creating top up token",
    };
  }

  private _selectCandidateMints(options: {
    balances: Record<string, number>;
    units: Record<string, "sat" | "msat">;
    amount: number;
    preferredMintUrl: string;
    excludeMints: string[];
    allowedMints?: string[];
  }): string[] {
    const {
      balances,
      units,
      amount,
      preferredMintUrl,
      excludeMints,
      allowedMints,
    } = options;

    const candidates: string[] = [];

    const { selectedMintUrl: firstMint } = selectMintWithBalance(
      balances,
      units,
      amount,
      excludeMints
    );

    if (
      firstMint &&
      (!allowedMints ||
        allowedMints.length === 0 ||
        allowedMints.includes(firstMint))
    ) {
      candidates.push(firstMint);
    }

    const canUseMint = (mint: string): boolean => {
      if (excludeMints.includes(mint)) return false;
      if (
        allowedMints &&
        allowedMints.length > 0 &&
        !allowedMints.includes(mint)
      ) {
        return false;
      }
      const rawBalance = balances[mint] || 0;
      const unit = units[mint];
      const balanceInSats = getBalanceInSats(rawBalance, unit);
      return balanceInSats >= amount;
    };

    if (
      preferredMintUrl &&
      canUseMint(preferredMintUrl) &&
      !candidates.includes(preferredMintUrl)
    ) {
      candidates.push(preferredMintUrl);
    }

    for (const mint in balances) {
      if (mint === preferredMintUrl || candidates.includes(mint)) continue;
      if (canUseMint(mint)) {
        candidates.push(mint);
      }
    }

    return candidates;
  }

  private async _refundOtherProvidersForTopUp(
    baseUrl: string,
    mintUrl: string
  ): Promise<void> {
    const pendingDistribution =
      this.storageAdapter.getCachedTokenDistribution();

    const toRefund = pendingDistribution.filter(
      (pending) => pending.baseUrl !== baseUrl
    );

    const refundResults = await Promise.allSettled(
      toRefund.map(async (pending) => {
        const token = this.storageAdapter.getToken(pending.baseUrl);
        if (!token) {
          return { baseUrl: pending.baseUrl, success: false };
        }

        const tokenBalance = await this.getTokenBalance(token, pending.baseUrl);
        if (tokenBalance.reserved > 0) {
          return { baseUrl: pending.baseUrl, success: false };
        }

        const result = await this.refund({
          mintUrl,
          baseUrl: pending.baseUrl,
          token,
        });

        return { baseUrl: pending.baseUrl, success: result.success };
      })
    );

    for (const result of refundResults) {
      if (result.status === "fulfilled" && result.value.success) {
        this.storageAdapter.removeToken(result.value.baseUrl);
      }
    }
  }

  /**
   * Fetch refund token from provider API
   */
  private async _fetchRefundToken(
    baseUrl: string,
    storedToken: string
  ): Promise<{
    success: boolean;
    token?: string;
    requestId?: string;
    error?: string;
  }> {
    if (!baseUrl) {
      return {
        success: false,
        error: "No base URL configured",
      };
    }

    const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

    const url = `${normalizedBaseUrl}v1/wallet/refund`;

    // Create an AbortController for timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 60000); // 1 minute timeout

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const requestId =
        response.headers.get("x-routstr-request-id") || undefined;

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        if (
          response.status === 400 &&
          errorData?.detail === "No balance to refund"
        ) {
          this.storageAdapter.removeToken(baseUrl);
          return {
            success: false,
            requestId,
            error: "No balance to refund",
          };
        }

        return {
          success: false,
          requestId,
          error: `Refund request failed with status ${response.status}: ${
            errorData?.detail || response.statusText
          }`,
        };
      }

      const data = await response.json();
      console.log("refund rsule", data);
      return {
        success: true,
        token: data.token,
        requestId,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("[BalanceManager._fetchRefundToken] Fetch error", error);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          return {
            success: false,
            error: "Request timed out after 1 minute",
          };
        }
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: false,
        error: "Unknown error occurred during refund request",
      };
    }
  }

  /**
   * Post topup request to provider API
   */
  private async _postTopUp(
    baseUrl: string,
    storedToken: string,
    cashuToken: string
  ): Promise<{
    success: boolean;
    requestId?: string;
    error?: string;
  }> {
    if (!baseUrl) {
      return {
        success: false,
        error: "No base URL configured",
      };
    }

    const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const url = `${normalizedBaseUrl}v1/wallet/topup?cashu_token=${encodeURIComponent(
      cashuToken
    )}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 60000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const requestId =
        response.headers.get("x-routstr-request-id") || undefined;

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          requestId,
          error:
            errorData?.detail || `Top up failed with status ${response.status}`,
        };
      }

      return { success: true, requestId };
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("[BalanceManager._postTopUp] Fetch error", error);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          return {
            success: false,
            error: "Request timed out after 1 minute",
          };
        }
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: false,
        error: "Unknown error occurred during top up request",
      };
    }
  }

  /**
   * Attempt to receive token back after failed top up
   */
  private async _recoverFailedTopUp(cashuToken: string): Promise<void> {
    try {
      await this.cashuSpender.receiveToken(cashuToken);
    } catch (error) {
      console.error(
        "[BalanceManager._recoverFailedTopUp] Failed to recover token",
        error
      );
    }
  }

  /**
   * Handle refund errors with specific error types
   */
  private _handleRefundError(
    error: unknown,
    mintUrl: string,
    requestId?: string
  ): RefundResult {
    if (error instanceof Error) {
      // Network errors
      if (isNetworkErrorMessage(error.message)) {
        return {
          success: false,
          message: `Failed to connect to the mint: ${mintUrl}`,
          requestId,
        };
      }

      // Wallet not found error
      if (error.message.includes("Wallet not found")) {
        return {
          success: false,
          message: `Wallet couldn't be loaded. Please save this refunded cashu token manually.`,
          requestId,
        };
      }

      return {
        success: false,
        message: error.message,
        requestId,
      };
    }

    return {
      success: false,
      message: "Refund failed",
      requestId,
    };
  }

  /**
   * Get token balance from provider
   */
  async getTokenBalance(
    token: string,
    baseUrl: string
  ): Promise<{
    amount: number;
    reserved: number;
    unit: "sat" | "msat";
    apiKey: string;
  }> {
    try {
      const response = await fetch(`${baseUrl}v1/wallet/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        console.log("TOKENA FASJDFAS", data);
        return {
          amount: data.balance,
          reserved: data.reserved ?? 0,
          unit: "msat",
          apiKey: data.api_key,
        };
      } else {
        console.log(response.status);
        const data = await response.json();
        console.log("FAILED ", data);
      }
    } catch (error) {
      console.error("ERRORR IN RESTPONSE", error);
      // Fall through to default
    }

    return { amount: -1, reserved: 0, unit: "sat", apiKey: "" };
  }

  /**
   * Handle topup errors with specific error types
   */
  private _handleTopUpError(
    error: unknown,
    mintUrl: string,
    requestId?: string
  ): TopUpResult {
    if (error instanceof Error) {
      if (isNetworkErrorMessage(error.message)) {
        return {
          success: false,
          message: `Failed to connect to the mint: ${mintUrl}`,
          requestId,
        };
      }

      if (error.message.includes("Wallet not found")) {
        return {
          success: false,
          message:
            "Wallet couldn't be loaded. The cashu token was recovered locally.",
          requestId,
        };
      }

      return {
        success: false,
        message: error.message,
        requestId,
      };
    }

    return {
      success: false,
      message: "Top up failed",
      requestId,
    };
  }
}
