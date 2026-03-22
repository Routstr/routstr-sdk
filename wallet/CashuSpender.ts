/**
 * CashuSpender - Core spending logic for Cashu tokens
 *
 * Handles:
 * - Mint selection with sufficient balance
 * - Provider mint compatibility checks
 * - Retry logic with alternate mints
 * - Critical section management (busy state)
 *
 * Extracted from hooks/useCashuWithXYZ.ts
 */

import type { WalletAdapter, StorageAdapter } from "./interfaces";
import type { SpendResult } from "../core/types";
import { InsufficientBalanceError } from "../core/errors";
import { BalanceManager } from "./BalanceManager";
import { auditLogger } from "./AuditLogger";
import { getBalanceInSats, isNetworkErrorMessage } from "./tokenUtils";

/**
 * Options for spending cashu tokens
 */
export interface SpendOptions {
  /** The mint URL to send from (can be overridden if insufficient balance) */
  mintUrl: string;

  /** The amount to spend in sats */
  amount: number;

  /** The provider base URL (for token storage and provider mint checks) */
  baseUrl: string;

  /** Whether to reuse an existing token if available */
  reuseToken?: boolean;

  /** Optional P2PK public key */
  p2pkPubkey?: string;

  /** Array of mint URLs to exclude (for retry logic) */
  excludeMints?: string[];

  /** Current retry count (for internal recursion) */
  retryCount?: number;

  /** Specific provider baseUrls to refund (if not provided, refunds all except current) */
  refundBaseUrls?: string[];
}

type DebugLevel = "DEBUG" | "WARN" | "ERROR";

/**
 * CashuSpender manages the spending of Cashu tokens
 */
export class CashuSpender {
  private _isBusy = false;
  private debugLevel: DebugLevel = "WARN";

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private _providerRegistry?: unknown,
    private balanceManager?: BalanceManager
  ) {}

  async receiveToken(token: string): Promise<{
    success: boolean;
    amount: number;
    unit: "sat" | "msat";
    message?: string;
  }> {
    const result = await this.walletAdapter.receiveToken(token);

    if (!result.success && result.message?.includes("Failed to fetch mint")) {
      const cachedTokens = this.storageAdapter.getCachedReceiveTokens();
      const existingIndex = cachedTokens.findIndex((t) => t.token === token);
      if (existingIndex === -1) {
        this.storageAdapter.setCachedReceiveTokens([
          ...cachedTokens,
          {
            token,
            amount: result.amount,
            unit: result.unit,
            createdAt: Date.now(),
          },
        ]);
      }
    }

    return result;
  }

  private async _getBalanceState(): Promise<{
    totalBalance: number;
    providerBalances: Record<string, number>;
    mintBalances: Record<string, number>;
  }> {
    if (this.balanceManager) {
      return this.balanceManager.getBalanceState();
    }

    const mintBalances = await this.walletAdapter.getBalances();
    const units = this.walletAdapter.getMintUnits();

    let totalMintBalance = 0;
    const normalizedMintBalances: Record<string, number> = {};
    for (const url in mintBalances) {
      const balance = mintBalances[url];
      const unit = units[url];
      const balanceInSats = getBalanceInSats(balance, unit);
      normalizedMintBalances[url] = balanceInSats;
      totalMintBalance += balanceInSats;
    }

    const pendingDistribution =
      this.storageAdapter.getCachedTokenDistribution();
    const providerBalances: Record<string, number> = {};
    let totalProviderBalance = 0;
    for (const pending of pendingDistribution) {
      providerBalances[pending.baseUrl] =
        (providerBalances[pending.baseUrl] || 0) + pending.amount;
      totalProviderBalance += pending.amount;
    }

    const apiKeys = this.storageAdapter.getAllApiKeys();
    for (const apiKey of apiKeys) {
      if (!providerBalances[apiKey.baseUrl]) {
        providerBalances[apiKey.baseUrl] = 0;
      }
      providerBalances[apiKey.baseUrl] += apiKey.balance;
      totalProviderBalance += apiKey.balance;
    }

    return {
      totalBalance: totalMintBalance + totalProviderBalance,
      providerBalances,
      mintBalances: normalizedMintBalances,
    };
  }

  private async _logTransaction(
    action: "spend" | "topup" | "refund" | "receive" | "balance_check",
    options?: {
      amount?: number;
      mintUrl?: string;
      baseUrl?: string;
      status?: "success" | "failed";
      details?: string;
    }
  ): Promise<void> {
    const balanceState = await this._getBalanceState();
    await auditLogger.logBalanceSnapshot(action, balanceState, options);
  }

  /**
   * Check if the spender is currently in a critical operation
   */
  get isBusy(): boolean {
    return this._isBusy;
  }

  getDebugLevel(): DebugLevel {
    return this.debugLevel;
  }

  setDebugLevel(level: DebugLevel): void {
    this.debugLevel = level;
  }

  private _log(level: "DEBUG" | "WARN" | "ERROR", ...args: unknown[]): void {
    const levelPriority: Record<DebugLevel, number> = {
      DEBUG: 0,
      WARN: 1,
      ERROR: 2,
    };

    if (levelPriority[level] >= levelPriority[this.debugLevel]) {
      switch (level) {
        case "DEBUG":
          console.log(...args);
          break;
        case "WARN":
          console.warn(...args);
          break;
        case "ERROR":
          console.error(...args);
          break;
      }
    }
  }

  /**
   * Spend Cashu tokens with automatic mint selection and retry logic
   * Throws errors on failure instead of returning failed SpendResult
   */
  async spend(options: SpendOptions): Promise<SpendResult> {
    const {
      mintUrl,
      amount,
      baseUrl,
      reuseToken = false,
      p2pkPubkey,
      excludeMints = [],
      retryCount = 0,
    } = options;

    this._isBusy = true;

    try {
      const result = await this._spendInternal({
        mintUrl,
        amount,
        baseUrl,
        reuseToken,
        p2pkPubkey,
        excludeMints,
        retryCount,
      });

      if (result.status === "failed" || !result.token) {
        const errorMsg =
          result.error || `Insufficient balance. Need ${amount} sats.`;

        if (this._isNetworkError(errorMsg)) {
          throw new Error(
            `Your mint ${mintUrl} is unreachable or is blocking your IP. Please try again later or switch mints.`
          );
        }

        if (result.errorDetails) {
          throw new InsufficientBalanceError(
            result.errorDetails.required,
            result.errorDetails.available,
            result.errorDetails.maxMintBalance,
            result.errorDetails.maxMintUrl
          );
        }

        throw new Error(errorMsg);
      }

      return result;
    } finally {
      this._isBusy = false;
    }
  }

  /**
   * Check if error message indicates a network error
   */
  private _isNetworkError(message: string): boolean {
    return (
      isNetworkErrorMessage(message) ||
      (message.includes("Your mint") && message.includes("unreachable"))
    );
  }

  /**
   * Internal spending logic
   */
  private async _spendInternal(options: SpendOptions): Promise<SpendResult> {
    let {
      mintUrl,
      amount,
      baseUrl,
      reuseToken,
      p2pkPubkey,
      excludeMints,
      retryCount,
    } = options;

    this._log(
      "DEBUG",
      `[CashuSpender] _spendInternal: amount=${amount}, mintUrl=${mintUrl}, baseUrl=${baseUrl}, reuseToken=${reuseToken}`
    );

    // Validate amount
    let adjustedAmount = Math.ceil(amount);
    if (!adjustedAmount || isNaN(adjustedAmount)) {
      this._log(
        "ERROR",
        `[CashuSpender] _spendInternal: Invalid amount: ${amount}`
      );
      return {
        token: null,
        status: "failed",
        balance: 0,
        error: "Please enter a valid amount",
      };
    }

    // Try to get existing token for reuse
    if (reuseToken && baseUrl) {
      this._log(
        "DEBUG",
        `[CashuSpender] _spendInternal: Attempting to reuse token for ${baseUrl}`
      );
      const existingResult = await this._tryReuseToken(
        baseUrl,
        adjustedAmount,
        mintUrl
      );
      if (existingResult) {
        this._log(
          "DEBUG",
          `[CashuSpender] _spendInternal: Successfully reused token, balance: ${existingResult.balance}`
        );
        return existingResult;
      }
      this._log(
        "DEBUG",
        `[CashuSpender] _spendInternal: Could not reuse token, will create new token`
      );
    }

    // Get current balance state
    const balanceState = await this._getBalanceState();
    const totalAvailableBalance = balanceState.totalBalance;

    this._log(
      "DEBUG",
      `[CashuSpender] _spendInternal: totalAvailableBalance=${totalAvailableBalance}, adjustedAmount=${adjustedAmount}`
    );

    // Check total balance
    if (totalAvailableBalance < adjustedAmount) {
      this._log(
        "ERROR",
        `[CashuSpender] _spendInternal: Insufficient balance, have=${totalAvailableBalance}, need=${adjustedAmount}`
      );
      return this._createInsufficientBalanceError(
        adjustedAmount,
        balanceState.mintBalances,
        totalAvailableBalance
      );
    }

    let token: string | null = null;
    let selectedMintUrl: string | undefined;
    let spentAmount = adjustedAmount;

    if (this.balanceManager) {
      const tokenResult = await this.balanceManager.createProviderToken({
        mintUrl,
        baseUrl,
        amount: adjustedAmount,
        p2pkPubkey,
        excludeMints,
        retryCount,
      });

      if (!tokenResult.success || !tokenResult.token) {
        if ((tokenResult.error || "").includes("Insufficient balance")) {
          return this._createInsufficientBalanceError(
            adjustedAmount,
            balanceState.mintBalances,
            totalAvailableBalance
          );
        }

        return {
          token: null,
          status: "failed",
          balance: 0,
          error: tokenResult.error || "Failed to create token",
        };
      }

      token = tokenResult.token;
      selectedMintUrl = tokenResult.selectedMintUrl;
      spentAmount = tokenResult.amountSpent || adjustedAmount;
    } else {
      try {
        token = await this.walletAdapter.sendToken(
          mintUrl,
          adjustedAmount,
          p2pkPubkey
        );
        selectedMintUrl = mintUrl;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          token: null,
          status: "failed",
          balance: 0,
          error: `Error generating token: ${errorMsg}`,
        };
      }
    }

    // Store token and return
    if (token && baseUrl) {
      try {
        this.storageAdapter.setToken(baseUrl, token);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Token already exists")
        ) {
          this._log(
            "DEBUG",
            `[CashuSpender] _spendInternal: Token already exists for ${baseUrl}, receiving newly created token and using existing`
          );
          const receiveResult = await this.receiveToken(token);
          if (receiveResult.success) {
            this._log(
              "DEBUG",
              `[CashuSpender] _spendInternal: Token restored successfully, amount=${receiveResult.amount}`
            );
          }
          token = this.storageAdapter.getToken(baseUrl);
        } else {
          throw error;
        }
      }
    }

    this._logTransaction("spend", {
      amount: spentAmount,
      mintUrl: selectedMintUrl || mintUrl,
      baseUrl,
      status: "success",
    });

    this._log(
      "DEBUG",
      `[CashuSpender] _spendInternal: Successfully spent ${spentAmount}, returning token with balance=${spentAmount}`
    );

    const units = this.walletAdapter.getMintUnits();

    return {
      token,
      status: "success",
      balance: spentAmount,
      unit:
        (selectedMintUrl ? units[selectedMintUrl] : units[mintUrl]) || "sat",
    };
  }

  /**
   * Try to reuse an existing token
   */
  private async _tryReuseToken(
    baseUrl: string,
    amount: number,
    mintUrl: string
  ): Promise<SpendResult | null> {
    const storedToken = this.storageAdapter.getToken(baseUrl);
    if (!storedToken) return null;

    // Get pending distribution to check balance
    const pendingDistribution =
      this.storageAdapter.getCachedTokenDistribution();
    const balanceForBaseUrl =
      pendingDistribution.find((b) => b.baseUrl === baseUrl)?.amount || 0;

    this._log("DEBUG", "RESUINGDSR GSODGNSD", balanceForBaseUrl, amount);

    if (balanceForBaseUrl > amount) {
      const units = this.walletAdapter.getMintUnits();
      const unit = units[mintUrl] || "sat";
      return {
        token: storedToken,
        status: "success",
        balance: balanceForBaseUrl,
        unit,
      };
    }

    // Token exists but insufficient balance - attempt topup
    if (this.balanceManager) {
      const topUpAmount = Math.ceil(amount * 1.2 - balanceForBaseUrl);
      const topUpResult = await this.balanceManager.topUp({
        mintUrl,
        baseUrl,
        amount: topUpAmount,
      });
      this._log("DEBUG", "TOPUP ", topUpResult);

      if (topUpResult.success && topUpResult.toppedUpAmount) {
        const newBalance = balanceForBaseUrl + topUpResult.toppedUpAmount;
        const units = this.walletAdapter.getMintUnits();
        const unit = units[mintUrl] || "sat";

        this._logTransaction("topup", {
          amount: topUpResult.toppedUpAmount,
          mintUrl,
          baseUrl,
          status: "success",
        });

        return {
          token: storedToken,
          status: "success",
          balance: newBalance,
          unit,
        };
      }

      const providerBalance = await this._getProviderTokenBalance(
        baseUrl,
        storedToken
      );
      this._log("DEBUG", providerBalance);
      if (providerBalance <= 0) {
        this.storageAdapter.removeToken(baseUrl);
      }
    }

    return null;
  }

  /**
   * Refund specific providers without retrying spend
   */
  async refundProviders(
    baseUrls: string[],
    mintUrl: string,
    refundApiKeys: boolean = false
  ): Promise<{ baseUrl: string; success: boolean }[]> {
    const results: { baseUrl: string; success: boolean }[] = [];

    const pendingDistribution =
      this.storageAdapter.getCachedTokenDistribution();

    const toRefund = pendingDistribution.filter((p) =>
      baseUrls.includes(p.baseUrl)
    );

    const refundResults = await Promise.allSettled(
      toRefund.map(async (pending) => {
        const token = this.storageAdapter.getToken(pending.baseUrl);
        this._log("DEBUG", token, this.balanceManager);
        if (!token || !this.balanceManager) {
          return { baseUrl: pending.baseUrl, success: false };
        }

        const tokenBalance = await this.balanceManager.getTokenBalance(
          token,
          pending.baseUrl
        );

        if (tokenBalance.reserved > 0) {
          return { baseUrl: pending.baseUrl, success: false };
        }

        const result = await this.balanceManager.refund({
          mintUrl,
          baseUrl: pending.baseUrl,
          token,
        });
        this._log("DEBUG", result);

        if (result.success) {
          this.storageAdapter.removeToken(pending.baseUrl);
        }

        return { baseUrl: pending.baseUrl, success: result.success };
      })
    );

    results.push(
      ...refundResults.map((r) =>
        r.status === "fulfilled" ? r.value : { baseUrl: "", success: false }
      )
    );

    if (refundApiKeys) {
      const apiKeyDistribution = this.storageAdapter.getApiKeyDistribution();
      const apiKeysToRefund = apiKeyDistribution.filter((p) =>
        baseUrls.includes(p.baseUrl)
      );

      for (const apiKeyEntry of apiKeysToRefund) {
        const apiKeyEntryFull = this.storageAdapter.getApiKey(
          apiKeyEntry.baseUrl
        );
        if (apiKeyEntryFull && this.balanceManager) {
          const refundResult = await this.balanceManager.refundApiKey({
            mintUrl,
            baseUrl: apiKeyEntry.baseUrl,
            apiKey: apiKeyEntryFull.key,
          });

          if (refundResult.success) {
            this.storageAdapter.updateApiKeyBalance(apiKeyEntry.baseUrl, 0);
          }

          results.push({
            baseUrl: apiKeyEntry.baseUrl,
            success: refundResult.success,
          });
        } else {
          results.push({
            baseUrl: apiKeyEntry.baseUrl,
            success: false,
          });
        }
      }
    }

    return results;
  }

  /**
   * Create an insufficient balance error result
   */
  private _createInsufficientBalanceError(
    required: number,
    normalizedBalances: Record<string, number>,
    availableBalance?: number
  ): SpendResult {
    let maxBalance = 0;
    let maxMintUrl = "";

    for (const mintUrl in normalizedBalances) {
      const balanceInSats = normalizedBalances[mintUrl];

      if (balanceInSats > maxBalance) {
        maxBalance = balanceInSats;
        maxMintUrl = mintUrl;
      }
    }

    const error = new InsufficientBalanceError(
      required,
      availableBalance ?? maxBalance,
      maxBalance,
      maxMintUrl
    );

    return {
      token: null,
      status: "failed",
      balance: 0,
      error: error.message,
      errorDetails: {
        required,
        available: availableBalance ?? maxBalance,
        maxMintBalance: maxBalance,
        maxMintUrl,
      },
    };
  }

  private async _getProviderTokenBalance(
    baseUrl: string,
    token: string
  ): Promise<number> {
    try {
      const response = await fetch(`${baseUrl}v1/wallet/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        return data.balance / 1000;
      }
    } catch {
      return 0;
    }
    return 0;
  }
}
