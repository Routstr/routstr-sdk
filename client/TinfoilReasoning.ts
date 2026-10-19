/**
 * Tinfoil reasoning-effort translation, applied before EHBP sealing.
 *
 * Tinfoil's gateway and its models do not agree on `reasoning_effort`: the
 * gateway advertises the OpenAI literals
 * (`none|minimal|low|medium|high|xhigh|max`), while a model's chat template can
 * be narrower. DeepSeek V4.1 and GLM 5.3 reject a literal `medium`:
 *
 *   DeepSeek V4.1 reasoning_effort must be low, high, xhigh, max, or an
 *   integer within [1, 100] in chat_template_kwargs
 *
 * Because EHBP encrypts the body end to end, the Routstr proxy is a blind relay
 * and cannot rewrite the field. The translation therefore has to happen here,
 * inside the client, before the request is sealed.
 *
 * Nodes running routstr-core#848 publish the per-model map on `/v1/models`
 * (`reasoning.effort_map`): the caller-facing levels a UI offers
 * (`low`/`medium`/`high`) as keys, the spelling the model's template accepts as
 * values.
 *
 * This deliberately mirrors the node's own readable-body translation in
 * `TinfoilUpstreamProvider._apply_reasoning_effort`, because the same model
 * must behave the same whether its body reaches the enclave plaintext or sealed
 * through EHBP. Two rules follow from that:
 *
 * - Only levels the model *rejects* are translated. A value that is already one
 *   of the model's own spellings is left exactly as sent: the map's keys
 *   overlap its values (DeepSeek maps `high` -> `xhigh` while also accepting
 *   `high`), so a key must never win over a value that is already legal.
 *   Otherwise a caller asking for `high` silently gets `xhigh`.
 * - Levels the map does not mention (`none`, `max`, `minimal`, integers) pass
 *   through unchanged. `none` disables reasoning and `max` outranks `xhigh`, so
 *   reshaping either would change what the caller asked for.
 *
 * Tinfoil publishes `effort_map` alone, with no `supported_efforts`, and one
 * must not be derived from the map's values: routstr-core *applies* that field
 * by snapping a request onto its members, which is what turned a deliberate
 * `none` into `low` and downgraded `max`. The map's values are the model's
 * spellings for the three coarse levels, not the set of values it accepts.
 *
 * When the map is absent — an older node, or a model whose reasoning is a plain
 * on/off toggle — the body is forwarded unchanged rather than guessed at.
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

function normalizeEffort(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The model's own spellings — the map's values. A body carrying one of these is
 * already native and must not be rewritten, even when the same string is also a
 * map key: DeepSeek publishes `high` as both a key (-> `xhigh`) and a value, and
 * a caller who asked for `high` means the native level, not the coarse key.
 */
function nativeEfforts(
  effortMap: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const native = new Set<string>();
  for (const value of Object.values(effortMap)) {
    if (typeof value === "string" && value.trim() !== "") {
      native.add(normalizeEffort(value));
    }
  }
  return native;
}

function mappedEffort(
  effort: string,
  effortMap: Readonly<Record<string, unknown>>,
  native: ReadonlySet<string>,
): string | null {
  const requested = normalizeEffort(effort);
  if (requested === "") {
    return null;
  }
  // Already legal for this model: leave it exactly as sent.
  if (native.has(requested)) {
    return null;
  }
  const mapped = effortMap[requested];
  if (typeof mapped !== "string") {
    return null;
  }
  const nativeValue = mapped.trim();
  if (nativeValue === "" || nativeValue === effort) {
    return null;
  }
  return nativeValue;
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
  native: ReadonlySet<string>,
): Record<string, unknown> | null {
  const container = site.parent === null ? body : body[site.parent];
  if (!isPlainObject(container)) {
    return null;
  }

  const current = container[site.field];
  if (typeof current !== "string") {
    return null;
  }

  const mapped = mappedEffort(current, effortMap, native);
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
 * Only levels the model rejects are translated: a value that is already one of
 * the model's own spellings, or one the map does not cover (`none`, `max`, an
 * integer), is forwarded untouched.
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

  const native = nativeEfforts(effortMap);

  // Thread each rewrite into the next site's read, so a body with several
  // shapes is fully translated in one pass. Each `rewriteAtSite` copies only
  // the containers on its own path, so untouched siblings keep their identity.
  let next: Record<string, unknown> = body;
  for (const site of EFFORT_SITES) {
    const rewritten = rewriteAtSite(next, site, effortMap, native);
    if (rewritten !== null) {
      next = rewritten;
    }
  }

  return next;
}
