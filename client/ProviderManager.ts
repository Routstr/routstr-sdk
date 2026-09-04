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

import type { DiscoveryAdapter } from "../discovery/interfaces";
import type { Model, ProviderInfo, SdkLogger } from "../core/types";
import { consoleLogger } from "../core/types";
import type { SdkStore } from "../storage/store";
import { isOnionUrl, isTorContext } from "../utils/torUtils";
import { isTinfoilModel } from "./TinfoilSecure";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

/**
 * Fetch provider info from network if not cached, then cache it.
 * Replaces the old ProviderRegistry.getProviderInfo() method.
 */
const fetchProviderInfo = async (
  adapter: DiscoveryAdapter,
  baseUrl: string,
  logger: SdkLogger,
): Promise<ProviderInfo | null> => {
  const normalized = normalizeBaseUrl(baseUrl);
  const cached = adapter.getCachedProviderInfo()[normalized];
  if (cached) return cached;
  try {
    const response = await fetch(`${normalized}v1/info`);
    if (!response.ok) {
      throw new Error(`Failed ${response.status}`);
    }
    const info = (await response.json()) as ProviderInfo;
    adapter.setCachedProviderInfo({
      ...adapter.getCachedProviderInfo(),
      [normalized]: info,
    });
    return info;
  } catch (error) {
    logger.warn(`Failed to fetch provider info from ${normalized}:`, error);
    return null;
  }
};

export interface ModelProviderPrice {
  baseUrl: string;
  model: Model;
  promptPerMillion: number;
  completionPerMillion: number;
  totalPerMillion: number;
}

/**
 * Extract image resolution (width, height) from a base64 data URL without DOM.
 * Supports PNG and JPEG. Returns null if format unsupported or parsing fails.
 */
function getImageResolutionFromDataUrl(
  dataUrl: string
): { width: number; height: number } | null {
  try {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:"))
      return null;

    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) return null;

    const meta = dataUrl.slice(5, commaIdx); // e.g. "image/png;base64"
    const base64 = dataUrl.slice(commaIdx + 1);

    // Decode base64 to binary
    const binary =
      typeof atob === "function"
        ? atob(base64)
        : Buffer.from(base64, "base64").toString("binary");

    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    const isPNG = meta.includes("image/png");
    const isJPEG = meta.includes("image/jpeg") || meta.includes("image/jpg");

    // PNG: width/height are 4-byte big-endian at offsets 16 and 20
    if (isPNG) {
      // Validate PNG signature
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < sig.length; i++) {
        if (bytes[i] !== sig[i]) return null;
      }
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      );
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }

    // JPEG: parse markers to SOF0/SOF2 for dimensions
    if (isJPEG) {
      let offset = 0;
      // JPEG SOI 0xFFD8
      if (bytes[offset++] !== 0xff || bytes[offset++] !== 0xd8) return null;

      while (offset < bytes.length) {
        // Find marker
        while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
        if (offset + 1 >= bytes.length) break;

        // Skip fill bytes 0xFF
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];

        // Standalone markers without length
        if (marker === 0xd8 || marker === 0xd9) continue; // SOI/EOI

        if (offset + 1 >= bytes.length) break;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        offset += 2;

        // SOF0 (0xC0) or SOF2 (0xC2) contain dimensions
        if (marker === 0xc0 || marker === 0xc2) {
          if (length < 7 || offset + length - 2 > bytes.length) return null;
          const precision = bytes[offset];
          const height = (bytes[offset + 1] << 8) | bytes[offset + 2];
          const width = (bytes[offset + 3] << 8) | bytes[offset + 4];
          if (precision > 0 && width > 0 && height > 0)
            return { width, height };
          return null;
        } else {
          // Skip this segment
          offset += length - 2;
        }
      }
      return null;
    }

    // Unsupported formats (e.g., webp/gif) - skip for now
    return null;
  } catch {
    return null;
  }
}

/**
 * Calculate image tokens based on OpenAI's vision pricing.
 *
 * For low detail: 85 tokens
 * For high detail/auto: 85 base tokens + 170 tokens per 512px tile
 * For original detail: patch-based pricing at the image's original
 *   resolution — ceil(patches * 1.2) tokens at 32x32px patches, bounded
 *   by the 30,000-patch rejection limit (36,000 tokens worst case).
 */
function calculateImageTokens(
  width: number,
  height: number,
  detail: "low" | "high" | "auto" | "original" = "auto"
): number {
  if (detail === "low") return 85;

  if (detail === "original") {
    const patches =
      Math.ceil(width / IMAGE_PATCH_PX) *
      Math.ceil(height / IMAGE_PATCH_PX);
    return Math.ceil(Math.min(patches, MAX_IMAGE_PATCHES) * 1.2);
  }

  let w = width;
  let h = height;

  // Clamp longest side to 2048 while preserving aspect ratio
  if (w > 2048 || h > 2048) {
    const aspectRatio = w / h;
    if (w > h) {
      w = 2048;
      h = Math.floor(w / aspectRatio);
    } else {
      h = 2048;
      w = Math.floor(h * aspectRatio);
    }
  }

  // Then clamp longest side to 768 while preserving aspect ratio
  if (w > 768 || h > 768) {
    const aspectRatio = w / h;
    if (w > h) {
      w = 768;
      h = Math.floor(w / aspectRatio);
    } else {
      h = 768;
      w = Math.floor(h * aspectRatio);
    }
  }

  // Number of 512px tiles, ceil division using (x + 511) // 512
  const tilesWidth = Math.floor((w + 511) / 512);
  const tilesHeight = Math.floor((h + 511) / 512);
  const numTiles = tilesWidth * tilesHeight;

  return 85 + 170 * numTiles;
}

/** 32x32px patch grid used for detail="original" image billing. */
const IMAGE_PATCH_PX = 32;
/** OpenAI rejects images above 30,000 patches. */
const MAX_IMAGE_PATCHES = 30_000;

/** Max 512px tiles after the 2048px/768px downscaling passes. */
const MAX_TILED_IMAGE_TOKENS = 85 + 170 * 4; // 765
/** 30,000 patches * 1.2 multiplier. */
const MAX_ORIGINAL_IMAGE_TOKENS = Math.ceil(MAX_IMAGE_PATCHES * 1.2); // 36,000

/**
 * Worst-case tokens a single image can bill at each detail level, used
 * when dimensions are unknown (file_id references, remote URLs, or data
 * URLs in formats the local parser cannot read — the node's full image
 * library handles those).
 */
function worstCaseImageTokensForDetail(detail: string): number {
  if (detail === "low") return 85;
  if (detail === "original") return MAX_ORIGINAL_IMAGE_TOKENS;
  return MAX_TILED_IMAGE_TOKENS;
}

/**
 * Estimate tokens for a single image_url payload at a given detail level.
 * Remote URLs get the worst case for the detail level: the node fetches
 * and measures them, so a local 0 would under-deposit.
 */
function estimateImageTokensForUrl(
  url: string | undefined,
  detail: string
): number {
  if (!url || typeof url !== "string") return 0;
  if (url.startsWith("data:")) {
    const res = getImageResolutionFromDataUrl(url);
    if (res) {
      return calculateImageTokens(
        res.width,
        res.height,
        detail as "low" | "high" | "auto" | "original"
      );
    }
    return worstCaseImageTokensForDetail(detail);
  }
  return worstCaseImageTokensForDetail(detail);
}

/**
 * Estimate tokens for a Responses API input_image item. Honors the
 * item-level (sibling) detail; file_id references without a usable
 * image_url use the worst case for the detail level.
 */
function estimateInputImageTokens(item: any): number {
  const detail =
    typeof item?.detail === "string" && item?.detail ? item.detail : "auto";
  const url =
    typeof item?.image_url === "string"
      ? item.image_url
      : item?.image_url?.url;
  const fromUrl = estimateImageTokensForUrl(url, detail);
  if (fromUrl > 0 || !item?.file_id) return fromUrl;
  return worstCaseImageTokensForDetail(detail);
}

/**
 * Count image tokens across chat-completions messages: image_url parts
 * (nested detail) and input_image parts (sibling detail), matching the
 * node's messages-side estimator.
 */
function countImageTokensInMessages(apiMessages: any[]): number {
  let total = 0;
  for (const msg of apiMessages ?? []) {
    const content = (msg as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "image_url") {
        const detail =
          typeof part.image_url?.detail === "string" &&
          part.image_url?.detail
            ? part.image_url.detail
            : "auto";
        const url =
          typeof part.image_url === "string"
            ? part.image_url
            : part.image_url?.url;
        total += estimateImageTokensForUrl(url, detail);
      } else if (part.type === "input_image") {
        total += estimateInputImageTokens(part);
      }
    }
  }
  return total;
}

/**
 * Count image tokens across a Responses API input list: top-level
 * input_image items and input_image parts inside message content lists.
 */
function countImageTokensInResponsesInput(input: any): number {
  if (!Array.isArray(input)) return 0;
  let total = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "input_image") {
      total += estimateInputImageTokens(item);
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (
          part &&
          typeof part === "object" &&
          part.type === "input_image"
        ) {
          total += estimateInputImageTokens(part);
        }
      }
    }
  }
  return total;
}

/**
 * JSON.stringify that never throws (circular references etc. return null
 * so callers can fall back to a conservative token count).
 */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

/**
 * Compact (canonical) JSON.stringify that never throws. Uses the same
 * `JSON.stringify(value)` form the node uses for its billed-char counts
 * (separators `,`/`:`), so object/array payloads contribute the same
 * character count on both sides. Returns null on circular references so
 * callers can fall back to a conservative token count.
 */
function safeStringifyCompact(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Conservative character length for a text/JSON payload, matching the
 * node's `_text_length`: strings count their length; objects/arrays count
 * their compact-serialized length; anything else counts as zero. Used so
 * the SDK counts the same billed content the node does.
 */
function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value !== null && typeof value === "object") {
    return safeStringifyCompact(value)?.length ?? 0;
  }
  return 0;
}

/**
 * Count the billed text characters across chat-completions messages,
 * excluding the JSON envelope (keys, role fields, punctuation) that the
 * node does not bill as prompt tokens. Counts string content, `text`
 * parts, and assistant `tool_calls` function name + arguments. Image
 * parts contribute zero here (they are priced separately as tokens).
 */
function countMessageTextChars(apiMessages: any[]): number {
  let total = 0;
  for (const msg of apiMessages ?? []) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as any).content;
    if (typeof content === "string") {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && part.type === "text") {
          total += textLength(part.text);
        }
      }
    }
    const toolCalls = (msg as any).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = call?.function;
        if (!fn || typeof fn !== "object") continue;
        total += textLength(fn.name);
        total += textLength(fn.arguments);
      }
    }
  }
  return total;
}

/**
 * Strip image items/parts and encrypted reasoning payloads from a
 * Responses API input list before serializing it for the text token
 * estimate: base64 image data and encrypted_content massively overstate
 * the prompt, and the node counts neither as prompt text.
 */
function stripImagesFromResponsesInput(input: any[]): any[] {
  const result: any[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      result.push(item);
      continue;
    }
    if (item.type === "input_image") continue; // dropped entirely
    if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
      const { encrypted_content, ...rest } = item;
      result.push(rest);
      continue;
    }
    if (Array.isArray(item.content)) {
      const filtered = item.content.filter(
        (p: any) =>
          !(p && typeof p === "object" && p.type === "input_image")
      );
      result.push({ ...item, content: filtered });
      continue;
    }
    result.push(item);
  }
  return result;
}

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
  /** Track when each provider last failed (provider URL -> timestamp) */
  private lastFailed = new Map<string, number>();
  /** Providers on cooldown: [provider_url, cooldown_started_timestamp][] */
  private providersOnCoolDown: [string, number][] = [];
  /** Cooldown duration in milliseconds (210 seconds) */
  private static readonly COOLDOWN_DURATION_MS = 210 * 1000;
  /** Optional persistent store for failure tracking */
  private store: SdkStore | null = null;
  /** Instance ID for debugging */
  private readonly instanceId: string;
  private readonly logger: SdkLogger;

  constructor(
    private discoveryAdapter: DiscoveryAdapter,
    store?: SdkStore,
    logger?: SdkLogger
  ) {
    this.instanceId = `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.logger = (logger ?? consoleLogger).child(`ProviderManager:${this.instanceId}`);
    if (store) {
      this.store = store;
      this.hydrateFromStore();
    }
  }

  /**
   * Hydrate in-memory state from persistent store
   */
  private hydrateFromStore(): void {
    if (!this.store) return;
    const state = this.store.getState();

    // Hydrate failedProviders
    this.failedProviders = new Set(state.failedProviders);

    // Hydrate lastFailed
    this.lastFailed = new Map(Object.entries(state.lastFailed));

    // Hydrate providersOnCooldown (filter out expired)
    const now = Date.now();
    this.providersOnCoolDown = state.providersOnCooldown
      .filter(
        (entry) => now - entry.timestamp < ProviderManager.COOLDOWN_DURATION_MS
      )
      .map((entry) => [entry.baseUrl, entry.timestamp] as [string, number]);

  }

  /**
   * Get instance ID for debugging
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Clean up expired cooldown entries
   * Also removes the provider from failedProviders so it can be retried
   */
  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    this.providersOnCoolDown = this.providersOnCoolDown.filter(
      ([url, timestamp]) => {
        const age = now - timestamp;
        const isExpired = age >= ProviderManager.COOLDOWN_DURATION_MS;
        if (isExpired) {
          // Also remove from failedProviders so the provider can be retried
          this.failedProviders.delete(url);
          // Persist to store
          if (this.store) {
            this.store.getState().removeFailedProvider(url);
          }
        }
        return !isExpired;
      }
    );
  }

  /**
   * Get the cooldown duration in milliseconds
   */
  getCooldownDurationMs(): number {
    return ProviderManager.COOLDOWN_DURATION_MS;
  }

  /**
   * Check if a provider is currently on cooldown
   */
  isOnCooldown(baseUrl: string): boolean {
    this.cleanupExpiredCooldowns();

    const result = this.providersOnCoolDown.some(([url]) => url === baseUrl);
    return result;
  }

  /**
   * Get all providers currently on cooldown
   */
  getProvidersOnCooldown(): [string, number][] {
    this.cleanupExpiredCooldowns();
    return [...this.providersOnCoolDown];
  }

  /**
   * Reset the failed providers list
   */
  resetFailedProviders(): void {
    this.failedProviders.clear();
    // Persist to store
    if (this.store) {
      this.store.getState().setFailedProviders([]);
    }
  }

  /**
   * Get the last failed timestamp for a provider
   */
  getLastFailed(baseUrl: string): number | undefined {
    return this.lastFailed.get(baseUrl);
  }

  /**
   * Get all providers with their last failed timestamps
   */
  getAllLastFailed(): Map<string, number> {
    return new Map(this.lastFailed);
  }

  /**
   * Mark a provider as failed
   * If a provider fails twice within 5 minutes, it's added to cooldown
   */
  markFailed(baseUrl: string, reason?: string): void {
    const now = Date.now();
    const lastFailure = this.lastFailed.get(baseUrl);

    // Track this failure in memory
    this.lastFailed.set(baseUrl, now);
    this.failedProviders.add(baseUrl);

    // Persist to store
    if (this.store) {
      this.store.getState().setLastFailedTimestamp(baseUrl, now);
      this.store.getState().addFailedProvider(baseUrl);
    }

    // Check if this is a second failure within the cooldown window
    if (
      lastFailure !== undefined &&
      now - lastFailure < ProviderManager.COOLDOWN_DURATION_MS
    ) {
      // Second failure within 5 minutes - add to cooldown
      if (!this.isOnCooldown(baseUrl)) {
        this.providersOnCoolDown.push([baseUrl, now]);
        // Persist to store
        if (this.store) {
          this.store.getState().addProviderOnCooldown(baseUrl, now);
        }
      }
    }
  }

  /**
   * Remove a provider from cooldown (e.g., after successful request)
   */
  removeFromCooldown(baseUrl: string): void {
    this.providersOnCoolDown = this.providersOnCoolDown.filter(
      ([url]) => url !== baseUrl
    );
    // Persist to store
    if (this.store) {
      this.store.getState().removeProviderFromCooldown(baseUrl);
    }
  }

  /**
   * Clear all cooldown tracking
   */
  clearCooldowns(): void {
    this.providersOnCoolDown = [];
    // Persist to store
    if (this.store) {
      this.store.getState().clearProvidersOnCooldown();
    }
  }

  /**
   * Clear all failure tracking (lastFailed timestamps)
   */
  clearFailureHistory(): void {
    this.lastFailed.clear();
    // Persist to store
    if (this.store) {
      this.store.getState().setLastFailed({});
    }
  }

  /**
   * Check if a provider has failed
   */
  hasFailed(baseUrl: string): boolean {
    return this.failedProviders.has(baseUrl);
  }

  /**
   * Get a copy of the failed providers set
   */
  getFailedProviders(): Set<string> {
    return new Set(this.failedProviders);
  }

  /**
   * Find the next best provider for a model
   * @param modelId The model ID to find a provider for
   * @param currentBaseUrl The current provider to exclude
   * @returns The best provider URL or null if none available
   */
  findNextBestProvider(modelId: string, currentBaseUrl: string): string | null {
    try {
      const torMode = isTorContext();
      const disabledProviders = new Set(
        this.discoveryAdapter.getDisabledProviders()
      );

      // Get all providers with their models
      const allProviders = this.discoveryAdapter.getCachedModels();

      // Find all candidate providers
      const candidates: CandidateProvider[] = [];

      for (const [baseUrl, models] of Object.entries(allProviders)) {
        // Skip current, failed, disabled, and cooldown providers
        if (baseUrl === currentBaseUrl) {
          continue;
        }
        // if (this.failedProviders.has(baseUrl)) {
        //   console.log(`[findNextBestProvider:${this.instanceId}] SKIP (failed): ${baseUrl}`);
        //   skippedFailed++;
        //   continue;
        // }
        if (disabledProviders.has(baseUrl)) {
          continue;
        }
        if (this.isOnCooldown(baseUrl)) {
          continue;
        }

        // Skip onion URLs if not in Tor mode
        if (!torMode && isOnionUrl(baseUrl)) {
          continue;
        }

        // Find the model in this provider's list
        const model = models.find((m: Model) => m.id === modelId);
        if (!model) {
          continue;
        }

        // Calculate cost (using completion price as the metric)
        const cost = model.sats_pricing?.completion ?? 0;
        candidates.push({ baseUrl, model, cost });
      }

      // Sort by price (lowest first)
      candidates.sort((a, b) => a.cost - b.cost);

      if (candidates.length > 0) {
        return candidates[0].baseUrl;
      } else {
        return null;
      }
    } catch (error) {
      this.logger.error("findNextBestProvider error:", error);
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
    const models = this.discoveryAdapter.getCachedModels()[normalizeBaseUrl(baseUrl)] || [];

    // First try exact match
    const exactMatch = models.find((m) => m.id === modelId);
    if (exactMatch) return exactMatch;

    // Try matching by ID suffix (for backward compatibility with v0.1.x providers)
    const providerInfo = await fetchProviderInfo(this.discoveryAdapter, baseUrl, this.logger);
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
    const allProviders = this.discoveryAdapter.getCachedModels();
    const disabledProviders = new Set(
      this.discoveryAdapter.getDisabledProviders()
    );
    const torMode = isTorContext();

    for (const [baseUrl, models] of Object.entries(allProviders)) {
      if (disabledProviders.has(baseUrl)) continue;
      if (this.isOnCooldown(baseUrl)) continue;
      if (!torMode && isOnionUrl(baseUrl))
        continue;

      const model = models.find((m: Model) => m.id === modelId);
      if (!model) continue;

      const cost = model.sats_pricing?.completion ?? 0;
      candidates.push({ baseUrl, model, cost });
    }

    return candidates.sort((a, b) => a.cost - b.cost);
  }

  /**
   * Get providers for a model sorted by prompt+completion pricing
   */
  getProviderPriceRankingForModel(
    modelId: string,
    options: { torMode?: boolean; includeDisabled?: boolean } = {}
  ): ModelProviderPrice[] {
    const includeDisabled = options.includeDisabled ?? false;
    const torMode = options.torMode ?? false;
    const disabledProviderList = this.discoveryAdapter.getDisabledProviders();
    const disabledProviders = new Set(disabledProviderList);
    if (disabledProviderList.length > 0) {
      this.logger.log(`getProviderPriceRankingForModel: disabled providers (${disabledProviderList.length}): ${disabledProviderList.join(", ")}`);
    }
    const allModels = this.discoveryAdapter.getCachedModels();
    const results: ModelProviderPrice[] = [];

    for (const [baseUrl, models] of Object.entries(allModels)) {
      if (!includeDisabled && disabledProviders.has(baseUrl)) continue;
      if (this.isOnCooldown(baseUrl)) continue;
      if (torMode && !baseUrl.includes(".onion")) continue;
      if (
        !torMode &&
        baseUrl.includes(".onion")
      )
        continue;

      const match = models.find((model) => model.id === modelId);
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

    results.sort((a, b) => {
      if (a.totalPerMillion !== b.totalPerMillion) {
        return a.totalPerMillion - b.totalPerMillion;
      }
      return a.baseUrl.localeCompare(b.baseUrl);
    });

    if (results.length > 0) {
      const ranking = results
        .map((r, i) => `  ${i + 1}. ${r.baseUrl} total=${r.totalPerMillion.toFixed(2)} sats/M (prompt=${r.promptPerMillion.toFixed(2)} completion=${r.completionPerMillion.toFixed(2)})`)
        .join("\n");
      this.logger.log(`getProviderPriceRankingForModel: ${modelId} ranking (${results.length} providers):\n${ranking}`);
    } else {
      this.logger.log(`getProviderPriceRankingForModel: ${modelId} no providers found`);
    }

    return results;
  }

  /**
   * Get best-priced provider for a specific model
   */
  getBestProviderForModel(
    modelId: string,
    options: { torMode?: boolean; includeDisabled?: boolean } = {}
  ): string | null {
    const ranking = this.getProviderPriceRankingForModel(modelId, options);
    return ranking[0]?.baseUrl ?? null;
  }

  /**
   * Check if a provider accepts a specific mint
   */
  providerAcceptsMint(baseUrl: string, mintUrl: string): boolean {
    const providerMints = this.discoveryAdapter.getCachedMints()[normalizeBaseUrl(baseUrl)] || [];
    if (providerMints.length === 0) {
      // If no mints specified, provider accepts all
      return true;
    }
    return providerMints.includes(mintUrl);
  }

  /**
   * Get required sats for a model based on the request body shape.
   *
   * Estimates the deposit the node will demand before forwarding: the
   * node sizes its gate from the request itself (messages, Responses
   * input/instructions, serialized tools definitions, image content
   * with detail levels), so the SDK must count the same payloads or
   * every affected request bounces off a 402 into a topup round-trip.
   *
   * @param apiMessages chat-completions `messages` array (Responses
   *   requests pass [])
   * @param maxTokens max_tokens / max_output_tokens from the request
   * @param requestBody the full request body, used to count Responses
   *   input/instructions and tools definitions on both APIs
   */
  getRequiredSatsForModel(
    model: Model,
    apiMessages: any[],
    maxTokens?: number,
    requestBody?: Record<string, unknown>
  ): number {
    try {
      const body = requestBody ?? {};

      let imageTokens = 0;
      let textChars = 0;
      let sawPromptShape = false;
      let textEstimateUnknown = false;

      // Chat-completions shape: messages with content parts. Count only
      // the billed text content (string content, text parts, tool_calls
      // name+arguments) — not the serialized JSON envelope (keys, roles,
      // punctuation), which the node does not bill as prompt tokens. This
      // removes a ~3x envelope-inflation over-estimate on prose-heavy
      // chats while no longer under-counting agentic chats with many
      // tool_calls.
      if (Array.isArray(apiMessages) && apiMessages.length > 0) {
        sawPromptShape = true;
        imageTokens += countImageTokensInMessages(apiMessages);
        textChars += countMessageTextChars(apiMessages);
      }

      // Responses shape: input list (or plain string) — only when there
      // are no chat messages, matching the node's messages-first choice.
      const responsesInput = body.input;
      if (!sawPromptShape) {
        if (Array.isArray(responsesInput)) {
          sawPromptShape = true;
          imageTokens += countImageTokensInResponsesInput(responsesInput);
          const stripped = safeStringify(
            stripImagesFromResponsesInput(responsesInput)
          );
          if (stripped === null) {
            textEstimateUnknown = true;
          } else {
            textChars += stripped.length;
          }
        } else if (typeof responsesInput === "string") {
          sawPromptShape = true;
          textChars += responsesInput.length;
        }
      }

      // Responses developer instructions count like prompt text.
      const instructions = body.instructions;
      if (typeof instructions === "string" && instructions) {
        sawPromptShape = true;
        textChars += instructions.length;
      }

      // Tool definitions are serialized into the prompt and billed as
      // input tokens by the node, on both the chat and Responses APIs.
      const tools = body.tools;
      if (Array.isArray(tools) && tools.length > 0) {
        sawPromptShape = true;
        // Canonical compact serialization, matching the node's billed
        // tool-definition character count (indentation is not billed).
        const serialized = safeStringifyCompact(tools);
        if (serialized === null) {
          textEstimateUnknown = true;
        } else {
          textChars += serialized.length;
        }
      }

      // ~2.84 chars per token keeps the client estimate at or above the
      // node's ~3 chars/token heuristic, so the client reserves a small
      // conservative margin over the server's (authoritative) heuristic.
      const approximateTokens = textEstimateUnknown
        ? 10_000 // serialization failed; assume a full prompt
        : sawPromptShape
          ? Math.ceil(textChars / 2.84)
          : 10_000; // no recognizable prompt shape; minimum-balance assumption

      const totalInputTokens = approximateTokens + imageTokens;

      const sp: any = model?.sats_pricing as any;

      if (!sp) {
        return 0;
      }

      // If we don't have max_completion_cost, fall back to max_cost
      if (!sp.max_completion_cost) {
        return sp.max_cost ?? 50;
      }

      // Calculate based on token usage (similar to getTokenAmountForModel in apiUtils.ts)
      // Include the per-request base fee (sp.request) so that even a tiny
      // probe request (e.g. a 10-token health check) prices at least the
      // base fee.  Without this, a near-zero token count produces a
      // sub-sat total that Math.ceil rounds up to just 1 sat, leaving the
      // newly-created API key with a worthless balance.
      const requestFee = sp.request || 0;
      const promptCosts = (sp.prompt || 0) * totalInputTokens;
      let completionCost = sp.max_completion_cost;
      // Tinfoil/EHBP models encrypt the request body client-side, so the
      // proxy/enclave cannot enforce max_tokens yet. Never apply the maxTokens
      // completion discount for these models — always reserve max_completion_cost.
      if (maxTokens !== undefined && sp.completion && !isTinfoilModel(model.id)) {
        completionCost = sp.completion * maxTokens;
      }
      const totalEstimatedCosts = (promptCosts + completionCost + requestFee) * 1.05;

      // Cap at the pricing envelope. The node's gate is always <= max_cost
      // (it only discounts downward from the full envelope), so a capped
      // deposit still clears it. The cap was disabled while the node
      // mis-priced original-detail images with tile math; the node now uses
      // patch-based pricing for original detail, so it is safe again.
      if (
        typeof sp.max_cost === "number" &&
        totalEstimatedCosts > sp.max_cost
      ) {
        return sp.max_cost;
      }
      return totalEstimatedCosts;
    } catch (e) {
      this.logger.error("getRequiredSatsForModel error:", e);
      // Fall back to the model envelope rather than 0: a zero deposit is
      // always rejected by the node's minimum-balance gate and forces a
      // 402 topup round-trip.
      const sp = (model as Model)?.sats_pricing as any;
      return sp?.max_cost ?? 50;
    }
  }
}
