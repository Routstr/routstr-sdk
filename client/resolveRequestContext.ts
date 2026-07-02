/**
 * Shared context resolution for routeRequests and fetchAIResponse.
 *
 * Extracted from routeRequests.ts so both routing helpers can bootstrap
 * ModelManager, fetch models, rank providers by price, resolve a mint URL,
 * and build a RoutstrClient without duplicating the pipeline.
 */

import type { Model, SdkLogger } from "../core/types";
import type { DiscoveryAdapter } from "../discovery/interfaces";
import type {
  WalletAdapter,
  StorageAdapter,
} from "../wallet/interfaces";
import { ModelManager } from "../discovery/ModelManager";
import { ProviderManager } from "./ProviderManager";
import {
  RoutstrClient,
  type DebugLevel,
  type RequestResponseLogSink,
} from "./RoutstrClient";
import type { UsageTrackingDriver } from "../storage/usageTracking";
import type { SdkStore } from "../storage/store";

export interface ResolveContextInput {
  /** The model ID to route (e.g., "gpt-4o"). Required for auto-discovery. */
  modelId: string;
  /** Optional: force a specific provider base URL (skips ranking). */
  forcedProvider?: string;
  /** Wallet adapter for Cashu operations. */
  walletAdapter: WalletAdapter;
  /** Storage adapter for caching. */
  storageAdapter: StorageAdapter;
  /** Discovery adapter for model/mint discovery and provider data. */
  discoveryAdapter: DiscoveryAdapter;
  /** Optional: additional provider URLs to include. */
  includeProviderUrls?: string[];
  /** Optional: Tor mode for onion routing. */
  torMode?: boolean;
  /** Optional: force refresh of cached data. */
  forceRefresh?: boolean;
  /** Optional: pre-initialized ModelManager (skips bootstrap if provided). */
  modelManager?: ModelManager;
  /** Optional: set RoutstrClient debug level. */
  debugLevel?: DebugLevel;
  /** Optional: client mode (xcashu or apikeys). */
  mode?: "xcashu" | "apikeys";
  /** Optional: explicit usage tracking driver. */
  usageTrackingDriver?: UsageTrackingDriver;
  /** Optional: explicit SDK store (for using correct DB path). */
  sdkStore?: SdkStore;
  /** Optional: shared ProviderManager instance for consistent failure tracking. */
  providerManager?: ProviderManager;
  /** Nostr pubkey for routstr review/model events (kind 38425/38423). */
  routstrPubkey?: string;
  /** Optional: injectable logger. */
  logger?: SdkLogger;
  /** Optional: raw request/response logging callbacks supplied by the runtime/app. */
  requestResponseLogSink?: RequestResponseLogSink;
  /** Optional: pre-built RoutstrClient. When provided, skips client creation. */
  client?: RoutstrClient;
}

export interface ResolvedContext {
  client: RoutstrClient;
  baseUrl: string;
  mintUrl: string;
  selectedModel: Model;
}

/**
 * Bootstrap ModelManager, fetch models, rank providers, resolve mint,
 * and build (or reuse) a RoutstrClient.
 *
 * This is the shared pipeline used by both routeRequests and fetchAIResponse.
 */
export async function resolveRequestContext(
  input: ResolveContextInput
): Promise<ResolvedContext> {
  const {
    modelId,
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
    routstrPubkey,
    logger,
  } = input;

  // ── ModelManager bootstrap ──────────────────────────────────────────
  let modelManager: ModelManager;

  if (providedModelManager) {
    modelManager = providedModelManager;
    const providers = modelManager.getBaseUrls();
    if (providers.length === 0) {
      throw new Error("No providers available - run bootstrap first");
    }
  } else {
    modelManager = new ModelManager(discoveryAdapter, {
      includeProviderUrls: forcedProvider
        ? [forcedProvider, ...includeProviderUrls]
        : includeProviderUrls,
      routstrPubkey,
      logger,
    });

    const providers = await modelManager.bootstrapProviders(torMode);
    if (providers.length === 0) {
      throw new Error("No providers available");
    }

    await modelManager.fetchModels(providers, forceRefresh);
  }

  // ── ProviderManager ─────────────────────────────────────────────────
  const providerManager =
    providedProviderManager ??
    new ProviderManager(discoveryAdapter, sdkStore, logger);

  // ── Select provider + model ─────────────────────────────────────────
  let baseUrl: string;
  let selectedModel: Model;

  if (forcedProvider) {
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

  // ── Mint resolution ─────────────────────────────────────────────────
  const providerMints = discoveryAdapter.getCachedMints()[baseUrl] || [];
  const mintUrl =
    walletAdapter.getActiveMintUrl() ||
    providerMints[0] ||
    Object.keys(await walletAdapter.getBalances())[0];

  if (!mintUrl) {
    throw new Error("No mint configured in wallet");
  }

  // ── Client ──────────────────────────────────────────────────────────
  const client =
    input.client ??
    new RoutstrClient(
      walletAdapter,
      storageAdapter,
      discoveryAdapter,
      "min",
      mode,
      {
        usageTrackingDriver,
        sdkStore,
        providerManager,
        logger,
        requestResponseLogSink: input.requestResponseLogSink,
      }
    );

  // Apply the requested debug level to the client (whether provided or
  // freshly created) so callers don't have to call setDebugLevel manually.
  if (debugLevel) {
    client.setDebugLevel(debugLevel);
  }

  return { client, baseUrl, mintUrl, selectedModel };
}
