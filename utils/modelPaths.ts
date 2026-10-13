/**
 * Hardcoded whitelist of DeepSeek upstream routes for the
 * x-routstr-model-path request header.
 *
 * A model path is the opaque percent-encoded route selector a routstr node
 * advertises on GET /v1/models/paths and a client pins per request via the
 * x-routstr-model-path header (the only header the SDK forwards upstream):
 *
 *   url=<upstream-base-url>&model-id=<id>[&endpoint=<tag>]
 *
 * Paths are unique by themselves: the selector carries no node-internal
 * database id. The whitelist matches on the stable upstream identity only —
 * the base URL and, for OpenRouter, the subprovider endpoint tag — and the
 * node rejects a selector that does not match one of its advertised paths
 * (404 invalid_model_path). Older nodes may still include a provider-id
 * parameter; it is tolerated when matching but never required or built.
 */

import type { ModelSatsPricing } from "../core/types";
import { modelIdVariants, type ModelIdMappings } from "../core/modelMappings";
import { normalizeProviderUrl } from "./torUtils";
import { withProviderDeadline } from "../discovery/providerDeadline";

/** The only request header the SDK forwards upstream on routed requests. */
export const MODEL_PATH_HEADER = "x-routstr-model-path";

/** One whitelisted DeepSeek upstream route, identified by its stable parts. */
export interface DeepSeekModelRoute {
  /** Upstream base URL, exactly as the node advertises it in the selector. */
  url: string;
  /**
   * OpenRouter subprovider endpoint tag. Required on whitelisted OpenRouter
   * routes: a bare OpenRouter selector would let OpenRouter pick any
   * subprovider (deepinfra, together, ...), not necessarily a whitelisted one.
   * Direct upstreams (the provider's own base URL, e.g. api.ppq.ai) carry no
   * endpoint tag — the base URL already names the single provider.
   */
  endpoint?: string;
}

/**
 * The upstream routes DeepSeek requests may take, in preference order.
 *
 * Order is load-bearing: `available[0]` is the default pin and the node's
 * ranking metric (and the per-route max_cost the deposit gate reserves), so
 * entries are only ever appended. Inserting ahead of the first entry would
 * change the default pin, the node ranking and the deposit envelope.
 *
 * 1. OpenRouter's deepseek subprovider — default pin
 * 2. OpenRouter's fireworks subprovider — original failover headroom
 * 3. api.ppq.ai — direct PPQ
 * 4. OpenRouter's venice/fp8 subprovider
 * 5. OpenRouter's wafer subprovider
 * 6. api.venice.ai — direct Venice
 * 7. api.fireworks.ai — direct Fireworks
 *
 * The direct upstreams are reached through the variant spelling a node files
 * them under (see resolveDeepSeekModelPathSelectors): `deepseek-v4-1-flash`
 * for Venice, `accounts/fireworks/models/deepseek-v4p1-flash` for Fireworks.
 */
export const DEEPSEEK_MODEL_PATH_WHITELIST: readonly DeepSeekModelRoute[] = [
  { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
  { url: "https://openrouter.ai/api/v1", endpoint: "fireworks" },
  { url: "https://api.ppq.ai" },
  { url: "https://openrouter.ai/api/v1", endpoint: "venice/fp8" },
  { url: "https://openrouter.ai/api/v1", endpoint: "wafer" },
  { url: "https://api.venice.ai/api/v1" },
  { url: "https://api.fireworks.ai/inference/v1" },
];

/**
 * The model whose requests get automatic x-routstr-model-path selection.
 * Only this model is auto-pinned for now; everything else routes normally.
 */
export const DEEPSEEK_AUTO_MODEL_ID = "deepseek-v4.1-flash";

/**
 * The nodes the automatic selection may pin, in preference order. A
 * selector is only guaranteed valid on the node that advertised it, so the
 * pinned node must be the node we asked for paths. Hardcoded for now; the
 * intent is to discover eligible nodes by their advertised routstr-core
 * version once model paths are widely deployed.
 */
export const DEEPSEEK_AUTO_NODE_URLS: readonly string[] = [
  "https://ai.redsh1ft.com",
  "https://routstr.otrta.me",
  "https://api.nonkycai.com",
];

/** The preferred automatic-selection node (first of DEEPSEEK_AUTO_NODE_URLS). */
export const DEEPSEEK_AUTO_NODE_URL = DEEPSEEK_AUTO_NODE_URLS[0];

/**
 * Per-route metadata advertised alongside a path (routstr-core model-path
 * metadata): each route of the same model prices and sizes itself.
 */
export interface NodeModelPathMetadata {
  /**
   * The route's full advertised sats pricing. Every field the node sends is
   * kept (not just prompt/completion/max_cost): the deposit gate in
   * ProviderManager.getRequiredSatsForModel is only self-consistent when
   * max_cost, max_prompt_cost and max_completion_cost all come from the
   * same route's envelope.
   */
  sats_pricing?: ModelPathSatsPricing;
  context_length?: number;
  max_completion_tokens?: number | null;
}

/**
 * Per-route sats pricing as advertised on GET /v1/models/paths. All fields
 * optional: a route may advertise only a subset, and cache-pricing fields
 * appear on live nodes without being part of ModelSatsPricing.
 */
export type ModelPathSatsPricing = Partial<ModelSatsPricing> & {
  input_cache_read?: number;
  input_cache_write?: number;
};

/** One advertised path: the selector string plus its per-route metadata. */
export interface NodeModelPathEntry {
  path: string;
  model?: NodeModelPathMetadata;
}

/** The subset of GET /v1/models/paths the SDK consumes. */
export interface NodeModelPaths {
  data: Array<{
    id: string;
    paths: NodeModelPathEntry[];
    /**
     * Other ids the node itself declares for this same model. Kept because a
     * node may file one model under several spellings — and the mapping
     * snapshot that links them (MODEL_ID_MAPPINGS) is replaced wholesale by a
     * trusted kind 38426 event, so it is not a stable contract. Empty when the
     * node declares none.
     */
    alias_ids: string[];
  }>;
  updatedAt: number | null;
}

/**
 * Fetch one node's GET /v1/models/paths and keep the fields the SDK needs:
 * the model id and, per path, the advertised selector string used verbatim as
 * the x-routstr-model-path header value. Returns null on any failure
 * (network, non-200, malformed payload).
 */
export async function fetchModelPaths(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<NodeModelPaths | null> {
  const normalized = normalizeProviderUrl(baseUrl);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL("v1/models/paths", normalized);
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = await withProviderDeadline(async (signal) => {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json" }, signal,
      });
      if (!response.ok) return null;
      return await response.json();
    }, 10_000);
  } catch {
    return null;
  }
  return parseModelPathsPayload(payload);
}

/** Defensive parse of a /v1/models/paths payload; null when malformed. */
export function parseModelPathsPayload(payload: unknown): NodeModelPaths | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const models: NodeModelPaths["data"] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const rawPaths = record.paths;
    if (typeof id !== "string" || !Array.isArray(rawPaths)) continue;
    // Each advertised path is an object; the selector string lives in .path,
    // per-route metadata in .model (absent on nodes before model-path
    // metadata landed).
    const paths: NodeModelPathEntry[] = [];
    for (const raw of rawPaths) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const path = entry.path;
      if (typeof path !== "string" || path.length === 0) continue;
      const model = parsePathMetadata(entry.model);
      paths.push(model ? { path, model } : { path });
    }
    const rawAliases = record.alias_ids;
    const alias_ids = Array.isArray(rawAliases)
      ? rawAliases.filter(
          (alias): alias is string =>
            typeof alias === "string" && alias.length > 0
        )
      : [];
    models.push({ id, paths, alias_ids });
  }
  if (models.length === 0) return null;
  const updatedAt = (payload as Record<string, unknown>).updated_at;
  return {
    data: models,
    updatedAt: typeof updatedAt === "number" ? updatedAt : null,
  };
}

/**
 * Percent-encode exactly like the node's urlencode (quote_plus) so built
 * selectors match the strings advertised by GET /v1/models/paths byte for
 * byte (encodeURIComponent leaves !'()* unencoded, quote_plus does not).
 */
function encodeFormValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** Inverse of encodeFormValue; + decodes as a space, like parse_qsl. */
function decodeFormValue(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

/** Defensive copy of a path's per-route metadata; undefined when absent. */
function parsePathMetadata(raw: unknown): NodeModelPathMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const metadata: NodeModelPathMetadata = {};
  const pricing = record.sats_pricing;
  if (pricing && typeof pricing === "object") {
    // Keep every numeric field the node advertises. Dropping fields here
    // (e.g. max_completion_cost) silently mixes route-level and model-level
    // numbers in the deposit gate, mis-sizing the reserve in both directions.
    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(
      pricing as Record<string, unknown>
    )) {
      if (typeof value === "number" && Number.isFinite(value)) {
        parsed[key] = value;
      }
    }
    if (Object.keys(parsed).length > 0) {
      metadata.sats_pricing = parsed as ModelPathSatsPricing;
    }
  }
  if (typeof record.context_length === "number") {
    metadata.context_length = record.context_length;
  }
  if (
    typeof record.max_completion_tokens === "number" ||
    record.max_completion_tokens === null
  ) {
    metadata.max_completion_tokens =
      record.max_completion_tokens as number | null;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Parse a selector into its fields; null when malformed or incomplete. */
function parseSelector(selector: string): Record<string, string> | null {
  if (!selector) return null;
  const params: Record<string, string> = {};
  for (const pair of selector.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    if (key in params) return null;
    try {
      params[key] = decodeFormValue(pair.slice(eq + 1));
    } catch {
      return null; // malformed percent-encoding
    }
    if (!params[key].trim()) return null;
  }
  // Paths are unique by themselves: url + model-id (+ endpoint tag). A
  // legacy provider-id parameter is tolerated but never required.
  if (!params.url || !params["model-id"]) {
    return null;
  }
  return params;
}

/**
 * Build the x-routstr-model-path selector pinning a DeepSeek model to one of
 * the whitelisted routes. Defaults to the first (preferred) whitelisted
 * route — OpenRouter's deepseek subprovider. Prefer the verbatim selector
 * the node advertises on GET /v1/models/paths when available; this builder
 * is for constructing one from scratch.
 */
export function deepSeekModelPath(
  modelId: string,
  route: DeepSeekModelRoute = DEEPSEEK_MODEL_PATH_WHITELIST[0]
): string {
  const components = [
    `url=${encodeFormValue(route.url)}`,
    `model-id=${encodeFormValue(modelId)}`,
  ];
  if (route.endpoint) {
    components.push(`endpoint=${encodeFormValue(route.endpoint)}`);
  }
  return components.join("&");
}

/**
 * The model id a selector names, or null when the selector is malformed.
 * The node validates the request body's model against this id byte for byte:
 * a selector advertised under a variant spelling (deepseek-v4-1-flash) paired
 * with a body asking for the canonical one (deepseek-v4.1-flash) is rejected
 * with 400 invalid_request even though both name the same model, so a pinned
 * request must carry exactly this spelling in its body.
 */
export function selectorModelId(selector: string): string | null {
  return parseSelector(selector)?.["model-id"] ?? null;
}

/**
 * Canonical identity of an x-routstr-model-path selector: the stable parts
 * (url, model-id, endpoint tag) re-encoded in fixed order. Two selectors
 * naming the same route — e.g. legacy ones carrying different provider-id
 * values — share one identity, so it is the right key for path-scoped
 * cooldowns. Null when the selector is malformed.
 */
export function canonicalModelPath(selector: string): string | null {
  const params = parseSelector(selector);
  if (!params) return null;
  const components = [
    `url=${encodeFormValue(params.url)}`,
    `model-id=${encodeFormValue(params["model-id"])}`,
  ];
  if (params.endpoint) {
    components.push(`endpoint=${encodeFormValue(params.endpoint)}`);
  }
  return components.join("&");
}

/**
 * Identity of one (node, route) failover candidate: the node's normalized
 * URL plus the selector's canonical path. Both nodes advertise the same
 * upstream route strings, so the canonical path alone cannot tell
 * node1:deepseek from node2:deepseek — the pair can. Used to skip
 * candidates a request already attempted: one strike does not trigger
 * cooldown, so the exclusion must live on the request.
 */
export function modelPathCandidateKey(
  baseUrl: string,
  selector: string
): string {
  const node = (normalizeProviderUrl(baseUrl) ?? baseUrl).toLowerCase();
  return `${node}|${canonicalModelPath(selector) ?? selector}`;
}

/**
 * The whitelisted route a selector identifies, or null when the selector is
 * malformed or routes through a non-whitelisted upstream. Only the stable
 * identity (url + endpoint tag) is matched.
 */
export function whitelistedDeepSeekRoute(
  selector: string
): DeepSeekModelRoute | null {
  const params = parseSelector(selector);
  if (!params) return null;
  return (
    DEEPSEEK_MODEL_PATH_WHITELIST.find(
      (route) =>
        route.url === params.url &&
        (route.endpoint ?? null) === (params.endpoint ?? null)
    ) ?? null
  );
}

/**
 * True when an x-routstr-model-path selector routes through one of the
 * whitelisted DeepSeek upstream identities. Only url and endpoint tag are
 * matched.
 */
export function isWhitelistedDeepSeekModelPath(selector: string): boolean {
  return whitelistedDeepSeekRoute(selector) !== null;
}

/** Whitelisted DeepSeek selectors resolved from one node's advertised paths. */
export interface DeepSeekModelPathSelectors {
  /**
   * selectors[i] is the node's advertised selector for
   * DEEPSEEK_MODEL_PATH_WHITELIST[i], or null when the node has no such route.
   */
  selectors: Array<string | null>;
  /**
   * satsPricing[i] is the per-route sats pricing the node advertised
   * alongside selectors[i], or null when the node provides no metadata.
   */
  satsPricing: Array<NodeModelPathMetadata["sats_pricing"] | null>;
}

/**
 * Every spelling under which one node may file a model: the requested id's
 * mapped variants (see modelIdVariants) plus any alias_ids the entries
 * themselves declare, closed transitively so an alias naming another entry's
 * id is followed.
 *
 * A node can list the same model as separate entries — e.g. the canonical
 * `deepseek-v4.1-flash` and its mapped variant `deepseek-v4-1-flash`, each
 * with a different path list — so the complete route set only appears when
 * the spellings are considered together. Entries that share no spelling with
 * the requested model never contribute.
 */
function modelSpellings(
  nodePaths: NodeModelPaths,
  modelId: string,
  mappings?: ModelIdMappings
): Set<string> {
  const spellings = new Set(
    modelIdVariants(modelId, mappings).map((id) => id.toLowerCase())
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of nodePaths.data) {
      const ids = [entry.id, ...entry.alias_ids];
      if (!ids.some((id) => spellings.has(id.toLowerCase()))) continue;
      for (const id of ids) {
        const key = id.toLowerCase();
        if (!spellings.has(key)) {
          spellings.add(key);
          grew = true;
        }
      }
    }
  }
  return spellings;
}

/**
 * Resolve the whitelisted DeepSeek selectors from a node's /v1/models/paths
 * payload, in whitelist preference order. Advertised path strings are used
 * verbatim: they carry the exact model id (and, on older nodes, the node's
 * provider id), so the node is guaranteed to accept them.
 *
 * Paths are gathered across every spelling the node files the model under
 * (see modelSpellings), so a route advertised only under a mapped variant —
 * the node's own alias_ids, or a spelling linked by MODEL_ID_MAPPINGS — is
 * still found. Returns null when the node lists the model under none of them.
 */
export function resolveDeepSeekModelPathSelectors(
  nodePaths: NodeModelPaths,
  modelId: string,
  mappings?: ModelIdMappings
): DeepSeekModelPathSelectors | null {
  const spellings = modelSpellings(nodePaths, modelId, mappings);
  const matching = nodePaths.data.filter((m) =>
    spellings.has(m.id.toLowerCase())
  );
  if (matching.length === 0) return null;
  // The requested spelling wins a contested route, then payload order: a node
  // listing both spellings must never have its canonical path list shadowed by
  // a variant entry.
  const requested = modelId.toLowerCase();
  const ordered = [
    ...matching.filter((m) => m.id.toLowerCase() === requested),
    ...matching.filter((m) => m.id.toLowerCase() !== requested),
  ];
  const selectors: Array<string | null> = DEEPSEEK_MODEL_PATH_WHITELIST.map(
    () => null
  );
  const satsPricing: Array<NodeModelPathMetadata["sats_pricing"] | null> =
    DEEPSEEK_MODEL_PATH_WHITELIST.map(() => null);
  for (const entry of ordered) {
    for (const { path, model } of entry.paths) {
      const route = whitelistedDeepSeekRoute(path);
      if (!route) continue;
      const index = DEEPSEEK_MODEL_PATH_WHITELIST.indexOf(route);
      if (index >= 0 && selectors[index] === null) {
        selectors[index] = path;
        satsPricing[index] = model?.sats_pricing ?? null;
      }
    }
  }
  return { selectors, satsPricing };
}


/**
 * Headers object for routeRequests({ headers }) pinning a DeepSeek model to a
 * whitelisted route.
 */
export function deepSeekModelPathHeaders(
  modelId: string,
  route?: DeepSeekModelRoute
): { [MODEL_PATH_HEADER]: string } {
  return { [MODEL_PATH_HEADER]: deepSeekModelPath(modelId, route) };
}

/** Cached /v1/models/paths payloads, keyed by node base URL. */
const MODEL_PATHS_TTL_MS = 10 * 60 * 1000;
const modelPathsCache = new Map<string, { paths: NodeModelPaths; at: number }>();

/** Drop cached /v1/models/paths payloads (tests, manual refresh). */
export function clearModelPathsCache(): void {
  modelPathsCache.clear();
  modelPathsForModelCache.clear();
  modelPathsForModelFailures.clear();
  modelPathsForModelInFlight.clear();
}

/**
 * A node's GET /v1/models/paths payload, cached for MODEL_PATHS_TTL_MS.
 * On fetch failure the stale cache entry (if any) is kept.
 */
export async function getNodeModelPaths(
  baseUrl: string
): Promise<NodeModelPaths | null> {
  const cached = modelPathsCache.get(baseUrl);
  if (cached && Date.now() - cached.at < MODEL_PATHS_TTL_MS) {
    return cached.paths;
  }
  const fetched = await fetchModelPaths(baseUrl);
  if (fetched) {
    modelPathsCache.set(baseUrl, { paths: fetched, at: Date.now() });
    return fetched;
  }
  return cached?.paths ?? null;
}

// ─── Per-model path lookups ─────────────────────────────────────────────
//
// The full GET /v1/models/paths payload is large (5.4 MB / 13–22 s on a busy
// node, measured 2026-10-12) and routinely blew the 10 s fetch abort, which
// silently dropped the node from every auto-pin ranking. Ranking only ever
// needs ONE model's paths, which GET /v1/models/paths/model?model_id=<id>
// serves in kilobytes (78 KB / ~4 s on the same node). The helpers below use
// that endpoint with:
//   - stale-while-revalidate: a cached entry is returned immediately, even
//     when expired, and refreshed in the background;
//   - in-flight dedupe: concurrent requests share one fetch per node+model;
//   - negative caching with exponential backoff: a node that fails is not
//     re-probed (and its timeout not re-paid) by every request.

/** Abort for one per-model path fetch. */
export const MODEL_PATHS_FETCH_TIMEOUT_MS = 10_000;
/** A fresh per-model entry is served without a refresh for this long. */
const MODEL_PATHS_FOR_MODEL_TTL_MS = 10 * 60 * 1000;
/** Stale entries older than this are no longer served while refreshing. */
const MODEL_PATHS_FOR_MODEL_MAX_STALE_MS = 60 * 60 * 1000;
/** First negative-cache window after a failed fetch; doubles per failure. */
const MODEL_PATHS_NEGATIVE_BASE_MS = 60 * 1000;
const MODEL_PATHS_NEGATIVE_MAX_MS = 30 * 60 * 1000;

interface ModelPathsForModelEntry {
  paths: NodeModelPaths | null;
  at: number;
}
const modelPathsForModelCache = new Map<string, ModelPathsForModelEntry>();
const modelPathsForModelFailures = new Map<
  string,
  { failures: number; retryAt: number }
>();
const modelPathsForModelInFlight = new Map<
  string,
  Promise<NodeModelPaths | null>
>();

function modelPathsForModelKey(baseUrl: string, modelId: string): string {
  return `${baseUrl.toLowerCase()}|${modelId.toLowerCase()}`;
}

/**
 * Parse a GET /v1/models/paths/model payload: a flat
 * `data: [{ path, provider, endpoint, model }]` list for one model, with no
 * `id` / `paths` / `alias_ids` wrapper. Each route's own `model.id` names the
 * spelling the node files it under (falls back to the requested id). Also
 * accepts the full /v1/models/paths shape. Returns an empty (not null)
 * result for a well-formed payload with no paths.
 */
export function parseModelPathsForModelPayload(
  payload: unknown,
  requestedModelId: string
): NodeModelPaths | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const updatedAtRaw = (payload as Record<string, unknown>).updated_at;
  const updatedAt = typeof updatedAtRaw === "number" ? updatedAtRaw : null;
  if (data.length === 0) return { data: [], updatedAt };
  // Full-shape payload (entries carry id + paths): reuse the full parser.
  const looksFull = data.some(
    (entry) =>
      !!entry &&
      typeof entry === "object" &&
      Array.isArray((entry as Record<string, unknown>).paths)
  );
  if (looksFull) return parseModelPathsPayload(payload) ?? { data: [], updatedAt };
  const byId = new Map<string, NodeModelPathEntry[]>();
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const path = record.path;
    if (typeof path !== "string" || path.length === 0) continue;
    const model = parsePathMetadata(record.model);
    const rawModel = record.model as Record<string, unknown> | undefined;
    const id =
      rawModel && typeof rawModel.id === "string" && rawModel.id.length > 0
        ? rawModel.id
        : requestedModelId;
    const list = byId.get(id) ?? [];
    list.push(model ? { path, model } : { path });
    byId.set(id, list);
  }
  return {
    data: [...byId.entries()].map(([id, paths]) => ({
      id,
      paths,
      alias_ids: [],
    })),
    updatedAt,
  };
}

/**
 * Fetch one model's paths from GET /v1/models/paths/model?model_id=<id>.
 * A 404 means the node does not serve that spelling: an empty result, not a
 * failure. Returns null on network error, timeout, other non-2xx, or a
 * malformed payload.
 */
export async function fetchModelPathsForModel(
  baseUrl: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = MODEL_PATHS_FETCH_TIMEOUT_MS
): Promise<NodeModelPaths | null> {
  const normalized = normalizeProviderUrl(baseUrl);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL("v1/models/paths/model", normalized);
    url.searchParams.set("model_id", modelId);
  } catch {
    return null;
  }
  try {
    return await withProviderDeadline(async (signal) => {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json" }, signal,
      });
      if (response.status === 404) return { data: [], updatedAt: null };
      if (!response.ok) return null;
      return parseModelPathsForModelPayload(await response.json(), modelId);
    }, timeoutMs);
  } catch {
    return null;
  }
}

async function fetchModelPathsForSpellings(
  baseUrl: string,
  spellings: string[]
): Promise<NodeModelPaths | null> {
  const results = await Promise.all(
    spellings.map((id) => fetchModelPathsForModel(baseUrl, id))
  );
  // Any failed spelling makes the whole lookup a failure: a partial result
  // could hide the node's preferred route and mis-rank it.
  if (results.some((r) => r === null)) return null;
  const byId = new Map<string, NodeModelPathEntry[]>();
  let updatedAt: number | null = null;
  for (const result of results as NodeModelPaths[]) {
    if (result.updatedAt != null) {
      updatedAt = Math.max(updatedAt ?? 0, result.updatedAt);
    }
    for (const entry of result.data) {
      const list = byId.get(entry.id) ?? [];
      const seen = new Set(list.map((p) => p.path));
      for (const path of entry.paths) {
        if (!seen.has(path.path)) list.push(path);
      }
      byId.set(entry.id, list);
    }
  }
  return {
    data: [...byId.entries()].map(([id, paths]) => ({
      id,
      paths,
      alias_ids: [],
    })),
    updatedAt,
  };
}

/**
 * One model's advertised paths on a node, via the per-model endpoint, for
 * every spelling the SDK knows (canonical id, mapping variants, and any
 * `extraSpellings` such as the node catalog's alias_ids). Never throws.
 *
 * Returns a cached entry immediately when one exists (refreshing it in the
 * background once older than the TTL), null while the node is in its
 * negative-cache window, and otherwise awaits a single shared fetch.
 */
export function getNodeModelPathsForModel(
  baseUrl: string,
  modelId: string,
  options: { mappings?: ModelIdMappings; extraSpellings?: string[] } = {}
): Promise<NodeModelPaths | null> {
  const key = modelPathsForModelKey(baseUrl, modelId);
  const now = Date.now();
  const cached = modelPathsForModelCache.get(key);
  const failure = modelPathsForModelFailures.get(key);

  const startFetch = (): Promise<NodeModelPaths | null> => {
    const existing = modelPathsForModelInFlight.get(key);
    if (existing) return existing;
    const spellings = [
      ...new Set(
        [
          ...modelIdVariants(modelId, options.mappings),
          ...(options.extraSpellings ?? []),
        ].filter((s) => typeof s === "string" && s.length > 0)
      ),
    ];
    const promise = fetchModelPathsForSpellings(baseUrl, spellings)
      .then((paths) => {
        if (paths) {
          modelPathsForModelCache.set(key, { paths, at: Date.now() });
          modelPathsForModelFailures.delete(key);
        } else {
          const failures = (modelPathsForModelFailures.get(key)?.failures ?? 0) + 1;
          const backoff = Math.min(
            MODEL_PATHS_NEGATIVE_BASE_MS * 2 ** (failures - 1),
            MODEL_PATHS_NEGATIVE_MAX_MS
          );
          modelPathsForModelFailures.set(key, {
            failures,
            retryAt: Date.now() + backoff,
          });
        }
        return paths;
      })
      .catch(() => null)
      .finally(() => {
        modelPathsForModelInFlight.delete(key);
      });
    modelPathsForModelInFlight.set(key, promise);
    return promise;
  };

  const inBackoff = !!failure && now < failure.retryAt;
  if (cached && now - cached.at < MODEL_PATHS_FOR_MODEL_MAX_STALE_MS) {
    if (now - cached.at >= MODEL_PATHS_FOR_MODEL_TTL_MS && !inBackoff) {
      void startFetch();
    }
    return Promise.resolve(cached.paths);
  }
  if (inBackoff) return Promise.resolve(null);
  return startFetch().then((paths) => paths ?? cached?.paths ?? null);
}


/** True when two base URLs point at the same node. */
export function sameNode(
  a?: string | null,
  b?: string | null
): boolean {
  const left = normalizeProviderUrl(a);
  const right = normalizeProviderUrl(b);
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}
