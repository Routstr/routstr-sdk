/**
 * Interfaces for the Routstr SDK wallet abstraction layer
 * These interfaces allow the SDK to be framework-agnostic
 */

import type { Message, TransactionHistory } from "../core/types";
import type { Model, ProviderInfo } from "../core/types";
export { ProviderInfo };

/**
 * WalletAdapter - Abstracts wallet operations (NIP-60 or legacy)
 * The React app implements this using its hooks
 */
export interface WalletAdapter {
  /** Get balances for all mints (mintUrl -> balance in sats) */
  getBalances(): Promise<Record<string, number>>;

  /** Get unit type for each mint (mintUrl -> 'sat' | 'msat') */
  getMintUnits(): Record<string, "sat" | "msat">;

  /** Get the currently active mint URL */
  getActiveMintUrl(): string | null;

  /**
   * Create and send a cashu token from a mint
   * @param mintUrl The mint URL to send from
   * @param amount Amount in sats
   * @param p2pkPubkey Optional P2PK public key
   * @returns Encoded cashu token string
   */
  sendToken(
    mintUrl: string,
    amount: number,
    p2pkPubkey?: string
  ): Promise<string>;

  /**
   * Receive/store a cashu token
   * Handles both NIP-60 and legacy storage internally
   * @param token Encoded cashu token string
   * @returns Result with success flag and amount received
   */
  receiveToken(token: string): Promise<{
    success: boolean;
    amount: number;
    unit: "sat" | "msat";
    message?: string;
  }>;
}

/**
 * StorageAdapter - Abstracts local storage operations
 * Separates token storage from wallet operations
 */
export interface ApiKeyEntry {
  baseUrl: string;
  key: string;
  balance: number; // tracked internally, updated via provider responses
  lastUsed: number | null;
}

export interface ChildKeyEntry {
  parentBaseUrl: string;
  childKey: string;
  balance: number;
  balanceLimit?: number;
  validityDate?: number;
  createdAt: number;
}

export interface XCashuTokenEntry {
  baseUrl: string;
  token: string;
  createdAt: number;
}

export interface StorageAdapter {
  /** Save provider info to cache */
  saveProviderInfo(baseUrl: string, info: ProviderInfo): void;

  /** Get cached provider info */
  getProviderInfo(baseUrl: string): ProviderInfo | null;

  // ========== API Keys (for apikeys mode) ==========

  /** Get stored API key entry for a provider */
  getApiKey(baseUrl: string): ApiKeyEntry | null;

  /** Store API key for a provider */
  setApiKey(baseUrl: string, key: string): void;

  /** Update balance for an existing stored API key (based on provider response) */
  updateApiKeyBalance(baseUrl: string, balance: number): void;

  /** Remove API key for a provider */
  removeApiKey(baseUrl: string): void;

  /** Get all stored API keys */
  getAllApiKeys(): ApiKeyEntry[];

  /** Get all stored API keys as distribution (baseUrl -> amount in sats) */
  getApiKeyDistribution(): Array<{ baseUrl: string; amount: number }>;

  // ========== Child Keys (for apikeys mode) ==========

  /** Get stored child key for a parent provider */
  getChildKey(parentBaseUrl: string): ChildKeyEntry | null;

  /** Store a child key for a parent provider */
  setChildKey(
    parentBaseUrl: string,
    childKey: string,
    balance?: number,
    validityDate?: number,
    balanceLimit?: number
  ): void;

  /** Update balance for an existing child key */
  updateChildKeyBalance(parentBaseUrl: string, balance: number): void;

  /** Remove child key for a parent provider */
  removeChildKey(parentBaseUrl: string): void;

  /** Get all stored child keys */
  getAllChildKeys(): ChildKeyEntry[];

  /** Get cached receive tokens (tokens that failed to receive due to mint errors) */
  getCachedReceiveTokens(): Array<{
    token: string;
    amount: number;
    unit: "sat" | "msat";
    createdAt: number;
  }>;

  /** Set cached receive tokens */
  setCachedReceiveTokens(
    tokens: Array<{
      token: string;
      amount: number;
      unit: "sat" | "msat";
      createdAt?: number;
    }>
  ): void;

  // ========== XCashu Tokens (multiple tokens per baseUrl) ==========

  /** Get all stored xcashu tokens */
  getXcashuTokens(): Record<string, XCashuTokenEntry[]>;

  /** Get xcashu tokens for a specific baseUrl */
  getXcashuTokensForBaseUrl(baseUrl: string): XCashuTokenEntry[];

  /** Add an xcashu token for a baseUrl */
  addXcashuToken(baseUrl: string, token: string): void;

  /** Remove an xcashu token */
  removeXcashuToken(baseUrl: string, token: string): void;

  /** Clear all xcashu tokens for a baseUrl */
  clearXcashuTokensForBaseUrl(baseUrl: string): void;
}

/**
 * ProviderRegistry - Provides access to provider/model data
 * Used by ProviderManager for failover logic
 */
export interface ProviderRegistry {
  /** Get all models available from a provider */
  getModelsForProvider(baseUrl: string): Model[];

  /** Get list of disabled provider URLs */
  getDisabledProviders(): string[];

  /** Get mints accepted by a provider */
  getProviderMints(baseUrl: string): string[];

  /**
   * Get provider info (version, etc.)
   * Should fetch from network if not cached, or return cached version
   */
  getProviderInfo(baseUrl: string): Promise<ProviderInfo | null>;

  /** Get all providers with their models */
  getAllProvidersModels(): Record<string, Model[]>;
}

/**
 * StreamingCallbacks - Callbacks for real-time updates during API calls
 * Used by RoutstrClient to communicate with the UI
 */
export interface StreamingCallbacks {
  /** Called when new content arrives from the stream */
  onStreamingUpdate: (content: string) => void;

  /** Called when thinking/reasoning content arrives */
  onThinkingUpdate: (content: string) => void;

  /** Called when a complete message should be appended */
  onMessageAppend: (message: Message) => void;

  /** Called when balance changes */
  onBalanceUpdate: (balance: number) => void;

  /** Called when a transaction is recorded */
  onTransactionUpdate: (transaction: TransactionHistory) => void;

  /** Called when a new token is created (amount in sats) */
  onTokenCreated?: (amount: number) => void;

  /** Called when payment processing starts/stops */
  onPaymentProcessing?: (isProcessing: boolean) => void;

  /** Called when sats spent on the last message is known */
  onLastMessageSatsUpdate?: (satsSpent: number, estimatedCosts: number) => void;
}

/**
 * Options for creating a RoutstrClient
 */
export interface RoutstrClientOptions {
  /** Wallet adapter for cashu operations */
  walletAdapter: WalletAdapter;

  /** Storage adapter for token management */
  storageAdapter: StorageAdapter;

  /** Provider registry for failover logic */
  providerRegistry: ProviderRegistry;

  /** Nostr relay URLs (for future nostr-based features) */
  relayUrls?: string[];
}
