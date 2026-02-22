/**
 * routeRequests - SDK helper for routing OpenAI-compatible requests to the cheapest provider
 *
 * This module provides a reusable function for routing requests to the cheapest
 * provider based on model pricing, with automatic Cashu token handling.
 */

import type { Model, Message } from "./core/types";
import type { DiscoveryAdapter } from "./discovery/interfaces";
import type {
  ProviderRegistry,
  WalletAdapter,
  StorageAdapter,
} from "./wallet/interfaces";
import { ModelManager } from "./discovery/ModelManager";
import { ProviderManager } from "./client/ProviderManager";
import { RoutstrClient } from "./client/RoutstrClient";

/**
 * Options for routeRequests function
 */
export interface RouteRequestOptions {
  /** The model ID to route (e.g., "gpt-4o") */
  modelId: string;
  /** The request body to proxy to the provider */
  requestBody: unknown;
  /** Optional: API path (defaults to /v1/chat/completions) */
  path?: string;
  /** Optional: force a specific provider base URL */
  forcedProvider?: string;
  /** Wallet adapter for Cashu operations */
  walletAdapter: WalletAdapter;
  /** Storage adapter for caching */
  storageAdapter: StorageAdapter;
  /** Provider registry for tracking available providers */
  providerRegistry: ProviderRegistry;
  /** Discovery adapter for model/mint discovery */
  discoveryAdapter: DiscoveryAdapter;
  /** Optional: additional provider URLs to include */
  includeProviderUrls?: string[];
  /** Optional: Tor mode for onion routing */
  torMode?: boolean;
  /** Optional: force refresh of cached data */
  forceRefresh?: boolean;
  /** Optional: pre-initialized ModelManager (skips bootstrap if provided) */
  modelManager?: ModelManager;
}

/**
 * Result from routeRequests function
 */
export interface RouteRequestResult {
  /** The selected provider base URL */
  baseUrl: string;
  /** The selected model with pricing info */
  selectedModel: Model;
  /** Pricing info for the selected provider */
  pricing: {
    promptPerMillion: number;
    completionPerMillion: number;
    totalPerMillion: number;
  };
  /** The response from the provider */
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
  };
}

/**
 * Route an OpenAI-compatible request to the cheapest provider
 *
 * This function:
 * 1. Bootstraps providers and fetches models
 * 2. Discovers available mints
 * 3. Selects the cheapest provider for the requested model
 * 4. Handles Cashu send/receive via RoutstrClient
 * 5. Proxies the request and returns the response
 *
 * @param options - Routing options
 * @returns The provider response
 */
export async function routeRequests(
  options: RouteRequestOptions
): Promise<Response> {
  const {
    modelId,
    requestBody,
    path = "/v1/chat/completions",
    forcedProvider,
    walletAdapter,
    storageAdapter,
    providerRegistry,
    discoveryAdapter,
    includeProviderUrls = [],
    torMode = false,
    forceRefresh = false,
    modelManager: providedModelManager,
  } = options;

  // Use provided ModelManager or create a new one
  let modelManager: ModelManager;
  let providers: string[];

  if (providedModelManager) {
    modelManager = providedModelManager;
    providers = modelManager.getBaseUrls();
    if (providers.length === 0) {
      throw new Error("No providers available - run bootstrap first");
    }
  } else {
    // Initialize ModelManager
    modelManager = new ModelManager(discoveryAdapter, {
      includeProviderUrls: forcedProvider
        ? [forcedProvider, ...includeProviderUrls]
        : includeProviderUrls,
    });

    // Bootstrap providers
    providers = await modelManager.bootstrapProviders(torMode);
    if (providers.length === 0) {
      throw new Error("No providers available");
    }

    // Fetch models
    await modelManager.fetchModels(providers, forceRefresh);
  }

  // Initialize ProviderManager
  const providerManager = new ProviderManager(providerRegistry);

  // Determine cheapest provider
  let baseUrl: string;
  let selectedModel: Model;

  if (forcedProvider) {
    // Use forced provider
    const normalizedProvider = forcedProvider.endsWith("/")
      ? forcedProvider
      : `${forcedProvider}/`;
    const cachedModels = modelManager.getAllCachedModels();
    const models = cachedModels[normalizedProvider] || [];
    const match = models.find((m) => m.id === modelId);
    if (!match) {
      throw new Error(
        `Provider ${normalizedProvider} does not offer model: ${modelId}`
      );
    }
    baseUrl = normalizedProvider;
    selectedModel = match;
  } else {
    // Find cheapest provider
    const ranking = providerManager.getProviderPriceRankingForModel(modelId, {
      torMode,
      includeDisabled: false,
    });
    if (ranking.length === 0) {
      throw new Error(`No providers found for model: ${modelId}`);
    }
    const cheapest = ranking[0];
    baseUrl = cheapest.baseUrl;
    selectedModel = cheapest.model;
  }

  // Get wallet balance
  const balances = await walletAdapter.getBalances();
  const totalBalance = Object.values(balances).reduce((sum, v) => sum + v, 0);

  if (totalBalance <= 0) {
    throw new Error(
      "Wallet balance is empty. Add a mint and fund it before making requests."
    );
  }

  // Get mint URL
  const providerMints = providerRegistry.getProviderMints(baseUrl);
  const mintUrl =
    walletAdapter.getActiveMintUrl() ||
    providerMints[0] ||
    Object.keys(balances)[0];

  if (!mintUrl) {
    throw new Error("No mint configured in wallet");
  }

  // Initialize RoutstrClient
  const alertLevel = "min";
  const client = new RoutstrClient(
    walletAdapter,
    storageAdapter,
    providerRegistry,
    alertLevel,
    "apikeys"
  );

  // Extract options from request body
  const messageHistory = extractMessageHistory(requestBody);
  const maxTokens = extractMaxTokens(requestBody);
  const stream = extractStream(requestBody);

  // Make the request using the simpler routeRequest method
  let response: Response | null = null;
  let responseData: unknown;

  try {
    const proxiedBody: Record<string, unknown> =
      requestBody && typeof requestBody === "object"
        ? { ...(requestBody as Record<string, unknown>) }
        : {};

    proxiedBody.model = selectedModel.id;

    if (stream !== undefined) {
      proxiedBody.stream = stream;
    }

    if (maxTokens !== undefined) {
      proxiedBody.max_tokens = maxTokens;
    }

    response = await client.routeRequest({
      path,
      method: "POST",
      body: proxiedBody,
      baseUrl,
      mintUrl,
      modelId: modelId,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    // For streaming responses, return the raw body for SSE handling
    if (stream) {
      return response;
    }

    // Get the raw response body
    responseData = await response.json();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("401") ||
        error.message.includes("402") ||
        error.message.includes("403"))
    ) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
    throw error;
  }

  return response;
}

/**
 * Extract message history from request body
 */
function extractMessageHistory(requestBody: unknown): Message[] {
  if (!requestBody || typeof requestBody !== "object") {
    return [];
  }

  const body = requestBody as Record<string, unknown>;
  const messages = body.messages;

  if (!Array.isArray(messages)) {
    return [];
  }

  return messages as Message[];
}

/**
 * Extract max_tokens from request body
 */
function extractMaxTokens(requestBody: unknown): number | undefined {
  if (!requestBody || typeof requestBody !== "object") {
    return undefined;
  }

  const body = requestBody as Record<string, unknown>;
  const maxTokens = body.max_tokens;

  if (typeof maxTokens === "number") {
    return maxTokens;
  }

  return undefined;
}

/**
 * Extract stream option from request body
 */
function extractStream(requestBody: unknown): boolean {
  if (!requestBody || typeof requestBody !== "object") {
    return false;
  }

  const body = requestBody as Record<string, unknown>;
  const stream = body.stream;

  return stream === true;
}
