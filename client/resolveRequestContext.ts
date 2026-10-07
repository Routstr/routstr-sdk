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
import { canonicalizeModelId, findModelForId, type ModelIdMappings } from "../core/modelMappings";
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

/**
 * True when a requested model id names the auto-selected model in any
 * spelling: the canonical id, a case variant of it, or a mapped variant such
 * as "deepseek-v4-1-flash" (see MODEL_ID_MAPPINGS). Without canonicalizing
 * first, asking for the mapped spelling silently disabled auto model-path
 * selection while still routing to the same model.
 */
function isAutoModelPathModel(id: string, mappings?: ModelIdMappings): boolean {
  return (
    canonicalizeModelId(id.trim().toLowerCase(), mappings).toLowerCase() ===
    DEEPSEEK_AUTO_MODEL_ID
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
  /** Opt into automatic DeepSeek V4.1 Flash model-path selection. Defaults to false; caller-supplied path headers still work. */
  autoModelPath?: boolean;
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
  /** Nostr pubkey for routstr-21 models (38423) and model ID mappings (38426). Falls back to routstrPubkey. */
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
   * The canonical form of the model id the caller requested. Pass it as
   * `modelId` to RoutstrClient.routeRequest so cooldowns and failover use
   * one stable identity; `selectedModel.id` is only the chosen provider's
   * native spelling (forward that in the upstream request body).
   */
  requestedModelId: string;
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
  /**
   * True when the caller forced a provider (see `forcedProvider`). A forced
   * provider is a pin: failover must never move the request to another node.
   */
  pinnedProvider?: boolean;
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
    autoModelPath = false,
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

  // ── Wallet-funded mints (for mint-aware provider selection) ─────────
  // Provider selection must not land on the cheapest node that accepts
  // none of the mints the wallet can actually spend from: the request would
  // hard-fail (or pay for a round trip) even though another node accepts a
  // funded mint. When the mint cache is cold every provider is acceptable,
  // so behavior is unchanged until discovery populates it.
  const normalizeMint = (mintUrl: string): string =>
    mintUrl.endsWith("/") ? mintUrl.slice(0, -1) : mintUrl;
  const walletBalances = await walletAdapter.getBalances();
  const fundedMints = Object.entries(walletBalances)
    .filter(([, balance]) => typeof balance === "number" && balance > 0)
    .map(([mintUrl]) => normalizeMint(mintUrl));
  const fundedMintSet = new Set(fundedMints);
  const providerAcceptsAnyFundedMint = (candidateBaseUrl: string): boolean => {
    const cached =
      discoveryAdapter.getCachedMints()[candidateBaseUrl] ||
      discoveryAdapter.getCachedMints()[
        candidateBaseUrl.endsWith("/")
          ? candidateBaseUrl
          : `${candidateBaseUrl}/`
      ] ||
      [];
    if (cached.length === 0) return true;
    return cached.some((mint) => fundedMintSet.has(normalizeMint(mint)));
  };
  const pickAcceptableProvider = <T extends { baseUrl: string }>(
    list: T[]
  ): T | undefined =>
    list.find((entry) => providerAcceptsAnyFundedMint(entry.baseUrl));

  // ── Select provider + model ─────────────────────────────────────────
  let baseUrl: string;
  let selectedModel: Model;
  let modelPath: ResolvedContext["modelPath"];
  let pinnedProvider = false;

  if (forcedProvider) {
    pinnedProvider = true;
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
    // Match by native id or a mapped variant/alias of it, so a
    // forced provider also serves requests using the canonical id.
    const match = findModelForId(models, modelId, discoveryAdapter.getModelIdMappings?.() ?? undefined);
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
      autoModelPath === true &&
      !hasModelPathHeader(inputHeaders) &&
      typeof modelId === "string" &&
      isAutoModelPathModel(
        modelId,
        discoveryAdapter.getModelIdMappings?.() ?? undefined
      ) &&
      DEEPSEEK_AUTO_NODE_URLS.some((nodeUrl) =>
        sameNode(nodeUrl, normalizedProvider)
      )
    ) {
      const nodePaths = await getNodeModelPaths(normalizedProvider);
      const resolved = nodePaths
        ? resolveDeepSeekModelPathSelectors(
            nodePaths,
            canonicalizeModelId(
              modelId,
              discoveryAdapter.getModelIdMappings?.() ?? undefined
            ),
            discoveryAdapter.getModelIdMappings?.() ?? undefined
          )
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
    autoModelPath === true &&
    !hasModelPathHeader(inputHeaders) &&
    typeof modelId === "string" &&
    isAutoModelPathModel(
      modelId,
      discoveryAdapter.getModelIdMappings?.() ?? undefined
    )
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
      const best = pickAcceptableProvider(ranking) ?? ranking[0];
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
      const fallbackBest = pickAcceptableProvider(fallback) ?? fallback[0];
      baseUrl = fallbackBest.baseUrl;
      selectedModel = fallbackBest.model;
    }
  } else {
    const ranking = providerManager.getProviderPriceRankingForModel(modelId, {
      torMode,
      includeDisabled: false,
    });
    if (ranking.length === 0) {
      throw new Error(`No providers found for model: ${modelId}`);
    }
    // Cheapest-first among providers that accept a funded mint (fail open
    // when the mint cache is empty).
    const cheapest = pickAcceptableProvider(ranking) ?? ranking[0];
    baseUrl = cheapest.baseUrl;
    selectedModel = cheapest.model;
  }

  // ── Mint resolution ─────────────────────────────────────────────────
  const providerMints = (
    discoveryAdapter.getCachedMints()[baseUrl] || []
  ).map(normalizeMint);
  const activeMint = walletAdapter.getActiveMintUrl();
  const mintAcceptedByProvider = (mintUrl: string): boolean =>
    providerMints.length === 0 || providerMints.includes(normalizeMint(mintUrl));
  const mintUrl =
    (activeMint &&
    fundedMintSet.has(normalizeMint(activeMint)) &&
    mintAcceptedByProvider(activeMint)
      ? activeMint
      : undefined) ||
    fundedMints.find((mint) => mintAcceptedByProvider(mint)) ||
    activeMint ||
    providerMints[0] ||
    Object.keys(walletBalances)[0];

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

  return {
    client,
    baseUrl,
    mintUrl,
    selectedModel,
    requestedModelId: canonicalizeModelId(modelId, discoveryAdapter.getModelIdMappings?.() ?? undefined),
    modelPath,
    pinnedProvider,
  };
}
