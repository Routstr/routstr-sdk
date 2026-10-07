import { describe, expect, it } from "vitest";
import {
  parseModelPathsPayload,
  resolveDeepSeekModelPathSelectors,
} from "../../utils/modelPaths";

/**
 * A node may file one model under several spellings — the canonical id and a
 * mapped variant such as deepseek-v4-1-flash — as *separate* entries with
 * different path lists, and may declare alias_ids of its own. Resolution must
 * read the whole set, otherwise a route advertised only under a variant
 * spelling is invisible (and a node listing only that spelling resolves to
 * null, silently dropping it from model-path ranking).
 */

const CANONICAL = "deepseek-v4.1-flash";
const VARIANT = "deepseek-v4-1-flash";

/** Byte-exact selector shape the nodes advertise (quote_plus encoding). */
const selector = (modelId: string, endpoint?: string): string =>
  `url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=${encodeURIComponent(
    modelId
  ).replace(/%20/g, "+")}` + (endpoint ? `&endpoint=${endpoint}` : "");

const priced = (
  path: string,
  completion: number
): { path: string; model: { sats_pricing: Record<string, number> } } => ({
  path,
  model: { sats_pricing: { prompt: 0.001, completion, max_cost: 700 } },
});

const entry = (
  id: string,
  paths: unknown[],
  alias_ids?: unknown
): Record<string, unknown> => {
  // The wire format is always an object per path; accept bare strings in the
  // tests for readability and wrap them.
  const normalised = paths.map((p) => (typeof p === "string" ? { path: p } : p));
  return alias_ids === undefined
    ? { id, paths: normalised }
    : { id, paths: normalised, alias_ids };
};

const payload = (data: unknown[]): unknown => ({ data, updated_at: null });

const parse = (data: unknown[]) => {
  const parsed = parseModelPathsPayload(payload(data));
  if (!parsed) throw new Error("payload did not parse");
  return parsed;
};

describe("parseModelPathsPayload alias_ids", () => {
  it("keeps the alias_ids a node declares for a model", () => {
    const parsed = parse([
      entry(CANONICAL, [selector(CANONICAL, "deepseek")], [VARIANT]),
    ]);
    expect(parsed.data[0].alias_ids).toEqual([VARIANT]);
  });

  it("defaults to an empty list when the node declares none", () => {
    const parsed = parse([entry(CANONICAL, [selector(CANONICAL)])]);
    expect(parsed.data[0].alias_ids).toEqual([]);
  });

  it("drops non-string and empty aliases", () => {
    const parsed = parse([
      entry(CANONICAL, [selector(CANONICAL)], [VARIANT, "", 7, null]),
    ]);
    expect(parsed.data[0].alias_ids).toEqual([VARIANT]);
  });
});

describe("resolveDeepSeekModelPathSelectors across spellings", () => {
  it("resolves a route advertised only under a mapped variant spelling", () => {
    const paths = parse([
      entry(VARIANT, [selector(VARIANT, "deepseek")]),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, CANONICAL);
    expect(resolved?.selectors[0]).toBe(selector(VARIANT, "deepseek"));
  });

  it("merges paths from every spelling, canonical first", () => {
    const paths = parse([
      entry(CANONICAL, [priced(selector(CANONICAL, "deepseek"), 0.001)]),
      entry(VARIANT, [priced(selector(VARIANT, "fireworks"), 0.002)]),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, CANONICAL);
    expect(resolved?.selectors).toEqual([
      selector(CANONICAL, "deepseek"),
      selector(VARIANT, "fireworks"),
    ]);
    // Pricing travels with the path it was advertised next to.
    expect(resolved?.satsPricing[0]?.completion).toBe(0.001);
    expect(resolved?.satsPricing[1]?.completion).toBe(0.002);
  });

  it("lets the requested spelling win a route both entries advertise", () => {
    const paths = parse([
      entry(CANONICAL, [priced(selector(CANONICAL, "deepseek"), 0.001)]),
      entry(VARIANT, [priced(selector(VARIANT, "deepseek"), 0.009)]),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, CANONICAL);
    expect(resolved?.selectors[0]).toBe(selector(CANONICAL, "deepseek"));
    expect(resolved?.satsPricing[0]?.completion).toBe(0.001);
  });

  it("prefers the variant entry when the variant is what was requested", () => {
    const paths = parse([
      entry(CANONICAL, [priced(selector(CANONICAL, "deepseek"), 0.001)]),
      entry(VARIANT, [priced(selector(VARIANT, "deepseek"), 0.009)]),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, VARIANT);
    expect(resolved?.satsPricing[0]?.completion).toBe(0.009);
  });

  it("follows alias_ids the node declares, even with an empty mapping snapshot", () => {
    const paths = parse([
      entry(CANONICAL, [selector(VARIANT, "deepseek")], [VARIANT]),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, CANONICAL, {});
    expect(resolved?.selectors[0]).toBe(selector(VARIANT, "deepseek"));
  });

  it("does not invent spellings the snapshot no longer links", () => {
    // The mapping snapshot is authoritative: with none, and no alias_ids on
    // the node, a variant-only entry is a different model.
    const paths = parse([entry(VARIANT, [selector(VARIANT, "deepseek")])]);
    expect(resolveDeepSeekModelPathSelectors(paths, CANONICAL, {})).toBeNull();
  });

  it("never merges an entry that shares no spelling", () => {
    const paths = parse([
      entry(CANONICAL, [selector(CANONICAL, "deepseek")]),
      entry("grok-4-6", [selector("grok-4-6", "fireworks")]),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, CANONICAL);
    expect(resolved?.selectors).toEqual([
      selector(CANONICAL, "deepseek"),
      null,
    ]);
  });

  it("returns null when the node lists none of the spellings", () => {
    const paths = parse([entry("grok-4-6", [selector("grok-4-6")])]);
    expect(resolveDeepSeekModelPathSelectors(paths, CANONICAL)).toBeNull();
  });

  it("still ignores routes outside the whitelist, whatever the spelling", () => {
    const paths = parse([
      entry(
        VARIANT,
        [
          "url=https%3A%2F%2Fapi.deepseek.com&model-id=deepseek-v4-1-flash",
          "url=https%3A%2F%2Fapi.venice.ai%2Fapi%2Fv1&model-id=deepseek-v4-1-flash",
        ]
      ),
    ]);
    const resolved = resolveDeepSeekModelPathSelectors(paths, CANONICAL);
    expect(resolved?.selectors).toEqual([null, null]);
  });
});
