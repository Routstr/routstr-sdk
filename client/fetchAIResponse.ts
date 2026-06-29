import type { Message, Model, StreamingResult, SdkLogger } from "../core/types";
import type {
  StreamingCallbacks,
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
} from "../wallet/interfaces";
import type { DiscoveryAdapter } from "../discovery/interfaces";
import { StreamProcessor } from "./StreamProcessor";
import type { AlertLevel, RoutstrClientMode } from "./RoutstrClient";
import {
  resolveRequestContext,
  type ResolveContextInput,
} from "./resolveRequestContext";
import type { UsageTrackingDriver } from "../storage/usageTracking";
import type { SdkStore } from "../storage/store";
import type { ModelManager } from "../discovery/ModelManager";
import type { ProviderManager } from "./ProviderManager";

// Re-export for convenience so callers can import from a single place
export { resolveRequestContext };
export type { ResolveContextInput, ResolvedContext } from "./resolveRequestContext";

/**
 * Options for fetching AI response.
 *
 * Two paths are supported:
 *
 * 1. **Pre-resolved** (backward-compatible): provide `selectedModel`,
 *    `baseUrl`, and `mintUrl` directly. The caller is responsible for
 *    discovery and ranking.
 *
 * 2. **Auto-discovery**: provide `modelId` + adapters (`discoveryAdapter`,
 *    `walletAdapter`, `storageAdapter`, `providerRegistry`). The function
 *    bootstraps ModelManager, fetches models, ranks providers by price,
 *    resolves a mint, and builds a RoutstrClient internally.
 */
export interface FetchOptions {
  /** Message history for the conversation */
  messageHistory: Message[];

  // ── Pre-resolved path (use selectModel/baseUrl/mintUrl) ──────────
  /** Pre-resolved model with pricing info */
  selectedModel?: Model;
  /** Pre-resolved provider base URL */
  baseUrl?: string;
  /** Pre-resolved mint URL */
  mintUrl?: string;

  // ── Auto-discovery path (use modelId + adapters) ─────────────────
  /** The model ID to discover and route (e.g., "gpt-4o") */
  modelId?: string;
  /** Force a specific provider (skips price ranking) */
  forcedProvider?: string;
  /** Additional provider URLs to include */
  includeProviderUrls?: string[];
  /** Tor mode for onion routing */
  torMode?: boolean;
  /** Force refresh of cached data */
  forceRefresh?: boolean;
  /** Nostr pubkey for routstr review/model events */
  routstrPubkey?: string;
  /** Client mode (xcashu or apikeys) */
  mode?: "xcashu" | "apikeys";

  /** Optional: max tokens for the completion */
  maxTokens?: number;
  /** Optional: request headers to forward upstream */
  headers?: Record<string, string>;

  // ── Adapters (only needed for auto-discovery path) ────────────────
  /** Discovery adapter for model/mint discovery */
  discoveryAdapter?: DiscoveryAdapter;
  /** Wallet adapter for Cashu operations */
  walletAdapter?: WalletAdapter;
  /** Storage adapter for caching */
  storageAdapter?: StorageAdapter;
  /** Provider registry for tracking available providers */
  providerRegistry?: ProviderRegistry;
  /** Optional: pre-initialized ModelManager (skips bootstrap if provided) */
  modelManager?: ModelManager;
  /** Optional: shared ProviderManager instance for consistent failure tracking */
  providerManager?: ProviderManager;
  /** Optional: explicit usage tracking driver */
  usageTrackingDriver?: UsageTrackingDriver;
  /** Optional: explicit SDK store */
  sdkStore?: SdkStore;
}

interface FetchAIResponseClient {
  routeRequest(params: {
    path: string;
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    baseUrl: string;
    mintUrl: string;
    modelId?: string;
  }): Promise<Response>;
  getMode(): RoutstrClientMode;
}

export interface FetchAIResponseDeps {
  /**
   * Client for making routed requests.
   *
   * Required when using the pre-resolved path (FetchOptions provides
   * selectedModel/baseUrl/mintUrl). Optional when using auto-discovery
   * (FetchOptions provides modelId + adapters) — a RoutstrClient is
   * created internally.
   */
  client?: FetchAIResponseClient;
  alertLevel: AlertLevel;
  logger: SdkLogger;
  getPendingCashuTokenAmount?: () => number;
}

/**
 * Fetch an AI chat/completions response using RoutstrClient.routeRequest for
 * payment/auth/failover/accounting, then consume the returned SSE stream and
 * drive the legacy streaming callbacks.
 *
 * Supports two operational modes:
 * - **Pre-resolved**: caller passes selectedModel/baseUrl/mintUrl + client in deps
 * - **Auto-discovery**: caller passes modelId + adapters in options; the function
 *   bootstraps discovery, ranks providers, resolves a mint, and creates a client.
 */
export async function fetchAIResponse(
  options: FetchOptions,
  callbacks: StreamingCallbacks,
  deps: FetchAIResponseDeps
): Promise<void> {
  const {
    messageHistory,
    maxTokens,
    headers,
  } = options;

  try {
    // ── Resolve selectedModel / baseUrl / mintUrl / client ────────────
    let selectedModel: Model;
    let baseUrl: string;
    let mintUrl: string;
    let client: FetchAIResponseClient;

    if (options.selectedModel && options.baseUrl && options.mintUrl && deps.client) {
      // Pre-resolved path (backward-compatible)
      selectedModel = options.selectedModel;
      baseUrl = options.baseUrl;
      mintUrl = options.mintUrl;
      client = deps.client;
    } else if (options.modelId) {
      // Auto-discovery path
      if (!deps.logger) {
        throw new Error(
          "fetchAIResponse auto-discovery requires a logger in deps"
        );
      }

      const {
        discoveryAdapter,
        walletAdapter,
        storageAdapter,
        providerRegistry,
      } = options;

      if (!discoveryAdapter || !walletAdapter || !storageAdapter || !providerRegistry) {
        throw new Error(
          "fetchAIResponse auto-discovery requires discoveryAdapter, walletAdapter, storageAdapter, and providerRegistry in FetchOptions"
        );
      }

      const resolved = await resolveRequestContext({
        modelId: options.modelId,
        forcedProvider: options.forcedProvider,
        walletAdapter,
        storageAdapter,
        providerRegistry,
        discoveryAdapter,
        includeProviderUrls: options.includeProviderUrls,
        torMode: options.torMode,
        forceRefresh: options.forceRefresh,
        mode: options.mode,
        routstrPubkey: options.routstrPubkey,
        logger: deps.logger,
        modelManager: options.modelManager,
        providerManager: options.providerManager,
        usageTrackingDriver: options.usageTrackingDriver,
        sdkStore: options.sdkStore,
      });

      selectedModel = resolved.selectedModel;
      baseUrl = resolved.baseUrl;
      mintUrl = resolved.mintUrl;
      client = resolved.client;
    } else {
      throw new Error(
        "fetchAIResponse requires either (selectedModel + baseUrl + mintUrl + client in deps) or (modelId + discoveryAdapter + walletAdapter + storageAdapter + providerRegistry in options)"
      );
    }

    const apiMessages = await convertMessages(messageHistory);

    callbacks.onPaymentProcessing?.(true);

    callbacks.onTokenCreated?.(deps.getPendingCashuTokenAmount?.() ?? 0);

    const body: any = {
      model: selectedModel.id,
      messages: apiMessages,
      stream: true,
    };

    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    if (selectedModel?.name?.startsWith("OpenAI:")) {
      body.tools = [{ type: "web_search" }];
    }

    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body,
      headers,
      baseUrl,
      mintUrl,
      modelId: selectedModel.id,
    });

    if (!response.body) {
      throw new Error("Response body is not available");
    }

    if (response.status !== 200) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const streamProcessor = new StreamProcessor();
    const streamingResult = await streamProcessor.process(
      response,
      {
        onContent: callbacks.onStreamingUpdate,
        onThinking: callbacks.onThinkingUpdate,
      },
      selectedModel.id
    );

    if (streamingResult.finish_reason === "content_filter") {
      callbacks.onMessageAppend({
        role: "assistant",
        content: "Your request was denied due to content filtering.",
      });
    } else if (
      streamingResult.content ||
      (streamingResult.images && streamingResult.images.length > 0)
    ) {
      const message = await createAssistantMessage(streamingResult);
      callbacks.onMessageAppend(message);
    } else {
      callbacks.onMessageAppend({
        role: "system",
        content: "The provider did not respond to this request.",
      });
    }

    callbacks.onStreamingUpdate("");
    callbacks.onThinkingUpdate("");

    // routeRequest owns usage extraction + balance finalization. For streaming
    // responses it runs finalization in the background while this function
    // consumes the client-facing stream. Consumers that need exact cost can read
    // the persisted usage entry later.
  } catch (error) {
    handleError(error, callbacks, deps.alertLevel, deps.logger);
  } finally {
    callbacks.onPaymentProcessing?.(false);
  }
}

async function convertMessages(messages: Message[]): Promise<any[]> {
  return Promise.all(
    messages
      .filter((m) => m.role !== "system")
      .map(async (m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content,
      }))
  );
}

async function createAssistantMessage(result: StreamingResult): Promise<Message> {
  if (result.images && result.images.length > 0) {
    const content: any[] = [];

    if (result.content) {
      content.push({
        type: "text",
        text: result.content,
        thinking: result.thinking,
        citations: result.citations,
        annotations: result.annotations,
      });
    }

    for (const img of result.images) {
      content.push({
        type: "image_url",
        image_url: {
          url: img.image_url.url,
        },
      });
    }

    return {
      role: "assistant",
      content,
    };
  }

  return {
    role: "assistant",
    content: result.content || "",
  };
}

function handleError(
  error: unknown,
  callbacks: StreamingCallbacks,
  alertLevel: AlertLevel,
  logger: SdkLogger
): void {
  logger.error("[fetchAIResponse] Error occurred", error);

  if (error instanceof Error) {
    const isStreamError =
      error.message.includes("Error in input stream") ||
      error.message.includes("Load failed");
    const modifiedErrorMsg = isStreamError
      ? "AI stream was cut off, turn on Keep Active or please try again"
      : error.message;

    logger.error(
      `[fetchAIResponse] Error type=${error.constructor.name}, message=${modifiedErrorMsg}, isStreamError=${isStreamError}`
    );

    callbacks.onMessageAppend({
      role: "system",
      content:
        "Uncaught Error: " +
        modifiedErrorMsg +
        (alertLevel === "max" ? " | " + error.stack : ""),
    });
  } else {
    callbacks.onMessageAppend({
      role: "system",
      content: "Unknown Error: Please tag Routstr on Nostr and/or retry.",
    });
  }
}
