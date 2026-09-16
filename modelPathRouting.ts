/**
 * Automatic x-routstr-model-path selection for DeepSeek.
 *
 * routeRequestsWithModelPath() wraps routeRequests() and, for
 * deepseek-v4.1-flash only, pins the request to one of the two whitelisted
 * upstream routes (see utils/modelPaths.ts):
 *
 *   1. the official DeepSeek API
 *   2. DeepSeek through OpenRouter's `deepseek` subprovider
 *
 * Because provider ids are node-internal, the wrapper first pins the node
 * (forcedProvider, default https://ai.redsh1ft.com), then fetches that
 * node's GET /v1/models/paths, then uses the advertised selector string
 * verbatim so the node is guaranteed to accept it.
 *
 * Strategies:
 *   - prefer-official  (default): use the official API route when the node
 *     advertises it, otherwise OpenRouter's deepseek subprovider
 *   - prefer-openrouter: the reverse
 *   - failover        : prefer-official order, but retry once through the
 *     other route when the first attempt fails with an upstream-style
 *     failure (5xx or transport error). Payment and 4xx errors are never
 *     retried. Each attempt is a separate paid request.
 *
 * All other models route exactly like routeRequests() with no header. A
 * caller-supplied x-routstr-model-path header always wins and disables the
 * automatic selection.
 */

import { routeRequests, type RouteRequestOptions } from "./routeRequests";
import { InsufficientBalanceError } from "./core/errors";
import {
  MODEL_PATH_HEADER,
  DEEPSEEK_AUTO_MODEL_ID,
  DEEPSEEK_AUTO_NODE_URL,
  fetchModelPaths,
  resolveDeepSeekModelPathSelectors,
  type NodeModelPaths,
} from "./utils/modelPaths";

/** How the wrapper picks between the two whitelisted routes. */
export type ModelPathStrategy =
  | "prefer-official"
  | "prefer-openrouter"
  | "failover";

/** Options for routeRequestsWithModelPath. */
export interface ModelPathRoutingOptions extends RouteRequestOptions {
  /** Route selection strategy. Defaults to prefer-official. */
  strategy?: ModelPathStrategy;
}

/** Cache the node's model paths for this long before refetching. */
const MODEL_PATHS_TTL_MS = 10 * 60 * 1000;

const modelPathsCache = new Map<string, NodeModelPaths>();
const modelPathsCacheAt = new Map<string, number>();

/** Drop cached /v1/models/paths payloads (used by tests and manual refresh). */
export function clearModelPathsCache(): void {
  modelPathsCache.clear();
  modelPathsCacheAt.clear();
}

async function getNodeModelPaths(
  baseUrl: string
): Promise<NodeModelPaths | null> {
  const cached = modelPathsCache.get(baseUrl);
  const cachedAt = modelPathsCacheAt.get(baseUrl);
  if (cached && cachedAt !== undefined && Date.now() - cachedAt < MODEL_PATHS_TTL_MS) {
    return cached;
  }
  const fetched = await fetchModelPaths(baseUrl);
  if (fetched) {
    modelPathsCache.set(baseUrl, fetched);
    modelPathsCacheAt.set(baseUrl, Date.now());
    return fetched;
  }
  // A failed refresh falls back to the stale cache rather than nothing.
  return cached ?? null;
}

function hasExplicitModelPathHeader(
  headers?: Record<string, string>
): boolean {
  if (!headers) return false;
  return Object.keys(headers).some(
    (name) => name.toLowerCase() === MODEL_PATH_HEADER
  );
}

/**
 * True for failures worth retrying through the other whitelisted route:
 * upstream 5xx responses and transport errors. Payment problems, wrapped
 * auth failures, and 4xx client errors are not.
 */
function isRetryableUpstreamFailure(error: unknown): boolean {
  if (error instanceof InsufficientBalanceError) return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.startsWith("Authentication failed:")) return false;
  if (/^4\d\d\b/.test(message)) return false;
  return true;
}

/**
 * Route a request like routeRequests(), auto-pinning deepseek-v4.1-flash to
 * one of the two whitelisted DeepSeek upstream paths on the pinned node.
 */
export async function routeRequestsWithModelPath(
  options: ModelPathRoutingOptions
): Promise<Response> {
  const { strategy = "prefer-official" } = options;

  // Automatic selection is scoped to deepseek-v4.1-flash only.
  if (
    typeof options.modelId !== "string" ||
    options.modelId.trim().toLowerCase() !== DEEPSEEK_AUTO_MODEL_ID
  ) {
    return routeRequests(options);
  }

  // A caller-supplied selector is an explicit pin: respect it as-is.
  if (hasExplicitModelPathHeader(options.headers)) {
    return routeRequests(options);
  }

  // The pinned node must be the node whose provider ids we resolve.
  const baseUrl = options.forcedProvider ?? DEEPSEEK_AUTO_NODE_URL;

  const nodePaths = await getNodeModelPaths(baseUrl);
  const selectors = nodePaths
    ? resolveDeepSeekModelPathSelectors(nodePaths, DEEPSEEK_AUTO_MODEL_ID)
    : null;

  const ordered =
    strategy === "prefer-openrouter"
      ? [selectors?.openrouter, selectors?.officialApi]
      : [selectors?.officialApi, selectors?.openrouter];
  const [primary, secondary] = ordered;

  // No whitelisted route on this node: still route through the pinned node,
  // but let the node choose the upstream as usual.
  const chosen = primary ?? secondary;
  if (!chosen) {
    options.logger?.warn(
      `[modelPathRouting] no whitelisted ${DEEPSEEK_AUTO_MODEL_ID} path on ${baseUrl}; routing without a pinned path`
    );
    return routeRequests({ ...options, forcedProvider: baseUrl });
  }

  try {
    return await routeRequests({
      ...options,
      forcedProvider: baseUrl,
      headers: { ...options.headers, [MODEL_PATH_HEADER]: chosen },
    });
  } catch (error) {
    if (strategy !== "failover" || !secondary || secondary === chosen) {
      throw error;
    }
    if (!isRetryableUpstreamFailure(error)) {
      throw error;
    }
    options.logger?.warn(
      `[modelPathRouting] ${DEEPSEEK_AUTO_MODEL_ID} failed via ${chosen} (${
        error instanceof Error ? error.message : String(error)
      }); retrying via ${secondary}`
    );
    return routeRequests({
      ...options,
      forcedProvider: baseUrl,
      headers: { ...options.headers, [MODEL_PATH_HEADER]: secondary },
    });
  }
}
