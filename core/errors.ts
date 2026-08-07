/**
 * Custom error classes for the Routstr SDK
 * Provides specific error types for different failure modes
 */

import type { ParsedCoreError } from "./errorTypes";

/**
 * Error thrown when balance is insufficient for an operation
 */
export class InsufficientBalanceError extends Error {
  constructor(
    public required: number,
    public available: number,
    public maxMintBalance: number = 0,
    public maxMintUrl: string = "",
    customMessage?: string
  ) {
    super(
      customMessage ??
        (`Insufficient balance: need ${required} sats, have ${available} sats available. ` +
          (maxMintBalance > 0
            ? `Largest mint balance: ${maxMintBalance} sats from ${maxMintUrl}`
            : ""))
    );
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Error thrown when a provider returns an error response
 */
export class ProviderError extends Error {
  constructor(
    public baseUrl: string,
    public statusCode: number,
    message: string,
    public requestId?: string
  ) {
    super(
      `Provider ${baseUrl} returned ${statusCode}: ${message}` +
        (requestId ? ` (Request ID: ${requestId})` : "")
    );
    this.name = "ProviderError";
  }
}

/**
 * Error thrown when a mint is unreachable
 */
export class MintUnreachableError extends Error {
  constructor(public mintUrl: string) {
    super(
      `Your mint ${mintUrl} is unreachable or is blocking your IP. Please try again later or switch mints.`
    );
    this.name = "MintUnreachableError";
  }
}

/**
 * Error thrown when a token operation fails
 */
export class TokenOperationError extends Error {
  constructor(
    message: string,
    public operation: "send" | "receive" | "refund",
    public mintUrl?: string
  ) {
    super(message);
    this.name = "TokenOperationError";
  }
}

/**
 * Error thrown when provider failover fails
 */
export class FailoverError extends Error {
  constructor(
    public originalProvider: string,
    public failedProviders: string[],
    message?: string
  ) {
    super(
      message ||
        `All providers failed. Original: ${originalProvider}, Failed: ${failedProviders.join(", ")}`
    );
    this.name = "FailoverError";
  }
}

/**
 * Error thrown when streaming response processing fails
 */
export class StreamingError extends Error {
  constructor(
    message: string,
    public finishReason?: string,
    public accumulatedContent?: string
  ) {
    super(message);
    this.name = "StreamingError";
  }
}

/**
 * Error thrown when model is not found on a provider
 */
export class ModelNotFoundError extends Error {
  constructor(public modelId: string, public baseUrl: string) {
    super(`Model '${modelId}' not found on provider ${baseUrl}`);
    this.name = "ModelNotFoundError";
  }
}

/**
 * Error thrown when provider bootstrap fails
 */
export class ProviderBootstrapError extends Error {
  constructor(
    public failedProviders: string[],
    message?: string
  ) {
    super(
      message || `Failed to bootstrap providers. Tried: ${failedProviders.join(", ")}`
    );
    this.name = "ProviderBootstrapError";
  }
}

/**
 * Error thrown when no providers are available
 */
export class NoProvidersAvailableError extends Error {
  constructor() {
    super("No providers are available for model discovery");
    this.name = "NoProvidersAvailableError";
  }
}

/**
 * Error thrown when a Cashu token has already been spent/redeemed.
 *
 * Corresponds to routstr-core's `token_already_spent` error type (HTTP 400).
 * The token is permanently gone — callers must not retry with the same token.
 */
export class TokenAlreadySpentError extends Error {
  /** The provider base URL that returned the error */
  baseUrl: string;
  /** HTTP status from the error response (always 400 for this error) */
  statusCode: number;
  /** The mint URL the token was from (if known) */
  mintUrl?: string;
  /** The parsed structured error from routstr-core */
  parsedError?: ParsedCoreError;
  /** Request ID from the error response */
  requestId?: string;

  constructor(opts: {
    baseUrl: string;
    statusCode?: number;
    mintUrl?: string;
    message?: string;
    parsedError?: ParsedCoreError;
    requestId?: string;
  }) {
    super(
      opts.message ??
        opts.parsedError?.message ??
        "Cashu token already spent — do not retry with the same token"
    );
    this.name = "TokenAlreadySpentError";
    this.baseUrl = opts.baseUrl;
    this.statusCode = opts.statusCode ?? 400;
    if (opts.mintUrl !== undefined) this.mintUrl = opts.mintUrl;
    if (opts.parsedError) this.parsedError = opts.parsedError;
    if (opts.requestId) this.requestId = opts.requestId;
  }
}

/**
 * Error thrown when the Cashu mint rejects a fee/melt/swap operation.
 *
 * Corresponds to routstr-core's `mint_error` error type (HTTP 422). The token
 * was NOT consumed — the mint rejected the melt — so the sats are still on the
 * token/key. Callers should not remove the token, and may retry with a
 * different mint or a larger token depending on the `code`:
 *
 * - `cashu_token_swap_fees_exceed_amount` — token too small for fees; a fresh
 *   topup with more sats may succeed.
 * - `cashu_foreign_mint_swap_failed` — foreign mint swap failed; a different
 *   mint may succeed.
 */
export class MintError extends Error {
  /** The provider base URL that returned the error */
  baseUrl: string;
  /** HTTP status from the error response (always 422 for this error) */
  statusCode: number;
  /** The mint URL that rejected the operation (if known) */
  mintUrl?: string;
  /** Finer-grained code (e.g. `cashu_token_swap_fees_exceed_amount`) */
  code?: string;
  /** The parsed structured error from routstr-core */
  parsedError?: ParsedCoreError;
  /** Request ID from the error response */
  requestId?: string;

  constructor(opts: {
    baseUrl: string;
    statusCode?: number;
    mintUrl?: string;
    code?: string;
    message?: string;
    parsedError?: ParsedCoreError;
    requestId?: string;
  }) {
    super(
      opts.message ??
        opts.parsedError?.message ??
        "Cashu mint rejected the token (fee/melt failure) — the token was not spent"
    );
    this.name = "MintError";
    this.baseUrl = opts.baseUrl;
    this.statusCode = opts.statusCode ?? 422;
    if (opts.mintUrl !== undefined) this.mintUrl = opts.mintUrl;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.parsedError) this.parsedError = opts.parsedError;
    if (opts.requestId) this.requestId = opts.requestId;
  }
}

/**
 * Error thrown when mint discovery fails
 */
export class MintDiscoveryError extends Error {
  constructor(
    public baseUrl: string,
    message?: string
  ) {
    super(message || `Failed to discover mints from provider ${baseUrl}`);
    this.name = "MintDiscoveryError";
  }
}
