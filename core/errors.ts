/**
 * Custom error classes for the Routstr SDK
 * Provides specific error types for different failure modes
 */

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
