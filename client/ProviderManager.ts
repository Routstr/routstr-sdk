/**
 * ProviderManager - Handles provider selection and failover logic
 *
 * Handles:
 * - Finding the best provider for a model based on price
 * - Provider failover when errors occur
 * - Tracking failed providers to avoid retry loops
 * - Provider version compatibility
 *
 * Extracted from utils/apiUtils.ts findNextBestProvider and related logic
 */

import type { ProviderRegistry } from "../wallet/interfaces";
import type { Model } from "../core/types";
import { isOnionUrl, isTorContext } from "@/utils/torUtils";

/**
 * Candidate provider for failover
 */
interface CandidateProvider {
  baseUrl: string;
  model: Model;
  cost: number;
}

/**
 * ProviderManager handles provider selection and failover
 */
export class ProviderManager {
  private failedProviders = new Set<string>();

  constructor(private providerRegistry: ProviderRegistry) {}

  /**
   * Reset the failed providers list
   */
  resetFailedProviders(): void {
    this.failedProviders.clear();
  }

  /**
   * Mark a provider as failed
   */
  markFailed(baseUrl: string): void {
    this.failedProviders.add(baseUrl);
  }

  /**
   * Check if a provider has failed
   */
  hasFailed(baseUrl: string): boolean {
    return this.failedProviders.has(baseUrl);
  }

  /**
   * Find the next best provider for a model
   * @param modelId The model ID to find a provider for
   * @param currentBaseUrl The current provider to exclude
   * @returns The best provider URL or null if none available
   */
  findNextBestProvider(
    modelId: string,
    currentBaseUrl: string
  ): string | null {
    try {
      const torMode = isTorContext();
      const disabledProviders = new Set(
        this.providerRegistry.getDisabledProviders()
      );

      // Get all providers with their models
      const allProviders = this.providerRegistry.getAllProvidersModels();

      // Find all candidate providers
      const candidates: CandidateProvider[] = [];

      for (const [baseUrl, models] of Object.entries(allProviders)) {
        // Skip current, failed, and disabled providers
        if (
          baseUrl === currentBaseUrl ||
          this.failedProviders.has(baseUrl) ||
          disabledProviders.has(baseUrl)
        ) {
          continue;
        }

        // Skip onion URLs if not in Tor mode
        if (!torMode && isOnionUrl(baseUrl)) {
          continue;
        }

        // Find the model in this provider's list
        const model = models.find((m: Model) => m.id === modelId);
        if (!model) continue;

        // Calculate cost (using completion price as the metric)
        const cost = model.sats_pricing?.completion ?? 0;
        candidates.push({ baseUrl, model, cost });
      }

      // Sort by price (lowest first)
      candidates.sort((a, b) => a.cost - b.cost);

      return candidates.length > 0 ? candidates[0].baseUrl : null;
    } catch (error) {
      console.error("Error finding next best provider:", error);
      return null;
    }
  }

  /**
   * Find the best model for a provider
   * Useful when switching providers and need to find equivalent model
   */
  async getModelForProvider(
    baseUrl: string,
    modelId: string
  ): Promise<Model | null> {
    // Get models for this provider
    const models = this.providerRegistry.getModelsForProvider(baseUrl);

    // First try exact match
    const exactMatch = models.find((m) => m.id === modelId);
    if (exactMatch) return exactMatch;

    // Try matching by ID suffix (for backward compatibility with v0.1.x providers)
    const providerInfo = await this.providerRegistry.getProviderInfo(baseUrl);
    if (providerInfo?.version && /^0\.1\./.test(providerInfo.version)) {
      const suffix = modelId.split("/").pop();
      const suffixMatch = models.find((m) => m.id === suffix);
      if (suffixMatch) return suffixMatch;
    }

    return null;
  }

  /**
   * Get all available providers for a model
   * Returns sorted list by price
   */
  getAllProvidersForModel(modelId: string): Array<{
    baseUrl: string;
    model: Model;
    cost: number;
  }> {
    const candidates: CandidateProvider[] = [];
    const allProviders = this.providerRegistry.getAllProvidersModels();
    const disabledProviders = new Set(
      this.providerRegistry.getDisabledProviders()
    );
    const torMode = isTorContext();

    for (const [baseUrl, models] of Object.entries(allProviders)) {
      if (disabledProviders.has(baseUrl)) continue;
      if (!torMode && isOnionUrl(baseUrl)) continue;

      const model = models.find((m: Model) => m.id === modelId);
      if (!model) continue;

      const cost = model.sats_pricing?.completion ?? 0;
      candidates.push({ baseUrl, model, cost });
    }

    return candidates.sort((a, b) => a.cost - b.cost);
  }

  /**
   * Check if a provider accepts a specific mint
   */
  providerAcceptsMint(baseUrl: string, mintUrl: string): boolean {
    const providerMints = this.providerRegistry.getProviderMints(baseUrl);
    if (providerMints.length === 0) {
      // If no mints specified, provider accepts all
      return true;
    }
    return providerMints.includes(mintUrl);
  }

  /**
   * Get required sats for a model based on message history
   * Simple estimation based on typical usage
   */
  getRequiredSatsForModel(model: Model, apiMessages: any[]): number {
    // Estimate prompt tokens (rough approximation)
    const estimatedPromptTokens = apiMessages.reduce((total, msg) => {
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      // Rough estimate: 4 chars per token
      return total + Math.ceil(content.length / 4);
    }, 0);

    // Calculate required sats (prompt + some completion allowance)
    const promptSats =
      (model.sats_pricing?.prompt ?? 0) * estimatedPromptTokens;
    const completionSats =
      (model.sats_pricing?.completion ?? 0) * 500; // Assume 500 tokens completion

    return Math.ceil(promptSats + completionSats);
  }
}
