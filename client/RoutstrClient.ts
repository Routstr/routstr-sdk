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

import type { SdkLogger } from "../core/types";
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
import {
  ProviderError,
  FailoverError,
  InsufficientBalanceError,
  TokenAlreadySpentError,
  MintError,
  InvalidTokenError,
  CashuRedemptionError,
  TokenConsumedError,
  CoreInternalError,
} from "../core/errors";
import {
  parseCoreError,
  CoreErrorCode,
  CoreErrorType,
  isInvalidTokenError,
  isCashuRedemptionError,
  isTokenConsumedError,
  isCoreInternalError,
  isHandledRedemptionError,
  shouldFailoverToAnotherMint,
  shouldPurgeStoredCredential,
  type ParsedCoreError,
} from "../core/errorTypes";
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

/**
 * RoutstrClient is the main SDK entry point
 */
export type AlertLevel = "max" | "min";
export type RoutstrClientMode = "xcashu" | "apikeys";
export type DebugLevel = "DEBUG" | "WARN" | "ERROR";

const TOPUP_MARGIN = 1.2;

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
    const prepared = await this._prepareRoutedRequest(params);
    const contentType =
      prepared.response.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");

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
        mintUrl: params.mintUrl,
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

    // Extract clientApiKey from incoming headers then discard them — they must
    // not be forwarded upstream (the client's Authorization Bearer key would
    // overwrite the Cashu/API-key auth we attach ourselves).
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
        // Completion budget for pricing. max_completion_tokens (the
        // OpenAI-standard chat field) wins when present: it's what
        // reasoning-capable upstreams actually enforce, and routstrd now
        // injects it as the default cap — so it reflects the real billing
        // ceiling even when a legacy max_tokens rides alongside it.
        // Precedence: max_completion_tokens → max_tokens (legacy chat) →
        // max_output_tokens (Responses API). Undefined prices at the
        // provider's worst-case max_completion_cost.
        requestMaxTokens =
          typeof requestBodyForPricing.max_completion_tokens === "number"
            ? (requestBodyForPricing.max_completion_tokens as number)
            : typeof requestBodyForPricing.max_tokens === "number"
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
          requestMaxTokens
        );
      }
    }

    let requestBody = body;
    if (body && typeof body === "object") {
      const bodyObj = body as Record<string, unknown>;
      if (!bodyObj.stream) {
        requestBody = { ...bodyObj, stream: false };
      }
    }

    // Build clean outgoing headers — do NOT pass the incoming client headers here
    const baseHeaders = this._buildBaseHeaders();

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
      tokenBalanceUnit,
      tokenBalanceUnknown,
      selectedMintUrl,
    } = spendResult;

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

    if (contentType.includes("text/event-stream") && response.body) {
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
   * Extract clientApiKey from Authorization Bearer token if present
   */
  private _extractClientApiKey(
    headers: Record<string, string>
  ): string | undefined {
    const authHeader = headers["Authorization"] || headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      const extractedKey = authHeader.slice(7);
      return extractedKey;
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

      if (this.mode === "xcashu") this._log("DEBUG", "HEADERS,", headers);

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
          params.retryCount ?? 0
        );
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
   * Store request details to a file in the reqs/ folder before fetch.
   */
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
    },
    token: string,
    status: number,
    requestId?: string,
    xCashuRefundToken?: string,
    responseBody?: string,
    retryCount: number = 0
  ): Promise<Response> {
    const MAX_RETRIES_PER_PROVIDER = 2;
    const { path, method, body, selectedModel, baseUrl, mintUrl } = params;
    let tryNextProvider: boolean = false;

    const errorMessage = responseBody;

    // ── Parse structured error from routstr-core ────────────────────────
    const parsedError = parseCoreError(responseBody, status, requestId);
    const resolvedRequestId = parsedError.requestId ?? requestId;
    const handledRedemptionError = isHandledRedemptionError(parsedError);
    let recoveryAttempted = false;
    let recoverySucceeded = false;

    this._log(
      "DEBUG",
      `[RoutstrClient] _handleErrorResponse: status=${status}, baseUrl=${baseUrl}, mode=${this.mode}, token preview=${token}, requestId=${resolvedRequestId}, errorType=${parsedError.type ?? "unknown"}, errorCode=${parsedError.code ?? "unknown"}, errorMessage=${errorMessage}`
    );

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
        `[RoutstrClient] _handleErrorResponse: Attempting to receive xcashu refund token, preview=${xCashuRefundToken.substring(0, 20)}...`
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

    // For recognized redemption errors, a failed receive is still a provider
    // failure: preserve the stored token for later recovery, mark this provider
    // failed below, and retry with a fresh token on a different provider.
    if (
      this.mode === "xcashu" &&
      handledRedemptionError &&
      !tryNextProvider
    ) {
      this._log(
        "WARN",
        `[RoutstrClient] _handleErrorResponse: recovery failed for structured redemption error type=${parsedError.type} code=${parsedError.code}; preserving token and trying provider failover`
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
          const topupResult = await this.balanceManager.topUp({
            mintUrl,
            baseUrl,
            amount: topupAmount * TOPUP_MARGIN,
            token: params.token,
          });
          this._log(
            "DEBUG",
            `[RoutstrClient] _handleErrorResponse: Topup result for ${baseUrl}: success=${topupResult.success}, message=${topupResult.message}`
          );

          if (!topupResult.success) {
            const message = topupResult.message || "";
            if (message.includes("Insufficient balance")) {
              const needMatch = message.match(/need (\d+)/);
              const haveMatch = message.match(/have (\d+)/);
              const required = needMatch
                ? parseInt(needMatch[1], 10)
                : params.requiredSats;
              const available = haveMatch ? parseInt(haveMatch[1], 10) : 0;
              this._log(
                "DEBUG",
                `[RoutstrClient] _handleErrorResponse: Insufficient balance, need=${required}, have=${available}`
              );
              throw new InsufficientBalanceError(
                required,
                available,
                0,
                "",
                message
              );
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

          if (latestBalanceInfo.apiKey) {
            const storedApiKeyEntry = this.storageAdapter.getApiKey(baseUrl);
            if (storedApiKeyEntry?.key !== latestBalanceInfo.apiKey) {
              if (storedApiKeyEntry) {
                this.storageAdapter.removeApiKey(baseUrl);
              }
              this.storageAdapter.setApiKey(baseUrl, latestBalanceInfo.apiKey);
            }
            retryToken = latestBalanceInfo.apiKey;
          }

          if (latestTokenBalance !== undefined && latestTokenBalance >= 0) {
            this.storageAdapter.updateApiKeyBalance(
              baseUrl,
              latestTokenBalance
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
        `[RoutstrClient] _handleErrorResponse: Checking balance for ${baseUrl}, key preview=${token}`
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
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === 521) &&
      !tryNextProvider
    ) {
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: Status ${status} (${status === 429 ? "rate limited" : "auth/server error"}), attempting refund for ${baseUrl}, mode=${this.mode}`
      );
      if (this.mode === "apikeys") {
        this._log(
          "DEBUG",
          `[RoutstrClient] _handleErrorResponse: Attempting API key refund for ${baseUrl}, key preview=${token}`
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
            // Known transient refund failure: the upstream wallet refuses to
            // refund a shared API key while other in-flight requests are still
            // using it (HTTP 400 "Cannot refund key. There are ongoing
            // requests for this api key."). The sats are still on the key and
            // will be reclaimed by a later refund sweep — this is not a
            // terminal provider failure, so fall through to markFailed() +
            // findNextBestProvider() instead of throwing.
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
    this.providerManager.markFailed(baseUrl, failReason);
    this._log(
      "DEBUG",
      `[RoutstrClient] _handleErrorResponse: Marked provider ${baseUrl} as failed (${failReason})`
    );

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

    const nextProvider = this.providerManager.findNextBestProvider(
      selectedModel.id,
      baseUrl
    );

    if (nextProvider) {
      this._log(
        "DEBUG",
        `[RoutstrClient] _handleErrorResponse: Failing over to next provider: ${nextProvider}, model: ${selectedModel.id}`
      );
      // Get new model for this provider
      const newModel =
        (await this.providerManager.getModelForProvider(
          nextProvider,
          selectedModel.id
        )) ?? selectedModel;

      const messagesForPricing = Array.isArray(
        (body as { messages?: unknown })?.messages
      )
        ? ((body as { messages?: unknown }).messages as any[])
        : [];

      const newRequiredSats = this.providerManager.getRequiredSatsForModel(
        newModel,
        messagesForPricing,
        params.maxTokens
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
      let spendResult: Awaited<ReturnType<RoutstrClient["_spendToken"]>>;
      try {
        spendResult = await this._spendToken({
          mintUrl,
          amount: newRequiredSats,
          baseUrl: nextProvider,
        });
      } catch (error) {
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

      // Retry with new provider (reset retry count). Attach the balance that
      // was observed before the retry request so callers do not have to query
      // after the provider may already have charged the request.
      const retryResponse = await this._makeRequest({
        ...params,
        path,
        method,
        body,
        baseUrl: nextProvider,
        selectedModel: newModel,
        token: spendResult.token!,
        selectedMintUrl: spendResult.selectedMintUrl,
        excludeMints: undefined,
        requiredSats: newRequiredSats,
        headers: this._withAuthAndTinfoilHeaders(
          params.baseHeaders,
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

    // No more providers to try. If the root cause was a specific core error
    // type (e.g. token_already_spent), surface that instead of a generic
    // FailoverError so callers can branch on the specific failure.
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

    throw new FailoverError(
      baseUrl,
      Array.from(this.providerManager.getFailedProviders())
    );
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
    mintUrl: string;
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
      mintUrl,
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
          latestBalanceInfo.apiKey,
          baseUrl
        );
        const latestTokenBalance = latestBalanceInfo.balanceUnknown
          ? undefined
          : latestBalanceInfo.unit === "msat"
            ? latestBalanceInfo.amount / 1000
            : latestBalanceInfo.amount;

        const storedApiKeyEntry = this.storageAdapter.getApiKey(baseUrl);
        if (
          storedApiKeyEntry?.key.startsWith("cashu") &&
          latestBalanceInfo.apiKey
        ) {
          this.storageAdapter.removeApiKey(baseUrl);
          this.storageAdapter.setApiKey(baseUrl, latestBalanceInfo.apiKey);
        }
        if (latestTokenBalance !== undefined) {
          this.storageAdapter.updateApiKeyBalance(baseUrl, latestTokenBalance);
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
            `[RoutstrClient] _spendToken: Cashu token created, token preview: ${spendResult.token}`
          );
        }

        this._log(
          "DEBUG",
          `[RoutstrClient] _spendToken: Created API key for ${baseUrl}, key preview: ${spendResult.token}, balance: ${spendResult.balance}`
        );

        try {
          this.storageAdapter.setApiKey(baseUrl, spendResult.token);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("ApiKey already exists")
          ) {
            const receiveResult = await this.cashuSpender.receiveToken(
              spendResult.token
            );
            if (receiveResult.success) {
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
      } else {
        this._log(
          "DEBUG",
          `[RoutstrClient] _spendToken: Using existing API key for ${baseUrl}, key preview: ${parentApiKey.key}`
        );
      }

      let tokenBalance = 0;
      let tokenBalanceUnit: "sat" | "msat" = "sat";
      let tokenBalanceUnknown = false;

      const apiKeyDistribution = this.storageAdapter.getApiKeyDistribution();
      const distributionForBaseUrl = apiKeyDistribution.find(
        (d) => d.baseUrl === baseUrl
      );
      if (distributionForBaseUrl) {
        tokenBalance = distributionForBaseUrl.amount;
      }

      if (tokenBalance === 0 && parentApiKey) {
        try {
          const balanceInfo = await this.balanceManager.getTokenBalance(
            parentApiKey.key,
            baseUrl
          );
          tokenBalance = balanceInfo.amount;
          tokenBalanceUnit = balanceInfo.unit;
          tokenBalanceUnknown = Boolean(balanceInfo.balanceUnknown);
        } catch (e) {
          this._log("WARN", "Could not get initial API key balance:", e);
        }
      }

      this._log(
        "DEBUG",
        `[RoutstrClient] _spendToken: Returning token with balance=${tokenBalance} ${tokenBalanceUnit}`
      );

      return {
        token: parentApiKey?.key ?? "",
        tokenBalance,
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
        `[RoutstrClient] _spendToken: Cashu token created, token preview: ${spendResult.token}, balance: ${spendResult.balance} ${spendResult.unit ?? "sat"}`
      );
      // Store xcashu token using the storage adapter
      this.storageAdapter.addXcashuToken(baseUrl, spendResult.token);
    }

    return {
      token: spendResult.token!,
      tokenBalance: spendResult.balance,
      tokenBalanceUnit: spendResult.unit ?? "sat",
      tokenBalanceUnknown: false,
      selectedMintUrl: spendResult.selectedMintUrl,
    };
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

