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
 * True when an x-routstr-model-path selector routes through one of the two
 * whitelisted DeepSeek upstream identities. Matches url and endpoint tag
 * only; the node-specific provider-id is ignored (the node enforces that it
 * matches the pinned url) but must still be a well-formed positive integer.
 */
export function isWhitelistedDeepSeekModelPath(selector: string): boolean {
  const params = parseSelector(selector);
  if (!params) return false;
  const providerId = Number(params["provider-id"]);
  if (!Number.isInteger(providerId) || providerId <= 0) return false;
  return DEEPSEEK_MODEL_PATH_WHITELIST.some(
    (route) =>
      route.url === params.url &&
      (route.endpoint ?? null) === (params.endpoint ?? null)
  );
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
