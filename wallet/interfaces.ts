/**
 * Interfaces for the Routstr SDK wallet abstraction layer
 * These interfaces allow the SDK to be framework-agnostic
 */

import type { Message, TransactionHistory } from "@/types/chat";
import type { Model, ProviderInfo } from "@/sdk/core";
export { ProviderInfo };

/**
 * WalletAdapter - Abstracts wallet operations (NIP-60 or legacy)
 * The React app implements this using its hooks
 */
export interface WalletAdapter {
  /** Get balances for all mints (mintUrl -> balance in sats) */
  getBalances(): Promise<Record<string, number>>;

  /** Get unit type for each mint (mintUrl -> 'sat' | 'msat') */
  getMintUnits(): Record<string, string>;

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
  receiveToken(token: string): Promise<{ success: boolean; amount: number }>;

  /** Check if using NIP-60 wallet (for unit conversion decisions) */
  isUsingNip60(): boolean;
}

/**
 * StorageAdapter - Abstracts local storage operations
 * Separates token storage from wallet operations
 */
export interface StorageAdapter {
  /** Get stored API token for a provider */
  getToken(baseUrl: string): string | null;

  /** Store API token for a provider */
  setToken(baseUrl: string, token: string): void;

  /** Remove API token for a provider */
  removeToken(baseUrl: string): void;

  /** Get all stored tokens as distribution (baseUrl -> amount in sats) */
  getPendingTokenDistribution(): Array<{ baseUrl: string; amount: number }>;

  /** Save provider info to cache */
  saveProviderInfo(baseUrl: string, info: ProviderInfo): void;

  /** Get cached provider info */
  getProviderInfo(baseUrl: string): ProviderInfo | null;
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
  onLastMessageSatsUpdate?: (satsSpent: number) => void;
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
