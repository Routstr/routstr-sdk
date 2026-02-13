/**
 * RefundManager - Handles refunding tokens from providers
 *
 * Handles:
 * - Fetching refund tokens from provider API
 * - Receiving/storing refunded tokens
 * - Error handling for various refund failure modes
 *
 * Extracted from utils/cashuUtils.ts
 */

import type { WalletAdapter, StorageAdapter } from "./interfaces";
import type { RefundResult } from "../core/types";
import { TokenOperationError } from "../core/errors";

/**
 * Options for refunding tokens
 */
export interface RefundOptions {
  /** The mint URL (for NIP-60 wallet operations) */
  mintUrl: string;

  /** The provider base URL */
  baseUrl: string;

  /** Optional specific token to refund (if not provided, uses stored token) */
  token?: string;
}

/**
 * RefundManager handles token refunds from providers
 */
export class RefundManager {
  constructor(
    private walletAdapter: WalletAdapter,
    private storageAdapter: StorageAdapter
  ) {}

  /**
   * Unified refund - handles both NIP-60 and legacy wallet refunds
   */
  async refund(options: RefundOptions): Promise<RefundResult> {
    const { mintUrl, baseUrl, token: providedToken } = options;
    console.log("[RefundManager] Starting refund", {
      mintUrl,
      baseUrl,
      hasProvidedToken: !!providedToken,
    });

    const storedToken = providedToken || this.storageAdapter.getToken(baseUrl);
    console.log("[RefundManager] Token lookup", {
      hasStoredToken: !!storedToken,
    });

    if (!storedToken) {
      console.log("[RefundManager] No token to refund, returning early");
      return { success: true, message: "No API key to refund" };
    }

    let fetchResult:
      | { success: boolean; token?: string; requestId?: string; error?: string }
      | undefined;

    try {
      console.log("[RefundManager] Fetching refund token from provider...");
      // Fetch refund token from provider
      fetchResult = await this._fetchRefundToken(baseUrl, storedToken);
      console.log("[RefundManager] Fetch result", {
        success: fetchResult.success,
        hasToken: !!fetchResult.token,
        requestId: fetchResult.requestId,
        error: fetchResult.error,
      });

      if (!fetchResult.success) {
        return {
          success: false,
          message: fetchResult.error || "Refund failed",
          requestId: fetchResult.requestId,
        };
      }

      if (!fetchResult.token) {
        return {
          success: false,
          message: "No token received from refund",
          requestId: fetchResult.requestId,
        };
      }

      // Check if this is a "no balance to refund" case
      if (fetchResult.error === "No balance to refund") {
        console.log(
          "[RefundManager] No balance to refund, removing stored token"
        );
        this.storageAdapter.removeToken(baseUrl);
        return { success: true, message: "No balance to refund" };
      }

      console.log("[RefundManager] Receiving refunded token into wallet...");
      // Receive the refunded token
      const receiveResult = await this.walletAdapter.receiveToken(
        fetchResult.token
      );
      const totalAmount = receiveResult.amount;
      console.log("[RefundManager] Token received", {
        success: receiveResult.success,
        totalAmount,
      });

      // Remove the stored token if we used it from storage
      if (!providedToken) {
        console.log("[RefundManager] Removing stored token for baseUrl");
        this.storageAdapter.removeToken(baseUrl);
      }

      console.log("[RefundManager] Refund complete", {
        refundedAmount: totalAmount,
      });
      return {
        success: receiveResult.success,
        refundedAmount: totalAmount,
        requestId: fetchResult.requestId,
      };
    } catch (error) {
      console.error("[RefundManager] Refund error", error);
      return this._handleRefundError(error, mintUrl, fetchResult?.requestId);
    }
  }

  /**
   * Fetch refund token from provider API
   */
  private async _fetchRefundToken(
    baseUrl: string,
    storedToken: string
  ): Promise<{
    success: boolean;
    token?: string;
    requestId?: string;
    error?: string;
  }> {
    console.log("[RefundManager._fetchRefundToken] Starting fetch", {
      baseUrl,
    });
    if (!baseUrl) {
      console.log("[RefundManager._fetchRefundToken] No base URL configured");
      return {
        success: false,
        error: "No base URL configured",
      };
    }

    const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

    const url = `${normalizedBaseUrl}v1/wallet/refund`;
    console.log("[RefundManager._fetchRefundToken] Request URL:", url);

    // Create an AbortController for timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(
        "[RefundManager._fetchRefundToken] Request timed out, aborting"
      );
      controller.abort();
    }, 60000); // 1 minute timeout

    try {
      console.log("[RefundManager._fetchRefundToken] Sending POST request...");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${storedToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const requestId =
        response.headers.get("x-routstr-request-id") || undefined;
      console.log("[RefundManager._fetchRefundToken] Response received", {
        status: response.status,
        ok: response.ok,
        requestId,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.log(
          "[RefundManager._fetchRefundToken] Error response",
          errorData
        );

        if (
          response.status === 400 &&
          errorData?.detail === "No balance to refund"
        ) {
          this.storageAdapter.removeToken(baseUrl);
          return {
            success: false,
            requestId,
            error: "No balance to refund",
          };
        }

        return {
          success: false,
          requestId,
          error: `Refund request failed with status ${response.status}: ${
            errorData?.detail || response.statusText
          }`,
        };
      }

      const data = await response.json();
      console.log("[RefundManager._fetchRefundToken] Success response", {
        hasToken: !!data.token,
      });
      return {
        success: true,
        token: data.token,
        requestId,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("[RefundManager._fetchRefundToken] Fetch error", error);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          return {
            success: false,
            error: "Request timed out after 1 minute",
          };
        }
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: false,
        error: "Unknown error occurred during refund request",
      };
    }
  }

  /**
   * Handle refund errors with specific error types
   */
  private _handleRefundError(
    error: unknown,
    mintUrl: string,
    requestId?: string
  ): RefundResult {
    if (error instanceof Error) {
      // Network errors
      if (
        error.message.includes(
          "NetworkError when attempting to fetch resource"
        ) ||
        error.message.includes("Failed to fetch") ||
        error.message.includes("Load failed")
      ) {
        return {
          success: false,
          message: `Failed to connect to the mint: ${mintUrl}`,
          requestId,
        };
      }

      // Wallet not found error
      if (error.message.includes("Wallet not found")) {
        return {
          success: false,
          message: `Wallet couldn't be loaded. Please save this refunded cashu token manually.`,
          requestId,
        };
      }

      return {
        success: false,
        message: error.message,
        requestId,
      };
    }

    return {
      success: false,
      message: "Refund failed",
      requestId,
    };
  }
}
