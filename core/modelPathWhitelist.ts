import { canonicalizeModelId, modelIdVariants, type ModelIdMappings } from "./modelMappings";
import { normalizeProviderUrl } from "../utils/torUtils";

export interface ModelPathRoute { url: string; endpoint?: string }
export interface ModelPathPolicy {
  /** Preference order; never sorted. */
  routes: readonly ModelPathRoute[];
  /** Absent/empty means all eligible discovered nodes. */
  nodes?: readonly string[];
}
/** JSON-safe policy projection. Empty is an explicit kill switch, not a cache miss. */
export type ModelPathWhitelist = Record<string, ModelPathPolicy>;

/** Offline bootstrap only, never substituted for an accepted empty snapshot. */
export const MODEL_PATH_BOOTSTRAP: ModelPathWhitelist = {
  "deepseek-v4.1-flash": {
    routes: [
      { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
      { url: "https://openrouter.ai/api/v1", endpoint: "fireworks" },
      { url: "https://api.ppq.ai" },
      { url: "https://openrouter.ai/api/v1", endpoint: "venice/fp8" },
      { url: "https://openrouter.ai/api/v1", endpoint: "wafer" },
      { url: "https://api.venice.ai/api/v1" },
      { url: "https://api.fireworks.ai/inference/v1" },
    ],
    nodes: [
      "https://ai.redsh1ft.com",
      "https://routstr.otrta.me",
      "https://api.nonkycai.com",
    ],
  },
};

/** Matching identity only. Headers always use the node's verbatim selector. */
export function normalizeRoute(url: string, endpoint?: string): string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    throw new Error("invalid route URL");
  }
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.hash || url.includes('#')) throw new Error("invalid route URL");
  if (endpoint !== undefined && (typeof endpoint !== 'string' || !endpoint.trim())) {
    throw new Error("invalid route endpoint");
  }
  return JSON.stringify([parsed.href, endpoint ?? null]);
}

export function canonicalizeModelPathKey(id: string, mappings?: ModelIdMappings): string {
  const trimmed = id.trim();
  // Mapping keys and values are exact identities. Lowercase compatibility is
  // only for unmapped spellings such as historical DeepSeek request casing.
  if (mappings && (Object.hasOwn(mappings, trimmed) || Object.values(mappings).includes(trimmed))) {
    return canonicalizeModelId(trimmed, mappings);
  }
  return canonicalizeModelId(trimmed.toLowerCase(), mappings);
}

export function modelPathPolicyFor(id: string, whitelist: ModelPathWhitelist,
  mappings?: ModelIdMappings): ModelPathPolicy | undefined {
  const canonical = canonicalizeModelPathKey(id, mappings);
  for (const key of modelIdVariants(canonical, mappings)) {
    if (Object.hasOwn(whitelist, key)) return whitelist[key];
  }
  return Object.entries(whitelist).find(([key]) =>
    canonicalizeModelPathKey(key, mappings) === canonical)?.[1];
}

export function parseModelPathWhitelist(content: string,
  mappings: ModelIdMappings): ModelPathWhitelist {
  const value = JSON.parse(content);
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || (value.version !== undefined && value.version !== 1) ||
      !object(value.models)) throw new Error("invalid model path whitelist");
  const entries = Object.entries(value.models);
  if (entries.length > 100) throw new Error("too many models");
  const result: ModelPathWhitelist = Object.create(null);
  const canonicalKeys = new Set<string>();
  for (const [key, policy] of entries) {
    const normalizedKey = key.trim();
    if (!normalizedKey || ['__proto__', 'constructor', 'prototype'].includes(normalizedKey.toLowerCase())) {
      throw new Error("invalid model key");
    }
    const canonical = canonicalizeModelPathKey(key, mappings);
    if (canonicalKeys.has(canonical)) throw new Error("colliding model keys");
    canonicalKeys.add(canonical);
    if (!object(policy) || !Array.isArray(policy.routes) || !policy.routes.length ||
        policy.routes.length > 200) throw new Error("invalid routes");
    const routes: ModelPathRoute[] = [];
    const seen = new Set<string>();
    for (const route of policy.routes) {
      if (!object(route) || typeof route.url !== 'string' ||
          (Object.hasOwn(route, 'endpoint') && typeof route.endpoint !== 'string')) {
        throw new Error("invalid route");
      }
      const identity = normalizeRoute(route.url, route.endpoint as string | undefined);
      if (seen.has(identity)) continue;
      seen.add(identity);
      routes.push({ url: new URL(route.url).href,
        ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint as string }) });
    }
    let nodes: string[] | undefined;
    if (Object.hasOwn(policy, 'nodes')) {
      if (!Array.isArray(policy.nodes) || policy.nodes.length > 50) throw new Error("invalid nodes");
      nodes = policy.nodes.map((node: unknown) => {
        if (typeof node !== 'string' || !node.trim()) throw new Error("invalid node");
        // Validate before provider normalization (which also accepts scheme-less inputs).
        normalizeRoute(node);
        const normalized = normalizeProviderUrl(new URL(node).href);
        if (!normalized) throw new Error("invalid node");
        return normalized;
      });
      nodes = [...new Set(nodes)];
    }
    // Retain variant keys: resolution follows the current mapping snapshot, not a
    // canonical key frozen at the time this event was first accepted.
    result[normalizedKey] = { routes, ...(nodes === undefined ? {} : { nodes }) };
  }
  return result;
}
