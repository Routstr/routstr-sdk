import type { Model } from "./types";

/**
 * Bootstrap fallback variant → canonical model ID mappings.
 *
 * Keys are model identifiers as served by a provider's `/v1/models` — either
 * the provider-native `id` or any of its declared `alias_ids`. Values are the
 * canonical IDs used by the curated routstr21 list and by clients when
 * requesting models.
 *
 * A provider model entry is identified by the whole set `{id, ...alias_ids}`:
 * if ANY of those identifiers is a key here, the entry resolves to the mapped
 * canonical ID. Resolution is single-hop on purpose — a map value must never
 * also be a map key (see tests/unit/modelMappings.test.ts).
 *
 * This snapshot is used until a trusted kind 38426 Nostr snapshot is cached.
 * Once published, the Nostr snapshot replaces the fallback (including with an
 * empty mapping). Keep the fallback for offline first runs.
 */
export const MODEL_ID_MAPPINGS: Record<string, string> = {
  // routstr.cypherpunk.today (verified against its /v1/models catalog)
  "z-ai-glm-5-3": "glm-5.3",
  "z-ai-glm-5-3-flash": "glm-5.3-flash",
  "openai-gpt-56-sol": "gpt-5.6-sol",
  "openai-gpt-56-terra": "gpt-5.6-terra",
  "openai-gpt-56-luna": "gpt-5.6-luna",
  "openai-gpt-6-astra": "gpt-6-astra",
  "deepseek-v4-1-flash": "deepseek-v4.1-flash",
  "grok-4-6": "grok-4.6",
  "gemini-3-8-flash": "gemini-3.8-flash",
  "minimax-m3-preview": "minimax-m3",
};

const hasMapping = (id: string, mappings: ModelIdMappings): boolean =>
  Object.prototype.hasOwnProperty.call(mappings, id);

/**
 * Canonicalize a bare model id (as requested by a client, or as stored in a
 * cooldown key). Mapped variants resolve to their canonical id; everything
 * else is returned unchanged. Idempotent because the map is single-hop.
 *
 * Use this wherever a model id is used as an identity (cooldown keys,
 * provider lookups) so spellings such as "claude-opus-5-5" and
 * "claude-opus-5.5" can never drift apart.
 */
export function canonicalizeModelId(
  id: string,
  mappings: ModelIdMappings = MODEL_ID_MAPPINGS,
): string {
  return hasMapping(id, mappings) ? mappings[id] : id;
}

/**
 * Every spelling of a model id: the canonical id plus all mapped variants
 * (canonical first). Used to clean up persisted entries written before
 * model ids were canonicalized.
 */
export function modelIdVariants(
  id: string,
  mappings: ModelIdMappings = MODEL_ID_MAPPINGS,
): string[] {
  const canonical = canonicalizeModelId(id, mappings);
  return [
    canonical,
    ...Object.keys(mappings).filter(
      (variant) => mappings[variant] === canonical
    ),
  ];
}

/**
 * All identifiers a provider model claims: native id first, then any
 * provider-declared aliases.
 */
export function modelIdentifiers(model: Model): string[] {
  return [model.id, ...(model.alias_ids ?? [])];
}

export type ModelIdMappings = Record<string, string>;

/**
 * Resolve a provider model entry to its canonical model ID.
 *
 * Priority: native id in the map → any alias in the map → the native id
 * itself (unmapped models keep their own id).
 */
export function canonicalIdForModel(
  model: Model,
  mappings: ModelIdMappings = MODEL_ID_MAPPINGS,
): string {
  for (const identifier of modelIdentifiers(model)) {
    const canonical = Object.hasOwn(mappings, identifier) ? mappings[identifier] : undefined;
    if (canonical) return canonical;
  }
  return model.id;
}

/**
 * Find which model a provider would serve for a requested (canonical) ID.
 *
 * Priority: exact native id match → mapped match via id or alias (the
 * requested id is canonicalized first, so a variant spelling such as
 * "claude-opus-5-5" also finds a node that lists only "claude-opus-5.5"). The
 * exact match always wins so a mapping can never shadow a model the provider
 * serves natively. Callers that want a deterministic choice when a node
 * lists several spellings as separate entries should pass the canonical id
 * (see canonicalizeModelId): the canonical entry is then the exact match.
 *
 * Callers forwarding a request upstream must use the returned model's native
 * `id`, not the requested canonical ID.
 */
export function findModelForId(
  models: Model[],
  requestedId: string,
  mappings: ModelIdMappings = MODEL_ID_MAPPINGS,
): Model | undefined {
  const canonicalRequested = canonicalizeModelId(requestedId, mappings);
  return (
    models.find((m) => m.id === requestedId) ??
    models.find((m) => canonicalIdForModel(m, mappings) === canonicalRequested)
  );
}
