/**
 * Core types for the Routstr SDK
 * These types are shared across wallet and client modules
 */

import type { Message, TransactionHistory } from "@/types/chat";
import type { Model } from "@/types/models";

// Re-export for SDK internal use
export type { Message, TransactionHistory, Model };

/**
 * Result from spending cashu tokens
 */
export interface SpendResult {
  token: string | null;
  status: "success" | "failed";
  balance: number;
  error?: string;
}

/**
 * Result from refund operations
 */
export interface RefundResult {
  success: boolean;
  refundedAmount?: number;
  message?: string;
  requestId?: string;
}

/**
 * Token balance information
 */
export interface TokenBalance {
  amount: number;
  unit: "sat" | "msat";
}

/**
 * API error verdict for retry logic
 */
export interface APIErrorVerdict {
  retry: boolean;
  reason: string;
  newBaseUrl?: string; // New provider to retry with (for 50X errors)
}

/**
 * Image data from API response
 */
export interface ImageData {
  type: "image_url";
  image_url: {
    url: string;
  };
  index?: number;
}

/**
 * Annotation data from API response
 */
export interface AnnotationData {
  type: "url_citation";
  start_index: number;
  end_index: number;
  url: string;
  title: string;
}

/**
 * Usage statistics from API response
 */
export interface UsageStats {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Result from streaming response processing
 */
export interface StreamingResult {
  content: string;
  thinking?: string;
  images?: ImageData[];
  usage?: UsageStats;
  model?: string;
  finish_reason?: string;
  citations?: string[];
  annotations?: AnnotationData[];
}

/**
 * Parameters for fetching AI response
 */
export interface FetchAIResponseParams {
  messageHistory: Message[];
  selectedModel: Model;
  baseUrl: string;
  mintUrl: string;
  balance: number;
  transactionHistory: TransactionHistory[];
}

/**
 * Candidate provider for failover
 */
export interface CandidateProvider {
  baseUrl: string;
  model: Model;
  cost: number;
}

/**
 * Mint selection result
 */
export interface MintSelection {
  selectedMintUrl: string | null;
  selectedMintBalance: number;
}

/**
 * Pending token entry
 */
export interface PendingTokenEntry {
  baseUrl: string;
  amount: number;
}
