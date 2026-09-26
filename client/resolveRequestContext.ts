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
import { findModelForId } from "../core/modelMappings";
import {
  RoutstrClient,
  type DebugLevel,
  type RequestResponseLogSink,
} from "./RoutstrClient";
import type { UsageTrackingDriver } from "../storage/usageTracking";
import type { SdkStore } from "../storage/store";
import {
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URLS,
  getNodeModelPaths,
  MODEL_PATH_HEADER,
  resolveDeepSeekModelPathSelectors,
  sameNode,
  type ModelPathSatsPricing,
} from "../utils/modelPaths";

function hasModelPathHeader(headers?: Record<string, string>): boolean {
  return (
    !!headers &&
    Object.keys(headers).some((name) => name.toLowerCase() === MODEL_PATH_HEADER)
  );
}

export interface ResolveContextInput {
  /** The model ID to route (e.g., "gpt-4o"). Required for auto-discovery. */
  modelId: string;
  /** Optional: force a specific provider base URL (skips ranking). */
  forcedProvider?: string;
  /** Optional: caller-supplied request headers (an x-routstr-model-path
   * header here suppresses the SDK's automatic model-path pinning). */
  inputHeaders?: Record<string, string>;
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
  /** Nostr pubkey for routstr review/audit events (kind 38425). */
  routstrPubkey?: string;
  /** Nostr pubkey for the routstr-21 model list only (kind 38423). Falls back to routstrPubkey. */
  routstrModelsPubkey?: string;
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
  /**
   * Present when the SDK auto-pinned an x-routstr-model-path selector for
   * this request (see DEEPSEEK_AUTO_MODEL_ID): the selector to send and the
   * per-route sats pricing the node advertised for it. `autoPinned` marks
   * the selector as SDK-chosen, so failover may re-resolve a selector on
   * the next model-path node; caller-supplied selectors never fail over.
   */
  modelPath?: {
    selector: string;
    satsPricing?: ModelPathSatsPricing;
    autoPinned: true;
  };
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
    inputHeaders,
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
    routstrModelsPubkey,
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
      routstrModelsPubkey,
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
  let modelPath: ResolvedContext["modelPath"];

  if (forcedProvider) {
    const normalizedProvider = forcedProvider.endsWith("/")
      ? forcedProvider
      : `${forcedProvider}/`;

    // Honor disabled providers list even for forced providers.
    // This includes manually-disabled providers that must never be
    // re-enabled by a Nostr review sync cycle.
    const disabledProviders = discoveryAdapter.getDisabledProviders();
    if (disabledProviders.includes(normalizedProvider)) {
      throw new Error(
        `Provider ${normalizedProvider} is disabled. Use 'routstrd providers enable' to re-enable it.`
      );
    }

    const cachedModels = modelManager.getAllCachedModels();
    const models = cachedModels[normalizedProvider] || [];
    // Match by native id or a statically mapped variant/alias of it, so a
    // forced provider also serves requests using the canonical id.
    const match = findModelForId(models, modelId);
    if (!match) {
      throw new Error(
        `Provider ${normalizedProvider} does not offer model: ${modelId}`
      );
    }
    baseUrl = normalizedProvider;
    selectedModel = match;

    // Forcing one of the auto-selection nodes still pins the model path on
    // that node: the selector is resolved from that node's own advertised
    // paths, so the node is guaranteed to accept it.
    if (
      !hasModelPathHeader(inputHeaders) &&
      typeof modelId === "string" &&
      modelId.trim().toLowerCase() === DEEPSEEK_AUTO_MODEL_ID &&
      DEEPSEEK_AUTO_NODE_URLS.some((nodeUrl) =>
        sameNode(nodeUrl, normalizedProvider)
      )
    ) {
      const nodePaths = await getNodeModelPaths(normalizedProvider);
      const resolved = nodePaths
        ? resolveDeepSeekModelPathSelectors(nodePaths, modelId)
        : null;
      const index = resolved?.selectors.findIndex(
        (s): s is string => s !== null
      ) ?? -1;
      if (resolved && index >= 0) {
        modelPath = {
          selector: resolved.selectors[index]!,
          satsPricing: resolved.satsPricing[index] ?? undefined,
          autoPinned: true,
        };
      }
    }
  } else if (
    !hasModelPathHeader(inputHeaders) &&
    typeof modelId === "string" &&
    modelId.trim().toLowerCase() === DEEPSEEK_AUTO_MODEL_ID
  ) {
    // "Get baseUrl for model path": rank the whitelisted auto-selection
    // nodes by their per-route price and pin the best candidate's selector.
    // An empty ranking (nodes down, cooled, or not advertising the route)
    // degrades to the normal price ranking unpinned.
    const ranking = await providerManager.getModelPathProviderRanking(
      modelId,
      { torMode }
    );
    if (ranking.length > 0) {
      const best = ranking[0];
      baseUrl = best.baseUrl;
      selectedModel = best.model;
      modelPath = {
        selector: best.selectors[0],
        satsPricing: best.satsPricing[0] ?? undefined,
        autoPinned: true,
      };
    } else {
      const fallback = providerManager.getProviderPriceRankingForModel(
        modelId,
        { torMode, includeDisabled: false }
      );
      if (fallback.length === 0) {
        throw new Error(`No providers found for model: ${modelId}`);
      }
      baseUrl = fallback[0].baseUrl;
      selectedModel = fallback[0].model;
    }
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

  return { client, baseUrl, mintUrl, selectedModel, modelPath };
}
