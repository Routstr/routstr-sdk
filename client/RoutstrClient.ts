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
import { RefundManager } from "../wallet/RefundManager";
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
}

/**
 * RoutstrClient is the main SDK entry point
 */
export class RoutstrClient {
  private cashuSpender: CashuSpender;
  private refundManager: RefundManager;
  private streamProcessor: StreamProcessor;
  private providerManager: ProviderManager;

  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter,
    private providerRegistry: ProviderRegistry
  ) {
    this.cashuSpender = new CashuSpender(
      walletAdapter,
      storageAdapter,
      providerRegistry
    );
    this.refundManager = new RefundManager(walletAdapter, storageAdapter);
    this.streamProcessor = new StreamProcessor();
    this.providerManager = new ProviderManager(providerRegistry);
  }

  /**
   * Get the CashuSpender instance
   */
  getCashuSpender(): CashuSpender {
    return this.cashuSpender;
  }

  /**
   * Get the RefundManager instance
   */
  getRefundManager(): RefundManager {
    return this.refundManager;
  }

  /**
   * Check if the client is currently busy (in critical section)
   */
  get isBusy(): boolean {
    return this.cashuSpender.isBusy;
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
    } = options;

    const initialBalance = this.walletAdapter.isUsingNip60()
      ? balance
      : this._getBalanceFromStoredProofs();

    // Convert messages for API
    const apiMessages = await this._convertMessages(messageHistory);

    // Calculate required amount
    const requiredSats = this.providerManager.getRequiredSatsForModel(
      selectedModel,
      apiMessages
    );

    let tokenBalance: number;
    let tokenBalanceUnit: "sat" | "msat" = "sat";

    try {
      // Spend tokens
      callbacks.onPaymentProcessing?.(true);
      console.log("Sending token worth: ", requiredSats);

      const spendResult = await this.cashuSpender.spend({
        mintUrl,
        amount: requiredSats,
        baseUrl,
        reuseToken: true,
      });

      if (spendResult.status === "failed" || !spendResult.token) {
        const errorMsg =
          spendResult.error ||
          `Insufficient balance. Need ${requiredSats} sats.`;

        if (this._isNetworkError(errorMsg)) {
          throw new Error(
            `Your mint ${mintUrl} is unreachable or is blocking your IP. Please try again later or switch mints.`
          );
        }

        throw new Error(errorMsg);
      }

      const token = spendResult.token;

      // Get token balance from wallet info
      const balanceInfo = await this._getTokenBalance(token, baseUrl);
      tokenBalance = balanceInfo.amount;
      tokenBalanceUnit = balanceInfo.unit;

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
          console.log(streamingResult);
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

        // Handle post-response refund
        const satsSpent = await this._handlePostResponseRefund({
          mintUrl,
          baseUrl: baseUrlUsed,
          tokenBalance,
          tokenBalanceUnit,
          initialBalance,
          selectedModel,
          streamingResult,
          callbacks,
          transactionHistory,
        });

        callbacks.onLastMessageSatsUpdate?.(satsSpent);
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
  }): Promise<Response> {
    const {
      apiMessages,
      selectedModel,
      baseUrl,
      mintUrl,
      token,
      requiredSats,
    } = params;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

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
    },
    token: string
  ): Promise<Response> {
    const { apiMessages, selectedModel, baseUrl, mintUrl, requiredSats } =
      params;
    const status = response.status;

    // Try to refund current token
    await this.refundManager.refund({
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
          apiMessages
        );

        // Spend new token for next provider
        const spendResult = await this.cashuSpender.spend({
          mintUrl,
          amount: newRequiredSats,
          baseUrl: nextProvider,
          reuseToken: true,
        });

        if (spendResult.status === "failed" || !spendResult.token) {
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
    }
  ): Promise<Response> {
    const { apiMessages, selectedModel, baseUrl, mintUrl } = params;

    // Refund current token
    await this.refundManager.refund({
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
      apiMessages
    );

    const spendResult = await this.cashuSpender.spend({
      mintUrl,
      amount: newRequiredSats,
      baseUrl: nextProvider,
      reuseToken: true,
    });

    if (spendResult.status === "failed" || !spendResult.token) {
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

    // Calculate estimated costs
    let estimatedCosts = 0;
    if (streamingResult.usage) {
      const { completion_tokens, prompt_tokens } = streamingResult.usage;
      if (completion_tokens !== undefined && prompt_tokens !== undefined) {
        estimatedCosts =
          (selectedModel.sats_pricing?.completion ?? 0) * completion_tokens +
          (selectedModel.sats_pricing?.prompt ?? 0) * prompt_tokens;
      }
    }

    // Perform refund
    const refundResult = await this.refundManager.refund({
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
      const isDev = process.env.NODE_ENV === "development";
      const isBeta =
        typeof window !== "undefined" &&
        (window.location.origin === "https://beta.chat.routstr.com" ||
          window.location.origin === "https://alpha.chat.routstr.com");

      if (isBeta || isDev) {
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
   * Get pending cashu token amount
   */
  private _getPendingCashuTokenAmount(): number {
    const distribution = this.storageAdapter.getPendingTokenDistribution();
    return distribution.reduce((total, item) => total + item.amount, 0);
  }

  /**
   * Get balance from stored proofs (legacy wallet)
   */
  private _getBalanceFromStoredProofs(): number {
    try {
      const storedProofs = localStorage.getItem("cashu_proofs");
      if (!storedProofs) return 0;

      const proofs = JSON.parse(storedProofs);
      return proofs.reduce(
        (total: number, proof: any) => total + proof.amount,
        0
      );
    } catch {
      return 0;
    }
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

    const isDev = process.env.NODE_ENV === "development";
    const isBeta =
      typeof window !== "undefined" &&
      (window.location.origin === "https://beta.chat.routstr.com" ||
        window.location.origin === "https://alpha.chat.routstr.com");

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
          (isDev || isBeta ? " | " + error.stack : ""),
      });
    } else {
      callbacks.onMessageAppend({
        role: "system",
        content: "Unknown Error: Please tag Routstr on Nostr and/or retry.",
      });
    }
  }
}
