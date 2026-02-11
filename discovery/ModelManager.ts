/**
 * ModelManager class for discovering, fetching, and managing models from providers
 * Core responsibility: fetching models from providers, caching them, and selecting the best option
 * (lowest cost) across multiple providers
 */

import type { Model } from "@/types/models";
import type { DiscoveryAdapter, ProviderInfo } from "./interfaces";
import {
  NoProvidersAvailableError,
  ProviderBootstrapError,
} from "@/sdk/core/errors";

/**
 * Configuration for ModelManager
 */
export interface ModelManagerConfig {
  /** URL to fetch provider directory from */
  providerDirectoryUrl?: string;
  /** Additional provider base URLs to include */
  includeProviderUrls?: string[];
  /** Provider base URLs to exclude */
  excludeProviderUrls?: string[];
  /** Cache TTL in milliseconds (default: 21 minutes) */
  cacheTTL?: number;
}

export interface ModelProviderPrice {
  baseUrl: string;
  model: Model;
  promptPerMillion: number;
  completionPerMillion: number;
  totalPerMillion: number;
}

/**
 * ModelManager handles all model discovery and caching logic
 * Abstracts away storage details via DiscoveryAdapter
 */
export class ModelManager {
  private readonly cacheTTL: number;
  private readonly providerDirectoryUrl: string;
  private readonly includeProviderUrls: string[];
  private readonly excludeProviderUrls: string[];

  constructor(
    private adapter: DiscoveryAdapter,
    config: ModelManagerConfig = {}
  ) {
    this.providerDirectoryUrl =
      config.providerDirectoryUrl || "https://api.routstr.com/v1/providers/";
    this.cacheTTL = config.cacheTTL || 21 * 60 * 1000; // 21 minutes
    this.includeProviderUrls = config.includeProviderUrls || [];
    this.excludeProviderUrls = config.excludeProviderUrls || [];
  }

  static async init(
    adapter: DiscoveryAdapter,
    config: ModelManagerConfig = {},
    options: { torMode?: boolean; forceRefresh?: boolean } = {}
  ): Promise<ModelManager> {
    const manager = new ModelManager(adapter, config);
    const torMode = options.torMode ?? false;
    const forceRefresh = options.forceRefresh ?? false;
    const providers = await manager.bootstrapProviders(torMode);
    await manager.fetchModels(providers, forceRefresh);
    return manager;
  }

  /**
   * Bootstrap provider list from the provider directory
   * Fetches available providers and caches their base URLs
   * @param torMode Whether running in Tor context
   * @returns Array of provider base URLs
   * @throws ProviderBootstrapError if all providers fail to fetch
   */
  async bootstrapProviders(torMode: boolean = false): Promise<string[]> {
    try {
      // First check if we already have cached providers
      const cachedUrls = this.adapter.getBaseUrlsList();
      if (cachedUrls.length > 0) {
        const lastUpdate = this.adapter.getBaseUrlsLastUpdate();
        const cacheValid =
          lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;
        if (cacheValid) {
          return this.filterBaseUrlsForTor(cachedUrls, torMode);
        }
      }

      // Fetch from provider directory
      const res = await fetch(this.providerDirectoryUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch providers: ${res.status}`);
      }

      const data = await res.json();
      const providers = Array.isArray(data?.providers) ? data.providers : [];

      // Extract endpoints from providers
      const bases = new Set<string>();
      for (const p of providers) {
        const endpoints = this.getProviderEndpoints(p, torMode);
        for (const endpoint of endpoints) {
          bases.add(endpoint);
        }
      }

      // Add additional configured providers
      for (const url of this.includeProviderUrls) {
        const normalized = this.normalizeUrl(url);
        if (!torMode || normalized.includes(".onion")) {
          bases.add(normalized);
        }
      }

      const excluded = new Set(
        this.excludeProviderUrls.map((url) => this.normalizeUrl(url))
      );

      const list = Array.from(bases).filter((base) => {
        if (excluded.has(base)) return false;
        return true;
      });

      if (list.length > 0) {
        this.adapter.setBaseUrlsList(list);
        this.adapter.setBaseUrlsLastUpdate(Date.now());
      }

      return list;
    } catch (e) {
      console.error("Failed to bootstrap providers", e);
      throw new ProviderBootstrapError([], `Provider bootstrap failed: ${e}`);
    }
  }

  /**
   * Fetch models from all providers and select best-priced options
   * Uses cache if available and not expired
   * @param baseUrls List of provider base URLs to fetch from
   * @param forceRefresh Ignore cache and fetch fresh data
   * @returns Array of unique models with best prices selected
   */
  async fetchModels(
    baseUrls: string[],
    forceRefresh: boolean = false
  ): Promise<Model[]> {
    if (baseUrls.length === 0) {
      throw new NoProvidersAvailableError();
    }

    const bestById = new Map<string, { model: Model; base: string }>();
    const modelsFromAllProviders: Record<string, Model[]> = {};
    const disabledProviders = this.adapter.getDisabledProviders();

    // Helper to estimate minimum cost for a model
    const estimateMinCost = (m: Model): number => {
      return m?.sats_pricing?.completion ?? 0;
    };

    // Fetch from all providers in parallel
    const fetchPromises = baseUrls.map(async (url) => {
      const base = url.endsWith("/") ? url : `${url}/`;
      try {
        // Check cache if not forcing refresh
        let list: Model[];

        if (!forceRefresh) {
          const lastUpdate = this.adapter.getProviderLastUpdate(base);
          const cacheValid =
            lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;

          if (cacheValid) {
            const cachedModels = this.adapter.getCachedModels();
            const cachedList = cachedModels[base] || [];
            list = cachedList;
          } else {
            // Cache expired or doesn't exist, fetch fresh
            list = await this.fetchModelsFromProvider(base);
          }
        } else {
          // Force refresh
          list = await this.fetchModelsFromProvider(base);
        }

        modelsFromAllProviders[base] = list;
        this.adapter.setProviderLastUpdate(base, Date.now());

        // Update best-priced models if provider not disabled
        if (!disabledProviders.includes(base)) {
          for (const m of list) {
            const existing = bestById.get(m.id);

            // Skip models without sats pricing
            if (!m.sats_pricing) continue;

            if (!existing) {
              bestById.set(m.id, { model: m, base });
              continue;
            }

            // Replace if this provider has lower cost
            const currentCost = estimateMinCost(m);
            const existingCost = estimateMinCost(existing.model);
            if (currentCost < existingCost && m.sats_pricing) {
              bestById.set(m.id, { model: m, base });
            }
          }
        }

        return { success: true, base, list };
      } catch (error) {
        console.warn(`Failed to fetch models from ${base}:`, error);
        this.adapter.setProviderLastUpdate(base, Date.now());
        return { success: false, base };
      }
    });

    // Wait for all to complete
    await Promise.allSettled(fetchPromises);

    // Cache all provider results
    const existingCache = this.adapter.getCachedModels();
    this.adapter.setCachedModels({
      ...existingCache,
      ...modelsFromAllProviders,
    });

    // Update model -> provider mapping for best-price winners
    const modelMap = this.adapter.getModelProviderMap();
    let mapChanged = false;
    for (const [id, entry] of bestById.entries()) {
      if (modelMap[id] !== entry.base) {
        modelMap[id] = entry.base;
        mapChanged = true;
      }
    }
    if (mapChanged) {
      this.adapter.setModelProviderMap(modelMap);
    }

    // Return combined models array
    return Array.from(bestById.values()).map((v) => v.model);
  }

  /**
   * Fetch models from a single provider
   * @param baseUrl Provider base URL
   * @returns Array of models from provider
   */
  private async fetchModelsFromProvider(baseUrl: string): Promise<Model[]> {
    const res = await fetch(`${baseUrl}v1/models`);
    if (!res.ok) {
      throw new Error(`Failed to fetch models: ${res.status}`);
    }

    const json = await res.json();
    const list = Array.isArray(json?.data)
      ? json.data.map((m: Model) => ({
          ...m,
          id: m.id.split("/").pop() || m.id,
        }))
      : [];

    return list;
  }

  /**
   * Get best-priced provider for a specific model
   * @param modelId Model ID to look up
   * @returns Base URL for the provider with best price, or null if not found
   */
  getProviderForModel(modelId: string): string | null {
    const modelMap = this.adapter.getModelProviderMap();
    return modelMap[modelId] || null;
  }

  /**
   * Get all cached models from all providers
   * @returns Record mapping baseUrl -> models
   */
  getAllCachedModels(): Record<string, Model[]> {
    return this.adapter.getCachedModels();
  }

  /**
   * Get providers for a model sorted by prompt+completion pricing
   */
  getProviderPriceRankingForModel(
    modelId: string,
    options: { torMode?: boolean; includeDisabled?: boolean } = {}
  ): ModelProviderPrice[] {
    const normalizedId = this.normalizeModelId(modelId);
    const includeDisabled = options.includeDisabled ?? false;
    const torMode = options.torMode ?? false;
    const disabledProviders = new Set(this.adapter.getDisabledProviders());
    const allModels = this.adapter.getCachedModels();
    const results: ModelProviderPrice[] = [];

    for (const [baseUrl, models] of Object.entries(allModels)) {
      if (!includeDisabled && disabledProviders.has(baseUrl)) continue;
      if (torMode && !baseUrl.includes(".onion")) continue;
      if (!torMode && baseUrl.includes(".onion")) continue;

      const match = models.find(
        (model) => this.normalizeModelId(model.id) === normalizedId
      );
      if (!match?.sats_pricing) continue;

      const prompt = match.sats_pricing.prompt;
      const completion = match.sats_pricing.completion;
      if (typeof prompt !== "number" || typeof completion !== "number") {
        continue;
      }

      const promptPerMillion = prompt * 1_000_000;
      const completionPerMillion = completion * 1_000_000;
      const totalPerMillion = promptPerMillion + completionPerMillion;

      results.push({
        baseUrl,
        model: match,
        promptPerMillion,
        completionPerMillion,
        totalPerMillion,
      });
    }

    return results.sort((a, b) => {
      if (a.totalPerMillion !== b.totalPerMillion) {
        return a.totalPerMillion - b.totalPerMillion;
      }
      return a.baseUrl.localeCompare(b.baseUrl);
    });
  }

  /**
   * Clear cache for a specific provider
   * @param baseUrl Provider base URL
   */
  clearProviderCache(baseUrl: string): void {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const cached = this.adapter.getCachedModels();
    delete cached[base];
    this.adapter.setCachedModels(cached);
    this.adapter.setProviderLastUpdate(base, 0);
  }

  /**
   * Clear all model caches
   */
  clearAllCache(): void {
    this.adapter.setCachedModels({});
    this.adapter.setModelProviderMap({});
  }

  /**
   * Filter base URLs based on Tor context
   * @param baseUrls Provider URLs to filter
   * @param torMode Whether in Tor context
   * @returns Filtered URLs appropriate for Tor mode
   */
  filterBaseUrlsForTor(baseUrls: string[], torMode: boolean): string[] {
    if (!torMode) {
      // In normal mode, exclude onion URLs
      return baseUrls.filter((url) => !url.includes(".onion"));
    }
    // In Tor mode, only include onion URLs
    return baseUrls.filter((url) => url.includes(".onion"));
  }

  /**
   * Get provider endpoints from provider info
   * @param provider Provider object from directory
   * @param torMode Whether in Tor context
   * @returns Array of endpoint URLs
   */
  private getProviderEndpoints(provider: any, torMode: boolean): string[] {
    const endpoints: string[] = [];

    if (torMode && provider.onion_url) {
      endpoints.push(this.normalizeUrl(provider.onion_url));
    } else if (provider.endpoint_url) {
      endpoints.push(this.normalizeUrl(provider.endpoint_url));
    }

    return endpoints;
  }

  /**
   * Normalize provider URL with trailing slash
   * @param url URL to normalize
   * @returns Normalized URL
   */
  private normalizeUrl(url: string): string {
    if (!url.startsWith("http")) {
      url = `https://${url}`;
    }
    return url.endsWith("/") ? url : `${url}/`;
  }

  private normalizeModelId(modelId: string): string {
    return modelId.includes("/")
      ? modelId.split("/").pop() || modelId
      : modelId;
  }
}
