/**
 * Interfaces for the model and provider discovery system
 * These abstractions allow the discovery logic to be independent of storage implementation
 */

import type { Model, ProviderInfo } from "@/sdk/core";
export { ProviderInfo };

/**
 * Discovery adapter for managing cached provider and model data
 * Abstracts localStorage operations so discovery logic is testable and reusable
 */
export interface DiscoveryAdapter {
  /**
   * Get cached models from all providers
   * @returns Record mapping baseUrl -> array of models
   */
  getCachedModels(): Record<string, Model[]>;

  /**
   * Save models cache
   * @param models Record mapping baseUrl -> array of models
   */
  setCachedModels(models: Record<string, Model[]>): void;

  /**
   * Get cached mints from all providers
   * @returns Record mapping baseUrl -> array of mint URLs
   */
  getCachedMints(): Record<string, string[]>;

  /**
   * Save mints cache
   * @param mints Record mapping baseUrl -> array of mint URLs
   */
  setCachedMints(mints: Record<string, string[]>): void;

  /**
   * Get cached provider info from all providers
   * @returns Record mapping baseUrl -> provider info object
   */
  getCachedProviderInfo(): Record<string, ProviderInfo>;

  /**
   * Save provider info cache
   * @param info Record mapping baseUrl -> provider info object
   */
  setCachedProviderInfo(info: Record<string, ProviderInfo>): void;

  /**
   * Get provider last update timestamp
   * @param baseUrl Provider base URL
   * @returns Timestamp in milliseconds or null if never updated
   */
  getProviderLastUpdate(baseUrl: string): number | null;

  /**
   * Set provider last update timestamp
   * @param baseUrl Provider base URL
   * @param timestamp Timestamp in milliseconds
   */
  setProviderLastUpdate(baseUrl: string, timestamp: number): void;

  /**
   * Get last used model ID
   * @returns Model ID or null if none
   */
  getLastUsedModel(): string | null;

  /**
   * Save last used model ID
   * @param modelId Model ID to save
   */
  setLastUsedModel(modelId: string): void;

  /**
   * Get model -> provider base URL mapping
   * @returns Record mapping modelId -> baseUrl (for best-price winner)
   */
  getModelProviderMap(): Record<string, string>;

  /**
   * Save model -> provider mapping
   * @param map Record mapping modelId -> baseUrl
   */
  setModelProviderMap(map: Record<string, string>): void;

  /**
   * Get list of disabled provider base URLs
   * @returns Array of disabled provider URLs
   */
  getDisabledProviders(): string[];

  /**
   * Get list of configured provider base URLs
   * @returns Array of provider base URLs
   */
  getBaseUrlsList(): string[];

  /**
   * Get base URLs list last update timestamp
   * @returns Timestamp in milliseconds or null if never updated
   */
  getBaseUrlsLastUpdate(): number | null;

  /**
   * Save list of provider base URLs
   * @param urls Array of provider base URLs
   */
  setBaseUrlsList(urls: string[]): void;

  /**
   * Set base URLs list last update timestamp
   * @param timestamp Timestamp in milliseconds
   */
  setBaseUrlsLastUpdate(timestamp: number): void;
}
