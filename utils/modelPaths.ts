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

import { normalizeProviderUrl } from "./torUtils";

/** The only request header the SDK forwards upstream on routed requests. */
export const MODEL_PATH_HEADER = "x-routstr-model-path";

/** One whitelisted DeepSeek upstream route, identified by its stable parts. */
export interface DeepSeekModelRoute {
  /** Upstream base URL, exactly as the node advertises it in the selector. */
  url: string;
  /**
   * OpenRouter subprovider endpoint tag. Required on every whitelisted route:
   * a bare OpenRouter selector would let OpenRouter pick any subprovider
   * (deepinfra, together, ...), not necessarily a whitelisted one.
   */
  endpoint?: string;
}

/**
 * The only two upstream routes DeepSeek requests may take, for now, in
 * preference order — both pinned OpenRouter subproviders:
 * 1. DeepSeek's own subprovider on OpenRouter
 * 2. Fireworks' subprovider on OpenRouter
 */
export const DEEPSEEK_MODEL_PATH_WHITELIST: readonly DeepSeekModelRoute[] = [
  { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
  { url: "https://openrouter.ai/api/v1", endpoint: "fireworks" },
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
];

/** The preferred automatic-selection node (first of DEEPSEEK_AUTO_NODE_URLS). */
export const DEEPSEEK_AUTO_NODE_URL = DEEPSEEK_AUTO_NODE_URLS[0];

/**
 * Per-route metadata advertised alongside a path (routstr-core model-path
 * metadata): each route of the same model prices and sizes itself.
 */
export interface NodeModelPathMetadata {
  sats_pricing?: {
    prompt?: number;
    completion?: number;
    max_cost?: number;
  };
  context_length?: number;
  max_completion_tokens?: number | null;
}

/** One advertised path: the selector string plus its per-route metadata. */
export interface NodeModelPathEntry {
  path: string;
  model?: NodeModelPathMetadata;
}

/** The subset of GET /v1/models/paths the SDK consumes. */
export interface NodeModelPaths {
  data: Array<{ id: string; paths: NodeModelPathEntry[] }>;
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
    const response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    payload = await response.json();
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
  const models: Array<{ id: string; paths: NodeModelPathEntry[] }> = [];
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
    models.push({ id, paths });
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
    const p = pricing as Record<string, unknown>;
    metadata.sats_pricing = {
      prompt: typeof p.prompt === "number" ? p.prompt : undefined,
      completion: typeof p.completion === "number" ? p.completion : undefined,
      max_cost: typeof p.max_cost === "number" ? p.max_cost : undefined,
    };
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
 * True when an x-routstr-model-path selector routes through one of the two
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
 * Resolve the whitelisted DeepSeek selectors from a node's /v1/models/paths
 * payload, in whitelist preference order. Advertised path strings are used
 * verbatim: they carry the exact model id (and, on older nodes, the node's
 * provider id), so the node is guaranteed to accept them. Returns null when
 * the node does not list the model.
 */
export function resolveDeepSeekModelPathSelectors(
  nodePaths: NodeModelPaths,
  modelId: string
): DeepSeekModelPathSelectors | null {
  const entry = nodePaths.data.find(
    (m) => m.id.toLowerCase() === modelId.toLowerCase()
  );
  if (!entry) return null;
  const selectors: Array<string | null> = DEEPSEEK_MODEL_PATH_WHITELIST.map(
    () => null
  );
  const satsPricing: Array<NodeModelPathMetadata["sats_pricing"] | null> =
    DEEPSEEK_MODEL_PATH_WHITELIST.map(() => null);
  for (const { path, model } of entry.paths) {
    const route = whitelistedDeepSeekRoute(path);
    if (!route) continue;
    const index = DEEPSEEK_MODEL_PATH_WHITELIST.indexOf(route);
    if (index >= 0 && selectors[index] === null) {
      selectors[index] = path;
      satsPricing[index] = model?.sats_pricing ?? null;
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
