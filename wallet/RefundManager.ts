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

    const storedToken = providedToken || this.storageAdapter.getToken(baseUrl);

    if (!storedToken) {
      return { success: true, message: "No API key to refund" };
    }

    try {
      // Fetch refund token from provider
      const refundResult = await this._fetchRefundToken(baseUrl, storedToken);

      if (!refundResult.success) {
        return {
          success: false,
          message: refundResult.error || "Refund failed",
          requestId: refundResult.requestId,
        };
      }

      if (!refundResult.token) {
        return {
          success: false,
          message: "No token received from refund",
          requestId: refundResult.requestId,
        };
      }

      // Check if this is a "no balance to refund" case
      if (refundResult.error === "No balance to refund") {
        this.storageAdapter.removeToken(baseUrl);
        return { success: true, message: "No balance to refund" };
      }

      // Receive the refunded token
      const proofs = await this.walletAdapter.receiveToken(refundResult.token);

      // Calculate total amount received
      const totalAmount = proofs.reduce((sum, p: any) => sum + p.amount, 0);

      // Remove the stored token if we used it from storage
      if (!providedToken) {
        this.storageAdapter.removeToken(baseUrl);
      }

      return {
        success: true,
        refundedAmount: totalAmount,
        requestId: refundResult.requestId,
      };
    } catch (error) {
      return this._handleRefundError(error, mintUrl, refundResult?.requestId);
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
    if (!baseUrl) {
      return {
        success: false,
        error: "No base URL configured",
      };
    }

    const normalizedBaseUrl = baseUrl.endsWith("/")
      ? baseUrl
      : `${baseUrl}/`;

    // Create an AbortController for timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 60000); // 1 minute timeout

    try {
      const response = await fetch(`${normalizedBaseUrl}v1/wallet/refund`, {
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

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

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
      return {
        success: true,
        token: data.token,
        requestId,
      };
    } catch (error) {
      clearTimeout(timeoutId);

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
