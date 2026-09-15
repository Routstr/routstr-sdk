/**
 * Hardcoded whitelist of DeepSeek model-path selectors for the
 * x-routstr-model-path request header.
 *
 * A model path is the opaque percent-encoded route selector a routstr node
 * advertises on GET /v1/models/paths and a client pins per request via the
 * x-routstr-model-path header (the only header the SDK forwards upstream):
 *
 *   url=<upstream-base-url>&provider-id=<n>&model-id=<id>[&endpoint=<tag>]
 *
 * provider-id values are node-internal upstream IDs, so this hardcoded
 * whitelist is only valid against the node it was captured from
 * (ai.redsh1ft.com at the time of writing). Refresh from GET /v1/models/paths
 * when the node changes.
 */

/** The only request header the SDK forwards upstream on routed requests. */
export const MODEL_PATH_HEADER = "x-routstr-model-path";

/** One whitelisted upstream route: public base URL + the node's provider id. */
export interface DeepSeekModelRoute {
  url: string;
  providerId: number;
}

/**
 * The only two upstream paths DeepSeek requests may take, for now:
 * 1. the official DeepSeek API
 * 2. DeepSeek through OpenRouter
 */
export const DEEPSEEK_MODEL_PATH_WHITELIST: readonly DeepSeekModelRoute[] = [
  { url: "https://api.deepseek.com", providerId: 5 },
  { url: "https://openrouter.ai/api/v1", providerId: 8 },
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
 * the whitelisted routes. Defaults to the official DeepSeek API route.
 */
export function deepSeekModelPath(
  modelId: string,
  route: DeepSeekModelRoute = DEEPSEEK_MODEL_PATH_WHITELIST[0]
): string {
  return [
    `url=${encodeFormValue(route.url)}`,
    `provider-id=${route.providerId}`,
    `model-id=${encodeFormValue(modelId)}`,
  ].join("&");
}

/**
 * True when an x-routstr-model-path selector routes through one of the two
 * whitelisted DeepSeek upstreams. Checks route identity (url + provider-id);
 * the node itself enforces that the selector's model-id matches the request.
 */
export function isWhitelistedDeepSeekModelPath(selector: string): boolean {
  const params = parseSelector(selector);
  if (!params) return false;
  const providerId = Number(params["provider-id"]);
  if (!Number.isInteger(providerId) || providerId <= 0) return false;
  return DEEPSEEK_MODEL_PATH_WHITELIST.some(
    (route) => route.url === params.url && route.providerId === providerId
  );
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
