import type { Model } from "./types";

/**
 * Static variant → canonical model ID mappings.
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
 * Update this list when a provider is found serving a canonical model under
 * a non-canonical identifier. Each entry is a claim that the two IDs are the
 * same model; verify before adding.
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
  "claude-fable-5-1": "claude-fable-5.1",
  "grok-4-6": "grok-4.6",
  "gemini-3-8-flash": "gemini-3.8-flash",
  "minimax-m3-preview": "minimax-m3",
  // Verified 2026-09: routstr.otrta.me serves both claude-opus-5-5 and
  // claude-opus-5.5 with identical name ("Claude Opus 5.5") and 1M ctx;
  // cypherpunk declares claude-opus-5.5 as an alias of its claude-opus-5-5.
  "claude-opus-5-5": "claude-opus-5.5",
};

/**
 * All identifiers a provider model claims: native id first, then any
 * provider-declared aliases.
 */
export function modelIdentifiers(model: Model): string[] {
  return [model.id, ...(model.alias_ids ?? [])];
}

/**
 * Resolve a provider model entry to its canonical model ID.
 *
 * Priority: native id in the map → any alias in the map → the native id
 * itself (unmapped models keep their own id).
 */
export function canonicalIdForModel(model: Model): string {
  for (const identifier of modelIdentifiers(model)) {
    const canonical = MODEL_ID_MAPPINGS[identifier];
    if (canonical) return canonical;
  }
  return model.id;
}

/**
 * Find which model a provider would serve for a requested (canonical) ID.
 *
 * Priority: exact native id match → mapped match via id or alias. The exact
 * match always wins so a mapping can never shadow a model the provider
 * serves natively.
 *
 * Callers forwarding a request upstream must use the returned model's native
 * `id`, not the requested canonical ID.
 */
export function findModelForId(
  models: Model[],
  requestedId: string,
): Model | undefined {
  return (
    models.find((m) => m.id === requestedId) ??
    models.find((m) => canonicalIdForModel(m) === requestedId)
  );
}
