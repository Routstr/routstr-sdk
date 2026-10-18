/**
 * Tinfoil reasoning-effort translation, applied before EHBP sealing.
 *
 * Tinfoil publishes a per-model `effort_map` (caller-facing level -> the value
 * the model's chat template accepts). The two layers do not agree on the
 * vocabulary: the gateway's `reasoning_effort` literal set includes `medium`,
 * but DeepSeek V4.1's template only accepts `low`/`high`/`xhigh`/`max` and
 * rejects a literal `medium`:
 *
 *   DeepSeek V4.1 reasoning_effort must be low, high, xhigh, max, or an
 *   integer within [1, 100] in chat_template_kwargs
 *
 * Because EHBP encrypts the body end to end, the Routstr proxy is a blind relay
 * and cannot rewrite the field. The translation therefore has to happen here,
 * inside the client, before the request is sealed.
 *
 * The map is advertised by the node on `/v1/models` (`reasoning.effort_map`;
 * see the Tinfoil `fetch_models` in routstr-core). When it is absent — an older
 * node, or a model with no effort levels — the body is forwarded unchanged
 * rather than guessed at.
 */

import type { ModelReasoning } from "../core/types";

/** Where a request may carry the caller-facing effort level. */
interface EffortSite {
  /** Parent object holding the field, or null for the body itself. */
  readonly parent: "reasoning" | "chat_template_kwargs" | null;
  readonly field: string;
}

/**
 * Every shape seen in the wild for an OpenAI/Anthropic-compatible effort:
 *
 * - top-level `reasoning_effort` (OpenAI chat completions)
 * - `reasoning.effort` (OpenRouter / OpenAI Responses style)
 * - `chat_template_kwargs.reasoning_effort` (Tinfoil's documented enable shape)
 */
const EFFORT_SITES: readonly EffortSite[] = [
  { parent: null, field: "reasoning_effort" },
  { parent: "reasoning", field: "effort" },
  { parent: "chat_template_kwargs", field: "reasoning_effort" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mappedEffort(
  effort: string,
  effortMap: Readonly<Record<string, unknown>>,
): string | null {
  const requested = effort.trim().toLowerCase();
  if (requested === "") {
    return null;
  }
  const mapped = effortMap[requested];
  if (typeof mapped !== "string" || mapped.trim() === "") {
    return null;
  }
  return mapped;
}

/**
 * Rewrite the effort at one site. Returns a new body object when the value has
 * to change, or null when this site holds nothing to translate.
 *
 * Only the containers on the path to the changed field are copied, so callers
 * holding the original body (retries and failover rebuild from it) never see a
 * mutation.
 */
function rewriteAtSite(
  body: Record<string, unknown>,
  site: EffortSite,
  effortMap: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const container = site.parent === null ? body : body[site.parent];
  if (!isPlainObject(container)) {
    return null;
  }

  const current = container[site.field];
  if (typeof current !== "string") {
    return null;
  }

  const mapped = mappedEffort(current, effortMap);
  if (mapped === null || mapped === current) {
    return null;
  }

  const nextContainer = { ...container, [site.field]: mapped };
  return site.parent === null
    ? nextContainer
    : { ...body, [site.parent]: nextContainer };
}

/**
 * Translate a Tinfoil request body's reasoning effort into the exact value the
 * target model accepts, using the node-advertised `effort_map`.
 *
 * Every site is translated, not just the first one found: a caller (or a UI
 * built on top of it) may set more than one shape in the same body, and the
 * enclave validates whichever ones it reads. A body carrying two shapes
 * therefore comes out fully native rather than half-translated.
 *
 * Returns the original body object when nothing has to change — no map, a
 * non-object body, no effort field, a value the map does not cover, or a value
 * that is already native (`high`, `xhigh`, ...). Each value is written back to
 * the shape it was read from, so a caller that sent
 * `chat_template_kwargs.reasoning_effort` gets that field updated rather than a
 * new top-level one.
 */
export function applyTinfoilReasoningEffort(
  body: unknown,
  reasoning: ModelReasoning | null | undefined,
): unknown {
  const effortMap = reasoning?.effort_map;
  if (!isPlainObject(effortMap) || !isPlainObject(body)) {
    return body;
  }

  // Thread each rewrite into the next site's read, so a body with several
  // shapes is fully translated in one pass. Each `rewriteAtSite` copies only
  // the containers on its own path, so untouched siblings keep their identity.
  let next: Record<string, unknown> = body;
  for (const site of EFFORT_SITES) {
    const rewritten = rewriteAtSite(next, site, effortMap);
    if (rewritten !== null) {
      next = rewritten;
    }
  }

  return next;
}
