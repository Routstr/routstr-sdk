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

import type { Message, TransactionHistory } from "@/types/chat";
import type { Model } from "@/types/models";
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
import type { StreamingResult, TokenBalance } from "../core/types";
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
}

/**
 * RoutstrClient is the main SDK entry point
 */
export type AlertLevel = "max" | "min";
export type RoutstrClientMode = "xcashu" | "lazyrefund" | "apikeys";

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
    this.balanceManager = new BalanceManager(walletAdapter, storageAdapter);
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

    console.log(
      `[RoutstrClient.routeRequest] path: ${path}, baseUrl: ${baseUrl}, mintUrl: ${mintUrl}`
    );

    await this._checkBalance();

    let requiredSats = 1;
    if (modelId) {
      const model = await this.providerManager.getModelForProvider(
        baseUrl,
        modelId
      );
      if (model) {
        requiredSats = this.providerManager.getRequiredSatsForModel(model, []);
      }
    }

    const { token, tokenBalance, tokenBalanceUnit } = await this._spendToken({
      mintUrl,
      amount: requiredSats,
      baseUrl,
    });

    let requestBody = body;
    if (body && typeof body === "object") {
      const bodyObj = body as Record<string, unknown>;
      if (!bodyObj.stream) {
        requestBody = { ...bodyObj, stream: false };
      }
    }

    const requestHeaders = this._buildRequestHeaders(headers, token);

    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (body && method !== "GET") {
      fetchOptions.body = JSON.stringify(requestBody);
    }

    console.log(
      `[RoutstrClient.routeRequest] Making fetch request to ${url}...`
    );
    const response = await fetch(url, fetchOptions);

    console.log(
      `[RoutstrClient.routeRequest] Response status: ${response.status}`
    );

    if (!response.ok) {
      await this.balanceManager.refund({ mintUrl, baseUrl, token });
      throw new ProviderError(baseUrl, response.status, await response.text());
    }

    if (this.mode === "xcashu") {
      const refundToken = response.headers.get("x-cashu") ?? undefined;
      const tokenBalanceInSats =
        tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;

      let satsSpent = tokenBalanceInSats;
      if (refundToken) {
        try {
          const receiveResult =
            await this.walletAdapter.receiveToken(refundToken);
          satsSpent =
            tokenBalanceInSats -
            receiveResult.amount * (receiveResult.unit == "sat" ? 1 : 1000);
          console.log("[xcashu] Received refund token from response");
        } catch (error) {
          console.error("[xcashu] Failed to receive refund token:", error);
        }
      }
      console.log(`[routeRequest] satsSpent: ${satsSpent}`);
    } else if (this.mode === "lazyrefund") {
      const latestBalanceInfo = await this._getTokenBalance(token, baseUrl);
      const latestTokenBalance =
        latestBalanceInfo.unit === "msat"
          ? latestBalanceInfo.amount / 1000
          : latestBalanceInfo.amount;
      this.storageAdapter.updateTokenBalance(baseUrl, latestTokenBalance);
      const tokenBalanceInSats =
        tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;
      const satsSpent = tokenBalanceInSats - latestTokenBalance;
      console.log(`[routeRequest] satsSpent (lazyrefund): ${satsSpent}`);
    } else if (this.mode === "apikeys") {
      try {
        const latestBalanceInfo = await this._getApiKeyBalance(baseUrl, token);
        const latestTokenBalance =
          latestBalanceInfo.unit === "msat"
            ? latestBalanceInfo.amount / 1000
            : latestBalanceInfo.amount;
        this.storageAdapter.updateChildKeyBalance(baseUrl, latestTokenBalance);
        const tokenBalanceInSats =
          tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;
        const satsSpent = tokenBalanceInSats - latestTokenBalance;
        console.log(`[routeRequest] satsSpent (apikeys): ${satsSpent}`);
      } catch (e) {
        console.warn("Could not get updated API key balance:", e);
      }
    }

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

      // Reset failed providers for new request
      this.providerManager.resetFailedProviders();

      // Make API request
      const response = await this._makeRequest({
        apiMessages,
        selectedModel,
        baseUrl,
        mintUrl,
        token,
        requiredSats,
        maxTokens,
      });

      if (response instanceof Response && (response as any).tokenBalance) {
        tokenBalance = (response as any).tokenBalance;
        tokenBalanceUnit = "sat";
      }

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
        let satsSpent: number;
        if (this.mode === "xcashu") {
          const refundToken = response.headers.get("x-cashu") ?? undefined;
          satsSpent = tokenBalanceInSats;
          if (refundToken) {
            try {
              const receiveResult =
                await this.walletAdapter.receiveToken(refundToken);
              satsSpent =
                tokenBalanceInSats -
                receiveResult.amount * (receiveResult.unit == "sat" ? 1 : 1000);
              console.log("[xcashu] Received refund token from response");
            } catch (error) {
              console.error("[xcashu] Failed to receive refund token:", error);
            }
          }
        } else if (this.mode === "lazyrefund") {
          const latestBalanceInfo = await this._getTokenBalance(
            token,
            baseUrlUsed
          );
          const latestTokenBalance =
            latestBalanceInfo.unit === "msat"
              ? latestBalanceInfo.amount / 1000
              : latestBalanceInfo.amount;
          this.storageAdapter.updateTokenBalance(
            baseUrlUsed,
            latestTokenBalance
          );
          satsSpent = tokenBalanceInSats - latestTokenBalance;
        } else if (this.mode === "apikeys") {
          // For apikeys mode, get updated balance from provider (no refund needed)
          try {
            const latestBalanceInfo = await this._getApiKeyBalance(
              baseUrlUsed,
              token
            );
            const latestTokenBalance =
              latestBalanceInfo.unit === "msat"
                ? latestBalanceInfo.amount / 1000
                : latestBalanceInfo.amount;
            this.storageAdapter.updateChildKeyBalance(
              baseUrlUsed,
              latestTokenBalance
            );
            satsSpent = tokenBalanceInSats - latestTokenBalance;
          } catch (e) {
            console.warn("Could not get updated API key balance:", e);
            // Estimate based on usage
            satsSpent = this._getEstimatedCosts(selectedModel, streamingResult);
          }
        } else {
          satsSpent = await this._handlePostResponseRefund({
            mintUrl,
            baseUrl: baseUrlUsed,
            tokenBalance,
            tokenBalanceUnit,
            initialBalance: balance,
            selectedModel,
            streamingResult,
            callbacks,
            transactionHistory,
          });
        }
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
    apiMessages: any[];
    selectedModel: Model;
    baseUrl: string;
    mintUrl: string;
    token: string;
    requiredSats: number;
    maxTokens?: number;
  }): Promise<Response> {
    const {
      apiMessages,
      selectedModel,
      baseUrl,
      mintUrl,
      token,
      requiredSats,
      maxTokens,
    } = params;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.mode === "xcashu") {
      headers["X-Cashu"] = token;
    } else {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // Dev-only mock controls
    if (
      typeof window !== "undefined" &&
      process.env.NODE_ENV === "development"
    ) {
      try {
        const scenario = window.localStorage.getItem("msw:scenario");
        const latency = window.localStorage.getItem("msw:latency");
        if (scenario) headers["X-Mock-Scenario"] = scenario;
        if (latency) headers["X-Mock-Latency"] = latency;
      } catch {}
    }

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

    try {
      const response = await fetch(`${baseUrl}v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      (response as any).baseUrl = baseUrl;

      if (!response.ok) {
        return await this._handleErrorResponse(response, params, token);
      }

      return response;
    } catch (error: any) {
      // Handle network errors with failover
      if (this._isNetworkError(error?.message || "")) {
        return await this._handleNetworkError(error, params);
      }
      throw error;
    }
  }

  /**
   * Handle error responses with failover
   */
  private async _handleErrorResponse(
    response: Response,
    params: {
      apiMessages: any[];
      selectedModel: Model;
      baseUrl: string;
      mintUrl: string;
      token: string;
      requiredSats: number;
      maxTokens?: number;
    },
    token: string
  ): Promise<Response> {
    const {
      apiMessages,
      selectedModel,
      baseUrl,
      mintUrl,
      requiredSats,
      maxTokens,
    } = params;
    const status = response.status;

    // Handle apikeys mode differently - no refund needed
    if (this.mode === "apikeys") {
      // Remove invalid child key
      this.storageAdapter.removeChildKey(baseUrl);

      // For auth errors, try with a new child key
      if (status === 401 || status === 403) {
        const parentApiKey = this.storageAdapter.getApiKey(baseUrl);
        if (parentApiKey) {
          try {
            const childKeyResult = await this._createChildKey(
              baseUrl,
              parentApiKey
            );
            this.storageAdapter.setChildKey(
              baseUrl,
              childKeyResult.childKey,
              childKeyResult.balance,
              childKeyResult.validityDate,
              childKeyResult.balanceLimit
            );
            // Retry with new child key
            return this._makeRequest({
              ...params,
              token: childKeyResult.childKey,
            });
          } catch (e) {
            console.error("Failed to create new child key:", e);
          }
        }
      }
      throw new ProviderError(baseUrl, status, await response.text());
    }

    // Try to refund current token
    await this.balanceManager.refund({
      mintUrl,
      baseUrl,
      token,
    });

    // Mark current provider as failed
    this.providerManager.markFailed(baseUrl);
    this.storageAdapter.removeToken(baseUrl);

    // Find next best provider for retryable errors
    if (
      status === 401 ||
      status === 403 ||
      status === 402 ||
      status === 413 ||
      status === 400 ||
      status === 500 ||
      status === 502
    ) {
      const nextProvider = this.providerManager.findNextBestProvider(
        selectedModel.id,
        baseUrl
      );

      if (nextProvider) {
        // Get new model for this provider
        const newModel =
          (await this.providerManager.getModelForProvider(
            nextProvider,
            selectedModel.id
          )) ?? selectedModel;

        const newRequiredSats = this.providerManager.getRequiredSatsForModel(
          newModel,
          apiMessages,
          maxTokens
        );

        // Spend new token for next provider
        const spendResult = await this.cashuSpender.spend({
          mintUrl,
          amount: newRequiredSats,
          baseUrl: nextProvider,
          reuseToken: true,
        });

        if (spendResult.status === "failed" || !spendResult.token) {
          if (spendResult.errorDetails) {
            throw new InsufficientBalanceError(
              spendResult.errorDetails.required,
              spendResult.errorDetails.available,
              spendResult.errorDetails.maxMintBalance,
              spendResult.errorDetails.maxMintUrl
            );
          }
          throw new Error(
            spendResult.error || `Insufficient balance for ${nextProvider}`
          );
        }

        // Retry with new provider
        return this._makeRequest({
          ...params,
          baseUrl: nextProvider,
          selectedModel: newModel,
          token: spendResult.token,
          requiredSats: newRequiredSats,
        });
      }
    }

    // No more providers to try
    throw new ProviderError(baseUrl, status, await response.text());
  }

  /**
   * Handle network errors with failover
   */
  private async _handleNetworkError(
    error: Error,
    params: {
      apiMessages: any[];
      selectedModel: Model;
      baseUrl: string;
      mintUrl: string;
      token: string;
      requiredSats: number;
      maxTokens?: number;
    }
  ): Promise<Response> {
    const { apiMessages, selectedModel, baseUrl, mintUrl, maxTokens } = params;

    // Refund current token
    await this.balanceManager.refund({
      mintUrl,
      baseUrl,
      token: params.token,
    });

    // Mark provider as failed
    this.providerManager.markFailed(baseUrl);

    // Find next provider
    const nextProvider = this.providerManager.findNextBestProvider(
      selectedModel.id,
      baseUrl
    );

    if (!nextProvider) {
      throw new FailoverError(baseUrl, Array.from(this.providerManager as any));
    }

    // Get new model and spend token
    const newModel =
      (await this.providerManager.getModelForProvider(
        nextProvider,
        selectedModel.id
      )) ?? selectedModel;

    const newRequiredSats = this.providerManager.getRequiredSatsForModel(
      newModel,
      apiMessages,
      maxTokens
    );

    const spendResult = await this.cashuSpender.spend({
      mintUrl,
      amount: newRequiredSats,
      baseUrl: nextProvider,
      reuseToken: true,
    });

    if (spendResult.status === "failed" || !spendResult.token) {
      if (spendResult.errorDetails) {
        throw new InsufficientBalanceError(
          spendResult.errorDetails.required,
          spendResult.errorDetails.available,
          spendResult.errorDetails.maxMintBalance,
          spendResult.errorDetails.maxMintUrl
        );
      }
      throw new Error(
        spendResult.error || `Insufficient balance for ${nextProvider}`
      );
    }

    // Retry
    return this._makeRequest({
      ...params,
      baseUrl: nextProvider,
      selectedModel: newModel,
      token: spendResult.token,
      requiredSats: newRequiredSats,
    });
  }

  /**
   * Handle post-response refund and balance updates
   */
  private async _handlePostResponseRefund(params: {
    mintUrl: string;
    baseUrl: string;
    tokenBalance: number;
    tokenBalanceUnit: "sat" | "msat";
    initialBalance: number;
    selectedModel: Model;
    streamingResult: StreamingResult;
    callbacks: StreamingCallbacks;
    transactionHistory: TransactionHistory[];
  }): Promise<number> {
    const {
      mintUrl,
      baseUrl,
      tokenBalance,
      tokenBalanceUnit,
      initialBalance,
      selectedModel,
      streamingResult,
      callbacks,
    } = params;

    const tokenBalanceInSats =
      tokenBalanceUnit === "msat" ? tokenBalance / 1000 : tokenBalance;

    const estimatedCosts = this._getEstimatedCosts(
      selectedModel,
      streamingResult
    );

    // Perform refund
    const refundResult = await this.balanceManager.refund({
      mintUrl,
      baseUrl,
    });

    if (refundResult.success) {
      const refundedSats =
        refundResult.refundedAmount !== undefined
          ? refundResult.refundedAmount / 1000
          : 0;
    }

    let satsSpent: number;

    if (refundResult.success) {
      if (refundResult.refundedAmount !== undefined) {
        satsSpent = tokenBalanceInSats - refundResult.refundedAmount / 1000;
      } else if (refundResult.message?.includes("No API key to refund")) {
        satsSpent = 0;
      } else {
        satsSpent = tokenBalanceInSats;
      }

      // Update balance
      const newBalance = initialBalance - satsSpent;
      callbacks.onBalanceUpdate(newBalance);
    } else {
      // Refund failed
      if (
        refundResult.message?.includes("Refund request failed with status 401")
      ) {
        this.storageAdapter.removeToken(baseUrl);
      }
      satsSpent = tokenBalanceInSats;
    }

    // Check for overcharge
    const netCosts = satsSpent - estimatedCosts;
    const overchargeThreshold = tokenBalanceUnit === "msat" ? 0.05 : 1;

    if (netCosts > overchargeThreshold) {
      if (this.alertLevel === "max") {
        callbacks.onMessageAppend({
          role: "system",
          content: `ATTENTION: Provider may be overcharging. Estimated: ${estimatedCosts.toFixed(
            tokenBalanceUnit === "msat" ? 3 : 0
          )}, Actual: ${satsSpent.toFixed(
            tokenBalanceUnit === "msat" ? 3 : 0
          )}`,
        });
      }
    }

    // Record transaction
    const newTransaction: TransactionHistory = {
      type: "spent",
      amount: satsSpent,
      timestamp: Date.now(),
      status: "success",
      model: selectedModel.id,
      message: "Tokens spent",
      balance: initialBalance - satsSpent,
    };

    // Update transaction history (caller should persist this)
    callbacks.onTransactionUpdate(newTransaction);

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
   * Get token balance from provider
   */
  private async _getTokenBalance(
    token: string,
    baseUrl: string
  ): Promise<TokenBalance> {
    try {
      const response = await fetch(`${baseUrl}v1/wallet/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        return {
          amount: data.balance,
          unit: "msat", // wallet/info returns msats
        };
      }
    } catch {
      // Fall through to default
    }

    return { amount: 0, unit: "sat" };
  }

  /**
   * Derive a child key from the main API key for parallel requests
   * Uses timestamp to ensure uniqueness while keeping related requests traceable
   */
  private _deriveChildKey(apiKey: string): string {
    // Format: originalKey_timestamp
    const timestamp = Date.now();
    return `${apiKey}_${timestamp}`;
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
      childKey: data.key ?? data.keys?.[0],
      balance: data.balance ?? 0,
      balanceLimit: data.balance_limit,
      validityDate: data.validity_date,
    };
  }

  /**
   * Get balance for an API key from the provider
   */
  private async _getApiKeyBalance(
    baseUrl: string,
    apiKey: string
  ): Promise<TokenBalance> {
    try {
      const response = await fetch(`${baseUrl}v1/wallet/info`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        return {
          amount: data.balance,
          unit: "msat",
        };
      }
    } catch {
      // Fall through to default
    }

    return { amount: 0, unit: "sat" };
  }

  /**
   * Calculate estimated costs from usage
   */
  private _getEstimatedCosts(
    selectedModel: Model,
    streamingResult: StreamingResult
  ): number {
    let estimatedCosts = 0;
    console.log(streamingResult);
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
    const distribution = this.storageAdapter.getPendingTokenDistribution();
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
    console.error("RoutstrClient error:", error);

    if (error instanceof Error) {
      const modifiedErrorMsg =
        error.message.includes("Error in input stream") ||
        error.message.includes("Load failed")
          ? "AI stream was cut off, turn on Keep Active or please try again"
          : error.message;

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

    if (this.mode === "apikeys") {
      let parentApiKey = this.storageAdapter.getApiKey(baseUrl);
      if (!parentApiKey) {
        throw new Error(
          `No API key found for ${baseUrl}. Please add an API key first.`
        );
      }

      let childKeyEntry = this.storageAdapter.getChildKey(baseUrl);

      if (!childKeyEntry) {
        try {
          const childKeyResult = await this._createChildKey(
            baseUrl,
            parentApiKey
          );
          this.storageAdapter.setChildKey(
            baseUrl,
            childKeyResult.childKey,
            childKeyResult.balance,
            childKeyResult.validityDate,
            childKeyResult.balanceLimit
          );
          childKeyEntry = {
            parentBaseUrl: baseUrl,
            childKey: childKeyResult.childKey,
            balance: childKeyResult.balance,
            balanceLimit: childKeyResult.balanceLimit,
            validityDate: childKeyResult.validityDate,
            createdAt: Date.now(),
          };
        } catch (e) {
          console.warn("Could not create child key, using parent key:", e);
          childKeyEntry = {
            parentBaseUrl: baseUrl,
            childKey: parentApiKey,
            balance: 0,
            createdAt: Date.now(),
          };
        }
      }

      let tokenBalance = childKeyEntry.balance;
      let tokenBalanceUnit: "sat" | "msat" = "sat";

      if (tokenBalance === 0) {
        try {
          const balanceInfo = await this._getApiKeyBalance(
            baseUrl,
            childKeyEntry.childKey
          );
          tokenBalance = balanceInfo.amount;
          tokenBalanceUnit = balanceInfo.unit;
        } catch (e) {
          console.warn("Could not get initial API key balance:", e);
        }
      }

      return {
        token: childKeyEntry.childKey,
        tokenBalance,
        tokenBalanceUnit,
      };
    }

    console.log(`[RoutstrClient] Spending ${amount} sats for token...`);

    const spendResult = await this.cashuSpender.spend({
      mintUrl,
      amount,
      baseUrl,
      reuseToken: true,
    });

    if (spendResult.status === "failed" || !spendResult.token) {
      const errorMsg =
        spendResult.error || `Insufficient balance. Need ${amount} sats.`;

      if (this._isNetworkError(errorMsg)) {
        throw new Error(
          `Your mint ${mintUrl} is unreachable or is blocking your IP. Please try again later or switch mints.`
        );
      }

      if (spendResult.errorDetails) {
        throw new InsufficientBalanceError(
          spendResult.errorDetails.required,
          spendResult.errorDetails.available,
          spendResult.errorDetails.maxMintBalance,
          spendResult.errorDetails.maxMintUrl
        );
      }

      throw new Error(errorMsg);
    }

    return {
      token: spendResult.token,
      tokenBalance: spendResult.balance,
      tokenBalanceUnit: spendResult.unit ?? "sat",
    };
  }

  /**
   * Build request headers with common defaults and dev mock controls
   */
  private _buildRequestHeaders(
    additionalHeaders: Record<string, string> = {},
    token?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...additionalHeaders,
      "Content-Type": "application/json",
    };

    if (token) {
      if (this.mode === "xcashu") {
        headers["X-Cashu"] = token;
      } else {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    if (
      typeof window !== "undefined" &&
      process.env.NODE_ENV === "development"
    ) {
      try {
        const scenario = window.localStorage.getItem("msw:scenario");
        const latency = window.localStorage.getItem("msw:latency");
        if (scenario) headers["X-Mock-Scenario"] = scenario;
        if (latency) headers["X-Mock-Latency"] = latency;
      } catch {}
    }

    return headers;
  }
}
