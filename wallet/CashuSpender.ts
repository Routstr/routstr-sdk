import { awaitWithAbort } from "../client/abortable";
import { throwIfFundingAborted } from "./fundingCancellation";
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

import type { RecoveryCredential, WalletAdapter, StorageAdapter } from "./interfaces";
import type { SpendResult, SdkLogger } from "../core/types";
import { consoleLogger } from "../core/types";
import { InsufficientBalanceError, ProviderMintBalanceError } from "../core/errors";
import {
  CoreErrorType,
  isHandledRedemptionError,
} from "../core/errorTypes";
import { BalanceManager } from "./BalanceManager";
import { persistApiKeyBalance } from "./apiKeyBalance";
import { getBalanceInSats, isNetworkErrorMessage } from "./tokenUtils";
import { getTokenMetadata } from "@cashu/cashu-ts";

/**
 * Options for spending cashu tokens
 */
export interface SpendOptions {
  signal?: AbortSignal;
  /** The mint URL to send from (can be overridden if insufficient balance) */
  mintUrl: string;

  /** The amount to spend in sats */
  amount: number;

  /** The provider base URL (for token storage and provider mint checks) */
  baseUrl: string;

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
type ReceiveResult = Awaited<ReturnType<WalletAdapter["receiveToken"]>>;
type RecoveryResult = ReceiveResult & { pending?: boolean };

/**
 * CashuSpender manages the spending of Cashu tokens
 */
export class CashuSpender {
  private _isBusy = false;
  private debugLevel: DebugLevel = "WARN";
  private readonly logger: SdkLogger;

  /** Maximum number of retry attempts for a 404 "Refund not found" xcashu token
   *  before moving its original token to cached receive storage. */
  private static readonly MAX_REFUND_RETRIES = 3;

  /** Interval (ms) between background refund retries for 404 xcashu tokens. */
  private static readonly REFUND_RETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

  /** Handle for the background refund-retry interval, or null when not running. */
  private _refundRetryInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private _discoveryAdapter?: unknown,
    private balanceManager?: BalanceManager,
    logger?: SdkLogger
  ) {
    this.logger = (logger ?? consoleLogger).child("CashuSpender");
  }

  /** Disable failure caching when a durable xcashu record already owns recovery. */
  async receiveToken(token: string, cacheOnFailure = true): Promise<ReceiveResult> {
    try {
      const result = await this.walletAdapter.receiveToken(token);
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (cacheOnFailure && errorMessage.includes("Failed to fetch mint")) {
        this.cacheReceiveToken(token);
      }

      const { amount, unit } = this._decodeTokenAmount(token);
      return { success: false, amount, unit, message: errorMessage };
    }
  }

  /** Bound only the foreground wait. Shared recovery is independent of callers. */
  async receiveTokenForRecovery(
    token: string,
    signal?: AbortSignal,
    credential?: RecoveryCredential,
    timeoutMs = 10_000,
  ): Promise<RecoveryResult> {
    throwIfFundingAborted(signal);
    this.cacheReceiveToken(token, credential);
    const operation = this.startCachedReceive(token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await awaitWithAbort(Promise.race([
        operation,
        new Promise<RecoveryResult>(resolve => {
          timer = setTimeout(() => resolve({
            success: false,
            pending: true,
            ...this._decodeTokenAmount(token),
            message: "Payment recovery timed out; recovery remains pending",
          }), timeoutMs);
        }),
      ]), signal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private readonly pendingReceives = new Map<string, Promise<ReceiveResult>>();

  private startCachedReceive(token: string): Promise<ReceiveResult> {
    const pending = this.pendingReceives.get(token);
    if (pending) return pending;
    // Register before flushing, and keep ownership through cache/credential updates.
    const work = Promise.resolve().then(async () => {
      await this.storageAdapter.flush?.();
      const cached = this.storageAdapter.getCachedReceiveTokens().find(entry => entry.token === token);
      const result = cached?.received
        ? { success: true, amount: cached.amount, unit: cached.unit, message: undefined }
        : await this.receiveToken(token);
      const spent = /already spent/i.test(result.message ?? "");
      if (result.success || spent) {
        await this.finishCachedReceive(token, result, cached?.received === true);
      } else if (/^invalid (?:cashu )?token(?:$|:)/i.test(result.message?.trim() ?? "")) {
        // Keep ambiguous errors for retry; discard only conclusively malformed proofs.
        this.evictCachedReceiveToken(token);
      }
      return result;
    }).finally(() => { this.pendingReceives.delete(token); });
    this.pendingReceives.set(token, work);
    return work;
  }

  private async finishCachedReceive(token: string, result: ReceiveResult, alreadyRecorded: boolean): Promise<void> {
    const cleaned = new Set<string>();
    const identity = ({ mode, baseUrl, token }: RecoveryCredential) => JSON.stringify([mode, baseUrl, token]);
    // An already-spent original may still be a claim on a provider. A
    // distinct X-Cashu refund was already issued, so its old IOU is obsolete.
    const cleanup = () => (this.storageAdapter.getCachedReceiveTokens().find(entry => entry.token === token)?.cleanup ?? [])
      .filter(credential => result.success || (credential.mode === "xcashu" && credential.token !== token));
    let owners = cleanup();
    // Leave a receipt while credential removal is pending, so a restart can
    // finish cleanup without sending already-received proofs to the mint again.
    if (owners.length > 0 && result.success && !alreadyRecorded && this.storageAdapter.flush) {
      this.storageAdapter.setCachedReceiveTokens(this.storageAdapter.getCachedReceiveTokens().map(entry =>
        entry.token === token ? { ...entry, amount: result.amount, unit: result.unit, received: true } : entry
      ));
    }
    while (owners.length > 0) {
      for (const credential of owners) {
        const { mode, baseUrl, token: credentialToken } = credential;
        if (mode === "xcashu") {
          this.storageAdapter.removeXcashuToken(baseUrl, credentialToken);
        } else if (this.storageAdapter.getApiKey(baseUrl)?.key === credentialToken) {
          this.storageAdapter.removeApiKey(baseUrl);
        }
        cleaned.add(identity(credential));
      }
      // Never evict the record before credential removal reaches storage.
      if (!this.storageAdapter.flush) break;
      await this.storageAdapter.flush();
      // A foreground caller may have joined while storage was flushing.
      owners = cleanup().filter(credential => !cleaned.has(identity(credential)));
    }
    this.evictCachedReceiveToken(token);
  }

  private evictCachedReceiveToken(token: string): void {
    this.storageAdapter.setCachedReceiveTokens(
      this.storageAdapter.getCachedReceiveTokens().filter(entry => entry.token !== token)
    );
  }

  /** Preserve a recovery token and merge any credential association. */
  cacheReceiveToken(token: string, credential?: RecoveryCredential): void {
    const cached = this.storageAdapter.getCachedReceiveTokens();
    const existing = cached.find(entry => entry.token === token);
    if (existing) {
      if (!credential || existing.cleanup?.some(candidate =>
        candidate.mode === credential.mode && candidate.baseUrl === credential.baseUrl &&
        candidate.token === credential.token
      )) return;
      this.storageAdapter.setCachedReceiveTokens(cached.map(entry => entry === existing
        ? { ...entry, cleanup: [...(entry.cleanup ?? []), credential] }
        : entry));
      return;
    }
    const { amount, unit } = this._decodeTokenAmount(token);
    this.storageAdapter.setCachedReceiveTokens([
      ...cached,
      { token, amount, unit, createdAt: Date.now(), ...(credential ? { cleanup: [credential] } : {}) },
    ]);
  }

  /** Retry cached tokens not already owned by another receive. */
  async recoverCachedReceiveTokens(): Promise<{ token: string; success: boolean }[]> {
    const results: { token: string; success: boolean }[] = [];
    for (const { token } of this.storageAdapter.getCachedReceiveTokens()) {
      if (this.pendingReceives.has(token) ||
          !this.storageAdapter.getCachedReceiveTokens().some(entry => entry.token === token)) continue;
      const result = await this.startCachedReceive(token);
      results.push({ token, success: result.success });
    }
    return results;
  }

  private _decodeTokenAmount(token: string): {
    amount: number;
    unit: "sat" | "msat";
  } {
    try {
      const metadata = getTokenMetadata(token);
      const unit = (metadata.unit as "sat" | "msat") || "sat";
      return { amount: metadata.amount.toNumber(), unit };
    } catch {
      return { amount: 0, unit: "sat" };
    }
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

    const providerBalances: Record<string, number> = {};
    let totalProviderBalance = 0;

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
          this.logger.log(...args);
          break;
        case "WARN":
          this.logger.warn(...args);
          break;
        case "ERROR":
          this.logger.error(...args);
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
      p2pkPubkey,
      excludeMints = [],
      retryCount = 0,
      signal,
    } = options;

    this._isBusy = true;

    try {
      const result = await this._spendInternal({
        mintUrl,
        amount,
        baseUrl,
        p2pkPubkey,
        excludeMints,
        retryCount,
        signal,
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
          if (result.errorDetails.providerMintsShort) {
            throw new ProviderMintBalanceError(
              result.errorDetails.required,
              result.errorDetails.available,
              result.errorDetails.providerBaseUrl ?? baseUrl,
              result.errorDetails.acceptedMints ?? [],
              result.errorDetails.maxMintBalance,
              result.errorDetails.maxMintUrl
            );
          }
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
      p2pkPubkey,
      excludeMints,
      retryCount,
      signal,
    } = options;

    this._log(
      "DEBUG",
      `[CashuSpender] _spendInternal: amount=${amount}, mintUrl=${mintUrl}, baseUrl=${baseUrl}`
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

    // Get current balance state
    const balanceState = await this._getBalanceState();
    throwIfFundingAborted(signal);
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
        signal,
      });

      if (!tokenResult.success || !tokenResult.token) {
        if (tokenResult.providerMintsShort) {
          // The wallet has funds, but not on a mint this provider accepts.
          // Surface a distinct signal so routing fails over to a provider
          // that does accept a funded mint instead of reporting exhaustion.
          return {
            token: null,
            status: "failed",
            balance: 0,
            error:
              tokenResult.error ||
              "No funded mint accepted by provider",
            errorDetails: {
              required: adjustedAmount,
              available: totalAvailableBalance,
              maxMintBalance: tokenResult.maxMintBalance ?? 0,
              maxMintUrl: tokenResult.maxMintUrl ?? "",
              providerMintsShort: true,
              providerBaseUrl: tokenResult.providerBaseUrl,
              acceptedMints: tokenResult.acceptedMints,
            },
          };
        }

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
          p2pkPubkey,
          undefined,
          signal
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
    if (token) {
      this._log(
        "DEBUG",
        `[CashuSpender] _spendInternal: Successfully spent ${spentAmount}, returning token with balance=${spentAmount}`
      );
    }

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
      selectedMintUrl: selectedMintUrl || mintUrl,
    };
  }

  /**
   * Refund all xcashu tokens from storage by calling the provider's refund endpoint.
   * The xcashu token acts as an API key to claim the refund, and the response contains
   * the actual refunded Cashu token which is then received into the wallet.
   * @param mintUrl - The mint URL for receiving tokens
   * @param excludeBaseUrls - Base URLs to exclude from refund (optional)
   * @returns Results for each xcashu token refund attempt
   */
  async refundXcashuTokens(
    mintUrl: string,
    excludeBaseUrls?: string[]
  ): Promise<
    { baseUrl: string; token: string; success: boolean; error?: string }[]
  > {
    const results: {
      baseUrl: string;
      token: string;
      success: boolean;
      error?: string;
    }[] = [];
    const xcashuTokens = this.storageAdapter.getXcashuTokens();
    const excludedUrls = new Set(excludeBaseUrls || []);

    for (const [baseUrl, tokens] of Object.entries(xcashuTokens)) {
      if (excludedUrls.has(baseUrl)) continue;

      for (const xcashuToken of tokens) {
        try {
          // XCashu tokens need to be sent to the provider's refund endpoint
          // The xcashu token acts as an API key, and the response contains the actual refunded token
          if (!this.balanceManager) {
            throw new Error("BalanceManager not available for xcashu refund");
          }

          // Call the refund endpoint using the xcashu token as the API key
          const fetchResult = await this.balanceManager.fetchRefundToken(
            baseUrl,
            xcashuToken.token,
            true
          );

          // 425 "Refund is pending" is a race condition on the provider side:
          // the upstream request is still in flight and the refund will be
          // minted shortly. Do NOT touch tryCount or remove the token — just
          // record the failure and move on to the next token.
          if (!fetchResult.success && fetchResult.status === 425) {
            results.push({
              baseUrl,
              token: xcashuToken.token,
              success: false,
              error: fetchResult.error,
            });
            this._log(
              "WARN",
              `[CashuSpender] refundXcashuTokens: 425 "Refund is pending" for ${baseUrl}; leaving token in store, tryCount untouched`
            );
            continue;
          }

          // If the provider reports the token as already spent, it can NEVER
          // be refunded — no amount of retrying will change that. Remove it
          // immediately instead of burning MAX_REFUND_RETRIES attempts over
          // several minutes before finally giving up.
          if (
            !fetchResult.success &&
            fetchResult.parsedError?.type === CoreErrorType.TOKEN_ALREADY_SPENT
          ) {
            this.storageAdapter.removeXcashuToken(baseUrl, xcashuToken.token);
            results.push({
              baseUrl,
              token: xcashuToken.token,
              success: false,
              error: fetchResult.error,
            });
            this._log(
              "WARN",
              `[CashuSpender] refundXcashuTokens: token_already_spent for ${baseUrl}; removing permanently-spent xcashu token from store`
            );
            continue;
          }

          // For structured redemption failures, the provider-side refund was
          // attempted first. Try receiving the stored original token directly
          // before scheduling another refund retry. A missing refund can also
          // mean the provider never accepted the token (e.g. untrusted mint).
          // Keep the original proofs when both recovery paths fail.
          if (
            !fetchResult.success &&
            ((fetchResult.parsedError &&
              isHandledRedemptionError(fetchResult.parsedError)) ||
              (fetchResult.status === 404 &&
                (fetchResult.error || "").includes("Refund not found")))
          ) {
            const directReceive = await this.receiveToken(xcashuToken.token, false);
            if (directReceive.success) {
              this.storageAdapter.removeXcashuToken(
                baseUrl,
                xcashuToken.token
              );
              results.push({
                baseUrl,
                token: xcashuToken.token,
                success: true,
              });
              this._log(
                "DEBUG",
                `[CashuSpender] refundXcashuTokens: provider returned ${fetchResult.parsedError?.type ?? fetchResult.status}/${fetchResult.parsedError?.code ?? "unknown"}; recovered original token directly, amount=${directReceive.amount}`
              );
              continue;
            }
            this._log(
              "WARN",
              `[CashuSpender] refundXcashuTokens: provider returned ${fetchResult.parsedError?.type ?? fetchResult.status}/${fetchResult.parsedError?.code ?? "unknown"}; direct original-token recovery also failed: ${directReceive.message ?? "unknown error"}`
            );
          }

          // If the provider responds with 404 "Refund not found", the xcashu
          // token may be temporarily unavailable on the provider side. Instead
          // of removing it immediately, increment tryCount and schedule a
          // background retry. Only after MAX_REFUND_RETRIES attempts do we
          // stop provider polling and preserve the token in receive storage.
          if (
            !fetchResult.success &&
            fetchResult.status === 404 &&
            (fetchResult.error || "").includes("Refund not found")
          ) {
            const currentTryCount = xcashuToken.tryCount ?? 0;
            const newTryCount = currentTryCount + 1;

            if (newTryCount >= CashuSpender.MAX_REFUND_RETRIES) {
              // Stop polling the provider, but preserve the original proofs
              // for cached-token recovery before removing the IOU reference.
              this.cacheReceiveToken(xcashuToken.token);
              this.storageAdapter.removeXcashuToken(
                baseUrl,
                xcashuToken.token
              );
              this._log(
                "WARN",
                `[CashuSpender] refundXcashuTokens: 404 "Refund not found" for ${baseUrl} after ${newTryCount} retries; moving original token to cached receive storage`
              );
            } else {
              // Keep the token and schedule a background retry.
              this.storageAdapter.updateXcashuTokenTryCount(
                xcashuToken.token,
                newTryCount
              );
              this._log(
                "WARN",
                `[CashuSpender] refundXcashuTokens: 404 "Refund not found" for ${baseUrl}; tryCount=${newTryCount}/${CashuSpender.MAX_REFUND_RETRIES}, will retry in ${CashuSpender.REFUND_RETRY_INTERVAL_MS / 1000}s`
              );
              this._startRefundRetryInterval(mintUrl);
            }

            results.push({
              baseUrl,
              token: xcashuToken.token,
              success: false,
              error: fetchResult.error,
            });
            continue;
          }

          if (!fetchResult.success || !fetchResult.token) {
            throw new Error(
              fetchResult.error || "Failed to fetch refund token from provider"
            );
          }

          // Receive the refunded Cashu token into the wallet
          const receiveResult = await this.receiveToken(fetchResult.token);

          if (receiveResult.success) {
            // Remove successfully refunded token from storage
            this.storageAdapter.removeXcashuToken(baseUrl, xcashuToken.token);
            results.push({
              baseUrl,
              token: xcashuToken.token,
              success: true,
            });
            this._log(
              "DEBUG",
              `[CashuSpender] refundXcashuTokens: Successfully refunded xcashu token for ${baseUrl}, amount=${receiveResult.amount}`
            );
          } else if (/already spent/i.test(receiveResult.message ?? "")) {
            // The provider hands back a refund that was already received (e.g.
            // a parked copy recovered earlier). It can never be received again,
            // so stop retrying it and stop counting it as held.
            this.storageAdapter.removeXcashuToken(baseUrl, xcashuToken.token);
            results.push({
              baseUrl,
              token: xcashuToken.token,
              success: false,
              error: receiveResult.message,
            });
            this._log(
              "WARN",
              `[CashuSpender] refundXcashuTokens: refund from ${baseUrl} is already spent; removing its xcashu token`
            );
          } else {
            // Refund failed - increment tryCount
            const currentTryCount = xcashuToken.tryCount ?? 0;
            const newTryCount = currentTryCount + 1;
            this.storageAdapter.updateXcashuTokenTryCount(
              xcashuToken.token,
              newTryCount
            );
            results.push({
              baseUrl,
              token: xcashuToken.token,
              success: false,
              error: receiveResult.message ?? "Refund failed",
            });
            this._log(
              "DEBUG",
              `[CashuSpender] refundXcashuTokens: Failed to receive refund token for ${baseUrl}, incremented tryCount to ${newTryCount}: ${receiveResult.message}`
            );
          }
        } catch (error) {
          // Exception occurred - increment tryCount
          const currentTryCount = xcashuToken.tryCount ?? 0;
          const newTryCount = currentTryCount + 1;
          this.storageAdapter.updateXcashuTokenTryCount(
            xcashuToken.token,
            newTryCount
          );
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          results.push({
            baseUrl,
            token: xcashuToken.token,
            success: false,
            error: errorMessage,
          });
          this._log(
            "ERROR",
            `[CashuSpender] refundXcashuTokens: Exception during refund for ${baseUrl}: ${errorMessage}, incremented tryCount to ${newTryCount}`
          );
        }
      }
    }

    return results;
  }

  /**
   * Start a background interval that retries refunding xcashu tokens every
   * `REFUND_RETRY_INTERVAL_MS` (2 minutes). The interval automatically stops
   * itself once there are no more xcashu tokens left in the store.
   */
  private _startRefundRetryInterval(mintUrl: string): void {
    if (this._refundRetryInterval) return; // already running

    this._log(
      "DEBUG",
      `[CashuSpender] Starting refund retry interval (every ${CashuSpender.REFUND_RETRY_INTERVAL_MS / 1000}s)`
    );

    this._refundRetryInterval = setInterval(async () => {
      const remainingTokens = this.storageAdapter.getXcashuTokens();
      const hasTokens = Object.values(remainingTokens).some(
        (tokens) => tokens.length > 0
      );

      if (!hasTokens) {
        this._stopRefundRetryInterval();
        return;
      }

      try {
        await this.refundXcashuTokens(mintUrl);
      } catch (error) {
        this._log(
          "ERROR",
          `[CashuSpender] Refund retry interval error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }, CashuSpender.REFUND_RETRY_INTERVAL_MS);
  }

  /**
   * Stop the background refund retry interval if it is running.
   */
  private _stopRefundRetryInterval(): void {
    if (this._refundRetryInterval) {
      clearInterval(this._refundRetryInterval);
      this._refundRetryInterval = null;
      this._log(
        "DEBUG",
        `[CashuSpender] Stopped refund retry interval`
      );
    }
  }
  async refundProviders(
    mintUrl: string,
    forceRefund?: boolean
  ): Promise<{ baseUrl: string; success: boolean }[]> {
    const results: { baseUrl: string; success: boolean }[] = [];

    const apiKeyDistribution = this.storageAdapter.getApiKeyDistribution();

    // Refresh balances from providers before refunding
    for (const apiKeyEntry of apiKeyDistribution) {
      const apiKeyEntryFull = this.storageAdapter.getApiKey(
        apiKeyEntry.baseUrl
      );

      if (apiKeyEntryFull && this.balanceManager) {
        try {
          const balanceResult = await this.balanceManager.getTokenBalance(
            apiKeyEntryFull.key,
            apiKeyEntry.baseUrl
          );

          if (balanceResult.isInvalidApiKey) {
            // A stale balance probe cannot authorize removal of a replacement.
            if (this.storageAdapter.getApiKey(apiKeyEntry.baseUrl)?.key !== apiKeyEntryFull.key) {
              results.push({ baseUrl: apiKeyEntry.baseUrl, success: false });
              continue;
            }
            // Only the refund endpoint can settle an unresolved claim. Keep
            // the credential and fall through to the refund retry below.
            if (!this.balanceManager.isApiKeyRefundPending(apiKeyEntry.baseUrl, apiKeyEntryFull.key)) {
              this.logger.warn(
                `refundProviders: ${apiKeyEntry.baseUrl} returned invalid API key; removing local key and treating as success`
              );
              this.storageAdapter.removeApiKey(apiKeyEntry.baseUrl);
              results.push({
                baseUrl: apiKeyEntry.baseUrl,
                success: true,
              });
              continue;
            }
          } else {
            const refreshedBalance = persistApiKeyBalance(
              this.storageAdapter,
              apiKeyEntry.baseUrl,
              apiKeyEntryFull.key,
              balanceResult
            );
            // `persistApiKeyBalance` refuses a negative available figure on
            // purpose: it means the key is momentarily over-reserved, a state
            // that clears as the in-flight holds settle. Keep the last
            // non-negative snapshot and warn instead of writing a number that is
            // stale by the time it lands.
            if (
              !refreshedBalance &&
              !balanceResult.balanceUnknown &&
              balanceResult.amount < 0
            ) {
              this.logger.warn(
                `refundProviders: balance refresh for ${apiKeyEntry.baseUrl} returned negative amount; keeping stale local balance=${apiKeyEntryFull.balance}`
              );
            }
          }
        } catch (error) {
          // Balance check failed — proceed with stale local balance
          this.logger.warn(
            `refundProviders: balance refresh threw for ${apiKeyEntry.baseUrl}; proceeding with stale local balance`,
            error
          );
        }

        // Re-read the entry after balance refresh (may have been removed above)
        const refreshedEntry = this.storageAdapter.getApiKey(
          apiKeyEntry.baseUrl
        );
        if (!refreshedEntry) {
          continue;
        }

        const refundResult = await this.balanceManager.refundApiKey({
          mintUrl,
          baseUrl: apiKeyEntry.baseUrl,
          apiKey: refreshedEntry.key,
          // A pending claim is a retry, not a new refund. A recent lastUsed
          // (including one set by a previous sweep) must not suppress it.
          forceRefund: forceRefund || this.balanceManager.isApiKeyRefundPending(
            apiKeyEntry.baseUrl, refreshedEntry.key
          ),
        });

        if (refundResult.success) {
          // refundApiKey() already removed the key it refunded; this covers the
          // dead-key outcomes it treats as success. A replacement stored while
          // the refund was in flight must survive the sweep.
          const currentEntry = this.storageAdapter.getApiKey(
            apiKeyEntry.baseUrl
          );
          if (currentEntry && currentEntry.key === refreshedEntry.key) {
            this.storageAdapter.removeApiKey(apiKeyEntry.baseUrl);
          }
        } else {
          const currentEntry = this.storageAdapter.getApiKey(
            apiKeyEntry.baseUrl
          );
          this.logger.warn(
            `refundProviders: refund failed for ${apiKeyEntry.baseUrl}; currentEntry=${Boolean(currentEntry)} balance=${currentEntry?.balance ?? "none"}. Touching lastUsed to rate-limit retries.`
          );
          if (currentEntry) {
            this.storageAdapter.touchApiKeyLastUsed(
              apiKeyEntry.baseUrl
            ); // rate-limit: don't retry refund for 5 mins.
          }
        }

        results.push({
          baseUrl: apiKeyEntry.baseUrl,
          success: refundResult.success,
        });
      } else {
        this.logger.warn(
          `refundProviders: cannot refund ${apiKeyEntry.baseUrl}; apiKeyEntryFull=${Boolean(apiKeyEntryFull)} balanceManager=${Boolean(this.balanceManager)}`
        );
        results.push({
          baseUrl: apiKeyEntry.baseUrl,
          success: false,
        });
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
}
