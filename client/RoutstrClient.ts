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

import type { Message, TransactionHistory } from "../core/types";
import type { Model } from "../core/types";
import type {
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
  StreamingCallbacks,
} from "../wallet/interfaces";
import { CashuSpender } from "../wallet/CashuSpender";
import { BalanceManager } from "../wallet/BalanceManager";
import { StreamProcessor } from "./StreamProcessor";
import { ProviderManager } from "./ProviderManager";
import type { StreamingResult } from "../core/types";
import {
  ProviderError,
  FailoverError,
  InsufficientBalanceError,
} from "../core/errors";

/**
 * Options for fetching AI response
 */
export interface FetchOptions {
  messageHistory: Message[];
  selectedModel: Model;
  baseUrl: string;
  mintUrl: string;
  balance: number;
  transactionHistory: TransactionHistory[];
  maxTokens?: number;
  headers?: Record<string, string>;
}

/**
 * RoutstrClient is the main SDK entry point
 */
export type AlertLevel = "max" | "min";
export type RoutstrClientMode = "xcashu" | "lazyrefund" | "apikeys";

const TOPUP_MARGIN = 0.7;

export interface RouteRequestParams {
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  baseUrl: string;
  mintUrl: string;
  modelId?: string;
}

export class RoutstrClient {
  private cashuSpender: CashuSpender;
  private balanceManager: BalanceManager;
  private streamProcessor: StreamProcessor;
  private providerManager: ProviderManager;
  private alertLevel: AlertLevel;
  private mode: RoutstrClientMode;

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private providerRegistry: ProviderRegistry,
    alertLevel: AlertLevel,
    mode: RoutstrClientMode = "xcashu"
  ) {
    this.balanceManager = new BalanceManager(
      walletAdapter,
      storageAdapter,
      providerRegistry
    );
    this.cashuSpender = new CashuSpender(
      walletAdapter,
      storageAdapter,
      providerRegistry,
      this.balanceManager
    );
    this.streamProcessor = new StreamProcessor();
    this.providerManager = new ProviderManager(providerRegistry);
    this.alertLevel = alertLevel;
    this.mode = mode;
  }

  /**
   * Get the current client mode
   */
  getMode(): RoutstrClientMode {
    return this.mode;
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
    const {
      path,
      method,
      body,
      headers = {},
      baseUrl,
      mintUrl,
      modelId,
    } = params;

    await this._checkBalance();

    let requiredSats = 1;
    let selectedModel: Model | undefined;
    if (modelId) {
      const providerModel = await this.providerManager.getModelForProvider(
        baseUrl,
        modelId
      );
      selectedModel = providerModel ?? undefined;
      if (selectedModel) {
        requiredSats = this.providerManager.getRequiredSatsForModel(
          selectedModel,
          []
        );
      }
    }

    const { token, tokenBalance, tokenBalanceUnit } = await this._spendToken({
      mintUrl,
      amount: requiredSats,
      baseUrl,
    });
    console.log(token, baseUrl);

    let requestBody = body;
    if (body && typeof body === "object") {
      const bodyObj = body as Record<string, unknown>;
      if (!bodyObj.stream) {
        requestBody = { ...bodyObj, stream: false };
      }
    }

    const baseHeaders = this._buildBaseHeaders(headers);
    const requestHeaders = this._withAuthHeader(baseHeaders, token);

    const response = await this._makeRequest({
      path,
      method,
      body: method === "GET" ? undefined : requestBody,
      baseUrl,
      mintUrl,
      token,
      requiredSats,
      headers: requestHeaders,
      baseHeaders,
      selectedModel,
    });

    const tokenBalanceInSats =
      tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;
    const satsSpent = await this._handlePostResponseBalanceUpdate({
      token,
      baseUrl,
      initialTokenBalance: tokenBalanceInSats,
      response,
    });

    return response;
  }

  /**
   * Fetch AI response with streaming
   */
  async fetchAIResponse(
    options: FetchOptions,
    callbacks: StreamingCallbacks
  ): Promise<void> {
    const {
      messageHistory,
      selectedModel,
      baseUrl,
      mintUrl,
      balance,
      transactionHistory,
      maxTokens,
      headers,
    } = options;

    // Convert messages for API
    const apiMessages = await this._convertMessages(messageHistory);

    // Calculate required amount
    const requiredSats = this.providerManager.getRequiredSatsForModel(
      selectedModel,
      apiMessages,
      maxTokens
    );

    try {
      // Check balance first
      await this._checkBalance();

      // Spend tokens
      callbacks.onPaymentProcessing?.(true);

      const spendResult = await this._spendToken({
        mintUrl,
        amount: requiredSats,
        baseUrl,
      });

      let token = spendResult.token;
      let tokenBalance = spendResult.tokenBalance;
      let tokenBalanceUnit = spendResult.tokenBalanceUnit;

      const tokenBalanceInSats =
        tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;

      callbacks.onTokenCreated?.(this._getPendingCashuTokenAmount());

      const baseHeaders = this._buildBaseHeaders(headers);
      const requestHeaders = this._withAuthHeader(baseHeaders, token);

      // Reset failed providers for new request
      this.providerManager.resetFailedProviders();

      // Get provider info for version compatibility
      const providerInfo = await this.providerRegistry.getProviderInfo(baseUrl);
      const providerVersion = providerInfo?.version ?? "";

      // Handle v0.1.x providers (only send leaf ID)
      let modelIdForRequest = selectedModel.id;
      if (/^0\.1\./.test(providerVersion)) {
        const newModel = await this.providerManager.getModelForProvider(
          baseUrl,
          selectedModel.id
        );
        modelIdForRequest = newModel?.id ?? selectedModel.id;
      }

      const body: any = {
        model: modelIdForRequest,
        messages: apiMessages,
        stream: true,
      };

      if (maxTokens !== undefined) {
        body.max_tokens = maxTokens;
      }

      // Only add tools for OpenAI models
      if (selectedModel?.name?.startsWith("OpenAI:")) {
        body.tools = [{ type: "web_search" }];
      }

      // Make API request
      const response = await this._makeRequest({
        path: "/v1/chat/completions",
        method: "POST",
        body,
        selectedModel,
        baseUrl,
        mintUrl,
        token,
        requiredSats,
        maxTokens,
        headers: requestHeaders,
        baseHeaders,
      });

      if (!response.body) {
        throw new Error("Response body is not available");
      }

      // Process streaming response
      if (response.status === 200) {
        const baseUrlUsed = (response as any).baseUrl || baseUrl;

        const streamingResult = await this.streamProcessor.process(
          response,
          {
            onContent: callbacks.onStreamingUpdate,
            onThinking: callbacks.onThinkingUpdate,
          },
          selectedModel.id
        );

        // Handle finish reason
        if (streamingResult.finish_reason === "content_filter") {
          callbacks.onMessageAppend({
            role: "assistant",
            content: "Your request was denied due to content filtering.",
          });
        } else if (
          streamingResult.content ||
          (streamingResult.images && streamingResult.images.length > 0)
        ) {
          // Create assistant message
          const message = await this._createAssistantMessage(streamingResult);
          callbacks.onMessageAppend(message);
        } else {
          // No content received
          callbacks.onMessageAppend({
            role: "system",
            content: "The provider did not respond to this request.",
          });
        }

        // Clear streaming
        callbacks.onStreamingUpdate("");
        callbacks.onThinkingUpdate("");

        // Handle post-response refund (skip for xcashu mode - refund is in response)
        const isApikeysEstimate = this.mode === "apikeys";
        let satsSpent = await this._handlePostResponseBalanceUpdate({
          token,
          baseUrl: baseUrlUsed,
          initialTokenBalance: tokenBalanceInSats,
          fallbackSatsSpent: isApikeysEstimate
            ? this._getEstimatedCosts(selectedModel, streamingResult)
            : undefined,
          response,
        });
        const estimatedCosts = this._getEstimatedCosts(
          selectedModel,
          streamingResult
        );
        const onLastMessageSatsUpdate = callbacks.onLastMessageSatsUpdate as
          | ((satsSpent: number, estimatedCosts: number) => void)
          | undefined;
        onLastMessageSatsUpdate?.(satsSpent, estimatedCosts);
      } else {
        throw new Error(`${response.status} ${response.statusText}`);
      }
    } catch (error) {
      this._handleError(error, callbacks);
    } finally {
      callbacks.onPaymentProcessing?.(false);
    }
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
    token: string;
    requiredSats: number;
    maxTokens?: number;
    headers: Record<string, string>;
    baseHeaders: Record<string, string>;
  }): Promise<Response> {
    const { path, method, body, baseUrl, token, headers } = params;

    try {
      const url = `${baseUrl.replace(/\/$/, "")}${path}`;
      if (this.mode === "xcashu") console.log("HEADERS,", headers);
      const response = await fetch(url, {
        method,
        headers,
        body:
          body === undefined || method === "GET"
            ? undefined
            : JSON.stringify(body),
      });
      if (this.mode === "xcashu") console.log("response,", response);

      (response as any).baseUrl = baseUrl;

      if (!response.ok) {
        const requestId =
          response.headers.get("x-routstr-request-id") || undefined;
        return await this._handleErrorResponse(
          params,
          token,
          response.status,
          requestId,
          this.mode === "xcashu"
            ? (response.headers.get("x-cashu") ?? undefined)
            : undefined
        );
      }

      return response;
    } catch (error: any) {
      // Handle network errors with failover
      if (this._isNetworkError(error?.message || "")) {
        return await this._handleErrorResponse(
          params,
          token,
          -1 // just for Network Error to skip all statuses
        );
        // return await this._handleNetworkError(error, params);
      }
      throw error;
    }
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
      token: string;
      requiredSats: number;
      maxTokens?: number;
      headers: Record<string, string>;
      baseHeaders: Record<string, string>;
    },
    token: string,
    status: number,
    requestId?: string,
    xCashuRefundToken?: string
  ): Promise<Response> {
    const { path, method, body, selectedModel, baseUrl, mintUrl } = params;
    let tryNextProvider: boolean = false;

    console.log(
      `[RoutstrClient] _handleErrorResponse: status=${status}, baseUrl=${baseUrl}, mode=${this.mode}, token preview=${token}, requestId=${requestId}`
    );

    if (this.mode === "xcashu" || this.mode === "lazyrefund") {
      console.log(
        `[RoutstrClient] _handleErrorResponse: Attempting to receive/restore token for ${baseUrl}`
      );
      const tryReceiveTokenResult = await this.walletAdapter.receiveToken(
        params.token
      );
      if (tryReceiveTokenResult.success) {
        console.log(
          `[RoutstrClient] _handleErrorResponse: Token restored successfully, amount=${tryReceiveTokenResult.amount}`
        );
        tryNextProvider = true;
        if (this.mode === "lazyrefund")
          this.storageAdapter.removeToken(baseUrl);
      } else {
        console.log(
          `[RoutstrClient] _handleErrorResponse: Token restore failed or not needed`
        );
      }
    }

    if (this.mode === "xcashu") {
      if (xCashuRefundToken) {
        console.log(
          `[RoutstrClient] _handleErrorResponse: Attempting to receive xcashu refund token, preview=${xCashuRefundToken.substring(0, 20)}...`
        );
        try {
          const receiveResult =
            await this.walletAdapter.receiveToken(xCashuRefundToken);
          if (receiveResult.success) {
            console.log(
              `[RoutstrClient] _handleErrorResponse: xcashu refund received, amount=${receiveResult.amount}`
            );
            tryNextProvider = true;
          } else
            throw new ProviderError(
              baseUrl,
              status,
              "xcashu refund failed",
              requestId
            );
        } catch (error) {
          console.error("[xcashu] Failed to receive refund token:", error);
          throw new ProviderError(
            baseUrl,
            status,
            "[xcashu] Failed to receive refund token",
            requestId
          );
        }
      } else {
        if (!tryNextProvider)
          throw new ProviderError(
            baseUrl,
            status,
            "[xcashu] Failed to receive refund token",
            requestId
          );
      }
    }

    if (
      status === 402 &&
      !tryNextProvider &&
      (this.mode === "apikeys" || this.mode === "lazyrefund")
    ) {
      const topupResult = await this.balanceManager.topUp({
        mintUrl,
        baseUrl,
        amount: params.requiredSats * TOPUP_MARGIN,
        token: params.token,
      });
      console.log(
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
          console.log(
            `[RoutstrClient] _handleErrorResponse: Insufficient balance, need=${required}, have=${available}`
          );
          throw new InsufficientBalanceError(required, available);
        } else {
          console.log(
            `[RoutstrClient] _handleErrorResponse: Topup failed with non-insufficient-balance error, will try next provider`
          );
          tryNextProvider = true;
        }
      } else {
        console.log(
          `[RoutstrClient] _handleErrorResponse: Topup successful, will retry with new token`
        );
        tryNextProvider = true;
      }
      if (!tryNextProvider)
        return this._makeRequest({
          ...params,
          token: params.token,
          headers: this._withAuthHeader(params.baseHeaders, params.token),
        });
    }

    if (
      (status === 401 ||
        status === 403 ||
        status === 413 ||
        status === 400 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 521) &&
      !tryNextProvider
    ) {
      console.log(
        `[RoutstrClient] _handleErrorResponse: Status ${status} (auth/server error), attempting refund for ${baseUrl}, mode=${this.mode}`
      );
      if (this.mode === "lazyrefund") {
        try {
          // Refund current token
          const refundResult = await this.balanceManager.refund({
            mintUrl,
            baseUrl,
            token: params.token,
          });
          console.log(
            `[RoutstrClient] _handleErrorResponse: Lazyrefund result: success=${refundResult.success}`
          );
          if (refundResult.success) this.storageAdapter.removeToken(baseUrl);
          else
            throw new ProviderError(
              baseUrl,
              status,
              "refund failed",
              requestId
            );
        } catch (error) {
          throw new ProviderError(
            baseUrl,
            status,
            "Failed to refund token",
            requestId
          );
        }
      } else if (this.mode === "apikeys") {
        console.log(
          `[RoutstrClient] _handleErrorResponse: Attempting API key refund for ${baseUrl}, key preview=${token}`
        );
        const initialBalance = await this.balanceManager.getTokenBalance(
          token,
          baseUrl
        );
        console.log(
          `[RoutstrClient] _handleErrorResponse: Initial API key balance: ${initialBalance.amount}`
        );
        const refundResult = await this.balanceManager.refundApiKey({
          mintUrl,
          baseUrl,
          apiKey: token,
        });
        console.log(
          `[RoutstrClient] _handleErrorResponse: API key refund result: success=${refundResult.success}, message=${refundResult.message}`
        );
        if (!refundResult.success && initialBalance.amount > 0) {
          throw new ProviderError(
            baseUrl,
            status,
            refundResult.message ?? "Unknown error"
          );
        } else {
          this.storageAdapter.removeApiKey(baseUrl); // TODO: remove this after all nodes upgrade to 0.4.0
        }
      }
    }

    this.providerManager.markFailed(baseUrl);
    console.log(
      `[RoutstrClient] _handleErrorResponse: Marked provider ${baseUrl} as failed`
    );

    if (!selectedModel) {
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
      console.log(
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

      console.log(
        `[RoutstrClient] _handleErrorResponse: Creating new token for failover provider ${nextProvider}, required sats: ${newRequiredSats}`
      );
      const spendResult = await this._spendToken({
        mintUrl,
        amount: newRequiredSats,
        baseUrl: nextProvider,
      });

      // Retry with new provider
      return this._makeRequest({
        ...params,
        path,
        method,
        body,
        baseUrl: nextProvider,
        selectedModel: newModel,
        token: spendResult.token!,
        requiredSats: newRequiredSats,
        headers: this._withAuthHeader(params.baseHeaders, spendResult.token!),
      });
    }

    // No more providers to try
    throw new FailoverError(baseUrl, Array.from(this.providerManager as any));
  }

  /**
   * Handle post-response balance update for all modes
   */
  private async _handlePostResponseBalanceUpdate(params: {
    token: string;
    baseUrl: string;
    initialTokenBalance: number;
    fallbackSatsSpent?: number;
    response?: Response;
  }): Promise<number> {
    const { token, baseUrl, initialTokenBalance, fallbackSatsSpent, response } =
      params;

    let satsSpent: number = initialTokenBalance;

    if (this.mode === "xcashu" && response) {
      const refundToken = response.headers.get("x-cashu") ?? undefined;
      if (refundToken) {
        try {
          const receiveResult =
            await this.walletAdapter.receiveToken(refundToken);
          satsSpent =
            initialTokenBalance -
            receiveResult.amount * (receiveResult.unit == "sat" ? 1 : 1000);
        } catch (error) {
          console.error("[xcashu] Failed to receive refund token:", error);
        }
      }
    } else if (this.mode === "lazyrefund") {
      const latestBalanceInfo = await this.balanceManager.getTokenBalance(
        token,
        baseUrl
      );
      const latestTokenBalance =
        latestBalanceInfo.unit === "msat"
          ? latestBalanceInfo.amount / 1000
          : latestBalanceInfo.amount;
      this.storageAdapter.updateTokenBalance(baseUrl, latestTokenBalance);
      satsSpent = initialTokenBalance - latestTokenBalance;
    } else if (this.mode === "apikeys") {
      try {
        const latestBalanceInfo = await this.balanceManager.getTokenBalance(
          token,
          baseUrl
        );
        console.log(
          "LATEST Balance",
          latestBalanceInfo.amount,
          latestBalanceInfo.reserved,
          latestBalanceInfo.apiKey,
          baseUrl
        );
        const latestTokenBalance =
          latestBalanceInfo.unit === "msat"
            ? latestBalanceInfo.amount / 1000
            : latestBalanceInfo.amount;
        this.storageAdapter.updateChildKeyBalance(baseUrl, latestTokenBalance);
        this.storageAdapter.updateApiKeyBalance(baseUrl, latestTokenBalance);
        satsSpent = initialTokenBalance - latestTokenBalance;
      } catch (e) {
        console.warn("Could not get updated API key balance:", e);
        satsSpent = fallbackSatsSpent ?? initialTokenBalance;
      }
    }

    return satsSpent;
  }

  /**
   * Convert messages for API format
   */
  private async _convertMessages(messages: Message[]): Promise<any[]> {
    return Promise.all(
      messages
        .filter((m) => m.role !== "system")
        .map(async (m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : m.content,
        }))
    );
  }

  /**
   * Create assistant message from streaming result
   */
  private async _createAssistantMessage(
    result: StreamingResult
  ): Promise<Message> {
    if (result.images && result.images.length > 0) {
      // Multimodal message with images
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

    // Simple text message
    return {
      role: "assistant",
      content: result.content || "",
    };
  }

  /**
   * Create a child key for a parent API key via the provider's API
   * POST /v1/balance/child-key
   */
  private async _createChildKey(
    baseUrl: string,
    parentApiKey: string,
    options?: {
      count?: number;
      balanceLimit?: number;
      balanceLimitReset?: string;
      validityDate?: number;
    }
  ): Promise<{
    childKey: string;
    balance: number;
    balanceLimit?: number;
    validityDate?: number;
  }> {
    const response = await fetch(`${baseUrl}v1/balance/child-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${parentApiKey}`,
      },
      body: JSON.stringify({
        count: options?.count ?? 1,
        balance_limit: options?.balanceLimit,
        balance_limit_reset: options?.balanceLimitReset,
        validity_date: options?.validityDate,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to create child key: ${response.status} ${await response.text()}`
      );
    }

    const data = await response.json();

    return {
      childKey: data.api_keys?.[0],
      balance: data.balance ?? 0,
      balanceLimit: data.balance_limit,
      validityDate: data.validity_date,
    };
  }

  /**
   * Calculate estimated costs from usage
   */
  private _getEstimatedCosts(
    selectedModel: Model,
    streamingResult: StreamingResult
  ): number {
    let estimatedCosts = 0;
    if (streamingResult.usage) {
      const { completion_tokens, prompt_tokens } = streamingResult.usage;
      if (completion_tokens !== undefined && prompt_tokens !== undefined) {
        estimatedCosts =
          (selectedModel.sats_pricing?.completion ?? 0) * completion_tokens +
          (selectedModel.sats_pricing?.prompt ?? 0) * prompt_tokens;
      }
    }
    return estimatedCosts;
  }

  /**
   * Get pending cashu token amount
   */
  private _getPendingCashuTokenAmount(): number {
    const distribution = this.storageAdapter.getCachedTokenDistribution();
    return distribution.reduce((total, item) => total + item.amount, 0);
  }

  /**
   * Check if error message indicates a network error
   */
  private _isNetworkError(message: string): boolean {
    return (
      message.includes("NetworkError when attempting to fetch resource") ||
      message.includes("Failed to fetch") ||
      message.includes("Load failed")
    );
  }

  /**
   * Handle errors and notify callbacks
   */
  private _handleError(error: unknown, callbacks: StreamingCallbacks): void {
    console.error("[RoutstrClient] _handleError: Error occurred", error);

    if (error instanceof Error) {
      const isStreamError =
        error.message.includes("Error in input stream") ||
        error.message.includes("Load failed");
      const modifiedErrorMsg = isStreamError
        ? "AI stream was cut off, turn on Keep Active or please try again"
        : error.message;

      console.error(
        `[RoutstrClient] _handleError: Error type=${error.constructor.name}, message=${modifiedErrorMsg}, isStreamError=${isStreamError}`
      );

      callbacks.onMessageAppend({
        role: "system",
        content:
          "Uncaught Error: " +
          modifiedErrorMsg +
          (this.alertLevel === "max" ? " | " + error.stack : ""),
      });
    } else {
      callbacks.onMessageAppend({
        role: "system",
        content: "Unknown Error: Please tag Routstr on Nostr and/or retry.",
      });
    }
  }

  /**
   * Check wallet balance and throw if insufficient
   */
  private async _checkBalance(): Promise<void> {
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
  }): Promise<{
    token: string;
    tokenBalance: number;
    tokenBalanceUnit: "sat" | "msat";
  }> {
    const { mintUrl, amount, baseUrl } = params;

    console.log(
      `[RoutstrClient] _spendToken: mode=${this.mode}, amount=${amount}, baseUrl=${baseUrl}, mintUrl=${mintUrl}`
    );

    if (this.mode === "apikeys") {
      let parentApiKey = this.storageAdapter.getApiKey(baseUrl);
      if (!parentApiKey) {
        console.log(
          `[RoutstrClient] _spendToken: No existing API key for ${baseUrl}, creating new one via Cashu`
        );
        const spendResult = await this.cashuSpender.spend({
          mintUrl: mintUrl,
          amount: amount * TOPUP_MARGIN,
          baseUrl: "",
          reuseToken: false,
        });

        if (!spendResult.token) {
          console.error(
            `[RoutstrClient] _spendToken: Failed to create Cashu token for API key creation, error:`,
            spendResult.error
          );
        } else {
          console.log(
            `[RoutstrClient] _spendToken: Cashu token created, token preview: ${spendResult.token}`
          );
        }

        const apiKeyCreated = await this.balanceManager.getTokenBalance(
          spendResult.token!,
          baseUrl
        );
        console.log(
          `[RoutstrClient] _spendToken: Created API key for ${baseUrl}, key preview: ${apiKeyCreated.apiKey}, balance: ${apiKeyCreated.amount}`
        );

        this.storageAdapter.setApiKey(baseUrl, apiKeyCreated.apiKey);
        parentApiKey = this.storageAdapter.getApiKey(baseUrl);
      } else {
        console.log(
          `[RoutstrClient] _spendToken: Using existing API key for ${baseUrl}, key preview: ${parentApiKey.key}`
        );
      }

      let tokenBalance = 0;
      let tokenBalanceUnit: "sat" | "msat" = "sat";

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
        } catch (e) {
          console.warn("Could not get initial API key balance:", e);
        }
      }

      console.log(
        `[RoutstrClient] _spendToken: Returning token with balance=${tokenBalance} ${tokenBalanceUnit}`
      );

      return {
        token: parentApiKey?.key ?? "",
        tokenBalance,
        tokenBalanceUnit,
      };
    }

    console.log(
      `[RoutstrClient] _spendToken: Calling CashuSpender.spend for amount=${amount}, mintUrl=${mintUrl}, mode=${this.mode}`
    );
    const spendResult = await this.cashuSpender.spend({
      mintUrl,
      amount,
      baseUrl: this.mode === "lazyrefund" ? baseUrl : "",
      reuseToken: this.mode === "lazyrefund",
    });

    if (!spendResult.token) {
      console.error(
        `[RoutstrClient] _spendToken: CashuSpender.spend failed, error:`,
        spendResult.error
      );
    } else {
      console.log(
        `[RoutstrClient] _spendToken: Cashu token created, token preview: ${spendResult.token}, balance: ${spendResult.balance} ${spendResult.unit ?? "sat"}`
      );
    }

    return {
      token: spendResult.token!,
      tokenBalance: spendResult.balance,
      tokenBalanceUnit: spendResult.unit ?? "sat",
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
}
