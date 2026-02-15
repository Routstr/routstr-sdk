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

import type {
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
} from "./interfaces";
import type { SpendResult, MintSelection } from "../core/types";
import {
  InsufficientBalanceError,
  MintUnreachableError,
  TokenOperationError,
} from "../core/errors";

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
}

/**
 * CashuSpender manages the spending of Cashu tokens
 */
export class CashuSpender {
  private _isBusy = false;

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private providerRegistry?: ProviderRegistry
  ) {}

  /**
   * Check if the spender is currently in a critical operation
   */
  get isBusy(): boolean {
    return this._isBusy;
  }

  /**
   * Spend Cashu tokens with automatic mint selection and retry logic
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

    // Enter critical section
    this._isBusy = true;

    try {
      return await this._spendInternal({
        mintUrl,
        amount,
        baseUrl,
        reuseToken,
        p2pkPubkey,
        excludeMints,
        retryCount,
      });
    } finally {
      this._isBusy = false;
    }
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

    // Validate amount
    let adjustedAmount = Math.ceil(amount);
    if (!adjustedAmount || isNaN(adjustedAmount)) {
      return {
        token: null,
        status: "failed",
        balance: 0,
        error: "Please enter a valid amount",
      };
    }

    // Try to get existing token for reuse
    if (reuseToken && baseUrl) {
      const existingResult = await this._tryReuseToken(
        baseUrl,
        adjustedAmount,
        mintUrl
      );
      if (existingResult) {
        return existingResult;
      }
    }

    // Get current balances
    const balances = await this.walletAdapter.getBalances();
    const units = this.walletAdapter.getMintUnits();

    // Calculate total available balance
    let totalBalance = 0;
    for (const url in balances) {
      const balance = balances[url];
      const unit = units[url];
      const balanceInSats = unit === "msat" ? balance / 1000 : balance;
      totalBalance += balanceInSats;
    }

    // Check pending tokens
    const pendingDistribution =
      this.storageAdapter.getPendingTokenDistribution();
    const totalPending = pendingDistribution.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    // Check if we need to refund pending tokens to free up balance
    if (
      totalBalance < adjustedAmount &&
      totalPending > 0 &&
      (retryCount ?? 0) < 1
    ) {
      return await this._refundAndRetry(options);
    }

    const totalAvailableBalance = totalBalance + totalPending;

    // Check total balance
    if (totalAvailableBalance < adjustedAmount) {
      return this._createInsufficientBalanceError(
        adjustedAmount,
        balances,
        units,
        totalAvailableBalance
      );
    }

    // Select mint with sufficient balance
    let { selectedMintUrl, selectedMintBalance } = this._selectMintWithBalance(
      balances,
      units,
      adjustedAmount,
      excludeMints
    );

    // Check provider mint compatibility if provider registry is available
    if (selectedMintUrl && baseUrl && this.providerRegistry) {
      const providerMints = this.providerRegistry.getProviderMints(baseUrl);

      if (
        providerMints.length > 0 &&
        !providerMints.includes(selectedMintUrl)
      ) {
        // Try to find an alternate mint that the provider accepts
        const alternateResult = await this._findAlternateMint(
          options,
          balances,
          units,
          providerMints
        );

        if (alternateResult) {
          return alternateResult;
        }

        // If no alternate found, add fee for unsupported mint
        adjustedAmount += 2;
      }
    }

    // Check active mint balance
    const activeMintBalance = balances[mintUrl] || 0;
    const activeMintUnit = units[mintUrl];
    const activeMintBalanceInSats =
      activeMintUnit === "msat" ? activeMintBalance / 1000 : activeMintBalance;

    let token: string | null = null;

    if (
      activeMintBalanceInSats >= adjustedAmount &&
      (baseUrl === "" || !this.providerRegistry)
    ) {
      // Use active mint (either no provider or provider accepts it)
      try {
        token = await this.walletAdapter.sendToken(
          mintUrl,
          adjustedAmount,
          p2pkPubkey
        );
      } catch (error) {
        return this._handleSendError(error, options, balances, units);
      }
    } else if (selectedMintUrl && selectedMintBalance >= adjustedAmount) {
      // Use selected alternate mint
      try {
        token = await this.walletAdapter.sendToken(
          selectedMintUrl,
          adjustedAmount,
          p2pkPubkey
        );
      } catch (error) {
        return this._handleSendError(error, options, balances, units);
      }
    } else {
      // Insufficient balance
      return this._createInsufficientBalanceError(
        adjustedAmount,
        balances,
        units
      );
    }

    // Store token and return
    if (token && baseUrl) {
      this.storageAdapter.setToken(baseUrl, token);
    }

    return {
      token,
      status: "success",
      balance: adjustedAmount,
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
      this.storageAdapter.getPendingTokenDistribution();
    const balanceForBaseUrl =
      pendingDistribution.find((b) => b.baseUrl === baseUrl)?.amount || 0;

    if (balanceForBaseUrl > amount) {
      return {
        token: storedToken,
        status: "success",
        balance: balanceForBaseUrl,
      };
    }

    // Token exists but insufficient balance - attempt refund
    // This requires RefundManager, which we'll integrate later
    return null;
  }

  /**
   * Refund pending tokens and retry
   */
  private async _refundAndRetry(options: SpendOptions): Promise<SpendResult> {
    const { mintUrl, baseUrl, excludeMints, retryCount } = options;

    const pendingDistribution =
      this.storageAdapter.getPendingTokenDistribution();

    // Refund all pending tokens
    for (const pending of pendingDistribution) {
      const token = this.storageAdapter.getToken(pending.baseUrl);
      if (token) {
        // Remove token from storage (refund will be handled by caller or RefundManager)
        this.storageAdapter.removeToken(pending.baseUrl);
      }
    }

    // Retry with refunded balance
    return this._spendInternal({
      ...options,
      retryCount: (retryCount || 0) + 1,
    });
  }

  /**
   * Find an alternate mint that the provider accepts
   */
  private async _findAlternateMint(
    options: SpendOptions,
    balances: Record<string, number>,
    units: Record<string, string>,
    providerMints: string[]
  ): Promise<SpendResult | null> {
    const { amount, excludeMints } = options;
    const adjustedAmount = Math.ceil(amount) + 2; // Add fee for unsupported mint

    const extendedExcludes = [...(excludeMints || [])];

    while (true) {
      const { selectedMintUrl } = this._selectMintWithBalance(
        balances,
        units,
        adjustedAmount,
        extendedExcludes
      );

      if (!selectedMintUrl) break;

      if (providerMints.includes(selectedMintUrl)) {
        // Found an acceptable mint
        try {
          const token = await this.walletAdapter.sendToken(
            selectedMintUrl,
            adjustedAmount
          );

          if (options.baseUrl) {
            this.storageAdapter.setToken(options.baseUrl, token);
          }

          return {
            token,
            status: "success",
            balance: adjustedAmount,
          };
        } catch (error) {
          // Continue to next mint
          extendedExcludes.push(selectedMintUrl);
        }
      } else {
        extendedExcludes.push(selectedMintUrl);
      }
    }

    return null;
  }

  /**
   * Handle send errors with retry logic for network errors
   */
  private async _handleSendError(
    error: unknown,
    options: SpendOptions,
    balances: Record<string, number>,
    units: Record<string, string>
  ): Promise<SpendResult> {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Check for network errors
    const isNetworkError =
      error instanceof Error &&
      (error.message.includes(
        "NetworkError when attempting to fetch resource"
      ) ||
        error.message.includes("Failed to fetch") ||
        error.message.includes("Load failed"));

    if (isNetworkError) {
      const { mintUrl, amount, baseUrl, p2pkPubkey, excludeMints, retryCount } =
        options;

      // Try alternate mint
      const extendedExcludes = [...(excludeMints || []), mintUrl];
      const { selectedMintUrl } = this._selectMintWithBalance(
        balances,
        units,
        Math.ceil(amount),
        extendedExcludes
      );

      if (selectedMintUrl && (retryCount || 0) < Object.keys(balances).length) {
        return this._spendInternal({
          ...options,
          mintUrl: selectedMintUrl,
          excludeMints: extendedExcludes,
          retryCount: (retryCount || 0) + 1,
        });
      }

      // No more alternate mints
      throw new MintUnreachableError(mintUrl);
    }

    // Other errors
    return {
      token: null,
      status: "failed",
      balance: 0,
      error: `Error generating token: ${errorMsg}`,
    };
  }

  /**
   * Select a mint with sufficient balance
   */
  private _selectMintWithBalance(
    balances: Record<string, number>,
    units: Record<string, string>,
    amount: number,
    excludeMints: string[] = []
  ): MintSelection {
    for (const mintUrl in balances) {
      if (excludeMints.includes(mintUrl)) {
        continue;
      }

      const balance = balances[mintUrl];
      const unit = units[mintUrl];
      const balanceInSats = unit === "msat" ? balance / 1000 : balance;

      if (balanceInSats >= amount) {
        return { selectedMintUrl: mintUrl, selectedMintBalance: balanceInSats };
      }
    }

    return { selectedMintUrl: null, selectedMintBalance: 0 };
  }

  /**
   * Create an insufficient balance error result
   */
  private _createInsufficientBalanceError(
    required: number,
    balances: Record<string, number>,
    units: Record<string, string>,
    availableBalance?: number
  ): SpendResult {
    let maxBalance = 0;
    let maxMintUrl = "";

    for (const mintUrl in balances) {
      const balance = balances[mintUrl];
      const unit = units[mintUrl];
      const balanceInSats = unit === "msat" ? balance / 1000 : balance;

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
    };
  }
}
