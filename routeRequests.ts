/**
 * routeRequests - SDK helper for routing OpenAI-compatible requests to the cheapest provider
 *
 * This module provides a reusable function for routing requests to the cheapest
 * provider based on model pricing, with automatic Cashu token handling.
 */

import type { Model, Message, SdkLogger } from "./core/types";
import type { DiscoveryAdapter } from "./discovery/interfaces";
import type {
  WalletAdapter,
  StorageAdapter,
} from "./wallet/interfaces";
import { ModelManager } from "./discovery/ModelManager";
import { ProviderManager } from "./client/ProviderManager";
import {
  RoutstrClient,
  type DebugLevel,
  type RequestResponseLogSink,
} from "./client/RoutstrClient";
import type { UsageTrackingDriver } from "./storage/usageTracking";
import type { SdkStore } from "./storage/store";
import {
  resolveRequestContext,
  type ResolveContextInput,
  type ResolvedContext,
} from "./client/resolveRequestContext";

// Re-export for consumers that want access to the shared resolver
export { resolveRequestContext };
export type { ResolveContextInput, ResolvedContext };

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
  /** Optional: request headers to forward upstream */
  headers?: Record<string, string>;
  /** Optional: force a specific provider base URL */
  forcedProvider?: string;
  /** Wallet adapter for Cashu operations */
  walletAdapter: WalletAdapter;
  /** Storage adapter for caching */
  storageAdapter: StorageAdapter;
  /** Discovery adapter for model/mint discovery and provider data */
  discoveryAdapter: DiscoveryAdapter;
  /** Optional: additional provider URLs to include */
  includeProviderUrls?: string[];
  /** Optional: Tor mode for onion routing */
  torMode?: boolean;
  /** Optional: force refresh of cached data */
  forceRefresh?: boolean;
  /** Optional: pre-initialized ModelManager (skips bootstrap if provided) */
  modelManager?: ModelManager;
  /** Optional: set RoutstrClient debug level */
  debugLevel?: DebugLevel;
  /** Optional: client mode (xcashu or apikeys) */
  mode?: "xcashu" | "apikeys";
  /** Optional: explicit usage tracking driver */
  usageTrackingDriver?: UsageTrackingDriver;
  /** Optional: explicit SDK store (for using correct DB path) */
  sdkStore?: SdkStore;
  /** Optional: shared ProviderManager instance for consistent failure tracking */
  providerManager?: ProviderManager;
  /** Nostr pubkey for routstr review/model events (kind 38425/38423). Defaults to routstr's key. */
  routstrPubkey?: string;
  /** Optional: injectable logger for structured/prefixed logging */
  logger?: SdkLogger;
  /** Optional: raw request/response logging callbacks supplied by the runtime/app. */
  requestResponseLogSink?: RequestResponseLogSink;
  /** Optional: pre-built RoutstrClient. When provided, skips client creation. Must be configured with the appropriate mode, logger, usageTrackingDriver, sdkStore, providerManager, and requestResponseLogSink. */
  client?: RoutstrClient;
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

async function resolveRouteRequestContext(options: RouteRequestOptions): Promise<{
  client: RoutstrClient;
  baseUrl: string;
  mintUrl: string;
  path: string;
  headers: Record<string, string>;
  modelId: string;
  proxiedBody: Record<string, unknown>;
}> {
  const {
    modelId,
    requestBody,
    path = "/v1/chat/completions",
    headers = {},
    forcedProvider,
    walletAdapter,
    storageAdapter,
    discoveryAdapter,
    includeProviderUrls = [],
    torMode = false,
    forceRefresh = false,
    modelManager: providedModelManager,
    debugLevel,
    mode = "apikeys",
    usageTrackingDriver,
    sdkStore,
    providerManager: providedProviderManager,
    logger,
    requestResponseLogSink,
  } = options;

  // Delegate to shared context resolution
  const { client: resolvedClient, baseUrl, mintUrl, selectedModel } =
    await resolveRequestContext({
      modelId,
      forcedProvider,
      walletAdapter,
      storageAdapter,
      discoveryAdapter,
      includeProviderUrls,
      torMode,
      forceRefresh,
      modelManager: providedModelManager,
      debugLevel,
      mode,
      usageTrackingDriver,
      sdkStore,
      providerManager: providedProviderManager,
      routstrPubkey: options.routstrPubkey,
      logger,
      requestResponseLogSink,
      client: options.client,
    });

  const client = resolvedClient;

  const maxTokens = extractMaxTokens(requestBody);
  const stream = extractStream(requestBody);

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

  return {
    client,
    baseUrl,
    mintUrl,
    path,
    headers,
    modelId,
    proxiedBody,
  };
}

/**
 * Route an OpenAI-compatible request to the cheapest provider
 */
export async function routeRequests(
  options: RouteRequestOptions
): Promise<Response> {
  const { client, baseUrl, mintUrl, path, headers, modelId, proxiedBody } =
    await resolveRouteRequestContext(options);


  try {
    const response = await client.routeRequest({
      path,
      method: "POST",
      body: proxiedBody,
      headers,
      baseUrl,
      mintUrl,
      modelId,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response;
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

  return messages.filter(
    (m): m is Message =>
      m &&
      typeof m === "object" &&
      "role" in m &&
      "content" in m &&
      typeof (m as any).role === "string"
  );
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

  return typeof maxTokens === "number" ? maxTokens : undefined;
}

/**
 * Extract stream flag from request body
 */
function extractStream(requestBody: unknown): boolean | undefined {
  if (!requestBody || typeof requestBody !== "object") {
    return undefined;
  }

  const body = requestBody as Record<string, unknown>;
  const stream = body.stream;

  return typeof stream === "boolean" ? stream : undefined;
}
