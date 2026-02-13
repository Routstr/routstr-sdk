/**
 * MintDiscovery class for discovering mints and provider info
 * Core responsibility: fetching mint information from providers and caching it
 */

import type { DiscoveryAdapter, ProviderInfo } from "./interfaces";
import { MintDiscoveryError } from "@/sdk/core/errors";

/**
 * Configuration for MintDiscovery
 */
export interface MintDiscoveryConfig {
  /** Cache TTL in milliseconds (default: 21 minutes) */
  cacheTTL?: number;
}

/**
 * MintDiscovery handles mint and provider info discovery
 * Abstracts away storage details via DiscoveryAdapter
 */
export class MintDiscovery {
  private readonly cacheTTL: number;

  constructor(
    private adapter: DiscoveryAdapter,
    config: MintDiscoveryConfig = {}
  ) {
    this.cacheTTL = config.cacheTTL || 21 * 60 * 1000; // 21 minutes
  }

  /**
   * Fetch mints from all providers via their /v1/info endpoints
   * Caches mints and full provider info for later access
   * @param baseUrls List of provider base URLs to fetch from
   * @returns Object with mints and provider info from all providers
   */
  async discoverMints(
    baseUrls: string[],
    options: { forceRefresh?: boolean } = {}
  ): Promise<{
    mintsFromProviders: Record<string, string[]>;
    infoFromProviders: Record<string, ProviderInfo>;
  }> {
    if (baseUrls.length === 0) {
      return { mintsFromProviders: {}, infoFromProviders: {} };
    }

    const mintsFromAllProviders: Record<string, string[]> = {};
    const infoFromAllProviders: Record<string, ProviderInfo> = {};
    const forceRefresh = options.forceRefresh ?? false;

    // Fetch info from each provider
    const fetchPromises = baseUrls.map(async (url) => {
      const base = url.endsWith("/") ? url : `${url}/`;
      try {
        if (!forceRefresh) {
          const lastUpdate = this.adapter.getProviderLastUpdate(base);
          const cacheValid =
            lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;
          if (cacheValid) {
            const cachedMints = this.adapter.getCachedMints()[base] || [];
            const cachedInfo = this.adapter.getCachedProviderInfo()[base];
            mintsFromAllProviders[base] = cachedMints;
            if (cachedInfo) {
              infoFromAllProviders[base] = cachedInfo;
            }
            return {
              success: true,
              base,
              mints: cachedMints,
              info: cachedInfo,
            };
          }
        }

        const res = await fetch(`${base}v1/info`);
        if (!res.ok) {
          throw new Error(`Failed to fetch info: ${res.status}`);
        }

        const json = await res.json();

        // Extract mints array from response
        const mints: string[] = Array.isArray(json?.mints) ? json.mints : [];

        // Normalize mint URLs (remove trailing slashes for consistency)
        const normalizedMints = mints.map((mint) =>
          mint.endsWith("/") ? mint.slice(0, -1) : mint
        );

        // Save provider mints and full info
        mintsFromAllProviders[base] = normalizedMints;
        infoFromAllProviders[base] = json;
        this.adapter.setProviderLastUpdate(base, Date.now());

        return { success: true, base, mints: normalizedMints, info: json };
      } catch (error) {
        console.warn(`Failed to fetch mints from ${base}:`, error);
        this.adapter.setProviderLastUpdate(base, Date.now());
        throw new MintDiscoveryError(
          base,
          `Failed to discover mints: ${error}`
        );
      }
    });

    // Wait for all to complete (but allow individual failures)
    const results = await Promise.allSettled(fetchPromises);

    // Handle results
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { base, mints, info } = result.value;
        mintsFromAllProviders[base] = mints;
        if (info) {
          infoFromAllProviders[base] = info;
        }
      } else {
        // Log but don't throw - continue with partial results
        console.error("Mint discovery error:", result.reason);
      }
    }

    // Cache all results
    try {
      this.adapter.setCachedMints(mintsFromAllProviders);
      this.adapter.setCachedProviderInfo(infoFromAllProviders);
    } catch (error) {
      console.error("Error caching mint discovery results:", error);
    }

    return {
      mintsFromProviders: mintsFromAllProviders,
      infoFromProviders: infoFromAllProviders,
    };
  }

  /**
   * Get cached mints from all providers
   * @returns Record mapping baseUrl -> mint URLs
   */
  getCachedMints(): Record<string, string[]> {
    return this.adapter.getCachedMints();
  }

  /**
   * Get cached provider info from all providers
   * @returns Record mapping baseUrl -> provider info
   */
  getCachedProviderInfo(): Record<string, ProviderInfo> {
    return this.adapter.getCachedProviderInfo();
  }

  /**
   * Get mints for a specific provider
   * @param baseUrl Provider base URL
   * @returns Array of mint URLs for the provider
   */
  getProviderMints(baseUrl: string): string[] {
    const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const allMints = this.getCachedMints();
    return allMints[normalized] || [];
  }

  /**
   * Get info for a specific provider
   * @param baseUrl Provider base URL
   * @returns Provider info object or null if not found
   */
  getProviderInfo(baseUrl: string): ProviderInfo | null {
    const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const allInfo = this.getCachedProviderInfo();
    return allInfo[normalized] || null;
  }

  /**
   * Clear mint cache for a specific provider
   * @param baseUrl Provider base URL
   */
  clearProviderMintCache(baseUrl: string): void {
    const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

    const mints = this.getCachedMints();
    delete mints[normalized];
    this.adapter.setCachedMints(mints);

    const info = this.getCachedProviderInfo();
    delete info[normalized];
    this.adapter.setCachedProviderInfo(info);
  }

  /**
   * Clear all mint caches
   */
  clearAllCache(): void {
    this.adapter.setCachedMints({});
    this.adapter.setCachedProviderInfo({});
  }
}
