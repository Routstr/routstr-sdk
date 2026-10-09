/**
 * RoutstrClient - Main API client for Routstr
 *
 * Orchestrates:
 * - Token spending via CashuSpender
 * - API requests with authentication
 * - Streaming response processing
 * - Provider failover via ProviderManager
 * - Error handling and refunds
 *
 * Extracted from utils/apiUtils.ts
 */

import type { SdkLogger, TopUpResult } from "../core/types";
import type { Model } from "../core/types";
import { consoleLogger } from "../core/types";
import type {
  WalletAdapter,
  StorageAdapter,
} from "../wallet/interfaces";
import type { DiscoveryAdapter } from "../discovery/interfaces";
import type { UsageTrackingDriver } from "../storage/usageTracking";
import type { SdkStore } from "../storage/store";
import { CashuSpender } from "../wallet/CashuSpender";
import { BalanceManager } from "../wallet/BalanceManager";
import { ProviderManager } from "./ProviderManager";
import { MODEL_PATH_HEADER, canonicalModelPath, modelPathCandidateKey } from "../utils/modelPaths";
import type { ModelPathSatsPricing } from "../utils/modelPaths";
import {
  ProviderError,
  FailoverError,
  InsufficientBalanceError,
  ProviderMintBalanceError,
  TokenAlreadySpentError,
  MintError,
  InvalidTokenError,
  UntrustedMintError,
  CashuRedemptionError,
  TokenConsumedError,
  CoreInternalError,
} from "../core/errors";
import type { UpstreamEnvelope } from "../core/errors";
import {
  parseCoreError,
  CoreErrorCode,
  CoreErrorType,
  isInvalidTokenError,
  isUntrustedMintError,
  isCashuRedemptionError,
  isTokenConsumedError,
  isCoreInternalError,
  isHandledRedemptionError,
  isUpstreamRequestError,
  isUnknownPathError,
  shouldFailoverToAnotherMint,
  shouldPurgeStoredCredential,
  type ParsedCoreError,
} from "../core/errorTypes";
import {
  canonicalIdForModel,
  canonicalizeModelId,
} from "../core/modelMappings";
import { isNetworkErrorMessage } from "../wallet/tokenUtils";
import { getDefaultSdkStore, getDefaultUsageTrackingDriver } from "../storage";
import {
  extractResponseId,
  extractUsageFromResponseBody,
  extractUsageFromResponseHeaders,
  type UsageTrackingData,
} from "./usage";
import { inspectSSEWebStream } from "./sse";
import {
  isTinfoilModel,
  getTinfoilUpstreamModelId,
  prepareTinfoilClient,
  fetchTinfoilPreservingPlaintextErrors,
} from "./TinfoilSecure";
import { isOpenAiJsonBodyPath } from "../utils/openAiEndpoints";

/**
 * RoutstrClient is the main SDK entry point
 */
export type AlertLevel = "max" | "min";
export type RoutstrClientMode = "xcashu" | "apikeys";
export type DebugLevel = "DEBUG" | "WARN" | "ERROR";

const TOPUP_MARGIN = 1.4;

/** Never put spendable credentials (including even a prefix) in SDK logs. */
const REDACTED_CREDENTIAL = "[REDACTED]";

interface RequestFailures {
  attemptedProviders: Set<string>;
  errors: Array<{
    status: number;
    type?: string;
    code?: string | number;
    message: string;
    providers: string[];
  }>;
}

/** Response headers safe to hand to a caller forwarding an upstream error. */
const FORWARDABLE_ERROR_HEADERS = new Set([
  "content-type",
  "retry-after",
  "retry-after-ms",
  "x-routstr-request-id",
  "x-routstr-error-scope",
  "x-routstr-provider",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
]);

/**
 * Framing/hop-by-hop headers are tied to the body we consumed; never reuse
 * them for a body we re-wrap ourselves. Checked separately so they stay blocked
 * even if the allowlist above ever grows.
 */
const NEVER_FORWARDED_ERROR_HEADERS = new Set([
  "transfer-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

/** Pick the forwardable, non-framing subset of an upstream error's headers. */
function forwardableErrorHeaders(headers: Headers): Record<string, string> {
  const captured: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (NEVER_FORWARDED_ERROR_HEADERS.has(lower)) return;
    if (!FORWARDABLE_ERROR_HEADERS.has(lower)) return;
    captured[lower] = value;
  });
  return captured;
}

/** Floor for proactive topup amounts as a fraction of the request price,
 *  mirroring the 402 handler's heuristic. */
const PROACTIVE_TOPUP_MIN_FRACTION = 0.21;

/**
 * An SDK-pinned x-routstr-model-path selector and the per-route pricing the
 * node advertised for it. Marks the request as auto-pinned (failover may
 * re-resolve a selector on the next model-path node); caller-supplied
 * selectors never fail over.
 */
export interface ModelPathPin {
  selector: string;
  satsPricing?: ModelPathSatsPricing;
}

export interface RouteRequestParams {
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  baseUrl: string;
  mintUrl: string;
  modelId?: string;
  clientApiKey?: string;
  /**
   * Optional per-request secret scoping Tinfoil's prompt cache. Prefer a
   * stable, opaque, per-end-user value in multi-user deployments so users
   * under the same Tinfoil API identity cannot observe each other's cache
   * timing. Falls back to the client-level option, then the
   * TINFOIL_USER_CACHE_SECRET environment variable, then a generated secret.
   */
  userCacheSecret?: string;
  /** Optional: abort the in-flight request and stream consumption. */
  signal?: AbortSignal;
  /**
   * Set by the SDK's automatic model-path pinning (see resolveRequestContext).
   */
  autoModelPath?: ModelPathPin;
  /**
   * True when the caller forced a provider (see `forcedProvider` in
   * resolveRequestContext). A forced provider is a pin: the request must
   * never fail over to a different node.
   */
  pinnedProvider?: boolean;
}

export interface RequestResponseLogRequestInput {
  method: string;
  url: string;
  path: string;
  baseUrl: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export interface RequestResponseLogSink {
  logRequest?(input: RequestResponseLogRequestInput): string | undefined | Promise<string | undefined>;
  logResponseStart?(id: string | undefined, response: Response): void | Promise<void>;
  logResponseChunk?(id: string | undefined, sequence: number, text: string): void | Promise<void>;
  logResponseEnd?(id: string | undefined): void | Promise<void>;
  logResponseError?(id: string | undefined, error: unknown): void | Promise<void>;
  logResponseBody?(id: string | undefined, response: Response): void | Promise<void>;
}

export interface RoutstrClientConfig {
  usageTrackingDriver?: UsageTrackingDriver;
  sdkStore?: SdkStore;
  /** Optional: shared ProviderManager instance for consistent failure tracking across requests */
  providerManager?: ProviderManager;
  /** Optional: injectable logger (defaults to consoleLogger) */
  logger?: SdkLogger;
  /** Optional: raw request/response logging callbacks supplied by the runtime/app. */
  requestResponseLogSink?: RequestResponseLogSink;
  /**
   * Optional client-level secret scoping Tinfoil's prompt cache. Individual
   * `routeRequest` calls can override this with their own `userCacheSecret`.
   */
  userCacheSecret?: string;
  /**
   * Optional file path for the persisted default `userCacheSecret`
   * (analogous to `options.dbPath` on the sqlite storage driver). When
   * omitted, the secret persists at `~/.tinfoil/user_cache_secret`, shared
   * with Tinfoil's own SDKs. Set this to keep the app's secret isolated
   * (e.g. inside a routstrd data directory).
   */
  tinfoilCacheSecretPath?: string;
}

export class RoutstrClient {
  private cashuSpender: CashuSpender;
  private balanceManager: BalanceManager;
  private providerManager: ProviderManager;
  private alertLevel: AlertLevel;
  private mode: RoutstrClientMode;
  private debugLevel: DebugLevel = "WARN";
  private usageTrackingDriver?: UsageTrackingDriver;
  private sdkStore?: SdkStore;
  private logger: SdkLogger;
  private requestResponseLogSink?: RequestResponseLogSink;
  private userCacheSecret?: string;
  private tinfoilCacheSecretPath?: string;

  /** In-flight topup promises keyed by `${baseUrl}:${apiKey}`. Concurrent
   *  callers — proactive spin-offs and 402 handlers alike — share a single
   *  topUp call instead of stacking multiple deposits. */
  private _inflightTopups = new Map<string, Promise<TopUpResult>>();

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private discoveryAdapter: DiscoveryAdapter,
    alertLevel: AlertLevel,
    mode: RoutstrClientMode = "xcashu",
    options: RoutstrClientConfig = {}
  ) {
    this.logger = (options.logger ?? consoleLogger).child("RoutstrClient");
    this.balanceManager = new BalanceManager(
      walletAdapter,
      storageAdapter,
      discoveryAdapter,
      undefined,
      this.logger
    );
    this.cashuSpender = new CashuSpender(
      walletAdapter,
      storageAdapter,
      discoveryAdapter,
      this.balanceManager,
      this.logger
    );
    this.alertLevel = alertLevel;
    this.mode = mode;
    this.usageTrackingDriver = options.usageTrackingDriver;
    this.sdkStore = options.sdkStore;
    this.requestResponseLogSink = options.requestResponseLogSink;
    this.userCacheSecret = options.userCacheSecret;
    this.tinfoilCacheSecretPath = options.tinfoilCacheSecretPath;
    // Use provided ProviderManager or create a new one
    this.providerManager =
      options.providerManager ??
      new ProviderManager(discoveryAdapter, this.sdkStore, this.logger);
  }

  /**
   * Get the current client mode
   */
  getMode(): RoutstrClientMode {
    return this.mode;
  }

  getDebugLevel(): DebugLevel {
    return this.debugLevel;
  }

  setDebugLevel(level: DebugLevel): void {
    this.debugLevel = level;
  }

  private _log(level: "DEBUG" | "WARN" | "ERROR", ...args: unknown[]): void {
    const levelPriority: Record<DebugLevel, number> = {
      DEBUG: 0,
      WARN: 1,
      ERROR: 2,
    };

    if (levelPriority[level] >= levelPriority[this.debugLevel]) {
      switch (level) {
        case "DEBUG":
          this.logger.log(...args);
          break;
        case "WARN":
          this.logger.warn(...args);
          break;
        case "ERROR":
          this.logger.error(...args);
          break;
      }
    }
  }

  /**
   * Get the CashuSpender instance
   */
  getCashuSpender(): CashuSpender {
    return this.cashuSpender;
  }

  /**
   * Get the BalanceManager instance
   */
  getBalanceManager(): BalanceManager {
    return this.balanceManager;
  }

  /**
   * Get the ProviderManager instance
   */
  getProviderManager(): ProviderManager {
    return this.providerManager;
  }

  /**
   * Check if the client is currently busy (in critical section)
   */
  get isBusy(): boolean {
    return this.cashuSpender.isBusy;
  }

  /**
   * Route an API request to the upstream provider
   *
   * This is a simpler alternative to fetchAIResponse that just proxies
   * the request upstream without the streaming callback machinery.
   * Useful for daemon-style routing where you just need to forward
   * requests and get responses back.
   */
  async routeRequest(params: RouteRequestParams): Promise<Response> {
    const prepared = await this._prepareRoutedRequestWithMintFailover(params);
    const contentType =
      prepared.response.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");

    // Error payment recovery is handled in _handleErrorResponse. There is no
    // successful usage to account for; keep finalization off passthrough errors.
    if ((prepared.response as any).passthrough) {
      return prepared.response;
    }

    // For SSE, defer accounting until the inspector (tee'd branch) has seen
    // usage — which only happens as the client consumes the stream. We expose
    // the finalization as `(response).finalize` so callers that want to block
    // on accounting (e.g. a proxy after it finished piping) can `await` it.
    // Non-SSE responses can be finalized inline since the body is fully
    // available (the clone-and-read path inside `_trackResponseUsage` handles
    // JSON bodies without consuming the client-facing copy).
    const runFinalize = async (): Promise<number> => {
      const { capturedUsage, capturedResponseId } = await prepared.usagePromise;
      const usage = capturedUsage ?? prepared.capturedUsage;
      const requestId = capturedResponseId ?? prepared.capturedResponseId;
      const satsSpent = await this._handlePostResponseBalanceUpdate({
        token: prepared.tokenUsed,
        baseUrl: prepared.baseUrlUsed,
        initialTokenBalance: prepared.tokenBalanceInSats,
        initialTokenBalanceUnknown: prepared.tokenBalanceUnknown,
        fallbackSatsSpent: usage?.satsCost,
        response: prepared.response,
        modelId: prepared.modelId,
        usage,
        requestId,
        clientApiKey: prepared.clientApiKey,
      });
      (prepared.response as any).satsSpent = satsSpent;
      (prepared.response as any).usage = usage;
      (prepared.response as any).requestId = requestId;
      return satsSpent;
    };

    if (isSSE) {
      // Expose a finalize() that the caller can await after it's done piping
      // the stream to its client. Also fire-and-forget so accounting still
      // happens even if the caller ignores it.
      const finalizePromise = runFinalize().catch((error) => {
        this._log("ERROR", "[RoutstrClient] SSE finalize failed:", error);
        return 0;
      });
      (prepared.response as any).finalize = () => finalizePromise;
      return prepared.response;
    }

    await runFinalize();
    return prepared.response;
  }

  /**
   * Run the initial deposit, failing over to another provider when the
   * wallet cannot fund any mint the selected provider accepts.
   *
   * The post-key 402 path already fails over; without this the very first
   * deposit (no key yet) hard-failed with a 402 even though another provider
   * accepted a funded mint.
   */
  private async _prepareRoutedRequestWithMintFailover(
    params: RouteRequestParams
  ): Promise<Awaited<ReturnType<RoutstrClient["_prepareRoutedRequest"]>>> {
    let current = params;
    const attempted = new Set<string>();
    const triedModelPaths = new Set<string>();
    for (;;) {
      try {
        return await this._prepareRoutedRequest(current);
      } catch (error) {
        if (!(error instanceof ProviderMintBalanceError)) throw error;
        const selector = this._findModelPathHeader(current.headers ?? {});
        if (current.pinnedProvider || (selector && !current.autoModelPath)) {
          throw error;
        }
        attempted.add(current.baseUrl);
        if (!current.modelId) throw error;
        const fundedMints = Object.entries(
          await this.walletAdapter.getBalances()
        )
          .filter(([, balance]) => typeof balance === "number" && balance > 0)
          .map(([mintUrl]) =>
            mintUrl.endsWith("/") ? mintUrl.slice(0, -1) : mintUrl
          );
        if (current.autoModelPath) {
          triedModelPaths.add(modelPathCandidateKey(
            current.baseUrl, current.autoModelPath.selector
          ));
          const [next] = await this.providerManager.getModelPathProviderRanking(
            current.modelId,
            {
              excludeBaseUrls: attempted,
              excludeModelPaths: triedModelPaths,
              acceptableMintUrls: fundedMints,
            }
          );
          const nextSelector = next?.selectors[0];
          if (!next || !nextSelector) throw error;
          const headers = Object.fromEntries(
            Object.entries(current.headers ?? {}).filter(
              ([name]) => name.toLowerCase() !== MODEL_PATH_HEADER
            )
          );
          current = {
            ...current,
            baseUrl: next.baseUrl,
            headers: { ...headers, [MODEL_PATH_HEADER]: nextSelector },
            autoModelPath: {
              selector: nextSelector,
              satsPricing: next.satsPricing[0] ?? undefined,
            },
          };
          continue;
        }
        const nextProvider = this._findNextBestProvider(
          current.modelId,
          current.baseUrl,
          attempted,
          fundedMints
        );
        if (!nextProvider || attempted.has(nextProvider)) throw error;
        this._log(
          "WARN",
          `[RoutstrClient] routeRequest: provider-mint shortfall on ${current.baseUrl}; failing over to ${nextProvider}`
        );
        current = { ...current, baseUrl: nextProvider };
      }
    }
  }

  private async _prepareRoutedRequest(params: RouteRequestParams): Promise<{
    response: Response;
    tokenUsed: string;
    baseUrlUsed: string;
    tokenBalanceInSats: number;
    tokenBalanceUnknown: boolean;
    modelId?: string;
    capturedUsage?: UsageTrackingData;
    capturedResponseId?: string;
    clientApiKey?: string;
    usagePromise: Promise<{
      capturedUsage?: UsageTrackingData;
      capturedResponseId?: string;
    }>;
  }> {
    const {
      path: requestPath,
      method,
      body,
      headers = {},
      baseUrl,
      mintUrl,
      modelId,
      clientApiKey: providedClientApiKey,
      userCacheSecret: providedUserCacheSecret,
    } = params;

    const userCacheSecret = providedUserCacheSecret ?? this.userCacheSecret;

    // Extract clientApiKey for tracking. Only explicitly allowed routing headers
    // may be forwarded; client credentials must never replace SDK payment auth.
    const clientApiKey =
      providedClientApiKey ?? this._extractClientApiKey(headers);

    await this._checkBalance(baseUrl);

    let requiredSats = 1;
    let selectedModel: Model | undefined;
    let requestMaxTokens: number | undefined;
    if (modelId) {
      const providerModel = await this.providerManager.getModelForProvider(
        baseUrl,
        modelId
      );
      selectedModel = providerModel ?? undefined;
      if (selectedModel) {
        const requestMessages = Array.isArray(
          (body as { messages?: unknown })?.messages
        )
          ? ((body as { messages?: unknown }).messages as any[])
          : [];
        const requestBodyForPricing = (body ?? {}) as Record<string, unknown>;
        requestMaxTokens =
          typeof requestBodyForPricing.max_tokens === "number"
            ? (requestBodyForPricing.max_tokens as number)
            : typeof requestBodyForPricing.max_output_tokens === "number"
              ? (requestBodyForPricing.max_output_tokens as number)
              : undefined;

        this._log(
          "DEBUG",
          "[RoutstrClient] generic request pricing input",
          {
            modelId: selectedModel.id,
            messageCount: requestMessages.length,
            maxTokens: requestMaxTokens,
          }
        );

        requiredSats = this.providerManager.getRequiredSatsForModel(
          selectedModel,
          requestMessages,
          requestMaxTokens,
          requestBodyForPricing,
          params.autoModelPath?.satsPricing
        );
      }
    }

    let requestBody = body;
    if (body && typeof body === "object") {
      const bodyObj = body as Record<string, unknown>;
      // `stream` is OpenAI request vocabulary. Only normalize it on endpoints
      // that define it: strict non-chat endpoints (e.g. /v1/systemone) reject
      // unknown fields with a 400, so adding it there breaks the request.
      if (isOpenAiJsonBodyPath(requestPath) && !bodyObj.stream) {
        requestBody = { ...bodyObj, stream: false };
      }
    }

    // Forward the provider-native model id when selection resolved through a
    // static mapping: mapped providers only know their own id, so the
    // caller-facing canonical id would 400/404 upstream. Only touches JSON
    // bodies that already carry a string `model` field.
    if (selectedModel && requestBody && typeof requestBody === "object") {
      const bodyObj = requestBody as Record<string, unknown>;
      if (
        typeof bodyObj.model === "string" &&
        bodyObj.model !== selectedModel.id
      ) {
        requestBody = { ...bodyObj, model: selectedModel.id };
      }
    }

    // Keep the opaque selector in baseHeaders so request retries preserve it.
    // A caller-supplied selector is never forwarded to a different provider:
    // failover is disabled for caller-pinned requests in _handleErrorResponse.
    // An SDK auto-pin (params.autoModelPath) may fail over, with the selector
    // swapped for one the next node advertised.
    // Never spread incoming headers: Authorization, X-Cashu, cookies, etc. belong
    // to the caller, not the upstream payment connection.
    const baseHeaders = this._buildBaseHeaders();
    const modelPathSelector = this._findModelPathHeader(headers);
    if (modelPathSelector) {
      baseHeaders[MODEL_PATH_HEADER] = modelPathSelector;
    }

    // ─── Tinfoil EHBP: attest BEFORE spending tokens ──────
    const tinfoilEnabled = Boolean(modelId && isTinfoilModel(modelId));

    if (tinfoilEnabled) {
      this._log(
        "DEBUG",
        `[RoutstrClient] Attesting Tinfoil model ${modelId} before spend`
      );

      const { verification } = await prepareTinfoilClient({ baseUrl });

      this._log(
        "DEBUG",
        `[RoutstrClient] Tinfoil attestation passed, enclave=${verification.enclaveHost}, codeFingerprint=${verification.codeFingerprint.slice(0, 16)}...`
      );

      // Strip the tinfoil- prefix for the model id inside the encrypted body.
      // The attested enclave expects the bare model id (e.g. "kimi-k2-6"),
      // not the caller-facing routstr id (e.g. "tinfoil-kimi-k2-6").
      // The full id is sent in the X-Routstr-Model header for proxy-side lookup.
      if (requestBody && typeof requestBody === "object" && modelId) {
        requestBody = {
          ...(requestBody as Record<string, unknown>),
          model: getTinfoilUpstreamModelId(modelId),
        };
      }
    }

    // Spend tokens for the actual request
    const spendResult = await this._spendToken({
      mintUrl,
      amount: requiredSats,
      baseUrl,
    });

    const {
      token,
      tokenBalance,
      tokenReserved,
      tokenBalanceUnit,
      tokenBalanceUnknown,
      selectedMintUrl,
    } = spendResult;

    // Wait for a topup when the stored available balance cannot cover this
    // request. Within the margin, refill in the background without delaying
    // a request that can already succeed.
    await this._topUpIfNeeded({
      token,
      baseUrl,
      mintUrl,
      requiredSats,
      tokenBalance,
      tokenReserved,
      tokenBalanceUnit,
      tokenBalanceUnknown,
    });

    // Build final request headers (auth + Tinfoil model hint)
    const finalHeaders = this._withAuthAndTinfoilHeaders(
      baseHeaders,
      token,
      tinfoilEnabled,
      modelId
    );

    const response = await this._makeRequest({
      path: requestPath,
      method,
      body: method === "GET" ? undefined : requestBody,
      baseUrl,
      mintUrl,
      token,
      requiredSats,
      headers: finalHeaders,
      baseHeaders,
      selectedModel,
      selectedMintUrl,
      maxTokens: requestMaxTokens,
      tinfoilEnabled,
      userCacheSecret,
      tinfoilCacheSecretPath: this.tinfoilCacheSecretPath,
      signal: params.signal,
      // The SDK auto-pin marker must reach _handleErrorResponse to
      // distinguish an SDK-pinned selector (may fail over) from a
      // caller-pinned one (never does). Retry call sites inside
      // _handleErrorResponse spread ...params, so this is the single place
      // it can get lost.
      autoModelPath: params.autoModelPath,
      pinnedProvider: params.pinnedProvider,
      requestedModelId: modelId,
    });

    let tokenBalanceInSats =
      tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;
    let initialTokenBalanceUnknown = tokenBalanceUnknown;
    const baseUrlUsed = (response as any).baseUrl || baseUrl;
    const tokenUsed = (response as any).token || token;

    // If failover occurred, use the initial balance captured when the
    // failover token was created. Do not query here: by the time fetch returns,
    // the provider may already have charged the request.
    if (baseUrlUsed !== baseUrl || tokenUsed !== token) {
      if (typeof (response as any).initialTokenBalanceInSats === "number") {
        tokenBalanceInSats = (response as any).initialTokenBalanceInSats;
        initialTokenBalanceUnknown = Boolean(
          (response as any).initialTokenBalanceUnknown
        );
      } else {
        initialTokenBalanceUnknown = true;
      }
    }

    const contentType = response.headers.get("content-type") || "";
    let processedResponse = response;
    let capturedUsage: UsageTrackingData | undefined;
    let capturedResponseId: string | undefined;
    let usagePromise: Promise<{
      capturedUsage?: UsageTrackingData;
      capturedResponseId?: string;
    }> = Promise.resolve({});

    if (
      !(response as any).passthrough &&
      contentType.includes("text/event-stream") &&
      response.body
    ) {
      // Tee the upstream Web stream: one branch goes untouched to the client,
      // the other is consumed by an inspector that extracts usage / responseId.
      const [clientStream, inspectStream] = response.body.tee();
      const requestResponseLogId = (response as any).requestResponseLogId as
        | string
        | undefined;

      processedResponse = new Response(clientStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      (processedResponse as any).baseUrl = (response as any).baseUrl;
      (processedResponse as any).token = (response as any).token;
      (processedResponse as any).selectedMintUrl =
        (response as any).selectedMintUrl;
      (processedResponse as any).requestResponseLogId = requestResponseLogId;

      usagePromise = inspectSSEWebStream(
        inspectStream,
        (usage) => {
          capturedUsage = usage;
          (processedResponse as any).usage = usage;
        },
        (responseId) => {
          capturedResponseId = responseId;
          (processedResponse as any).requestId = responseId;
        },
        {
          onRawChunk: (_chunk, sequence, text) => {
            void this.requestResponseLogSink?.logResponseChunk?.(
              requestResponseLogId,
              sequence,
              text
            );
          },
        }
      ).then(async (result) => {
        await this.requestResponseLogSink?.logResponseEnd?.(requestResponseLogId);
        return result;
      }).catch(async (error) => {
        await this.requestResponseLogSink?.logResponseError?.(requestResponseLogId, error);
        throw error;
      });

      (processedResponse as any).usagePromise = usagePromise;
    }

    return {
      response: processedResponse,
      tokenUsed,
      baseUrlUsed,
      tokenBalanceInSats,
      tokenBalanceUnknown: initialTokenBalanceUnknown,
      modelId,
      capturedUsage,
      capturedResponseId,
      clientApiKey,
      usagePromise,
    };
  }

  /**
   * Extract clientApiKey from the inbound request headers if present.
   *
   * The key identifies which configured client made the call (usage
   * attribution); it is never forwarded as payment auth. Transports disagree
   * about where a key belongs: OpenAI-style clients send
   * `Authorization: Bearer <key>`, while Anthropic-style ones send
   * `x-api-key: <key>` — the Anthropic SDKs put `apiKey` there and reserve
   * `Authorization` for an OAuth `authToken`. Accept both spellings, so a
   * request routed over the Anthropic transport is attributed to its client
   * instead of being recorded as `unknown`.
   */
  private _extractClientApiKey(
    headers: Record<string, string>
  ): string | undefined {
    const authHeader = headers["Authorization"] || headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      const extractedKey = authHeader.slice(7);
      if (extractedKey) return extractedKey;
    }
    // Header names arrive lower-cased from Node's IncomingMessage; scan
    // case-insensitively anyway so callers passing their own map work too.
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "x-api-key") continue;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  }

  /**
   * Make the API request with failover support
   */
  private async _makeRequest(params: {
    path: string;
    method: string;
    body?: unknown;
    selectedModel?: Model;
    baseUrl: string;
    mintUrl: string;
    /** Actual mint used for this token; mintUrl is only the preference. */
    selectedMintUrl?: string;
    /** Mints already rejected while handling this request. */
    excludeMints?: string[];
    token: string;
    requiredSats: number;
    maxTokens?: number;
    headers: Record<string, string>;
    baseHeaders: Record<string, string>;
    retryCount?: number;
    /** Route the request body through Tinfoil SecureClient.fetch (EHBP). */
    tinfoilEnabled?: boolean;
    /** Secret scoping Tinfoil's prompt cache for this request. */
    userCacheSecret?: string;
    /** File path for the persisted default secret (client-level). */
    tinfoilCacheSecretPath?: string;
    /** Optional: abort the in-flight request. */
    signal?: AbortSignal;
    /** SDK-pinned model path for this request, if any. */
    autoModelPath?: ModelPathPin;
    /** Caller forced a provider: never fail over to another node. */
    pinnedProvider?: boolean;
    /**
     * The model id the caller originally requested. Cooldown keys, failover
     * candidate search and per-provider model lookup are all keyed by this
     * id (canonicalized) rather than selectedModel.id, which is just the
     * current provider's native spelling and differs between nodes.
     */
    requestedModelId?: string;
    /** (node, canonical path) candidates already attempted in this request. */
    triedModelPaths?: string[];
    failures?: RequestFailures;
  }): Promise<Response> {
    const { path, method, body, baseUrl, token, headers, tinfoilEnabled, signal } = params;

    // Bail out early if already aborted.
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    try {
      const url = `${baseUrl.replace(/\/$/, "")}${path}`;
      const requestBodyText =
        body === undefined || method === "GET" ? undefined : JSON.stringify(body);
      const requestLogId = await this.requestResponseLogSink?.logRequest?.({
        method,
        url,
        path,
        baseUrl,
        headers,
        body,
        rawBody: requestBodyText,
      });

      // Request headers contain bearer credentials / x-cashu tokens. The
      // request-response sink has its own header redaction; do not log raw headers.

      const response = tinfoilEnabled
        ? await fetchTinfoilPreservingPlaintextErrors(
            {
              baseUrl,
              userCacheSecret: params.userCacheSecret,
              tinfoilCacheSecretPath: params.tinfoilCacheSecretPath,
            },
            url,
            {
              method,
              headers,
              body: requestBodyText,
              signal,
            }
          )
        : await fetch(url, {
            method,
            headers,
            body: requestBodyText,
            signal,
          });
      if (this.mode === "xcashu") this._log("DEBUG", "response,", response);

      (response as any).baseUrl = baseUrl;
      (response as any).token = token;
      (response as any).selectedMintUrl = params.selectedMintUrl;
      (response as any).requestResponseLogId = requestLogId;
      await this.requestResponseLogSink?.logResponseStart?.(requestLogId, response);

      const contentType = response.headers.get("content-type") || "";

      if (!response.ok) {
        void this.requestResponseLogSink?.logResponseBody?.(requestLogId, response.clone());
        const requestId =
          response.headers.get("x-routstr-request-id") || undefined;
        // Capture the wire-level envelope before the body read consumes the response.
        const upstream: UpstreamEnvelope = {
          status: response.status,
          statusText: response.statusText,
          headers: forwardableErrorHeaders(response.headers),
        };
        let bodyText: string | undefined;
        try {
          bodyText = await response.text();
        } catch (e) {
          bodyText = undefined;
        }

        this._log("ERROR", "[RoutstrClient] Upstream error response", {
          baseUrl,
          url,
          path,
          status: response.status,
          statusText: response.statusText,
          requestId,
          body: bodyText ?? "<unable to read response body>",
        });

        return await this._handleErrorResponse(
          params,
          token,
          response.status,
          requestId,
          this.mode === "xcashu"
            ? (response.headers.get("x-cashu") ?? undefined)
            : undefined,
          bodyText,
          params.retryCount ?? 0,
          upstream
        );
      }

      // Only a successful model invocation proves this exact scope recovered.
      // Metadata/payment requests must not reset inference failure history.
      // HTTP success counts immediately, including SSE headers; stream errors
      // after this point are outside request-level cooldown tracking.
      if (
        params.selectedModel &&
        method.toUpperCase() === "POST" &&
        body &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).model === "string"
      ) {
        const modelId = this._canonicalRequestModelId(
          params.selectedModel,
          params.requestedModelId
        );
        const pinnedModelPath = this._findModelPathHeader(params.baseHeaders);
        const modelPath = pinnedModelPath
          ? canonicalModelPath(pinnedModelPath) ?? undefined
          : undefined;
        this.providerManager.recordSuccess(baseUrl, modelId, modelPath);
      }

      if (!contentType.includes("text/event-stream")) {
        void this.requestResponseLogSink?.logResponseBody?.(requestLogId, response.clone());
      }

      return response;
    } catch (error: any) {
      // Handle network errors with failover
      if (isNetworkErrorMessage(error?.message || "")) {
        const fetchUrl = `${baseUrl.replace(/\/$/, "")}${path}`;
        this._log("ERROR", "[RoutstrClient] Network error fetching from provider", {
          baseUrl,
          url: fetchUrl,
          path,
          error: error?.message || String(error),
        });
        return await this._handleErrorResponse(
          params,
          token,
          -1, // just for Network Error to skip all statuses
          undefined,
          undefined,
          error?.message || String(error),
          params.retryCount ?? 0
        );
        // return await this._handleNetworkError(error, params);
      }
      throw error;
    }
  }

  /**
   * Decide the cooldown scope for a failure.
   *
   * - Network errors (status -1) and `mint_unreachable` are model-independent:
   *   the provider host or its mint/wallet infrastructure is down, so the
   *   whole provider is cooled down (empty scope).
   * - A pinned x-routstr-model-path request attributes the failure to that
   *   upstream route: only the canonical path is cooled on the provider, so
   *   the provider's other routes for the same model stay usable.
   * - Otherwise the failure is attributed to the selected model only.
   */
  private _getCooldownScope(
    status: number,
    parsedError: ParsedCoreError,
    selectedModel?: Model,
    pinnedModelPath?: string,
    requestedModelId?: string
  ): { modelId?: string; modelPath?: string } {
    if (!selectedModel) return {};
    if (status === -1) return {};
    if (parsedError.type === CoreErrorType.MINT_UNREACHABLE) return {};
    const modelId = this._canonicalRequestModelId(
      selectedModel,
      requestedModelId
    );
    if (pinnedModelPath) {
      const modelPath = canonicalModelPath(pinnedModelPath);
      if (modelPath) return { modelId, modelPath };
    }
    return { modelId };
  }

  /**
   * The model identity used for cooldowns and failover: the canonical form
   * of the id the caller requested. A provider's native id for the model
   * (selectedModel.id) can differ per node — e.g. "claude-opus-5-5" on a
   * node that aliases the requested "claude-opus-5.5" — and keying state by
   * it makes cooldown writes miss the checks the ranking performs with the
   * requested id, and makes failover skip nodes that list only the
   * requested spelling. Falls back to the selected model's own canonical id
   * when the request carries no requested id.
   */
  private _canonicalRequestModelId(
    selectedModel: Model,
    requestedModelId?: string
  ): string {
    return requestedModelId !== undefined
      ? canonicalizeModelId(requestedModelId, this.discoveryAdapter.getModelIdMappings?.() ?? undefined)
      : canonicalIdForModel(selectedModel, this.discoveryAdapter.getModelIdMappings?.() ?? undefined);
  }

  /**
   * Mint-aware failover candidate search. Omits the mint option entirely
   * when the wallet has no funded mints, so providers are never filtered on
   * an empty set (and callers/tests observe the plain three-argument call).
   */
  private _findNextBestProvider(
    modelId: string,
    currentBaseUrl: string,
    attempted: ReadonlySet<string>,
    fundedMints: string[]
  ): string | null {
    if (fundedMints.length === 0) {
      return this.providerManager.findNextBestProvider(
        modelId,
        currentBaseUrl,
        attempted
      );
    }
    return this.providerManager.findNextBestProvider(
      modelId,
      currentBaseUrl,
      attempted,
      { acceptableMintUrls: fundedMints }
    );
  }

  /**
   * Handle error responses with failover
   */
  private async _handleErrorResponse(
    params: {
      path: string;
      method: string;
      body?: unknown;
      selectedModel?: Model;
      baseUrl: string;
      mintUrl: string;
      selectedMintUrl?: string;
      excludeMints?: string[];
      token: string;
      requiredSats: number;
      maxTokens?: number;
      headers: Record<string, string>;
      baseHeaders: Record<string, string>;
      tinfoilEnabled?: boolean;
      signal?: AbortSignal;
      /** SDK-pinned model path for this request, if any. */
      autoModelPath?: ModelPathPin;
      /** Caller forced a provider: never fail over to another node. */
      pinnedProvider?: boolean;
      /** The originally requested model id (see _makeRequest). */
      requestedModelId?: string;
      /** (node, canonical path) candidates already attempted in this request. */
      triedModelPaths?: string[];
      failures?: RequestFailures;
    },
    token: string,
    status: number,
    requestId?: string,
    xCashuRefundToken?: string,
    responseBody?: string,
    retryCount: number = 0,
    upstream?: UpstreamEnvelope
  ): Promise<Response> {
    const MAX_RETRIES_PER_PROVIDER = 2;
    const { path, method, body, selectedModel, baseUrl, mintUrl } = params;
    let tryNextProvider: boolean = false;

    // Request-local history is shared by retries, never by concurrent requests.
    const failures = params.failures ?? { attemptedProviders: new Set<string>(), errors: [] };
    params = { ...params, failures };
    failures.attemptedProviders.add(baseUrl);

    const errorMessage = responseBody;

    // ── Parse structured error from routstr-core ────────────────────────
    const parsedError = parseCoreError(responseBody, status, requestId);
    const resolvedRequestId = parsedError.requestId ?? requestId;
    const handledRedemptionError = isHandledRedemptionError(parsedError);
    let recoveryAttempted = false;
    let recoverySucceeded = false;
    // Thrown only once no other provider is left to try.
    let insufficientBalance: InsufficientBalanceError | undefined;
    // A provider-mint shortfall is retryable: another provider may accept a
    // mint this one does not. Deferred so it surfaces (as a 402) only when
    // every provider is exhausted, never mid-failover.
    let providerMintBalance: ProviderMintBalanceError | undefined;
    // routstr-core's own API-key balance error authorizes a top-up. It is a
    // local wallet condition, so the provider must not be cooled down for it.
    const localWalletShortfall =
      this.mode === "apikeys" &&
      status === 402 &&
      parsedError.type === CoreErrorType.INSUFFICIENT_QUOTA &&
      parsedError.code === CoreErrorCode.INSUFFICIENT_BALANCE;

    this._log(
      "DEBUG",
      `[RoutstrClient] _handleErrorResponse: status=${status}, baseUrl=${baseUrl}, mode=${this.mode}, token=${REDACTED_CREDENTIAL}, requestId=${resolvedRequestId}, errorType=${parsedError.type ?? "unknown"}, errorCode=${parsedError.code ?? "unknown"}, errorMessage=${errorMessage}`
    );

    const upstreamRequestError = isUpstreamRequestError(status, parsedError);
    const unknownPathError = isUnknownPathError(status, parsedError);
    const aggregateFailure = upstreamRequestError || status >= 500 ||
      status === 424 || status === 429 || status === -1;
    // Keep only diagnostic fields, never raw envelopes containing refund proofs.
    if (aggregateFailure) {
      const redact = (value: string) => [params.token, xCashuRefundToken]
        .filter((secret): secret is string => !!secret)
        .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
        .replace(/cashu[AB][A-Za-z0-9_-]+/g, "[REDACTED]")
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
      const message = redact(parsedError.message ?? (status === -1 ? "Network request failed" : `Upstream returned HTTP ${status}`));
      const type = parsedError.type ? redact(parsedError.type) : undefined;
      let code: string | number | undefined = parsedError.code ? redact(parsedError.code) : undefined;
      // Provider envelopes also use numeric codes; the wallet parser only
      // recognizes strings, but diagnostics should preserve either format.
      if (code === undefined && responseBody) {
        try {
          const body = JSON.parse(responseBody);
          const numericCode = body?.error?.code ?? body?.detail?.error?.code;
          if (typeof numericCode === "number") code = numericCode;
        } catch { /* Plain-text upstream errors have no structured code. */ }
      }
      const existing = failures.errors.find((error) =>
        error.status === status && error.type === type && error.code === code && error.message === message
      );
      if (existing) {
        if (!existing.providers.includes(baseUrl)) existing.providers.push(baseUrl);
      } else {
        failures.errors.push({ status, type, code, message, providers: [baseUrl] });
      }
    }

    // ── Handle token_already_spent ────────────────────────────────────
    // The token is permanently spent — core deliberately withholds the
    // X-Cashu refund header for this case. Don't attempt refund/receive
    // (the token is gone), just clean up storage and failover.
    if (parsedError.type === CoreErrorType.TOKEN_ALREADY_SPENT) {
      this._log(
        "WARN",
        `[RoutstrClient] _handleErrorResponse: token_already_spent detected for ${baseUrl}, mode=${this.mode}, cleaning up and failing over`
      );
      if (this.mode === "xcashu") {
        // Remove the spent xcashu IOU so future refund sweeps don't keep
        // retrying a permanently-spent token.
        this.storageAdapter.removeXcashuToken(baseUrl, params.token);
      } else if (this.mode === "apikeys") {
        // Only remove the key that actually failed. Another concurrent request
        // may already have replaced the bootstrap Cashu token with the
        // provider's canonical API key while this response was in flight.
        const storedApiKey = this.storageAdapter.getApiKey(baseUrl);
        if (storedApiKey?.key === params.token) {
          this.storageAdapter.removeApiKey(baseUrl);
        } else if (storedApiKey) {
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: preserving replacement API key for ${baseUrl}; spent response belongs to an older key`
          );
        }
      }
      tryNextProvider = true;
    }

    // ── Reclaim sats: try the refund token FIRST, then fall back to the ──
    // original token. This avoids a wasted mint round-trip when the node
    // already consumed the proofs (the common upstream_error case) and
    // prevents double-receiving when both are somehow valid.
    // Skipped entirely for token_already_spent (handled above).
    let refundReceived = false;

    if (!tryNextProvider && this.mode === "xcashu" && xCashuRefundToken) {
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: Attempting to receive xcashu refund token=${REDACTED_CREDENTIAL}`
      );
      recoveryAttempted = true;
      const receiveResult =
        await this.cashuSpender.receiveToken(xCashuRefundToken);
      if (receiveResult.success) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: xcashu refund received, amount=${receiveResult.amount}`
        );
        // Refund claimed — remove the original spent token from storage so
        // it isn't left as an orphaned IOU (mirrors _handlePostResponseBalanceUpdate).
        this.storageAdapter.removeXcashuToken(baseUrl, params.token);
        tryNextProvider = true;
        refundReceived = true;
        recoverySucceeded = true;
      } else {
        this.cashuSpender.cacheReceiveToken(xCashuRefundToken);
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: xcashu refund receive failed${xCashuRefundToken === params.token ? " (same as original; not receiving twice)" : ", falling back to original token"}: ${receiveResult.message}`
        );
      }
    }

    // Only try the original token if we didn't get the refund. If the response
    // token is byte-for-byte identical, it was already attempted above and
    // must not be received twice. If it differs, try the response token first
    // and fall back to the original only when the first receive failed.
    if (
      !tryNextProvider &&
      !refundReceived &&
      params.token.startsWith("cashu") &&
      (!xCashuRefundToken || xCashuRefundToken !== params.token)
    ) {
      recoveryAttempted = true;
      const receiveResult = await this.cashuSpender.receiveToken(params.token);
      if (receiveResult.success) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Token restored successfully, amount=${receiveResult.amount}`
        );
        // The original token is back in the wallet. Drop the stored
        // credential: an xcashu IOU in xcashu mode, or the (now permanently
        // dead) bootstrap API key in apikeys mode — but only if a concurrent
        // request hasn't already swapped in the provider's canonical key.
        if (this.mode === "xcashu") {
          this.storageAdapter.removeXcashuToken(baseUrl, params.token);
        } else if (
          this.mode === "apikeys" &&
          this.storageAdapter.getApiKey(baseUrl)?.key === params.token
        ) {
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: Removing dead bootstrap API key for ${baseUrl} (token restored to wallet)`
          );
          this.storageAdapter.removeApiKey(baseUrl);
        }
        tryNextProvider = true;
        recoverySucceeded = true;
      } else {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Failed to receive token: ${receiveResult.message}`
        );
      }
    }

    // A foreign-mint swap failure (mint_error) and an unreachable mint
    // (mint_unreachable) both identify the mint, not the provider. Once the
    // rejected token has been reclaimed, retry this same provider first with
    // that mint excluded. Candidate selection will still enforce the
    // provider's advertised mint list and available wallet balance.
    if (
      params.token.startsWith("cashu") &&
      tryNextProvider &&
      shouldFailoverToAnotherMint(parsedError) &&
      retryCount < MAX_RETRIES_PER_PROVIDER
    ) {
      const failedMintUrl = params.selectedMintUrl || mintUrl;
      const excludeMints = Array.from(
        new Set([...(params.excludeMints || []), failedMintUrl])
      );

      this._log(
        "WARN",
        `[RoutstrClient] _handleErrorResponse: ${parsedError.type ?? "mint_error"} from ${failedMintUrl}; retrying provider ${baseUrl} with another supported mint`
      );

      let spendResult:
        | Awaited<ReturnType<RoutstrClient["_spendToken"]>>
        | undefined;
      try {
        spendResult = await this._spendToken({
          mintUrl,
          amount: params.requiredSats,
          baseUrl,
          excludeMints,
        });
      } catch (error) {
        this._log(
          "WARN",
          `[RoutstrClient] _handleErrorResponse: no compatible alternative mint for ${baseUrl}; trying provider failover`,
          error
        );
      }

      if (spendResult) {
        const retryResponse = await this._makeRequest({
          ...params,
          token: spendResult.token,
          selectedMintUrl: spendResult.selectedMintUrl,
          excludeMints,
          headers: this._withAuthAndTinfoilHeaders(
            params.baseHeaders,
            spendResult.token,
            params.tinfoilEnabled,
            params.selectedModel?.id
          ),
          retryCount: retryCount + 1,
        });
        (retryResponse as any).initialTokenBalanceInSats =
          spendResult.tokenBalanceUnit === "msat"
            ? spendResult.tokenBalance / 1000
            : spendResult.tokenBalance;
        (retryResponse as any).initialTokenBalanceUnknown =
          spendResult.tokenBalanceUnknown;
        return retryResponse;
      }
    }

    // Preserve failed payment recovery for a later sweep, but allow a fresh
    // attempt elsewhere for redemption failures and upstream rejections.
    if (
      this.mode === "xcashu" &&
      (handledRedemptionError || upstreamRequestError || unknownPathError) &&
      !tryNextProvider
    ) {
      this._log(
        "WARN",
        `[RoutstrClient] _handleErrorResponse: recovery failed for retryable error type=${parsedError.type} code=${parsedError.code}; preserving token and trying provider failover`
      );
      tryNextProvider = true;
    }

    // In xcashu mode, if neither the refund nor the original was received for
    // an unclassified error, we have no safe recovery/failover policy.
    if (this.mode === "xcashu" && !tryNextProvider) {
      if (parsedError.type === CoreErrorType.MINT_ERROR) {
        throw new MintError({
          baseUrl,
          statusCode: status,
          mintUrl: params.selectedMintUrl || mintUrl,
          code: parsedError.code,
          parsedError,
          requestId: resolvedRequestId,
        });
      }
      throw new ProviderError(
        baseUrl,
        status,
        "[xcashu] Failed to receive refund token",
        requestId
      );
    }

    // ── Handle mint_error (HTTP 422) ───────────────────────────────────
    // The token was not consumed. xcashu's mint-specific retry was attempted
    // above after reclaiming it. API-key balances remain intact, and
    // non-retryable mint codes (such as fee-exceeds-amount) must not cycle
    // through unrelated mints. Skip refund and proceed to provider failover.
    if (parsedError.type === CoreErrorType.MINT_ERROR && !tryNextProvider) {
      this._log(
        "WARN",
        `[RoutstrClient] _handleErrorResponse: mint_error detected for ${baseUrl}, mode=${this.mode}, code=${parsedError.code ?? "unknown"}; skipping refund and trying provider failover`
      );
      tryNextProvider = true;
    }

    if (status === 402 && !tryNextProvider && this.mode === "apikeys") {
      // Only routstr-core's own API-key balance error authorizes a top-up.
      // Upstream providers can also return 402 (for example when the router's
      // OpenRouter account is empty); minting more user funds cannot fix that.
      const isLocalInsufficientBalance =
        parsedError.type === CoreErrorType.INSUFFICIENT_QUOTA &&
        parsedError.code === CoreErrorCode.INSUFFICIENT_BALANCE;

      if (!isLocalInsufficientBalance) {
        this._log(
          "WARN",
          `[RoutstrClient] _handleErrorResponse: Skipping topup for unrecognized/provider 402 from ${baseUrl} (type=${parsedError.type ?? "unknown"}, code=${parsedError.code ?? "unknown"})`
        );
        tryNextProvider = true;
      } else {
        let topupAmount = params.requiredSats;
        let balanceValidated = false;

        try {
          const currentBalanceInfo = await this.balanceManager.getTokenBalance(
            params.token,
            baseUrl
          );
          if (currentBalanceInfo.balanceUnknown) {
            this._log(
              "WARN",
              `[RoutstrClient] _handleErrorResponse: Skipping topup for ${baseUrl}; current API-key balance is unknown`
            );
          } else {
            const currentBalance =
              currentBalanceInfo.unit === "msat"
                ? currentBalanceInfo.amount / 1000
                : currentBalanceInfo.amount;
            const reservedBalance =
              currentBalanceInfo.unit === "msat"
                ? (currentBalanceInfo.reserved ?? 0) / 1000
                : (currentBalanceInfo.reserved ?? 0);
            const availableBalance = currentBalance - reservedBalance;
            const shortfall = Math.max(
              0,
              params.requiredSats - availableBalance
            );

            if (shortfall <= 0) {
              this._log(
                "WARN",
                `[RoutstrClient] _handleErrorResponse: Skipping topup for ${baseUrl}; API-key balance is sufficient (required=${params.requiredSats}, available=${availableBalance})`
              );
            } else {
              balanceValidated = true;
              topupAmount =
                shortfall > 0.21 * params.requiredSats
                  ? shortfall
                  : 0.21 * params.requiredSats;

              this._log(
                "DEBUG",
                `The shortfall is: ${shortfall}. requiredSats: ${params.requiredSats}. Current Balance: ${currentBalance}. Reserved Balance: ${reservedBalance}. Available Balance: ${availableBalance}`
              );
            }
          }
        } catch (e) {
          this._log(
            "WARN",
            `[RoutstrClient] _handleErrorResponse: Skipping topup for ${baseUrl}; could not validate current API-key balance`,
            e
          );
        }

        if (!balanceValidated) {
          tryNextProvider = true;
        } else {
          // A proactive (pre-request) topup may already be in flight for
          // this key — join it instead of stacking a second deposit.
          const topupResult = await this._topUpOnce(
            `${baseUrl}:${params.token}`,
            () =>
              this.balanceManager.topUp({
                mintUrl,
                baseUrl,
                amount: topupAmount * TOPUP_MARGIN,
                token: params.token,
              })
          );
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: Topup result for ${baseUrl}: success=${topupResult.success}, message=${topupResult.message}`
          );

          if (!topupResult.success) {
            const message = topupResult.message || "";
            if (topupResult.providerMintsShort) {
              // The wallet is funded, but not on a mint this provider
              // accepts. Fail over to a provider that does; only surface
              // this (as a 402) if every provider is exhausted.
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: provider-mint shortfall for ${baseUrl}; trying next provider`
              );
              providerMintBalance = new ProviderMintBalanceError(
                topupResult.required ?? params.requiredSats,
                topupResult.available ?? 0,
                topupResult.providerBaseUrl ?? baseUrl,
                topupResult.acceptedMints ?? [],
                topupResult.maxMintBalance ?? 0,
                topupResult.maxMintUrl ?? ""
              );
              tryNextProvider = true;
            } else if (message.includes("Insufficient balance")) {
              // Parse decimals and the largest-mint hint so the final 402
              // JSON reports the real shortfall instead of 0/"".
              const needMatch = message.match(/need ([\d.]+)/);
              const haveMatch = message.match(/have ([\d.]+)/);
              const maxMintMatch = message.match(
                /Largest mint balance: ([\d.]+) sats from (\S+)/
              );
              const required = needMatch
                ? parseFloat(needMatch[1])
                : params.requiredSats;
              const available = haveMatch ? parseFloat(haveMatch[1]) : 0;
              const maxMintBalance = maxMintMatch
                ? parseFloat(maxMintMatch[1])
                : 0;
              const maxMintUrl = maxMintMatch ? maxMintMatch[2] : "";
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: Insufficient balance, need=${required}, have=${available}; trying next provider`
              );
              // Another provider may accept a mint this one does not.
              insufficientBalance = new InsufficientBalanceError(
                required,
                available,
                maxMintBalance,
                maxMintUrl,
                message
              );
              tryNextProvider = true;
            } else {
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: Topup failed with non-insufficient-balance error, will try next provider`
              );
              tryNextProvider = true;
            }
          } else {
            this._log(
              "DEBUG",
              `[RoutstrClient] _handleErrorResponse: Topup successful, will retry with new token`
            );
          }
          if (!tryNextProvider) {
            if (retryCount < MAX_RETRIES_PER_PROVIDER) {
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: Retrying 402 (attempt ${retryCount + 1}/${MAX_RETRIES_PER_PROVIDER})`
              );
              return this._makeRequest({
                ...params,
                token: params.token,
                headers: this._withAuthAndTinfoilHeaders(
                  params.baseHeaders,
                  params.token,
                  params.tinfoilEnabled,
                  params.selectedModel?.id
                ),
                retryCount: retryCount + 1,
              });
            } else {
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: 402 retry limit reached (${retryCount}/${MAX_RETRIES_PER_PROVIDER}), failing over to next provider`
              );
              tryNextProvider = true;
            }
          }
        }
      }
    }

    if (
      status === 413 &&
      !tryNextProvider &&
      this.mode === "apikeys"
    ) {
      let retryToken = params.token;

      try {
        const latestBalanceInfo = await this.balanceManager.getTokenBalance(
          params.token,
          baseUrl
        );

        // Handle invalid/expired API key - delete and fail over
        if (latestBalanceInfo.isInvalidApiKey) {
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: Invalid API key (proofs already spent), removing for ${baseUrl}`
          );
          this.storageAdapter.removeApiKey(baseUrl);
          tryNextProvider = true;
        } else {
          const latestTokenBalance = latestBalanceInfo.balanceUnknown
            ? undefined
            : latestBalanceInfo.unit === "msat"
              ? latestBalanceInfo.amount / 1000
              : latestBalanceInfo.amount;
          const latestReservedBalance = latestBalanceInfo.balanceUnknown
            ? undefined
            : latestBalanceInfo.unit === "msat"
              ? latestBalanceInfo.reserved / 1000
              : latestBalanceInfo.reserved;

          if (latestBalanceInfo.apiKey) {
            const storedApiKeyEntry = this.storageAdapter.getApiKey(baseUrl);
            if (storedApiKeyEntry?.key !== latestBalanceInfo.apiKey) {
              this._replaceApiKey(baseUrl, latestBalanceInfo.apiKey);
            }
            retryToken = latestBalanceInfo.apiKey;
          }

          if (latestTokenBalance !== undefined && latestTokenBalance >= 0) {
            this.storageAdapter.updateApiKeyBalance(
              baseUrl,
              latestTokenBalance,
              latestReservedBalance
            );
            this.storageAdapter.touchApiKeyLastUsed(baseUrl);
          }
        }
      } catch (error) {
        this._log(
          "WARN",
          `[RoutstrClient] _handleErrorResponse: Failed to refresh API key after 413 insufficient balance for ${baseUrl}`,
          error
        );
      }

      if (retryCount < MAX_RETRIES_PER_PROVIDER) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Retrying 413 (attempt ${retryCount + 1}/${MAX_RETRIES_PER_PROVIDER})`
        );
        return this._makeRequest({
          ...params,
          token: retryToken,
          headers: this._withAuthAndTinfoilHeaders(
            params.baseHeaders,
            retryToken,
            params.tinfoilEnabled,
            params.selectedModel?.id
          ),
          retryCount: retryCount + 1,
        });
      } else {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: 413 retry limit reached (${retryCount}/${MAX_RETRIES_PER_PROVIDER}), failing over to next provider`
        );
        tryNextProvider = true;
      }
    }

    if (status === 401 && this.mode === "apikeys") {
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: Checking balance for ${baseUrl}, key=${REDACTED_CREDENTIAL}`
      );
      const latestBalanceInfo = await this.balanceManager.getTokenBalance(
        token,
        baseUrl
      );
      if (latestBalanceInfo.isInvalidApiKey) {
        this.storageAdapter.removeApiKey(baseUrl);
        tryNextProvider = true;
      }
    }

    if (
      (status === 401 ||
        status === 403 ||
        status === 404 ||
        status === 413 ||
        status === 400 ||
        status === 422 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === 521) &&
      !tryNextProvider &&
      // The node rejected the path before charging: the key is untouched
      // and still serves the paths this node allows, so keep it.
      !unknownPathError &&
      // An upstream 400/422 rejects the request, not the API key: nothing was
      // charged, so the key keeps its balance for the next request.
      !(this.mode === "apikeys" && upstreamRequestError)
    ) {
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: Status ${status} (${status === 429 ? "rate limited" : "auth/server error"}), attempting refund for ${baseUrl}, mode=${this.mode}`
      );
      if (this.mode === "apikeys") {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Attempting API key refund for ${baseUrl}, key=${REDACTED_CREDENTIAL}`
        );
        const latestBalanceInfo = await this.balanceManager.getTokenBalance(
          token,
          baseUrl
        );
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Initial API key balance: ${latestBalanceInfo.amount}`
        );
        recoveryAttempted = true;
        const refundResult = await this.balanceManager.refundApiKey({
          mintUrl,
          baseUrl,
          apiKey: token,
          forceRefund: true,
        });
        if (refundResult.success) recoverySucceeded = true;
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: API key refund result: success=${refundResult.success}, message=${refundResult.message}`
        );
        if (
          !refundResult.success &&
          latestBalanceInfo.amount > 0 &&
          !latestBalanceInfo.balanceUnknown
        ) {
          if (this._isTransientRefundError(refundResult.message)) {
            // A provider-wallet guard (recent/in-progress topup), or a
            // provider refusing to refund a key with ongoing requests, is a
            // transient refund skip. Preserve the key for a later sweep and
            // continue provider failover instead of aborting this request.
            this._log(
              "WARN",
              `[RoutstrClient] _handleErrorResponse: Refund skipped for ${baseUrl} (transient: ${refundResult.message}); failing over to next provider`
            );
            tryNextProvider = true;
          } else if (this._isRefundEndpointServerError(refundResult.status)) {
            // The upstream /v1/wallet/refund endpoint itself returned a server
            // error. The sats are still on the key and will be reclaimed by a
            // later refund sweep, so fail over instead of aborting.
            this._log(
              "WARN",
              `[RoutstrClient] _handleErrorResponse: Refund endpoint returned ${refundResult.status} for ${baseUrl}; leaving key for sweep and failing over to next provider`
            );
            tryNextProvider = true;
          } else if (handledRedemptionError) {
            this._log(
              "WARN",
              `[RoutstrClient] _handleErrorResponse: API key recovery failed for structured redemption error; preserving key and trying provider failover`
            );
            tryNextProvider = true;
          } else {
            throw new ProviderError(
              baseUrl,
              status,
              refundResult.message ?? "Unknown error"
            );
          }
        }
      }
    }

    // ── Purge permanently-unusable stored credentials ──────────────────
    // For a redemption error that proves the stored credential can never work
    // again (consumed, redeemed-to-zero, or a malformed/undecodable token),
    // remove it so a later request doesn't blindly reuse the same bad
    // credential and re-fail. Ambiguous failures (cashu_token_redemption_failed,
    // api_error/internal_error) are preserved so a refund sweep can still try.
    // Only when recovery failed — success already removed the credential above.
    if (
      handledRedemptionError &&
      shouldPurgeStoredCredential(parsedError) &&
      !recoverySucceeded
    ) {
      if (this.mode === "xcashu") {
        this.storageAdapter.removeXcashuToken(baseUrl, params.token);
        this._log(
          "WARN",
          `[RoutstrClient] _handleErrorResponse: Removing unusable xcashu token for ${baseUrl} (type=${parsedError.type} code=${parsedError.code})`
        );
      } else if (this.mode === "apikeys") {
        // Same concurrency guard as token_already_spent: only remove the exact
        // key that failed, never a replacement key swapped in meanwhile.
        const storedApiKey = this.storageAdapter.getApiKey(baseUrl);
        if (storedApiKey?.key === params.token) {
          this.storageAdapter.removeApiKey(baseUrl);
          this._log(
            "WARN",
            `[RoutstrClient] _handleErrorResponse: Removing unusable API key for ${baseUrl} (type=${parsedError.type} code=${parsedError.code})`
          );
        } else if (storedApiKey) {
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: preserving replacement API key for ${baseUrl}; unusable response belongs to an older key`
          );
        }
      }
    }

    const failReason = [
      `status=${status}`,
      resolvedRequestId ? `requestId=${resolvedRequestId}` : null,
      parsedError.type ? `type=${parsedError.type}` : null,
      parsedError.code ? `code=${parsedError.code}` : null,
      errorMessage ? `body=${errorMessage.slice(0, 200)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    // The pinned model-path selector (if any) decides both the cooldown
    // scope below and the failover behavior further down.
    const pinnedModelPath = this._findModelPathHeader(params.baseHeaders);

    // Scope the cooldown: a pinned request cools only its upstream route on
    // the provider, an unpinned model-specific failure cools only that
    // model, and network/mint failures cool the whole provider.
    const cooldownScope = this._getCooldownScope(
      status,
      parsedError,
      selectedModel,
      pinnedModelPath,
      params.requestedModelId
    );
    if (!upstreamRequestError && !unknownPathError && !localWalletShortfall) {
      this.providerManager.markFailed(
        baseUrl,
        failReason,
        cooldownScope.modelId,
        cooldownScope.modelPath
      );
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: Marked ${
          cooldownScope.modelPath
            ? `path ${cooldownScope.modelPath} on provider ${baseUrl}`
            : cooldownScope.modelId
              ? `model ${cooldownScope.modelId} on provider ${baseUrl}`
              : `provider ${baseUrl}`
        } as failed (${failReason})`
      );
    }

    // Unknown-path 404 with no model to fail over on: return it verbatim.
    if (unknownPathError && !selectedModel) {
      const response = this._upstreamErrorResponse(upstream, responseBody, baseUrl);
      if (response) {
        this._log(
          "WARN",
          `[RoutstrClient] _handleErrorResponse: unknown path 404 from ${baseUrl} (${parsedError.message}); not cooling down or failing over`
        );
        (response as any).passthrough = true;
        return response;
      }
    }

    if (!selectedModel) {
      if (handledRedemptionError) {
        throw this._createRedemptionError({
          parsedError,
          baseUrl,
          status,
          mintUrl: params.selectedMintUrl || mintUrl,
          requestId: resolvedRequestId,
          recoveryAttempted,
          recoverySucceeded,
        });
      }
      throw new ProviderError(
        baseUrl,
        status,
        "Funny, no selected model. HMM. "
      );
    }

    // A pinned x-routstr-model-path selector is only guaranteed valid on
    // the node that advertised it. A caller-pinned request must never fail
    // over to a different node: the selector may be rejected there (404
    // invalid_model_path) and the caller explicitly asked for that one
    // upstream. An SDK auto-pinned request walks the node-major model-path
    // chain (node1:deepseek -> node1:fireworks -> node2:deepseek -> ...),
    // swapping in a fresh selector resolved from the next candidate's own
    // node.
    // Failover is keyed by the requested (canonical) model id, never by the
    // failed provider's native id.
    const failoverModelId = this._canonicalRequestModelId(
      selectedModel,
      params.requestedModelId
    );
    // Funded mints the wallet can spend from. Used to prefer a failover
    // target that accepts one, so we do not bounce off a node whose mints
    // the wallet cannot fund.
    const fundedMintUrlsForFailover = Object.entries(
      await this.walletAdapter.getBalances()
    )
      .filter(([, balance]) => typeof balance === "number" && balance > 0)
      .map(([mintUrl]) =>
        mintUrl.endsWith("/") ? mintUrl.slice(0, -1) : mintUrl
      );

    let nextProvider: string | null;
    let nextModelPathSelector: string | undefined;
    let nextModelPathPricing: ModelPathSatsPricing | undefined;
    let nextTriedModelPaths: string[] | undefined;
    if (params.pinnedProvider) {
      // A caller-forced provider is a pin. Re-sending the same prompt to
      // another node is exactly what the caller asked us not to do, so a
      // failed request stays put regardless of the error type. (Retries
      // against the same provider — topups, mint fallback — still happen.)
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: not failing over, request is pinned to provider ${baseUrl}`
      );
      nextProvider = null;
    } else if (pinnedModelPath) {
      if (!params.autoModelPath) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: not failing over, request is pinned to a model path (${pinnedModelPath})`
        );
        nextProvider = null;
      } else {
        // The failed candidate joins the request's attempted set: one
        // strike does not cool a route down, so without this the chain
        // could burn paid retries revisiting a route that already failed
        // within this request.
        const triedModelPaths = new Set(params.triedModelPaths ?? []);
        triedModelPaths.add(modelPathCandidateKey(baseUrl, pinnedModelPath));
        nextTriedModelPaths = [...triedModelPaths];
        // A provider-wide failure (network error / mint unreachable — the
        // empty cooldown scope) rules out the node's remaining routes too:
        // they share the host. A route-scoped failure keeps them in play,
        // so the chain walks every route of the cheaper node first.
        const providerWideFailure = cooldownScope.modelId === undefined;
        const ranking =
          await this.providerManager.getModelPathProviderRanking(
            failoverModelId,
            {
              excludeModelPaths: triedModelPaths,
              ...((providerWideFailure || providerMintBalance)
                ? { excludeBaseUrl: baseUrl } : {}),
              acceptableMintUrls: fundedMintUrlsForFailover,
            }
          );
        const next = ranking[0];
        nextProvider = next?.baseUrl ?? null;
        nextModelPathSelector = next?.selectors[0];
        nextModelPathPricing = next?.satsPricing[0] ?? undefined;
        if (nextProvider) {
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: auto-pinned request failing over to next model-path route: ${nextProvider} (${nextModelPathSelector})`
          );
        }
      }
    } else {
      nextProvider = this._findNextBestProvider(
        failoverModelId,
        baseUrl,
        failures.attemptedProviders,
        fundedMintUrlsForFailover
      );
    }

    if (nextProvider && !pinnedModelPath && failures.attemptedProviders.has(nextProvider)) {
      nextProvider = null;
    }

    if (nextProvider) {
      // Candidate mints the wallet can fund; a provider that accepts none of
      // them cannot be funded even though it serves the model.
      const attemptedForSpend = new Set(failures.attemptedProviders);
      let spendResult:
        | Awaited<ReturnType<RoutstrClient["_spendToken"]>>
        | undefined;
      let newModel: Model = selectedModel;
      let newRequiredSats = params.requiredSats;

      while (nextProvider) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Failing over to next provider: ${nextProvider}, model: ${failoverModelId}`
        );
        // Get new model for this provider
        newModel =
          (await this.providerManager.getModelForProvider(
            nextProvider,
            failoverModelId
          )) ?? selectedModel;

        const messagesForPricing = Array.isArray(
          (body as { messages?: unknown })?.messages
        )
          ? ((body as { messages?: unknown }).messages as any[])
          : [];

        newRequiredSats =
          this.providerManager.getRequiredSatsForModel(
            newModel,
            messagesForPricing,
            params.maxTokens,
            body && typeof body === "object"
              ? (body as Record<string, unknown>)
              : undefined,
            nextModelPathPricing
          );

        if (params.tinfoilEnabled) {
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: Attesting Tinfoil failover provider ${nextProvider} before spend`
          );
          await prepareTinfoilClient({ baseUrl: nextProvider });
        }

        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Creating new token for failover provider ${nextProvider}, required sats: ${newRequiredSats}`
        );
        // Mint exclusions are scoped to a provider attempt. A different
        // provider may successfully handle the same mint, so do not carry the
        // previous provider's rejection into cross-provider failover.
        try {
          spendResult = await this._spendToken({
            mintUrl,
            amount: newRequiredSats,
            baseUrl: nextProvider,
          });
          break;
        } catch (error) {
          if (error instanceof ProviderMintBalanceError) {
            // The wallet cannot fund any mint this provider accepts. Keep
            // failing over to a provider that accepts a funded mint (fail
            // open when its mint list is unknown). A caller-pinned request
            // must not switch providers.
            if (params.pinnedProvider || (pinnedModelPath && !params.autoModelPath)) {
              throw error;
            }
            this._log(
              "WARN",
              `[RoutstrClient] _handleErrorResponse: provider-mint shortfall on ${nextProvider}; trying another provider`
            );
            providerMintBalance = providerMintBalance ?? error;
            attemptedForSpend.add(nextProvider);
            if (params.autoModelPath) {
              const tried = new Set(nextTriedModelPaths ?? []);
              if (nextModelPathSelector) {
                tried.add(modelPathCandidateKey(nextProvider, nextModelPathSelector));
              }
              // All routes on this node share its unfundable accepted mints.
              const [next] = await this.providerManager.getModelPathProviderRanking(
                failoverModelId,
                {
                  excludeBaseUrls: attemptedForSpend,
                  excludeModelPaths: tried,
                  acceptableMintUrls: fundedMintUrlsForFailover,
                }
              );
              nextProvider = next?.baseUrl ?? null;
              nextModelPathSelector = next?.selectors[0];
              nextModelPathPricing = next?.satsPricing[0] ?? undefined;
              nextTriedModelPaths = [...tried];
              continue;
            }
            nextProvider = this._findNextBestProvider(
              failoverModelId,
              baseUrl,
              attemptedForSpend,
              fundedMintUrlsForFailover
            );
            if (nextProvider && attemptedForSpend.has(nextProvider)) {
              nextProvider = null;
            }
            continue;
          }
          if (parsedError.type === CoreErrorType.MINT_ERROR) {
            throw new MintError({
              baseUrl,
              statusCode: status,
              mintUrl: params.selectedMintUrl || mintUrl,
              code: parsedError.code,
              parsedError,
              requestId: resolvedRequestId,
            });
          }
          if (handledRedemptionError) {
            throw this._createRedemptionError({
              parsedError,
              baseUrl,
              status,
              mintUrl: params.selectedMintUrl || mintUrl,
              requestId: resolvedRequestId,
              recoveryAttempted,
              recoverySucceeded,
            });
          }
          throw error;
        }
      }

      if (spendResult?.token) {
        // Retry with new provider (reset retry count). Attach the balance that
        // was observed before the retry request so callers do not have to query
        // after the provider may already have charged the request.
        // The failover target may serve the model under a different native id
        // (static mapping), so forward newModel.id, not the original body model.
        const bodyObj =
          body && typeof body === "object"
            ? (body as Record<string, unknown>)
            : undefined;
        const retryBody =
          bodyObj && typeof bodyObj.model === "string"
            ? { ...bodyObj, model: newModel.id }
            : body;
        // An auto-pinned request swaps its selector for one the new node
        // advertised; the failed node's selector is never forwarded.
        const retryBaseHeaders = { ...params.baseHeaders };
        if (nextModelPathSelector !== undefined) {
          retryBaseHeaders[MODEL_PATH_HEADER] = nextModelPathSelector;
        }
        const retryResponse = await this._makeRequest({
          ...params,
          path,
          method,
          body: retryBody,
          baseUrl: nextProvider!,
          baseHeaders: retryBaseHeaders,
          selectedModel: newModel,
          token: spendResult.token!,
          selectedMintUrl: spendResult.selectedMintUrl,
          excludeMints: undefined,
          triedModelPaths: nextTriedModelPaths ?? params.triedModelPaths,
          requiredSats: newRequiredSats,
          autoModelPath:
            nextModelPathSelector !== undefined
              ? {
                  selector: nextModelPathSelector,
                  satsPricing: nextModelPathPricing,
                }
              : undefined,
          headers: this._withAuthAndTinfoilHeaders(
            retryBaseHeaders,
            spendResult.token!,
            params.tinfoilEnabled,
            newModel.id
          ),
          retryCount: 0,
        });
        (retryResponse as any).initialTokenBalanceInSats =
          spendResult.tokenBalanceUnit === "msat"
            ? spendResult.tokenBalance / 1000
            : spendResult.tokenBalance;
        (retryResponse as any).initialTokenBalanceUnknown =
          spendResult.tokenBalanceUnknown;
        return retryResponse;
      }
      // No provider left that the wallet can fund. Fall through to the
      // exhaustion handling below, which surfaces the deferred
      // provider-mint / insufficient-balance error.
    }

    // No more providers to try. If the root cause was a specific core error
    // type (e.g. token_already_spent), surface that instead of a generic
    // FailoverError so callers can branch on the specific failure.
    // A provider-mint shortfall that survived every provider is genuine
    // exhaustion from this request's perspective: surface the honest 402.
    if (providerMintBalance) throw providerMintBalance;

    if (insufficientBalance) throw insufficientBalance;

    if (parsedError.type === CoreErrorType.TOKEN_ALREADY_SPENT) {
      throw new TokenAlreadySpentError({
        baseUrl,
        statusCode: status,
        mintUrl,
        parsedError,
        requestId: resolvedRequestId,
      });
    }

    if (parsedError.type === CoreErrorType.MINT_ERROR) {
      throw new MintError({
        baseUrl,
        statusCode: status,
        mintUrl: params.selectedMintUrl || mintUrl,
        code: parsedError.code,
        parsedError,
        requestId: resolvedRequestId,
      });
    }

    if (handledRedemptionError) {
      throw this._createRedemptionError({
        parsedError,
        baseUrl,
        status,
        mintUrl: params.selectedMintUrl || mintUrl,
        requestId: resolvedRequestId,
        recoveryAttempted,
        recoverySucceeded,
      });
    }

    // Financial and pinned-path failures above retain their typed semantics.
    // Ordinary upstream failures return a deduplicated diagnostic envelope.
    if (aggregateFailure) {
      const response = this._upstreamErrorResponse(
        upstream ?? { status: 502, statusText: "Bad Gateway", headers: {} },
        JSON.stringify({ error: {
          type: "all_providers_failed",
          message: failures.errors.map((error) => error.message).join("; "),
          errors: failures.errors,
        } }),
        baseUrl
      )!;
      response.headers.set("content-type", "application/json");
      response.headers.delete("x-routstr-error-scope");
      (response as any).passthrough = true;
      return response;
    }

    // Unknown-path 404 from the last node tried. The path allowlist differs
    // per node (core version, PROXY_EXTRA_ALLOWED_PATHS), so failover ran
    // first; when no node serves the path, return its 404 verbatim.
    if (unknownPathError) {
      const response = this._upstreamErrorResponse(upstream, responseBody, baseUrl);
      if (response) {
        (response as any).passthrough = true;
        return response;
      }
    }

    throw new FailoverError(
      baseUrl,
      Array.from(this.providerManager.getFailedProviders())
    );
  }

  /**
   * Rebuild the provider's own error response from the captured envelope so a
   * proxy caller can forward it verbatim (status + headers + body).
   *
   * Returns `undefined` when there is no status to forward — notably a network
   * failure (status -1), where `new Response` would also reject any status
   * below 200.
   */
  private _upstreamErrorResponse(
    upstream: UpstreamEnvelope | undefined,
    bodyText: string | undefined,
    baseUrl: string
  ): Response | undefined {
    if (!upstream || upstream.status < 400) return undefined;
    const headers = new Headers(upstream.headers);
    headers.set(
      "content-type",
      upstream.headers["content-type"] ?? "application/json"
    );
    if (!headers.has("x-routstr-provider")) {
      headers.set("x-routstr-provider", baseUrl);
    }
    return new Response(bodyText ?? "", {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  private _createRedemptionError(opts: {
    parsedError: ParsedCoreError;
    baseUrl: string;
    status: number;
    mintUrl?: string;
    requestId?: string;
    recoveryAttempted: boolean;
    recoverySucceeded: boolean;
  }):
    | InvalidTokenError
    | UntrustedMintError
    | CashuRedemptionError
    | TokenConsumedError
    | CoreInternalError {
    const shared = {
      baseUrl: opts.baseUrl,
      statusCode: opts.status,
      mintUrl: opts.mintUrl,
      code: opts.parsedError.code,
      parsedError: opts.parsedError,
      requestId: opts.requestId,
      recoveryAttempted: opts.recoveryAttempted,
      recoverySucceeded: opts.recoverySucceeded,
    };

    if (isInvalidTokenError(opts.parsedError)) {
      return new InvalidTokenError(shared);
    }
    if (isUntrustedMintError(opts.parsedError)) {
      return new UntrustedMintError(shared);
    }
    if (isCashuRedemptionError(opts.parsedError)) {
      return new CashuRedemptionError(shared);
    }
    if (isTokenConsumedError(opts.parsedError)) {
      return new TokenConsumedError(shared);
    }
    if (isCoreInternalError(opts.parsedError)) {
      return new CoreInternalError(shared);
    }

    // Callers guard this helper with isHandledRedemptionError(). Keep a hard
    // failure here so future taxonomy additions cannot silently become generic.
    throw new Error(
      `Unsupported routstr-core redemption error: ${opts.parsedError.type ?? "unknown"}/${opts.parsedError.code ?? "unknown"}`
    );
  }

  /**
   * Classify a refund failure as transient (i.e. safe to ignore and fall
   * through to provider failover) rather than terminal.
   *
   * This race is message-based because its HTTP status (400) is shared with
   * terminal refund failures. The upstream /v1/wallet/refund endpoint returns
   * HTTP 400 with detail "Cannot refund key. There are ongoing requests for
   * this api key." whenever a shared API key still has in-flight requests —
   * an inherent race in apikeys mode where one key is reused across concurrent
   * requests. The balance is still on the key and will be reclaimed by a
   * later refund sweep, so this must not abort the request.
   */
  private _isTransientRefundError(message?: string): boolean {
    if (!message) return false;
    const lower = message.toLowerCase();
    return (
      lower.startsWith("provider wallet operation locked;") ||
      lower.includes("ongoing requests for this api key") ||
      lower.includes("cannot refund key")
    );
  }

  /**
   * Whether the provider's own refund endpoint failed with an upstream server
   * error. In that case the sats are still on the API key and a later refund
   * sweep can reclaim them, so this must fail over rather than abort the
   * request.
   */
  private _isRefundEndpointServerError(status?: number): boolean {
    return (
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      status === 521
    );
  }

  /**
   * Handle post-response balance update for all modes
   */
  private async _handlePostResponseBalanceUpdate(params: {
    token: string;
    baseUrl: string;
    initialTokenBalance: number;
    initialTokenBalanceUnknown?: boolean;
    fallbackSatsSpent?: number;
    response?: Response;
    modelId?: string;
    usage?: UsageTrackingData;
    requestId?: string;
    clientApiKey?: string;
  }): Promise<number> {
    const {
      token,
      baseUrl,
      initialTokenBalance,
      initialTokenBalanceUnknown,
      fallbackSatsSpent,
      response,
      modelId,
      usage,
      requestId,
      clientApiKey,
    } = params;

    let satsSpent: number = initialTokenBalance;

    if (this.mode === "xcashu" && response) {
      const refundToken = response.headers.get("x-cashu") ?? undefined;
      if (refundToken) {
        const receiveResult =
          await this.cashuSpender.receiveToken(refundToken);
        if (receiveResult.success) {
          // Remove the spent token from storage
          this.storageAdapter.removeXcashuToken(baseUrl, token);
          satsSpent =
            initialTokenBalance -
            receiveResult.amount * (receiveResult.unit == "sat" ? 1 : 1000);
        } else {
          this._log(
            "ERROR",
            `[xcashu] Failed to receive refund token: ${receiveResult.message}`
          );
        }
      }
    } else if (this.mode === "apikeys") {
      try {
        const latestBalanceInfo = await this.balanceManager.getTokenBalance(
          token,
          baseUrl
        );
        this._log(
          "DEBUG",
          "LATEST Balance",
          latestBalanceInfo.amount,
          latestBalanceInfo.reserved,
          REDACTED_CREDENTIAL,
          baseUrl
        );
        const latestTokenBalance = latestBalanceInfo.balanceUnknown
          ? undefined
          : latestBalanceInfo.unit === "msat"
            ? latestBalanceInfo.amount / 1000
            : latestBalanceInfo.amount;
        const latestReservedBalance = latestBalanceInfo.balanceUnknown
          ? undefined
          : latestBalanceInfo.unit === "msat"
            ? latestBalanceInfo.reserved / 1000
            : latestBalanceInfo.reserved;

        const storedApiKeyEntry = this.storageAdapter.getApiKey(baseUrl);
        if (
          storedApiKeyEntry?.key.startsWith("cashu") &&
          latestBalanceInfo.apiKey
        ) {
          this._replaceApiKey(baseUrl, latestBalanceInfo.apiKey);
        }
        if (latestTokenBalance !== undefined) {
          this.storageAdapter.updateApiKeyBalance(
            baseUrl,
            latestTokenBalance,
            latestReservedBalance
          );
          this.storageAdapter.touchApiKeyLastUsed(baseUrl);
        }

        satsSpent =
          latestTokenBalance !== undefined && !initialTokenBalanceUnknown
            ? Math.max(0, initialTokenBalance - latestTokenBalance)
            : (fallbackSatsSpent ?? usage?.satsCost ?? this._headerSatsCost(response) ?? 0);
      } catch (e) {
        this._log("WARN", "Could not get updated API key balance:", e);
        satsSpent = fallbackSatsSpent ?? usage?.satsCost ?? this._headerSatsCost(response) ?? 0;
      }
    }

    await this._trackResponseUsage({
      token,
      baseUrl,
      response,
      modelId,
      satsSpent,
      usage,
      requestId,
      clientApiKey,
    });

    // Fire-and-forget async spinoff - does not block
    (async () => {
      try {
        // Refund all xcashu tokens
        // const xcashuResults =
        //  await this.cashuSpender.refundXcashuTokens(mintUrl);
        // this._log("DEBUG", "Refund xcashu tokens results:", xcashuResults);

        // Also refund API keys (apikeys mode) DISABLED FOR NOW
        // const results = await this.cashuSpaender.refundProviders(mintUrl);
      } catch (error) {
        this._log("ERROR", "Failed to refund providers:", error);
      }
    })();

    return satsSpent;
  }

  /**
   * Extract sats cost from EHBP/Tinfoil response headers as a last-resort
   * fallback when neither balance delta nor SSE/body usage provides a cost.
   */
  private _headerSatsCost(response?: Response): number | undefined {
    if (!response) return undefined;
    const headerUsage = extractUsageFromResponseHeaders(response.headers);
    return headerUsage?.satsCost;
  }

  private async _trackResponseUsage(params: {
    token: string;
    baseUrl: string;
    response?: Response;
    modelId?: string;
    satsSpent: number;
    usage?: UsageTrackingData;
    requestId?: string;
    clientApiKey?: string;
  }): Promise<void> {
    const {
      token,
      baseUrl,
      response,
      modelId,
      satsSpent,
      usage: providedUsage,
      requestId: providedRequestId,
      clientApiKey,
    } = params;

    if (!response || !modelId) {
      return;
    }

    try {
      let usage = providedUsage;
      let requestId = providedRequestId;

      if (!usage || !requestId) {
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
          usage = usage ?? (response as any).usage;
          requestId =
            requestId ??
            (response as any).requestId ??
            response.headers.get("x-routstr-request-id") ??
            undefined;

          if (!usage) {
            return;
          }
        } else {
          const cloned = response.clone();
          const responseBody = await cloned.json();
          usage =
            usage ??
            extractUsageFromResponseBody(responseBody, satsSpent) ??
            undefined;
          requestId =
            requestId ??
            extractResponseId(responseBody) ??
            response.headers.get("x-routstr-request-id") ??
            undefined;
        }
      }

      if (!usage) {
        // No usage from SSE/body — try response headers (EHBP/Tinfoil path
        // where cost is only in headers because the body is encrypted).
        const headerUsage = extractUsageFromResponseHeaders(response.headers);
        if (headerUsage) {
          usage = headerUsage;
        } else {
          return;
        }
      } else {
        // Merge header-based costs into SSE/body-extracted usage. For EHBP
        // requests, the SSE body may have token counts but no cost breakdown;
        // the headers carry the authoritative cost. Header values take
        // priority when non-zero.
        const headerUsage = extractUsageFromResponseHeaders(response.headers);
        if (headerUsage) {
          // Only override cost fields that headers actually have
          if (headerUsage.totalMsats) {
            usage.totalMsats = headerUsage.totalMsats;
            usage.satsCost = headerUsage.satsCost;
          }
          if (headerUsage.cost) usage.cost = headerUsage.cost;
          if (headerUsage.inputMsats) usage.inputMsats = headerUsage.inputMsats;
          if (headerUsage.outputMsats) usage.outputMsats = headerUsage.outputMsats;
          if (headerUsage.totalUsd) usage.totalUsd = headerUsage.totalUsd;
        }
      }

      const finalRequestId = requestId || "unknown";

      const store = this.sdkStore ?? (await getDefaultSdkStore());
      const state = store.getState();

      // Use clientApiKey for matching if provided, otherwise fall back to token
      const matchKey = clientApiKey ?? token;
      const matchingClient = state.clientIds.find(
        (client) => client.apiKey === matchKey
      );

      const entryId =
        finalRequestId === "unknown"
          ? `req-${Date.now()}-${modelId}`
          : finalRequestId;

      const usageTracking =
        this.usageTrackingDriver ?? getDefaultUsageTrackingDriver();

      const entry = {
        id: entryId,
        timestamp: Date.now(),
        modelId,
        baseUrl,
        requestId: finalRequestId,
        client: matchingClient?.clientId,
        ...usage,
        // Anthropic responses may omit the body provider; the node can
        // still identify the route in a response header (including SSE).
        provider:
          usage.provider ||
          response.headers.get("x-routstr-provider")?.trim() ||
          undefined,
      };

      // For xcashu mode, use satsSpent directly for satsCost instead of calculating from usage
      if (this.mode === "xcashu") {
        entry.satsCost = satsSpent;
      }

      await usageTracking.append(entry);
    } catch (error) {
      // Silently ignore tracking failures
    }
  }

  /**
   * Check wallet balance and throw if insufficient
   */
  private async _checkBalance(baseUrl: string): Promise<void> {
    // In apikeys mode, if a funded API key already exists in storage its
    // balance lives on the provider — skip the local wallet check.
    if (this.mode === "apikeys" && this.storageAdapter.getApiKey(baseUrl)) {
      return;
    }

    const balances = await this.walletAdapter.getBalances();
    const totalBalance = Object.values(balances).reduce((sum, v) => sum + v, 0);

    if (totalBalance <= 0) {
      throw new InsufficientBalanceError(1, 0);
    }
  }

  // ── Proactive (pre-request) topup ─────────────────────────────────
  // Stored API-key snapshots contain both total and last-known reserved
  // balance. The trigger and topup both trust this snapshot (no extra
  // balance round-trip); the post-topup total is persisted from topUp's
  // toppedUpAmount so the stored snapshot isn't stale-low and re-triggering.

  /**
   * Wait for a topup if the snapshot cannot cover this request; otherwise
   * refill the margin in the background. A failed topup does not prevent the
   * request from trying the provider (the snapshot may be stale). Never throws.
   */
  private async _topUpIfNeeded(snapshot: {
    token: string;
    baseUrl: string;
    mintUrl: string;
    requiredSats: number;
    tokenBalance: number;
    tokenReserved?: number;
    tokenBalanceUnit: "sat" | "msat";
    tokenBalanceUnknown: boolean;
  }): Promise<void> {
    if (this.mode !== "apikeys" || !snapshot.token) return;
    if (snapshot.tokenBalanceUnknown) return;

    const snapshotSats =
      snapshot.tokenBalanceUnit === "msat"
        ? snapshot.tokenBalance / 1000
        : snapshot.tokenBalance;
    const tokenReserved = snapshot.tokenReserved ?? 0;
    const snapshotReservedSats =
      snapshot.tokenBalanceUnit === "msat"
        ? tokenReserved / 1000
        : tokenReserved;
    const snapshotAvailableSats = snapshotSats - snapshotReservedSats;
    // Maintain the margin up front: proactively top up whenever the available
    // balance is below the request price scaled by TOPUP_MARGIN, so the
    // key stays covered at the margin instead of reacting only after a 402.
    const targetSats = snapshot.requiredSats * TOPUP_MARGIN;
    if (snapshotAvailableSats >= targetSats) return;

    const key = `${snapshot.baseUrl}:${snapshot.token}`;
    const mustWait = snapshotAvailableSats < snapshot.requiredSats;
    this._log(
      "DEBUG",
      `[RoutstrClient] _topUpIfNeeded: snapshot total=${snapshotSats} sat, reserved=${snapshotReservedSats} sat, available=${snapshotAvailableSats} sat < target=${targetSats} sat (required=${snapshot.requiredSats} x ${TOPUP_MARGIN}) for ${snapshot.baseUrl}; ${mustWait ? "awaiting topup" : "spinning off background topup"}`
    );

    // Concurrent callers join the same deposit. In the margin zone this is
    // deliberately detached; below the request price we wait for it first.
    const topup = this._topUpOnce(key, () => this._runProactiveTopup(snapshot));
    if (mustWait) {
      try {
        await topup;
      } catch (e) {
        this._log(
          "WARN",
          `[RoutstrClient] _topUpIfNeeded: topup crashed for ${snapshot.baseUrl}`,
          e
        );
      }
    } else {
      void topup.catch((e: unknown) => {
        this._log(
          "WARN",
          `[RoutstrClient] _topUpIfNeeded: background topup crashed for ${snapshot.baseUrl}`,
          e
        );
      });
    }
  }

  /**
   * Top up the key based on the balance snapshot captured by _spendToken. The
   * trigger already confirmed available < required x TOPUP_MARGIN, so we
   * deposit exactly the shortfall to land at the margin. No extra balance
   * round-trip: the post-topup total is persisted from topUp's
   * toppedUpAmount so future snapshots aren't stale. Never throws.
   */
  private async _runProactiveTopup(snapshot: {
    token: string;
    baseUrl: string;
    mintUrl: string;
    requiredSats: number;
    tokenBalance: number;
    tokenReserved?: number;
    tokenBalanceUnit: "sat" | "msat";
  }): Promise<TopUpResult> {
    try {
      const tokenReserved = snapshot.tokenReserved ?? 0;
      const snapshotSats =
        snapshot.tokenBalanceUnit === "msat"
          ? snapshot.tokenBalance / 1000
          : snapshot.tokenBalance;
      const reservedSats =
        snapshot.tokenBalanceUnit === "msat"
          ? tokenReserved / 1000
          : tokenReserved;
      const availableSats = snapshotSats - reservedSats;
      // The trigger already guaranteed available < target, so the shortfall
      // is exactly the amount needed to land the key at the margin.
      const targetSats = snapshot.requiredSats * TOPUP_MARGIN;
      const shortfall = Math.max(0, targetSats - availableSats);

      if (shortfall <= 0) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _runProactiveTopup: snapshot for ${snapshot.baseUrl} is sufficient (available=${availableSats} sat >= target=${targetSats} sat); no topup needed`
        );
        return {
          success: true,
          message: "proactive topup skipped: balance sufficient on snapshot",
        };
      }

      const topupAmount = Math.max(
        shortfall,
        PROACTIVE_TOPUP_MIN_FRACTION * snapshot.requiredSats
      );
      const result = await this.balanceManager.topUp({
        mintUrl: snapshot.mintUrl,
        baseUrl: snapshot.baseUrl,
        // The target already includes TOPUP_MARGIN — deposit the shortfall.
        amount: topupAmount,
        token: snapshot.token,
      });
      this._log(
        "DEBUG",
        `[RoutstrClient] _runProactiveTopup: result for ${snapshot.baseUrl}: success=${result.success}, amount=${topupAmount}, message=${result.message}`
      );

      // Persist the new total so the stored snapshot does not stay stale-low
      // and re-trigger a topup on every future request. topUp reports how
      // much it added; combine it with the snapshot total instead of fetching
      // the balance again.
      if (result.success) {
        const added = result.toppedUpAmount ?? topupAmount;
        this.storageAdapter.updateApiKeyBalance(
          snapshot.baseUrl,
          Math.floor(snapshotSats + added),
          Math.floor(reservedSats)
        );
      }
      return result;
    } catch (e) {
      this._log(
        "WARN",
        `[RoutstrClient] _runProactiveTopup: failed for ${snapshot.baseUrl}`,
        e
      );
      return {
        success: false,
        message: `proactive topup failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Run (or join) the single in-flight topup for an API key. Concurrent
   * callers — proactive spin-offs and 402 handlers alike — share one topUp
   * call instead of stacking multiple deposits.
   */
  private _topUpOnce(
    key: string,
    start: () => Promise<TopUpResult>
  ): Promise<TopUpResult> {
    const existing = this._inflightTopups.get(key);
    if (existing) return existing;
    const promise = start().finally(() => {
      this._inflightTopups.delete(key);
    });
    this._inflightTopups.set(key, promise);
    return promise;
  }

  /**
   * Spend a token using CashuSpender with standardized error handling
   */
  private async _spendToken(params: {
    mintUrl: string;
    amount: number;
    baseUrl: string;
    excludeMints?: string[];
  }): Promise<{
    token: string;
    tokenBalance: number;
    tokenReserved: number;
    tokenBalanceUnit: "sat" | "msat";
    tokenBalanceUnknown: boolean;
    selectedMintUrl?: string;
  }> {
    const { mintUrl, amount, baseUrl, excludeMints = [] } = params;

    this._log(
      "DEBUG",
      `[RoutstrClient] _spendToken: mode=${this.mode}, amount=${amount}, baseUrl=${baseUrl}, mintUrl=${mintUrl}`
    );

    if (this.mode === "apikeys") {
      let parentApiKey = this.storageAdapter.getApiKey(baseUrl);
      let selectedMintUrl: string | undefined;

      // A reused key may belong to another request whose write is pending,
      // or survive a failed save and failed recovery. Do not expose it yet.
      if (parentApiKey) await this.storageAdapter.flush?.();

      // A stored key that is still a bootstrap Cashu token (i.e. the
      // provider's canonical key was never swapped in) may be a zombie: if the
      // first request failed before the swap (e.g. 503 mint_unreachable) the
      // wallet received its proofs back, so the token can never authenticate
      // again. Detect it via the provider's balance endpoint and recreate
      // instead of blindly reusing a dead key.
      if (parentApiKey && parentApiKey.key.startsWith("cashu")) {
        try {
          const balanceInfo = await this.balanceManager.getTokenBalance(
            parentApiKey.key,
            baseUrl
          );
          if (balanceInfo.isInvalidApiKey) {
            this._log(
              "DEBUG",
              `[RoutstrClient] _spendToken: Stored bootstrap API key for ${baseUrl} is dead (proofs already spent), removing and recreating`
            );
            this.storageAdapter.removeApiKey(baseUrl);
            parentApiKey = null;
          }
        } catch (e) {
          this._log(
            "WARN",
            "Could not validate existing API key before reuse, keeping it:",
            e
          );
        }
      }

      if (!parentApiKey) {
        this._log(
          "DEBUG",
          `[RoutstrClient] _spendToken: No existing API key for ${baseUrl}, creating new one via Cashu`
        );
        // Enforce a minimum deposit of 10 sats when creating a brand-new
        // API key.  Without this, a tiny probe request (e.g. a 10-token
        // health check with max_tokens=10) can price at well under 1 sat,
        // and Math.ceil rounds it up to exactly 1 sat — leaving the new
        // key with a balance too small to serve any real request.
        const MIN_INITIAL_DEPOSIT = 7;
        const initialAmount = Math.max(
          Math.ceil(amount * TOPUP_MARGIN),
          MIN_INITIAL_DEPOSIT
        );
        const spendResult = await this.cashuSpender.spend({
          mintUrl: mintUrl,
          amount: initialAmount,
          baseUrl,
          reuseToken: false,
          excludeMints,
        });

        selectedMintUrl = spendResult.selectedMintUrl;

        if (!spendResult.token) {
          this._log(
            "ERROR",
            `[RoutstrClient] _spendToken: Failed to create Cashu token for API key creation, error:`,
            spendResult.error
          );
          throw new Error(
            `[RoutstrClient] _spendToken: Failed to create Cashu token for API key creation, error: ${spendResult.error}`
          );
        } else {
          this._log(
            "DEBUG",
            `[RoutstrClient] _spendToken: Cashu token created, token=${REDACTED_CREDENTIAL}`
          );
        }

        this._log(
          "DEBUG",
          `[RoutstrClient] _spendToken: Created API key for ${baseUrl}, key=${REDACTED_CREDENTIAL}, balance: ${spendResult.balance}`
        );

        // Legacy wallet adapters may ignore persistToken. Establish a recovery
        // owner before attempting either key persistence or wallet recovery.
        this.storageAdapter.addXcashuToken(baseUrl, spendResult.token);
        try {
          this.storageAdapter.setApiKey(baseUrl, spendResult.token);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("ApiKey already exists")
          ) {
            const receiveResult = await this.cashuSpender.receiveToken(
              spendResult.token,
              false
            );
            if (receiveResult.success) {
              this.storageAdapter.removeXcashuToken(baseUrl, spendResult.token);
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: Token restored successfully, amount=${receiveResult.amount}`
              );
            } else {
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: Token restore failed: ${receiveResult.message}`
              );
            }
            this._log(
              "DEBUG",
              `[RoutstrClient] _spendToken: API key already exists for ${baseUrl}, using existing key`
            );
          } else {
            throw error;
          }
        }
        parentApiKey = this.storageAdapter.getApiKey(baseUrl);

        // This token is now the only credential for its deposit, so it must be
        // stored before the provider sees it. If it cannot be stored, give the
        // proofs back to the wallet instead of paying with it.
        if (parentApiKey?.key === spendResult.token) {
          try {
            await this.storageAdapter.flush?.();
          } catch (error) {
            const receiveResult = await this.cashuSpender.receiveToken(
              spendResult.token,
              false
            );
            if (receiveResult.success) {
              this.storageAdapter.removeXcashuToken(baseUrl, spendResult.token);
              if (
                this.storageAdapter.getApiKey(baseUrl)?.key === spendResult.token
              ) {
                this.storageAdapter.removeApiKey(baseUrl);
              }
            }
            throw error;
          }
          // The key record now holds the token; drop the wallet handover copy.
          this.storageAdapter.removeXcashuToken(baseUrl, spendResult.token);
        }
      } else {
        this._log(
          "DEBUG",
          `[RoutstrClient] _spendToken: Using existing API key for ${baseUrl}, key=${REDACTED_CREDENTIAL}`
        );
      }

      // Also covers the winner when concurrent key creation lost the race.
      await this.storageAdapter.flush?.();
      if (this.storageAdapter.flush && parentApiKey?.key.startsWith("cashu")) {
        // A previous failed save may have left its recovery copy behind.
        // The key is durable now, so that handover copy is no longer needed.
        this.storageAdapter.removeXcashuToken(baseUrl, parentApiKey.key);
      }

      let tokenBalance = 0;
      let tokenReserved = 0;
      let tokenBalanceUnit: "sat" | "msat" = "sat";
      let tokenBalanceUnknown = false;

      const apiKeyDistribution = this.storageAdapter.getApiKeyDistribution();
      const distributionForBaseUrl = apiKeyDistribution.find(
        (d) => d.baseUrl === baseUrl
      );
      if (distributionForBaseUrl) {
        tokenBalance = distributionForBaseUrl.amount;
        tokenReserved = distributionForBaseUrl.reserved ?? 0;
      }

      if (tokenBalance === 0 && parentApiKey) {
        try {
          const balanceInfo = await this.balanceManager.getTokenBalance(
            parentApiKey.key,
            baseUrl
          );
          tokenBalance = balanceInfo.amount;
          tokenReserved = balanceInfo.reserved;
          tokenBalanceUnit = balanceInfo.unit;
          tokenBalanceUnknown = Boolean(balanceInfo.balanceUnknown);
        } catch (e) {
          this._log("WARN", "Could not get initial API key balance:", e);
        }
      }

      this._log(
        "DEBUG",
        `[RoutstrClient] _spendToken: Returning token with balance=${tokenBalance}, reserved=${tokenReserved} ${tokenBalanceUnit}`
      );

      return {
        token: parentApiKey?.key ?? "",
        tokenBalance,
        tokenReserved,
        tokenBalanceUnit,
        tokenBalanceUnknown,
        selectedMintUrl,
      };
    }

    this._log(
      "DEBUG",
      `[RoutstrClient] _spendToken: Calling CashuSpender.spend for amount=${amount}, mintUrl=${mintUrl}, mode=${this.mode}`
    );
    const spendResult = await this.cashuSpender.spend({
      mintUrl,
      amount,
      baseUrl,
      reuseToken: false,
      excludeMints,
    });

    if (!spendResult.token) {
      this._log(
        "ERROR",
        `[RoutstrClient] _spendToken: CashuSpender.spend failed, error:`,
        spendResult.error
      );
    } else {
      this._log(
        "DEBUG",
        `[RoutstrClient] _spendToken: Cashu token created, token=${REDACTED_CREDENTIAL}, balance: ${spendResult.balance} ${spendResult.unit ?? "sat"}`
      );
      // Store xcashu token using the storage adapter
      this.storageAdapter.addXcashuToken(baseUrl, spendResult.token);
    }

    return {
      token: spendResult.token!,
      tokenBalance: spendResult.balance,
      tokenReserved: 0,
      tokenBalanceUnit: spendResult.unit ?? "sat",
      tokenBalanceUnknown: false,
      selectedMintUrl: spendResult.selectedMintUrl,
    };
  }

  /**
   * Swap the stored API key in one write where the adapter supports it, so
   * storage never holds no key for a funded provider.
   */
  private _replaceApiKey(baseUrl: string, key: string): void {
    if (this.storageAdapter.replaceApiKey) {
      this.storageAdapter.replaceApiKey(baseUrl, key);
      return;
    }
    this.storageAdapter.removeApiKey(baseUrl);
    this.storageAdapter.setApiKey(baseUrl, key);
  }

  /**
   * Build request headers with common defaults and dev mock controls
   */
  private _buildBaseHeaders(
    additionalHeaders: Record<string, string> = {},
    token?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...additionalHeaders,
      "Content-Type": "application/json",
    };

    return headers;
  }

  /**
   * Attach auth headers using the active client mode
   */
  private _withAuthHeader(
    headers: Record<string, string>,
    token: string
  ): Record<string, string> {
    const nextHeaders = { ...headers };

    if (this.mode === "xcashu") {
      nextHeaders["X-Cashu"] = token;
    } else {
      nextHeaders["Authorization"] = `Bearer ${token}`;
    }

    return nextHeaders;
  }

  /** The x-routstr-model-path selector on these headers, if any. */
  private _findModelPathHeader(
    headers: Record<string, string>
  ): string | undefined {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === MODEL_PATH_HEADER) return value;
    }
    return undefined;
  }

  /**
   * Attach auth headers and preserve the plaintext model hint required by the
   * Routstr proxy for Tinfoil/EHBP requests. EHBP encrypts the JSON body, so
   * retries/failover must not rebuild headers from baseHeaders alone or the
   * proxy cannot route/price the encrypted request.
   */
  private _withAuthAndTinfoilHeaders(
    headers: Record<string, string>,
    token: string,
    tinfoilEnabled?: boolean,
    modelId?: string
  ): Record<string, string> {
    const nextHeaders = this._withAuthHeader(headers, token);

    if (tinfoilEnabled && modelId) {
      nextHeaders["X-Routstr-Model"] = modelId;
    }

    return nextHeaders;
  }

}

