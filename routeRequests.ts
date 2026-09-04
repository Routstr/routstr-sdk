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
import { InsufficientBalanceError } from "./core/errors";

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
  /**
   * Optional per-request secret scoping Tinfoil's prompt cache. Prefer a
   * stable, opaque, per-end-user value in multi-user deployments so users
   * under the same Tinfoil API identity cannot observe each other's cache
   * timing. Falls back to the TINFOIL_USER_CACHE_SECRET environment variable,
   * then a generated secret persisted at ~/.tinfoil/user_cache_secret.
   */
  userCacheSecret?: string;
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
  /** Nostr pubkey for routstr review/audit events (kind 38425). Defaults to routstr's key. */
  routstrPubkey?: string;
  /** Nostr pubkey for the routstr-21 model list only (kind 38423). Falls back to routstrPubkey. */
  routstrModelsPubkey?: string;
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
      routstrModelsPubkey: options.routstrModelsPubkey,
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

  if (maxTokens !== undefined && typeof (requestBody as any)?.max_tokens === "number") {
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
      userCacheSecret: options.userCacheSecret,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response;
  } catch (error) {
    // Preserve typed SDK errors so callers (e.g. routstrd) can instanceof-check
    // them and map to the correct HTTP status (e.g. 402 for InsufficientBalanceError).
    if (error instanceof InsufficientBalanceError) {
      throw error;
    }

    // Wrap auth failures with a helpful prefix. Match the HTTP status code at
    // the *start* of the message (e.g. "401 Unauthorized") rather than anywhere
    // in the body, since balance/error messages may contain digit sequences
    // like "4022.807" that would otherwise false-match "402".
    if (error instanceof Error && AUTH_STATUS_RE.test(error.message)) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
    throw error;
  }
}

const AUTH_STATUS_RE = /^(401|402|403)\b/;

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
  // Chat/completions use max_tokens; the OpenAI Responses API uses
  // max_output_tokens. Both cap the completion budget for pricing.
  const maxTokens = body.max_tokens ?? body.max_output_tokens;

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
