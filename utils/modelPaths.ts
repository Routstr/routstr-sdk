/**
 * Hardcoded whitelist of DeepSeek upstream routes for the
 * x-routstr-model-path request header.
 *
 * A model path is the opaque percent-encoded route selector a routstr node
 * advertises on GET /v1/models/paths and a client pins per request via the
 * x-routstr-model-path header (the only header the SDK forwards upstream):
 *
 *   url=<upstream-base-url>&provider-id=<n>&model-id=<id>[&endpoint=<tag>]
 *
 * The whitelist matches on the stable upstream identity only: the base URL
 * and, for OpenRouter, the subprovider endpoint tag. provider-id values are
 * node-internal database IDs that differ per node, so they are deliberately
 * NOT part of the whitelist — pass the node's provider id when *building* a
 * selector (from GET /v1/models/paths), and rely on the node to reject a
 * selector whose provider-id does not match the pinned URL (404
 * invalid_model_path).
 */

import { normalizeProviderUrl } from "./torUtils";

/** The only request header the SDK forwards upstream on routed requests. */
export const MODEL_PATH_HEADER = "x-routstr-model-path";

/** One whitelisted DeepSeek upstream route, identified by its stable parts. */
export interface DeepSeekModelRoute {
  /** Upstream base URL, exactly as the node advertises it in the selector. */
  url: string;
  /**
   * OpenRouter subprovider endpoint tag. Required on the OpenRouter entry:
   * a bare OpenRouter selector would let OpenRouter pick any subprovider
   * (deepinfra, fireworks, ...), not necessarily DeepSeek.
   */
  endpoint?: string;
}

/**
 * The only two upstream routes DeepSeek requests may take, for now:
 * 1. the official DeepSeek API
 * 2. DeepSeek through OpenRouter's `deepseek` subprovider
 */
export const DEEPSEEK_MODEL_PATH_WHITELIST: readonly DeepSeekModelRoute[] = [
  { url: "https://api.deepseek.com" },
  { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
];

/**
 * The model whose requests get automatic x-routstr-model-path selection.
 * Only this model is auto-pinned for now; everything else routes normally.
 */
export const DEEPSEEK_AUTO_MODEL_ID = "deepseek-v4.1-flash";

/**
 * The node the automatic selection resolves provider ids from. provider ids
 * are node-internal, so the pinned node must be the node we asked for paths.
 */
export const DEEPSEEK_AUTO_NODE_URL = "https://ai.redsh1ft.com";

/** The subset of GET /v1/models/paths the SDK consumes. */
export interface NodeModelPaths {
  data: Array<{ id: string; paths: string[] }>;
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
  const models: Array<{ id: string; paths: string[] }> = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const rawPaths = record.paths;
    if (typeof id !== "string" || !Array.isArray(rawPaths)) continue;
    // Each advertised path is an object; the selector string lives in .path.
    const paths: string[] = [];
    for (const raw of rawPaths) {
      if (!raw || typeof raw !== "object") continue;
      const path = (raw as Record<string, unknown>).path;
      if (typeof path === "string" && path.length > 0) {
        paths.push(path);
      }
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
  if (!params.url || !params["model-id"] || !params["provider-id"]) {
    return null;
  }
  return params;
}

/**
 * Build the x-routstr-model-path selector pinning a DeepSeek model to one of
 * the whitelisted routes. The provider id is node-specific: take it from the
 * node's GET /v1/models/paths entry whose url (and endpoint tag) match the
 * route. Defaults to the official DeepSeek API route.
 */
export function deepSeekModelPath(
  modelId: string,
  providerId: number,
  route: DeepSeekModelRoute = DEEPSEEK_MODEL_PATH_WHITELIST[0]
): string {
  const components = [
    `url=${encodeFormValue(route.url)}`,
    `provider-id=${providerId}`,
    `model-id=${encodeFormValue(modelId)}`,
  ];
  if (route.endpoint) {
    components.push(`endpoint=${encodeFormValue(route.endpoint)}`);
  }
  return components.join("&");
}

/**
 * The whitelisted route a selector identifies, or null when the selector is
 * malformed or routes through a non-whitelisted upstream. Only the stable
 * identity (url + endpoint tag) is matched; the node-specific provider-id is
 * ignored (the node enforces that it matches the pinned url) but must still
 * be a well-formed positive integer.
 */
export function whitelistedDeepSeekRoute(
  selector: string
): DeepSeekModelRoute | null {
  const params = parseSelector(selector);
  if (!params) return null;
  const providerId = Number(params["provider-id"]);
  if (!Number.isInteger(providerId) || providerId <= 0) return null;
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
 * matched; provider-id is node-specific plumbing, not identity.
 */
export function isWhitelistedDeepSeekModelPath(selector: string): boolean {
  return whitelistedDeepSeekRoute(selector) !== null;
}

/** Whitelisted DeepSeek selectors resolved from one node's advertised paths. */
export interface DeepSeekModelPathSelectors {
  /** Advertised selector for the official DeepSeek API, if the node has one. */
  officialApi: string | null;
  /** Advertised selector for OpenRouter's deepseek subprovider, if any. */
  openrouter: string | null;
}

/**
 * Resolve the whitelisted DeepSeek selectors from a node's /v1/models/paths
 * payload. Advertised path strings are used verbatim: they already carry the
 * node's provider-id and the exact model id, so the node is guaranteed to
 * accept them. Returns null when the node does not list the model.
 */
export function resolveDeepSeekModelPathSelectors(
  nodePaths: NodeModelPaths,
  modelId: string
): DeepSeekModelPathSelectors | null {
  const entry = nodePaths.data.find(
    (m) => m.id.toLowerCase() === modelId.toLowerCase()
  );
  if (!entry) return null;
  const selectors: DeepSeekModelPathSelectors = {
    officialApi: null,
    openrouter: null,
  };
  for (const path of entry.paths) {
    const route = whitelistedDeepSeekRoute(path);
    if (route === DEEPSEEK_MODEL_PATH_WHITELIST[0] && !selectors.officialApi) {
      selectors.officialApi = path;
    } else if (
      route === DEEPSEEK_MODEL_PATH_WHITELIST[1] &&
      !selectors.openrouter
    ) {
      selectors.openrouter = path;
    }
  }
  return selectors;
}

/**
 * Headers object for routeRequests({ headers }) pinning a DeepSeek model to a
 * whitelisted route. providerId is the node-specific upstream id from
 * GET /v1/models/paths.
 */
export function deepSeekModelPathHeaders(
  modelId: string,
  providerId: number,
  route?: DeepSeekModelRoute
): { [MODEL_PATH_HEADER]: string } {
  return { [MODEL_PATH_HEADER]: deepSeekModelPath(modelId, providerId, route) };
}