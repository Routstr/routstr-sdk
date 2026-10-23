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
import {
  canonicalizeModelId,
  findModelForId,
  modelIdVariants,
  MODEL_ID_MAPPINGS,
  type ModelIdMappings,
} from "../core/modelMappings";
import type { SdkStore } from "../storage/store";
import { isOnionUrl, isTorContext, normalizeProviderUrl } from "../utils/torUtils";
import {
  canonicalModelPath,
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URLS,
  getNodeModelPathsForModel,
  MODEL_PATHS_FETCH_TIMEOUT_MS,
  modelPathCandidateKey,
  resolveDeepSeekModelPathSelectors,
  type ModelPathSatsPricing,
} from "../utils/modelPaths";
import { isTinfoilModel } from "./TinfoilSecure";
import {
  estimateCost,
  hasUsableTokenRates,
  resolveBasket,
  WARM_COST_BASKET,
  type CostBasket,
  type CostEstimate,
  type CostRates,
} from "./costEstimate";

/**
 * Upper bound one auto-pin ranking waits for any single node's model paths.
 * Before this, the ranking awaited every node's fetch, so its latency was the
 * slowest node's 10 s abort — paid by every request while a node was slow.
 */
export const MODEL_PATH_RANKING_BUDGET_MS = 6_000;

/**
 * Backstop on a single warm lookup, derived from the per-spelling fetch
 * deadline rather than set beside it so the two cannot drift apart. That
 * deadline is the real ceiling — a fetch settles by it even when the runtime
 * ignores the abort (withProviderDeadline) — so this only fires if the inner
 * bound ever stops holding. Both are far above what a healthy pass costs.
 */
export const MODEL_PATH_WARM_BUDGET_MS = MODEL_PATHS_FETCH_TIMEOUT_MS + 5_000;

/** One (node, model) lookup of a warm pass. */
export interface ModelPathWarmResult {
  baseUrl: string;
  modelId: string;
  /**
   * Distinct routes the node advertises for the model, deduped across the
   * spellings the node filed them under (0 when unknown).
   */
  paths: number;
  /** Of those, how many are on the DeepSeek model-path whitelist. */
  whitelisted: number;
  elapsedMs: number;
  /**
   * Why this lookup contributed nothing: "invalid-url", "disabled",
   * "transport" (onion/clearnet mismatch), "no-catalog-model" (the node's
   * catalog does not carry the model, so no request would reach it), or
   * "unreachable" (the fetch failed or missed the budget). Absent on success.
   */
  reason?: string;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * One line for a warm pass, shaped for a refresh summary. Route counts are
 * summed per node (a node usually carries one auto-pinned model); failures
 * are grouped per node because a node that is down fails every model the
 * same way.
 */
export function formatModelPathWarmSummary(
  results: ModelPathWarmResult[]
): string {
  if (results.length === 0) return "model paths: no lookups";
  const ok = results.filter((r) => !r.reason);
  const perNode = new Map<string, number>();
  for (const result of ok) {
    perNode.set(result.baseUrl, (perNode.get(result.baseUrl) ?? 0) + result.whitelisted);
  }
  const parts = [`${ok.length}/${results.length} ok`];
  let routes = `${ok.reduce((n, r) => n + r.whitelisted, 0)} whitelisted route(s)`;
  if (perNode.size > 0) {
    routes += ` (${[...perNode.entries()]
      .map(([baseUrl, count]) => `${hostOf(baseUrl)} ${count}`)
      .join(", ")})`;
  }
  parts.push(routes);
  const failures = [
    ...new Set(
      results
        .filter((r) => r.reason)
        .map((r) => `${hostOf(r.baseUrl)}: ${r.reason}`)
    ),
  ];
  if (failures.length > 0) parts.push(`failed: ${failures.join(", ")}`);
  return `model paths: ${parts.join(", ")}`;
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

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
    // `/v1/info` also advertises the mints the provider accepts. Keep the
    // mint cache in sync here so consumers that only fetched provider info
    // still see the advertised mint list (and never spend a rejected mint).
    const advertisedMints = Array.isArray(info?.mints) ? info.mints : [];
    if (advertisedMints.length > 0) {
      const normalizedMints = advertisedMints.map((mint) =>
        mint.endsWith("/") ? mint.slice(0, -1) : mint,
      );
      adapter.setCachedMints({
        ...adapter.getCachedMints(),
        [normalized]: normalizedMints,
      });
    }
    return info;
  } catch (error) {
    logger.warn(`Failed to fetch provider info from ${normalized}:`, error);
    return null;
  }
};

/**
 * One provider priced against an explicit request basket.
 *
 * `cost` is what the basket would actually cost on this provider and is the
 * ranking key. `rates` and `breakdown` are kept so the decision stays
 * inspectable: which cache rate was used, whether the node advertised it, and
 * how the sats split across token classes.
 */
export interface ModelProviderPrice {
  baseUrl: string;
  model: Model;
  /** Sats the node would settle for the whole basket. */
  cost: number;
  /** The rates the cost was computed from, with provenance. */
  rates: CostRates;
  /** Per-class sats for the basket, plus the same `rates` it used. */
  breakdown: CostEstimate;
  /** The basket this entry was priced against. */
  basket: CostBasket;
}

/** Options shared by the price ranking and best-provider selection. */
export interface ProviderRankingOptions {
  torMode?: boolean;
  includeDisabled?: boolean;
  /**
   * Token split to price. Defaults to DEFAULT_COST_BASKET, which reproduces
   * the old prompt+completion per-million ordering exactly — pass a measured
   * basket to rank on what a real request costs.
   *
   * `cacheWriteRate` defaults to 0: a client cannot know how much of a prompt
   * an upstream will write to its cache, and the node only charges the write
   * rate for the tokens upstream reports as cache creation.
   */
  basket?: Partial<CostBasket>;
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
 * Count the billed text characters across a Responses API `input` list,
 * excluding the JSON envelope. Mirrors the node's
 * `estimate_tokens_from_input`: counts `input_text.text`,
 * `function_call.arguments`, `function_call_output.output`, the visible
 * `summary[].text` of `reasoning` items (NOT `encrypted_content`, whose
 * base64 overstates the reasoning tokens), message `content` strings, and
 * content-part `text` + `refusal`. Image parts contribute zero here (they
 * are priced separately as tokens).
 */
function countResponsesInputTextChars(input: any[]): number {
  if (!Array.isArray(input)) return 0;
  let total = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const itemType = item.type;

    if (itemType === "input_text") {
      total += textLength(item.text);
      continue;
    }
    if (itemType === "function_call") {
      total += textLength(item.arguments);
      continue;
    }
    if (itemType === "function_call_output") {
      total += textLength(item.output);
      continue;
    }
    if (itemType === "reasoning") {
      const summary = item.summary;
      if (Array.isArray(summary)) {
        for (const part of summary) {
          if (part && typeof part === "object") {
            total += textLength(part.text);
          }
        }
      }
      // fall through to also count content (below)
    }

    const content = item.content;
    if (typeof content === "string") {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        total += textLength(part.text);
        if (typeof part.refusal === "string") {
          total += part.refusal.length;
        }
      }
    }
  }
  return total;
}

/**
 * Node tolerance assumption for the gate calculation.
 *
 * Mirrors the default of routstr-core's `tolerance_percentage` setting, the
 * only value the SDK can assume: the node's configured tolerance is not
 * advertised anywhere in `/v1/models`. The reserve keeps a further margin on
 * top of the resulting gate, so a node running a slightly different tolerance
 * still ends up funded.
 */
const NODE_TOLERANCE_PERCENT = 1;

/**
 * Sum the length of every string in a value tree, keys included.
 *
 * Port of routstr-core `_sum_string_chars`. Nothing is excluded, because the
 * node excludes nothing: inline image data counts as text too, which is the
 * whole reason a request carrying a base64 image can no longer have its
 * prompt budget discounted (and therefore reserves its full prompt
 * allowance).
 */
function sumStringChars(node: unknown): number {
  if (typeof node === "string") return node.length;
  if (Array.isArray(node)) {
    return node.reduce<number>((total, item) => total + sumStringChars(item), 0);
  }
  if (node && typeof node === "object") {
    let total = 0;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      total += key.length + sumStringChars(value);
    }
    return total;
  }
  return 0;
}

/**
 * Count integer entries in a legacy completions `prompt` array.
 *
 * Port of routstr-core `_count_prompt_token_ids` (booleans are not token IDs).
 */
function countPromptTokenIds(node: unknown): number {
  if (typeof node === "number" && Number.isInteger(node)) return 1;
  if (Array.isArray(node)) {
    return node.reduce<number>((total, item) => total + countPromptTokenIds(item), 0);
  }
  return 0;
}

/**
 * Port of routstr-core `estimate_prompt_tokens`: every string in the
 * provider-bound body counts, summed over the whole tree and integer-divided
 * by three.
 *
 * JS `.length` counts UTF-16 code units where Python `len()` counts code
 * points, so astral characters (emoji) are counted slightly higher here. That
 * direction is safe: a larger prompt count means a smaller prompt discount,
 * hence a larger gate.
 */
function estimateNodePromptTokens(body: Record<string, unknown>): number {
  return Math.floor(sumStringChars(body) / 3) + countPromptTokenIds(body?.prompt);
}

/**
 * The completion cap a request declares, whichever spelling it uses.
 *
 * `max_tokens` (legacy chat), `max_completion_tokens` (modern chat) and
 * `max_output_tokens` (Responses API) are interchangeable names for the same
 * limit. When a body sets more than one, the **largest** wins — the same rule
 * routstr-core reserves against, because upstream precedence between the
 * fields varies by provider and the smaller cap may not be honored. Pricing
 * against the smaller one under-deposits against the node's gate.
 *
 * Returns `undefined` when the request declares no usable cap, in which case
 * the node discounts nothing and the reservation stays at the full envelope.
 */
export function completionCapFromBody(
  body: Record<string, unknown> | undefined
): number | undefined {
  if (!body) return undefined;

  let cap: number | undefined;
  for (const field of [
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
  ]) {
    const raw = body[field];
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(value)) continue;
    cap = cap === undefined ? value : Math.max(cap, value);
  }
  return cap;
}

const PICTURE_MEGAPIXELS: Readonly<Record<string, number>> = {
  "512": 0.25,
  "1K": 1,
  "2K": 4,
  "4K": 16,
};
const PICTURE_REFERENCE_FIELDS = [
  "input_references",
  "reference_images",
  "style_references",
  "image",
  "image_url",
];

function pictureEdges(body: Record<string, unknown>): number[] {
  if (typeof body.size === "string" && body.size.toLowerCase().includes("x")) {
    const edges = body.size.toLowerCase().split("x").map(Number);
    return edges.every(Number.isInteger) ? edges : [];
  }
  return [body.width, body.height].filter((edge): edge is number =>
    Number.isInteger(edge)
  );
}

function pictureResolution(body: Record<string, unknown>): string | undefined {
  if (typeof body.resolution === "string" && body.resolution)
    return body.resolution.toUpperCase();
  const edges = pictureEdges(body);
  if (edges.length === 0) return undefined;
  const area = edges.reduce((product, edge) => product * edge, 1);
  return area < 2 * 1024 * 1024 ? "1K" : area < 2 * 2048 * 2048 ? "2K" : "4K";
}

function pictureTierUsd(book: any, body: Record<string, unknown>): number {
  const resolution = pictureResolution(body);
  const quality =
    typeof body.quality === "string" && body.quality
      ? body.quality.toLowerCase()
      : undefined;
  const declared = (
    values: string[] | undefined,
    value: string | undefined,
    normal: (v: string) => string
  ) => !value || !values?.length || values.map(normal).includes(value);
  if (!declared(book.resolutions, resolution, (v) => v.toUpperCase()))
    return book.max_usd;
  if (!declared(book.qualities, quality, (v) => v.toLowerCase()))
    return book.max_usd;
  const wanted = resolution ?? book.default_resolution ?? null;
  for (const wantedQuality of [quality ?? book.default_quality ?? null, null]) {
    const tier = (book.tiers ?? []).find(
      (t: any) =>
        (t.resolution ?? null) === wanted &&
        (t.quality ?? null) === wantedQuality
    );
    if (tier) return tier.usd;
  }
  return book.max_usd;
}

function pictureHoldSats(
  model: Model,
  body: Record<string, unknown>
): number | undefined {
  const outputs = model.architecture?.output_modalities;
  const ceiling = (model.sats_pricing as any)?.image_output;
  if (outputs?.length !== 1 || outputs[0] !== "image" || !(ceiling > 0))
    return undefined;
  if (PICTURE_REFERENCE_FIELDS.some((field) => body[field])) return undefined;

  let perPicture = ceiling;
  const book = (model as any).image_pricing;
  if (book?.max_usd > 0) {
    const satsPerUsd = ceiling / book.max_usd;
    if (book.unit === "image") {
      perPicture = satsPerUsd * pictureTierUsd(book, body);
    } else if (
      book.unit === "megapixel" &&
      book.megapixel_usd > 0 &&
      !("steps" in body)
    ) {
      const edges = pictureEdges(body);
      const megapixels =
        edges.length > 0
          ? (edges[0] * (edges[1] ?? edges[0])) / 1_000_000
          : (PICTURE_MEGAPIXELS[pictureResolution(body) ?? "1K"] ?? 1);
      perPicture = satsPerUsd * megapixels * book.megapixel_usd;
    } else {
      return undefined;
    }
  }
  return (
    Math.max(1, Number(body.n) || 1, Number(body.variants) || 1) * perPicture
  );
}

/**
 * Port of the node's minimum-balance gate
 * (`routstr/payment/helpers.py:calculate_discounted_max_cost`), in sats.
 *
 * The node does not price a request by summing components; it gates on a
 * discounted envelope:
 *
 *     gate = max_cost * tolerance
 *          - max(0, prompt_allowance - prompt_tokens * prompt_price)
 *          - max(0, max_completion_cost * tolerance - max_tokens * completion_price)
 *
 * Two details of that formula are easy to miss on the client, and both of
 * them caused under-reserved deposits:
 *
 *  - The prompt side is only discounted while the node's prompt-token count
 *    fits inside the allowed prompt budget. That count covers the entire
 *    body, and inline base64 image data is counted as text, so *any* request
 *    carrying an image blows past the budget and the node keeps its whole
 *    prompt allowance reserved. Pricing the prompt from a stripped local text
 *    estimate reserves far less than the gate.
 *  - The completion discount comes from the **largest** cap the request
 *    declares across `max_tokens`, `max_completion_tokens` and
 *    `max_output_tokens`, matching the node's `calculate_discounted_max_cost`.
 *    The node takes the largest because upstream precedence between the
 *    fields varies by provider, so a smaller declared cap may not be honored;
 *    reserving against it would under-cover the bill.
 */
function nodeGateSats(
  model: Model,
  satsPricing: any,
  requestBody: Record<string, unknown>,
  imageTokens: number
): number {
  const maxCost = satsPricing?.max_cost;
  if (typeof maxCost !== "number" || !Number.isFinite(maxCost)) return 0;

  const toleranceFactor = 1 - NODE_TOLERANCE_PERCENT / 100;
  const promptPrice =
    typeof satsPricing.prompt === "number" ? satsPricing.prompt : 0;
  const completionPrice =
    typeof satsPricing.completion === "number" ? satsPricing.completion : 0;

  // `get_max_cost_for_model` truncates the envelope to whole millisats and
  // floors it at `min_request_msat` (1).
  let gateMsats = Math.max(1, Math.floor(maxCost * 1000 * toleranceFactor));

  // Prompt allowance: the node starts from `max_prompt_cost` and replaces it
  // with the model's *token* budget x price whenever it can derive one.
  let promptAllowanceSats =
    typeof satsPricing.max_prompt_cost === "number"
      ? satsPricing.max_prompt_cost * toleranceFactor
      : 0;

  const topProvider: any = (model as any)?.top_provider;
  const providerContextLength = topProvider?.context_length;
  const providerMaxCompletion = topProvider?.max_completion_tokens;
  let promptTokenLimit: number | undefined;

  if (topProvider && (providerContextLength || providerMaxCompletion)) {
    if (providerContextLength && providerMaxCompletion) {
      promptTokenLimit = Math.max(0, providerContextLength - providerMaxCompletion);
    } else if (providerContextLength) {
      promptTokenLimit = providerContextLength;
    } else {
      promptTokenLimit = 0;
    }
  } else if ((model as any)?.context_length) {
    promptTokenLimit = (model as any).context_length;
  }

  if (promptTokenLimit !== undefined) {
    promptAllowanceSats = promptTokenLimit * promptPrice * toleranceFactor;
  }

  // Images are added as a separate term by the node, and only for chat
  // `messages` (Responses input images are already inside the body count).
  const promptTokens =
    estimateNodePromptTokens(requestBody) +
    (Array.isArray((requestBody as any)?.messages) ? imageTokens : 0);

  if (promptTokens > 0) {
    const unusedPromptBudget = promptAllowanceSats - promptTokens * promptPrice;
    if (unusedPromptBudget > 0) {
      gateMsats -= Math.floor(unusedPromptBudget * 1000);
    }
  }

  // Completion budget: the largest cap the request declares, across all
  // three interchangeable spellings. EHBP/Tinfoil bodies are sealed, so the
  // node cannot read a budget out of them at all.
  const parsedMaxTokens = completionCapFromBody(requestBody);

  if (
    parsedMaxTokens !== undefined &&
    parsedMaxTokens > 0 &&
    typeof satsPricing?.max_completion_cost === "number" &&
    completionPrice > 0 &&
    !isTinfoilModel(model.id)
  ) {
    const unusedCompletionBudget =
      satsPricing.max_completion_cost * toleranceFactor -
      parsedMaxTokens * completionPrice;
    if (unusedCompletionBudget > 0) {
      gateMsats -= Math.floor(unusedCompletionBudget * 1000);
    }
  }

  return Math.max(gateMsats, 1) / 1000;
}

/**
 * A cooldown entry. When `modelId` is present, only that model is cooled
 * down on the provider; other models on the same provider stay selectable.
 * When `modelId` is undefined, the whole provider is on cooldown.
 */
export interface CooldownEntry {
  baseUrl: string;
  modelId?: string;
  /**
   * Canonical x-routstr-model-path identity (see canonicalModelPath) for
   * path-scoped entries: only that upstream route is cooled on the provider,
   * the provider's other routes for the same model stay selectable.
   */
  modelPath?: string;
  timestamp: number;
  /** Absolute expiry; legacy entries use timestamp + 210 seconds. */
  cooldownUntil?: number;
}

interface FailureStreak {
  baseUrl: string;
  modelId?: string;
  modelPath?: string;
  failureStreak: number;
  /** When this scope last failed; forgotten streaks are pruned by age. */
  failedAt?: number;
}

/**
 * Map key for a cooldown entry: `baseUrl` for provider-scoped entries,
 * `baseUrl::<canonical modelId>` for model-scoped entries. Callers resolve
 * the id against the active discovery mapping snapshot before building a key,
 * `baseUrl::path::<canonical path>` for path-scoped entries. (A fourth
 * scope — a path cooled across every node for upstream-wide outages — is a
 * deliberate future extension, not implemented.)
 */
const cooldownKey = (
  baseUrl: string,
  modelId?: string,
  modelPath?: string
): string =>
  modelPath != null
    ? `${baseUrl}::path::${modelPath}`
    : modelId != null
      ? `${baseUrl}::${modelId}`
      : baseUrl;

/**
 * ProviderManager handles provider selection and failover
 */
export class ProviderManager {
  private failedProviders = new Set<string>();
  /** Track when each scope (provider URL or baseUrl::modelId) last failed */
  private lastFailed = new Map<string, number>();
  /** Cooldown entries keyed by cooldownKey(baseUrl, modelId) */
  private failureStreaks = new Map<string, FailureStreak>();
  /** Discovery snapshot the streak map was last re-keyed against */
  private streakMappingSnapshot: ModelIdMappings | null = null;
  /** Last time the streak map was swept; see STREAK_SWEEP_INTERVAL_MS */
  private lastStreakSweepAt = 0;
  private providersOnCoolDown = new Map<string, CooldownEntry>();
  /** Cooldown duration in milliseconds (210 seconds) */
  private static readonly COOLDOWN_DURATION_MS = 210 * 1000;
  /**
   * A scope that has not failed for this long is forgotten and starts over at
   * the first-failure cooldown. Streaks outlive their cooldowns by design, so
   * nothing else would ever remove one: without this the map grows for the
   * whole life of the client and every cooldown check pays for it. Must stay
   * well above the maximum cooldown (10 minutes) so a scope keeps its streak
   * across its own cooldown window.
   */
  private static readonly STREAK_RETENTION_MS = 6 * 60 * 60 * 1000;
  /**
   * How often forgotten streaks are swept. Re-keying against the discovery
   * mapping snapshot is cheap to detect but costs a full pass over the map,
   * so it runs on this interval or when the snapshot itself is replaced.
   */
  private static readonly STREAK_SWEEP_INTERVAL_MS = 60 * 1000;
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

  /** Active signed snapshot; null/missing getter alone enables bootstrap fallback. */
  getModelIdMappings(): ModelIdMappings {
    return this.discoveryAdapter.getModelIdMappings?.() ?? MODEL_ID_MAPPINGS;
  }

  canonicalizeModelId(modelId: string): string {
    return canonicalizeModelId(modelId, this.getModelIdMappings());
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

    for (const entry of state.modelFailureStreaks ?? []) {
      const modelId = entry.modelId === undefined ? undefined : this.canonicalizeModelId(entry.modelId);
      const baseUrl = normalizeBaseUrl(entry.baseUrl);
      const key = cooldownKey(baseUrl, modelId, entry.modelPath);
      const previous = this.failureStreaks.get(key);
      if (!previous || previous.failureStreak < entry.failureStreak) {
        // Entries written before streaks carried a timestamp get a fresh
        // retention window rather than being dropped on sight.
        this.failureStreaks.set(key, { ...entry, baseUrl, modelId, failedAt: entry.failedAt ?? Date.now() });
      }
    }
    this.streakMappingSnapshot = this.getModelIdMappings();

    // Hydrate all entries; normal cleanup releases expired providers too.
    // Entries persisted before model ids were canonicalized may carry a
    // variant spelling; they are re-keyed (and re-labelled) canonically so a
    // legacy "claude-opus-5-5" entry still blocks "claude-opus-5.5". If a
    // legacy and a canonical entry collide, the newer timestamp wins.
    this.providersOnCoolDown = new Map();
    for (const entry of state.providersOnCooldown) {
      const modelId =
        entry.modelId !== undefined
          ? this.canonicalizeModelId(entry.modelId)
          : undefined;
      const key = cooldownKey(normalizeBaseUrl(entry.baseUrl), modelId, entry.modelPath);
      const existing = this.providersOnCoolDown.get(key);
      if (existing && existing.timestamp >= entry.timestamp) continue;
      this.providersOnCoolDown.set(key, {
        baseUrl: normalizeBaseUrl(entry.baseUrl),
        modelId,
        modelPath: entry.modelPath,
        timestamp: entry.timestamp,
        cooldownUntil: entry.cooldownUntil,
      });
    }
    this.cleanupExpiredCooldowns();
  }

  /**
   * Remove a persisted cooldown entry under every spelling of its model id,
   * so entries written before canonicalization are cleaned up too.
   */
  private removeStoredCooldown(
    baseUrl: string,
    modelId?: string,
    modelPath?: string
  ): void {
    if (!this.store) return;
    if (modelPath !== undefined) {
      // A path key is provider + path, independent of its model label.
      this.store.getState().removeProviderFromCooldown(baseUrl, modelId, modelPath);
      return;
    }
    const ids: Array<string | undefined> = modelId === undefined ? [undefined] : modelIdVariants(modelId, this.getModelIdMappings());
    for (const entry of this.store.getState().providersOnCooldown) {
      if (entry.baseUrl === baseUrl && entry.modelPath === modelPath &&
          entry.modelId !== undefined && modelId !== undefined &&
          this.canonicalizeModelId(entry.modelId) === modelId && !ids.includes(entry.modelId)) {
        ids.push(entry.modelId);
      }
    }
    for (const id of ids) {
      this.store.getState().removeProviderFromCooldown(baseUrl, id, modelPath);
    }
  }

  /**
   * Get instance ID for debugging
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Clean up expired cooldown entries
   * Also removes the provider from failedProviders (once none of its
   * cooldown entries remain) so it can be retried
   */
  private cleanupExpiredCooldowns(): void {
    // Discovery can accept a signed snapshot after this manager was created.
    // Re-key existing native-id strikes/cooldowns using the active snapshot,
    // including legacy persisted entries hydrated before mappings arrived.
    const cooldowns = new Map<string, CooldownEntry>();
    for (const entry of this.providersOnCoolDown.values()) {
      const modelId = entry.modelId === undefined
        ? undefined : this.canonicalizeModelId(entry.modelId);
      const key = cooldownKey(entry.baseUrl, modelId, entry.modelPath);
      const previous = cooldowns.get(key);
      if (!previous || previous.timestamp < entry.timestamp) {
        cooldowns.set(key, { ...entry, modelId });
      }
    }
    this.providersOnCoolDown = cooldowns;

    const strikes = new Map<string, number>();
    for (const [key, timestamp] of this.lastFailed) {
      const separator = key.lastIndexOf("::");
      const canonicalKey = separator < 0 || key.includes("::path::")
        ? key
        : cooldownKey(key.slice(0, separator), this.canonicalizeModelId(key.slice(separator + 2)));
      strikes.set(canonicalKey, Math.max(strikes.get(canonicalKey) ?? 0, timestamp));
    }
    this.lastFailed = strikes;
    const now = Date.now();
    const expiredProviders = new Set<string>();
    for (const [key, entry] of this.providersOnCoolDown) {
      if (now >= (entry.cooldownUntil ?? entry.timestamp + ProviderManager.COOLDOWN_DURATION_MS)) {
        this.providersOnCoolDown.delete(key);
        expiredProviders.add(entry.baseUrl);
        // Persist the removal of this exact entry (other entries for the
        // same provider, e.g. still-live model-scoped ones, are kept)
        this.removeStoredCooldown(entry.baseUrl, entry.modelId, entry.modelPath);
      }
    }

    // Prune strike timestamps older than the cooldown window: they can no
    // longer combine with a fresh failure into a two-strike cooldown, and
    // pruning keeps the per-scope map bounded.
    for (const [key, ts] of this.lastFailed) {
      if (now - ts >= ProviderManager.COOLDOWN_DURATION_MS) {
        this.lastFailed.delete(key);
      }
    }

    this.sweepFailureStreaks(now);

    // Remove providers from failedProviders once they have no active
    // cooldown entries left, so they can be retried
    for (const baseUrl of expiredProviders) {
      const stillCooled = [...this.providersOnCoolDown.values()].some(
        (entry) => entry.baseUrl === baseUrl
      );
      if (!stillCooled) {
        this.failedProviders.delete(baseUrl);
        if (this.store) {
          this.store.getState().removeFailedProvider(baseUrl);
        }
      }
    }
  }

  /**
   * Get the cooldown duration in milliseconds
   */
  getCooldownDurationMs(): number {
    return ProviderManager.COOLDOWN_DURATION_MS;
  }

  /**
   * Check if a provider is currently on cooldown
   *
   * A provider-scoped cooldown entry blocks every model on the provider.
   * A model-scoped entry only blocks the given `modelId`; a path-scoped
   * entry only blocks the given canonical `modelPath`. Pass `modelId` and/or
   * `modelPath` to check a specific scope, or omit both to check whether the
   * provider as a whole is unavailable.
   */
  isOnCooldown(baseUrl: string, modelId?: string, modelPath?: string): boolean {
    baseUrl = normalizeBaseUrl(baseUrl);
    this.cleanupExpiredCooldowns();
    if (modelId !== undefined) modelId = this.canonicalizeModelId(modelId);

    // Provider-wide cooldown blocks all models
    if (this.providersOnCoolDown.has(cooldownKey(baseUrl))) {
      return true;
    }
    // Model-scoped cooldown blocks only that model
    if (
      modelId !== undefined &&
      this.providersOnCoolDown.has(cooldownKey(baseUrl, modelId))
    ) {
      return true;
    }
    // Path-scoped cooldown blocks only that upstream route
    if (
      modelPath !== undefined &&
      this.providersOnCoolDown.has(cooldownKey(baseUrl, undefined, modelPath))
    ) {
      return true;
    }
    return false;
  }

  /**
   * Get all cooldown entries currently active (provider- and model-scoped)
   */
  getProvidersOnCooldown(): CooldownEntry[] {
    this.cleanupExpiredCooldowns();
    return [...this.providersOnCoolDown.values()];
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
   * Mark a provider (optionally a specific model or model path on it) as
   * failed
   *
   * Model/path failures immediately cool down for 10 seconds, doubling on
   * consecutive failures up to 10 minutes. Provider-wide failures retain
   * the legacy two-strike, 210-second policy:
   * - With `modelPath`: only that upstream route is cooled down on the
   *   provider (the canonical path identity, see canonicalModelPath).
   * - With `modelId` only: only that model is cooled down on the provider.
   * - Without either: the whole provider is cooled down (legacy behavior).
   */
  markFailed(
    baseUrl: string,
    reason?: string,
    modelId?: string,
    modelPath?: string
  ): void {
    baseUrl = normalizeBaseUrl(baseUrl);
    // Drop expired entries first so a stale entry can't suppress a fresh
    // second-strike cooldown for the same scope
    this.cleanupExpiredCooldowns();
    // Canonicalize so a native/variant spelling strikes the same scope the
    // ranking checks (e.g. claude-opus-5-5 vs claude-opus-5.5).
    if (modelId !== undefined) modelId = this.canonicalizeModelId(modelId);
    const now = Date.now();
    const key = cooldownKey(baseUrl, modelId, modelPath);
    const lastFailure = this.lastFailed.get(key);

    // Track this failure in memory
    this.lastFailed.set(key, now);
    this.failedProviders.add(baseUrl);

    // Persist to store. Model- and path-scoped strike counts stay in-memory
    // only; the cooldown entries themselves are persisted, so cross-restart
    // behavior is preserved once a cooldown actually triggers.
    if (this.store) {
      if (modelId === undefined && modelPath === undefined) {
        this.store.getState().setLastFailedTimestamp(baseUrl, now);
      }
      this.store.getState().addFailedProvider(baseUrl);
    }

    if (modelId !== undefined || modelPath !== undefined) {
      const failureStreak = Math.min((this.failureStreaks.get(key)?.failureStreak ?? 0) + 1, Number.MAX_SAFE_INTEGER);
      this.failureStreaks.set(key, { baseUrl, modelId, modelPath, failureStreak, failedAt: now });
      this.persistFailureStreaks();
      const cooldownUntil = now + Math.min(10_000 * 2 ** Math.min(failureStreak - 1, 6), 600_000);
      this.providersOnCoolDown.set(key, { baseUrl, modelId, modelPath, timestamp: now, cooldownUntil });
      this.store?.getState().addProviderOnCooldown(baseUrl, now, modelId, modelPath, cooldownUntil);
      return;
    }

    // Check if this is a second failure within the cooldown window
    if (
      lastFailure !== undefined &&
      now - lastFailure < ProviderManager.COOLDOWN_DURATION_MS
    ) {
      // Second failure within the window - add this scope to cooldown
      if (!this.providersOnCoolDown.has(key)) {
        this.providersOnCoolDown.set(key, {
          baseUrl,
          modelId,
          modelPath,
          timestamp: now,
        });
        // Persist to store
        if (this.store) {
          this.store
            .getState()
            .addProviderOnCooldown(baseUrl, now, modelId, modelPath);
        }
      }
    }
  }

  /**
   * Manually unblock a provider without resetting failure history.
   * Use recordSuccess to reset the exact successful scope.
   *
   * With `modelPath`, only that path's cooldown entry is removed; with
   * `modelId` only, only that model's entry; without either, every cooldown
   * entry for the provider is removed.
   */
  removeFromCooldown(baseUrl: string, modelId?: string, modelPath?: string): void {
    baseUrl = normalizeBaseUrl(baseUrl);
    this.cleanupExpiredCooldowns();
    if (modelId !== undefined) modelId = this.canonicalizeModelId(modelId);
    if (modelId === undefined && modelPath === undefined) {
      for (const [key, entry] of [...this.providersOnCoolDown]) {
        if (entry.baseUrl === baseUrl) {
          this.providersOnCoolDown.delete(key);
        }
      }
    } else {
      this.providersOnCoolDown.delete(cooldownKey(baseUrl, modelId, modelPath));
    }
    // Persist to store
    if (this.store) {
      if (modelId === undefined && modelPath === undefined) {
        this.store.getState().removeAllProviderCooldowns(baseUrl);
      } else {
        this.removeStoredCooldown(baseUrl, modelId, modelPath);
      }
    }
  }

  /**
   * Re-key streaks against the active discovery snapshot and drop scopes that
   * have not failed for STREAK_RETENTION_MS. Guarded twice so the common call
   * is O(1): the pass only runs when the mapping snapshot was replaced or the
   * sweep interval elapsed. Nothing is written unless the pass changed
   * something.
   */
  private sweepFailureStreaks(now: number): void {
    const mappings = this.getModelIdMappings();
    if (
      mappings === this.streakMappingSnapshot &&
      now - this.lastStreakSweepAt < ProviderManager.STREAK_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    this.streakMappingSnapshot = mappings;
    this.lastStreakSweepAt = now;

    const cutoff = now - ProviderManager.STREAK_RETENTION_MS;
    const streaks = new Map<string, FailureStreak>();
    let changed = false;
    for (const [previousKey, entry] of this.failureStreaks) {
      const failedAt = entry.failedAt ?? now;
      if (failedAt <= cutoff) {
        changed = true;
        continue;
      }
      const modelId =
        entry.modelId === undefined
          ? undefined
          : this.canonicalizeModelId(entry.modelId);
      const key = cooldownKey(entry.baseUrl, modelId, entry.modelPath);
      const previous = streaks.get(key);
      if (previous) {
        // Aliases are one scope: keep the longest streak and its latest
        // failure.
        changed = true;
        previous.failureStreak = Math.max(previous.failureStreak, entry.failureStreak);
        previous.failedAt = Math.max(previous.failedAt ?? failedAt, failedAt);
        continue;
      }
      streaks.set(key, { ...entry, modelId, failedAt });
      if (key !== previousKey || modelId !== entry.modelId) changed = true;
    }
    if (!changed) return;
    this.failureStreaks = streaks;
    this.persistFailureStreaks();
  }

  private persistFailureStreaks(): void {
    this.store?.getState().setModelFailureStreaks?.([...this.failureStreaks.values()]);
  }

  /** Reset only the successful scope. An unscoped success resets provider-wide
   * history only; it never clears model/path streaks on the same provider. */
  recordSuccess(baseUrl: string, modelId?: string, modelPath?: string): void {
    baseUrl = normalizeBaseUrl(baseUrl);
    this.cleanupExpiredCooldowns();
    if (modelId !== undefined) modelId = this.canonicalizeModelId(modelId);
    const key = cooldownKey(baseUrl, modelId, modelPath);
    const hadStreak = this.failureStreaks.delete(key);
    this.lastFailed.delete(key);
    const hadCooldown = this.providersOnCoolDown.delete(key);
    // recordSuccess fires on every successful request, so only write through
    // when this success actually cleared something; an unconditional persist
    // would rewrite the whole streak/cooldown arrays per request.
    if (hadStreak) this.persistFailureStreaks();
    if (hadCooldown) this.removeStoredCooldown(baseUrl, modelId, modelPath);
    if (modelId === undefined && modelPath === undefined) {
      const lastFailed = { ...this.store?.getState().lastFailed };
      delete lastFailed[baseUrl];
      this.store?.getState().setLastFailed(lastFailed);
    }
    if (
      this.failedProviders.has(baseUrl) &&
      ![...this.providersOnCoolDown.values()].some((entry) => entry.baseUrl === baseUrl)
    ) {
      this.failedProviders.delete(baseUrl);
      this.store?.getState().removeFailedProvider(baseUrl);
    }
  }

  /**
   * Clear all cooldown tracking
   */
  clearCooldowns(): void {
    this.providersOnCoolDown.clear();
    // Persist to store
    if (this.store) {
      this.store.getState().clearProvidersOnCooldown();
    }
  }

  /**
   * Clear all failure tracking (timestamps and consecutive scoped streaks).
   * Active cooldowns are left intact.
   */
  clearFailureHistory(): void {
    this.lastFailed.clear();
    this.failureStreaks.clear();
    this.persistFailureStreaks();
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
   * Find the next best provider for a model.
   *
   * Failover ranks exactly like initial selection: it asks
   * `getProviderPriceRankingForModel` for the ranking and then filters that
   * list down to the candidates this request can still use — the node being
   * failed over from, nodes already attempted, and nodes whose advertised
   * mints the wallet cannot fund. Filtering preserves the ranking's order, so
   * the first survivor is the cheapest usable provider under the same basket
   * and the same tiebreak routing uses.
   *
   * @param modelId The model ID to find a provider for
   * @param currentBaseUrl The current provider to exclude
   * @param attemptedProviders Request-local exclusions to prevent revisiting nodes
   * @returns The best provider URL or null if none available
   */
  findNextBestProvider(
    modelId: string,
    currentBaseUrl: string,
    attemptedProviders: ReadonlySet<string> = new Set(),
    options: { acceptableMintUrls?: string[] } = {}
  ): string | null {
    try {
      // Empty when the wallet knows no funded mint; providerAcceptsAnyMint
      // then fails open, so a cold wallet never blocks failover.
      const acceptableMints = options.acceptableMintUrls ?? [];

      const next = this.getProviderPriceRankingForModel(modelId, {
        torMode: isTorContext(),
        // The same basket routing ranks on, so a failover hop and the initial
        // pick agree on which node is cheapest.
        basket: WARM_COST_BASKET,
      }).find(
        ({ baseUrl }) =>
          baseUrl !== currentBaseUrl &&
          !attemptedProviders.has(baseUrl) &&
          this.providerAcceptsAnyMint(baseUrl, acceptableMints)
      );

      return next?.baseUrl ?? null;
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
    // Canonicalize so a node listing only the canonical spelling is found
    // from a provider-native variant id and vice versa. Both spellings on one
    // node resolve to the canonical entry.
    modelId = this.canonicalizeModelId(modelId);
    // Get models for this provider
    const models = this.discoveryAdapter.getCachedModels()[normalizeBaseUrl(baseUrl)] || [];

    // First try exact or mapped (variant/alias) match
    const mappedMatch = findModelForId(models, modelId, this.getModelIdMappings());
    if (mappedMatch) return mappedMatch;

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
   * Ranked DeepSeek model-path candidates for automatic pinning
   * ("get baseUrl for model path").
   *
   * One entry per whitelisted node that (a) is enabled and not cooled down
   * for the model, and (b) advertises at least one whitelisted route for it
   * on GET /v1/models/paths. Entries are sorted by what the node's best
   * available route costs for WARM_COST_BASKET — the same key
   * getProviderPriceRankingForModel (and therefore the fallback ranking
   * routing lands on) sorts on, so the pinned node and the unpinned pick
   * agree. Ties break on baseUrl. Within an entry, `selectors` and
   * `satsPricing` are in whitelist preference order with cooled-down routes
   * (and `excludeModelPaths` candidates) removed — the failover chain is
   * node-major: every route of the cheapest node before the next node.
   */
  async getModelPathProviderRanking(
    modelId: string,
    options: {
      torMode?: boolean;
      excludeBaseUrl?: string;
      excludeBaseUrls?: ReadonlySet<string>;
      acceptableMintUrls?: string[];
      /**
       * Candidate keys (see modelPathCandidateKey) already attempted in
       * this request. Request-local exclusions preserve failover progress
       * independently of cooldown expiry or failure-policy exclusions.
       */
      excludeModelPaths?: Iterable<string>;
    } = {}
  ): Promise<
    Array<{
      baseUrl: string;
      selectors: string[];
      satsPricing: Array<ModelPathSatsPricing | null>;
      model: Model;
    }>
  > {
    modelId = this.canonicalizeModelId(modelId);
    const torMode = options.torMode ?? isTorContext();
    const excludedModelPaths = new Set(options.excludeModelPaths ?? []);
    const disabledProviders = new Set(
      this.discoveryAdapter.getDisabledProviders()
    );
    const allModels = this.discoveryAdapter.getCachedModels();

    const candidates = await Promise.all(
      DEEPSEEK_AUTO_NODE_URLS.map(async (nodeUrl) => {
        const baseUrl = normalizeProviderUrl(nodeUrl);
        if (!baseUrl) return null;
        if (options.excludeBaseUrl && baseUrl === options.excludeBaseUrl) {
          return null;
        }
        if (options.excludeBaseUrls?.has(baseUrl)) return null;
        if (
          options.acceptableMintUrls &&
          !this.providerAcceptsAnyMint(baseUrl, options.acceptableMintUrls)
        ) return null;
        if (disabledProviders.has(baseUrl)) return null;
        // Enforce the transport invariant both ways (same as
        // getProviderPriceRankingForModel): Tor mode is onion-only, clearnet
        // mode never touches onion nodes. The auto-selection nodes are
        // clearnet today, so Tor mode gets an empty ranking here and
        // degrades to the normal onion-only price ranking (unpinned).
        if (torMode && !isOnionUrl(baseUrl)) return null;
        if (!torMode && isOnionUrl(baseUrl)) return null;
        if (this.isOnCooldown(baseUrl, modelId)) return null;

        const model = findModelForId(
          allModels[baseUrl] || [], modelId, this.getModelIdMappings()
        );
        if (!model) return null;

        // Per-model lookup (kilobytes), cached with stale-while-revalidate,
        // in-flight dedupe and negative caching; raced against a ranking
        // budget so one slow or hung node cannot stall every request. A node
        // that misses the budget is skipped for this ranking only — its
        // fetch keeps running and fills the cache for the next request.
        const nodePaths = await withBudget(
          getNodeModelPathsForModel(baseUrl, modelId, {
            mappings: this.getModelIdMappings(),
            extraSpellings: [model.id, ...(model.alias_ids ?? [])],
          }),
          MODEL_PATH_RANKING_BUDGET_MS
        );
        if (!nodePaths) return null;
        const resolved = resolveDeepSeekModelPathSelectors(
          nodePaths,
          modelId,
          this.getModelIdMappings()
        );
        if (!resolved) return null;

        // Whitelist order, dropping routes this node has on path-scoped
        // cooldown (or does not advertise at all).
        const available: Array<{
          selector: string;
          pricing: ModelPathSatsPricing | null;
        }> = [];
        for (let i = 0; i < resolved.selectors.length; i++) {
          const selector = resolved.selectors[i];
          if (!selector) continue;
          const pathId = canonicalModelPath(selector);
          // An attempted route may have just earned its first cooldown.
          // Keep it for this request's node-ranking price anchor, but the
          // request-local exclusion below still prevents selecting it again.
          const alreadyAttempted = excludedModelPaths.has(modelPathCandidateKey(baseUrl, selector));
          if (pathId && this.isOnCooldown(baseUrl, modelId, pathId) && !alreadyAttempted) continue;
          available.push({ selector, pricing: resolved.satsPricing[i] ?? null });
        }
        if (available.length === 0) return null;

        // Rank by what the node's best available route costs for the warm
        // basket — the key getProviderPriceRankingForModel ranks on, so the
        // auto-pinned node is the node the fallback ranking would have picked
        // first — deliberately BEFORE the request-scoped excludeModelPaths
        // filter. The failover chain is node-major (every route of the
        // cheapest node before the next node), so a node's position must stay
        // fixed as the request walks the chain and excludes candidates hop by
        // hop; re-ranking on the cheapest remaining route would interleave the
        // nodes (e.g. node1:deepseek -> node2:deepseek -> node1:fireworks
        // whenever node2's first route undercuts node1's second).
        //
        // `estimateCost(...).total` is the billed token classes only: the
        // node's per-request fee sizes the deposit ceiling and is not part of
        // what it charges, so it is not part of this key either. A route
        // publishing rates that are not prices (NaN, ±inf, negative) cannot
        // rank — a negative one wins every comparison and a NaN poisons the
        // sort — matching getProviderPriceRankingForModel, which skips such
        // nodes outright.
        const pricing =
          available[0].pricing ??
          available.find((a) => a.pricing != null)?.pricing ??
          model.sats_pricing;
        const cost = hasUsableTokenRates(pricing)
          ? estimateCost(pricing, WARM_COST_BASKET).total
          : Number.POSITIVE_INFINITY;

        const remaining = available.filter(
          (a) =>
            !excludedModelPaths.has(modelPathCandidateKey(baseUrl, a.selector))
        );
        if (remaining.length === 0) return null;
        const selectors = remaining.map((a) => a.selector);
        const satsPricing = remaining.map((a) => a.pricing);
        return { baseUrl, selectors, satsPricing, model, cost };
      })
    );

    return candidates
      .filter(
        (c): c is NonNullable<typeof c> => c !== null
      )
      // Same tiebreak as getProviderPriceRankingForModel: equal costs must
      // not depend on the order the nodes happened to be fetched in.
      .sort((a, b) => a.cost - b.cost || a.baseUrl.localeCompare(b.baseUrl))
      .map(({ cost: _cost, ...candidate }) => candidate);
  }

  /**
   * Refresh the auto-selection nodes' advertised paths for the auto-pinned
   * models, off the request path. Call it after a model refresh (routstrd's
   * periodic job) so the next ranking is a cache read.
   *
   * The ranking runs per request, but its per-model path lookups are cached
   * (10 min fresh, 1 h stale) and are only refreshed lazily; without a warm
   * pass the request that lands on a cold or expired entry pays the fetch,
   * bounded by MODEL_PATH_RANKING_BUDGET_MS — which is how a node that is
   * merely slow still taxes every request until its cache is filled.
   *
   * Nodes and models are gated exactly like getModelPathProviderRanking
   * gates them (disabled, transport, catalog entry, alias spellings), so an
   * entry written here is one the next ranking reads — same key, same
   * spelling set. The result is a per-lookup report for the caller's log;
   * this method never throws.
   */
  async warmModelPathCaches(
    options: {
      /** Models to warm; defaults to the auto-pinned model. */
      modelIds?: readonly string[];
      torMode?: boolean;
      budgetMs?: number;
    } = {}
  ): Promise<ModelPathWarmResult[]> {
    const modelIds = [
      ...new Set(
        (options.modelIds ?? [DEEPSEEK_AUTO_MODEL_ID]).map((id) =>
          this.canonicalizeModelId(id)
        )
      ),
    ];
    const torMode = options.torMode ?? isTorContext();
    const budgetMs = options.budgetMs ?? MODEL_PATH_WARM_BUDGET_MS;
    const disabledProviders = new Set(
      this.discoveryAdapter.getDisabledProviders()
    );
    const allModels = this.discoveryAdapter.getCachedModels();

    const entries = await Promise.all(
      DEEPSEEK_AUTO_NODE_URLS.flatMap((nodeUrl) =>
        modelIds.map(async (modelId): Promise<ModelPathWarmResult> => {
          const startedAt = Date.now();
          const baseUrl = normalizeProviderUrl(nodeUrl);
          const report = (
            fields: Partial<ModelPathWarmResult> = {}
          ): ModelPathWarmResult => ({
            baseUrl: baseUrl ?? nodeUrl,
            modelId,
            paths: 0,
            whitelisted: 0,
            elapsedMs: Date.now() - startedAt,
            ...fields,
          });

          if (!baseUrl) return report({ reason: "invalid-url" });
          if (disabledProviders.has(baseUrl)) {
            return report({ reason: "disabled" });
          }
          if (torMode !== isOnionUrl(baseUrl)) {
            return report({ reason: "transport" });
          }
          // No catalog entry on this node means no request can reach it, so
          // there is nothing to warm there.
          const model = findModelForId(
            allModels[baseUrl] || [],
            modelId,
            this.getModelIdMappings()
          );
          if (!model) return report({ reason: "no-catalog-model" });

          const nodePaths = await withBudget(
            getNodeModelPathsForModel(baseUrl, modelId, {
              mappings: this.getModelIdMappings(),
              extraSpellings: [model.id, ...(model.alias_ids ?? [])],
              force: true,
            }),
            budgetMs
          );
          if (!nodePaths) return report({ reason: "unreachable" });

          const resolved = resolveDeepSeekModelPathSelectors(
            nodePaths,
            modelId,
            this.getModelIdMappings()
          );
          return report({
            paths: new Set(
              nodePaths.data.flatMap((entry) =>
                entry.paths.map((path) => path.path)
              )
            ).size,
            whitelisted: (resolved?.selectors ?? []).filter(
              (selector): selector is string => !!selector
            ).length,
          });
        })
      )
    );
    return entries.flat();
  }

  /**
   * Get providers for a model, ranked by what one request basket costs.
   *
   * The cost of the basket (DEFAULT_COST_BASKET unless the caller passes one)
   * is what the node would settle for it, billing each token class at the rate
   * that class is charged: fresh input at the prompt rate, cache reads at the
   * cache-read rate, cache writes at the cache-write rate, output at the
   * completion rate. Routes that publish no usable cache rate are billed those
   * tokens at the prompt rate — which is what the node charges — rather than
   * ranked as though cache were free, so a published 0 cannot win.
   *
   * The per-request fee is not part of the ranking key: the node settles token
   * classes only and uses that fee to size the deposit ceiling. It is reported
   * in `breakdown.requestSats`.
   *
   * The default basket is the one this ranking implied before the key changed
   * (1M prompt + 1M completion, no cache participation), so the ordering here
   * is exactly the prompt+completion per-million ordering. Pass a measured
   * basket to rank on what a real request costs.
   */
  getProviderPriceRankingForModel(
    modelId: string,
    options: ProviderRankingOptions = {}
  ): ModelProviderPrice[] {
    modelId = this.canonicalizeModelId(modelId);
    const includeDisabled = options.includeDisabled ?? false;
    const torMode = options.torMode ?? false;
    const basket = resolveBasket(options.basket);
    const disabledProviders = new Set(this.discoveryAdapter.getDisabledProviders());
    const allModels = this.discoveryAdapter.getCachedModels();
    const results: ModelProviderPrice[] = [];

    for (const [baseUrl, models] of Object.entries(allModels)) {
      if (!includeDisabled && disabledProviders.has(baseUrl)) continue;
      if (this.isOnCooldown(baseUrl, modelId)) continue;
      if (torMode && !baseUrl.includes(".onion")) continue;
      if (
        !torMode &&
        baseUrl.includes(".onion")
      )
        continue;

      const match = findModelForId(models, modelId, this.getModelIdMappings());
      if (!match?.sats_pricing) continue;

      // A route whose only published rates are not prices (NaN, ±inf,
      // negative) cannot be ranked on: a negative one wins every comparison
      // and a NaN poisons the sort.
      if (!hasUsableTokenRates(match.sats_pricing)) continue;

      const breakdown = estimateCost(match.sats_pricing, basket);

      results.push({
        baseUrl,
        model: match,
        cost: breakdown.total,
        rates: breakdown.rates,
        breakdown,
        basket,
      });
    }

    results.sort((a, b) => {
      if (a.cost !== b.cost) {
        return a.cost - b.cost;
      }
      return a.baseUrl.localeCompare(b.baseUrl);
    });

    if (results.length > 0) {
      const ranking = results
        .map(
          (r, i) =>
            `  ${i + 1}. ${r.baseUrl} cost=${r.cost.toFixed(2)} sats ` +
            `(fresh=${r.breakdown.freshInputSats.toFixed(2)} ` +
            `cache-read=${r.breakdown.cacheReadSats.toFixed(2)} ` +
            `cache-write=${r.breakdown.cacheWriteSats.toFixed(2)} ` +
            `out=${r.breakdown.outputSats.toFixed(2)}; ` +
            `rates prompt=${r.rates.prompt} cache-read=${r.rates.cacheRead} ${r.rates.cacheReadSource} ` +
            `cache-write=${r.rates.cacheWrite} ${r.rates.cacheWriteSource} completion=${r.rates.completion}; ` +
            `request=${r.breakdown.requestSats.toFixed(2)} sats reserved, not billed)`
        )
        .join("\n");
      this.logger.log(
        `getProviderPriceRankingForModel: ${modelId} ranking (${results.length} providers, ` +
          `${basket.promptTokens} in @ ${(basket.cacheHitRate * 100).toFixed(0)}% cache hit / ` +
          `${(basket.cacheWriteRate * 100).toFixed(0)}% cache write, ` +
          `${basket.outputTokens} out):\n${ranking}`
      );
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
    options: ProviderRankingOptions = {}
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
   * Check whether a provider accepts at least one of the given mints.
   *
   * Fails open (returns true) when either side is unknown: a provider with
   * no cached mint list, or an empty candidate list. Callers use this to
   * rank/select providers without ever excluding one on missing data.
   */
  providerAcceptsAnyMint(baseUrl: string, mintUrls: string[]): boolean {
    const providerMints =
      this.discoveryAdapter.getCachedMints()[normalizeBaseUrl(baseUrl)] || [];
    if (providerMints.length === 0) return true;
    if (mintUrls.length === 0) return true;
    return providerMints.some((mint) => mintUrls.includes(mint));
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
   * @param maxTokens the request's completion cap (see
   *   `completionCapFromBody`); the largest of the three spellings
   * @param requestBody the full request body, used to count Responses
   *   input/instructions and tools definitions on both APIs
   */
  getRequiredSatsForModel(
    model: Model,
    apiMessages: any[],
    maxTokens?: number,
    requestBody?: Record<string, unknown>,
    pathPricing?: ModelPathSatsPricing
  ): number {
    try {
      // A pinned model path prices itself: the node advertises a full
      // per-route sats pricing set alongside the path, which replaces the
      // model's aggregate pricing wholesale — prompt/completion rates, the
      // max_cost envelope, AND the max_prompt_cost / max_completion_cost
      // allowances the gate discounts against. The gate formula is only
      // self-consistent when the envelope and its allowances come from the
      // same route; mixing the route's max_cost with the aggregate
      // allowances mis-sizes the deposit in both directions (e.g. one live
      // node: 537 sats reserved against an 804-sat gate without max_tokens,
      // 243 sats against a ~4-sat true cost with max_tokens=4000).
      if (pathPricing) {
        const routePricing = Object.fromEntries(
          Object.entries(pathPricing).filter(([, value]) => value !== undefined)
        );
        model = {
          ...model,
          sats_pricing: {
            ...((model.sats_pricing ?? {}) as unknown as Record<
              string,
              unknown
            >),
            ...routePricing,
          },
        } as unknown as Model;
      }
      const body = requestBody ?? {};

      const pictureSats = pictureHoldSats(model, body);
      if (pictureSats !== undefined) return pictureSats * 1.05;

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
      // Count only billed text content, not the serialized envelope.
      const responsesInput = body.input;
      if (!sawPromptShape) {
        if (Array.isArray(responsesInput)) {
          sawPromptShape = true;
          imageTokens += countImageTokensInResponsesInput(responsesInput);
          textChars += countResponsesInputTextChars(responsesInput);
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
      // proxy/enclave cannot enforce an output cap yet. Never apply the
      // maxTokens completion discount for these models — always reserve
      // max_completion_cost.
      if (maxTokens !== undefined && sp.completion && !isTinfoilModel(model.id)) {
        completionCost = sp.completion * maxTokens;
      }
      const componentEstimate = (promptCosts + completionCost + requestFee) * 1.05;

      // The component estimate above prices what the request is expected to
      // *cost*. The gate is what the node actually *demands* up front, and the
      // two diverge whenever the node cannot discount a budget it holds in
      // reserve — which is the normal case for any request carrying an inline
      // image (see nodeGateSats). Reserve the larger of the two, keeping the
      // same 5% margin the component estimate uses so the node's configured
      // tolerance (which the SDK cannot read) cannot eat the whole reserve.
      const gateEstimate = nodeGateSats(model, sp, body, imageTokens) * 1.05;
      let totalEstimatedCosts = Math.max(componentEstimate, gateEstimate);

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
