/**
 * MintDiscovery class for discovering mints and provider info
 * Core responsibility: fetching mint information from providers and caching it
 */

import type { DiscoveryAdapter, ProviderInfo } from "./interfaces";
import { withProviderDeadline } from "./providerDeadline";
import type { SdkLogger } from "../core/types";
import { consoleLogger } from "../core/types";
import {
  classifyProviderFailure,
  diffProviderOutage,
  type ProviderFailure,
  type ProviderOutcome,
} from "./providerOutageReport";

// A hanging provider must not hold an info pass open indefinitely.
const INFO_FETCH_TIMEOUT_MS = 10_000;

/**
 * One provider's slot in a mint pass. `success` is false when the provider did
 * not answer, in which case `failure` carries the classified reason for the
 * end-of-pass report.
 */
type MintPassOutcome = ProviderOutcome & {
  success: boolean;
  mints: string[];
  info: ProviderInfo | null;
};

/**
 * Configuration for MintDiscovery
 */
export interface MintDiscoveryConfig {
  /** Cache TTL in milliseconds (default: 21 minutes) */
  cacheTTL?: number;
  /** Optional injectable logger */
  logger?: SdkLogger;
}

/**
 * MintDiscovery handles mint and provider info discovery
 * Abstracts away storage details via DiscoveryAdapter
 */
export class MintDiscovery {
  private readonly cacheTTL: number;
  private readonly logger: SdkLogger;
  // Tracked here, not via the adapter's provider timestamp: that stamp
  // belongs to the model cache and mint refreshes kept it alive forever.
  private lastMintFetch = new Map<string, number>();
  private providerInfoRequests = new Map<string, Promise<ProviderInfo>>();
  // Last pass's failures, so an unchanged outage collapses into the summary
  // instead of re-printing a line per provider per pass. See the report for
  // the transition rules.
  private providerFailures = new Map<string, ProviderFailure>();

  constructor(
    private adapter: DiscoveryAdapter,
    config: MintDiscoveryConfig = {}
  ) {
    this.cacheTTL = config.cacheTTL || 21 * 60 * 1000; // 21 minutes
    this.logger = (config.logger ?? consoleLogger).child("MintDiscovery");
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

    const forceRefresh = options.forceRefresh ?? false;
    const startedAt = Date.now();
    // Only network-fetched bases count as retried, so a provider served from
    // cache is never reported recovered on the strength of a stale entry.
    const freshlyFetched = new Set<string>();

    // Fetch info from each provider
    const fetchPromises = baseUrls.map(async (url): Promise<MintPassOutcome> => {
      const base = url.endsWith("/") ? url : `${url}/`;
      try {
        if (!forceRefresh) {
          const lastUpdate = this.lastMintFetch.get(base);
          const cacheValid =
            lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;
          if (cacheValid) {
            const cachedMints = this.adapter.getCachedMints()[base] || [];
            const cachedInfo = this.adapter.getCachedProviderInfo()[base];
            return {
              success: true,
              base,
              mints: cachedMints,
              info: cachedInfo,
            };
          }
        }

        const json = await this.fetchProviderInfo(base);
        const normalizedMints = this.adapter.getCachedMints()[base] ?? [];
        freshlyFetched.add(base);

        return { success: true, base, mints: normalizedMints, info: json };
      } catch (error) {
        // No stamp on failure, so the provider is retried next pass. The raw
        // error is carried to the end-of-pass report rather than logged here:
        // a node that has been down for days must not re-print its stack on
        // every refresh. See reportProviderFailures().
        return {
          success: false,
          base,
          mints: [],
          info: null,
          failure: classifyProviderFailure(error),
        };
      }
    });

    // Wait for all to complete (but allow individual failures)
    const results = await Promise.allSettled(fetchPromises);

    this.reportProviderFailures(
      results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      ),
      freshlyFetched,
      baseUrls.length,
      Date.now() - startedAt
    );

    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error("Mint discovery error:", result.reason);
      }
    }

    // Successes were published immediately. Do not merge an older pass's
    // snapshot here: it could overwrite advertisements refreshed meanwhile.
    return {
      mintsFromProviders: this.adapter.getCachedMints(),
      infoFromProviders: this.adapter.getCachedProviderInfo(),
    };
  }

  private fetchProviderInfo(base: string): Promise<ProviderInfo> {
    const running = this.providerInfoRequests.get(base);
    if (running) return running;

    const request = withProviderDeadline(async (signal) => {
      const res = await fetch(`${base}v1/info`, { signal });
      if (!res.ok) throw new Error(`Failed to fetch info: ${res.status}`);
      return await res.json() as ProviderInfo;
    }, INFO_FETCH_TIMEOUT_MS).then((info) => {
      const mints: string[] = Array.isArray(info?.mints) ? info.mints : [];
      const normalized = mints.map((mint) =>
        mint.endsWith("/") ? mint.slice(0, -1) : mint
      );
      // Merge freshest state and retain known restrictions on every failure.
      // The freshness clock advances only after both payloads are published.
      this.adapter.setCachedMints({ ...this.adapter.getCachedMints(), [base]: normalized });
      this.adapter.setCachedProviderInfo({ ...this.adapter.getCachedProviderInfo(), [base]: info });
      this.lastMintFetch.set(base, Date.now());
      return info;
    }).finally(() => {
      this.providerInfoRequests.delete(base);
    });
    this.providerInfoRequests.set(base, request);
    return request;
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

  /**
   * Report reachability for one mint pass as state transitions plus a single
   * summary, the same shape `ModelManager` uses for model refreshes. The diff
   * itself lives in `providerOutageReport.ts`; this only emits its lines.
   */
  private reportProviderFailures(
    outcomes: ProviderOutcome[],
    freshlyFetched: Set<string>,
    total: number,
    elapsedMs: number
  ): void {
    const report = diffProviderOutage(
      this.providerFailures,
      outcomes,
      freshlyFetched,
      total,
      elapsedMs,
      "Mint discovery"
    );
    this.providerFailures = report.failures;

    for (const line of report.lines) {
      if (line.level === "warn") this.logger.warn(line.message);
      else if (line.level === "info") this.logger.log(line.message);
      else this.logger.debug(line.message);
    }
  }
}
