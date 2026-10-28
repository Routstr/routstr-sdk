import { describe, expect, it } from "vitest";
import {
  parseModelPathWhitelist, normalizeRoute, modelPathPolicyFor,
} from "../../core/modelPathWhitelist";
import { resolveModelPathSelectors } from "../../utils/modelPaths";

const route = { url: "https://upstream.example/v1" };
const parse = (models: unknown, extra = {}) =>
  parseModelPathWhitelist(JSON.stringify({ models, ...extra }), {});

describe("model path policy contract", () => {
  it.each([null, [], {}, { models: null }, { models: [] }, { models: {}, version: 2 }])(
    "rejects malformed envelopes %j", content => {
      expect(() => parseModelPathWhitelist(JSON.stringify(content), {})).toThrow();
    });
  it("rejects invalid JSON", () => expect(() => parseModelPathWhitelist("{", {})).toThrow());
  it.each([
    { "": { routes: [route] } }, { " ": { routes: [route] } },
    JSON.parse('{"__proto__":{"routes":[]}}'), { constructor: { routes: [route] } },
    { prototype: { routes: [route] } }, { x: null }, { x: [] }, { x: {} },
    { x: { routes: [] } }, { x: { routes: [null] } }, { x: { routes: [[]] } },
    { x: { routes: [{ url: "" }] } }, { x: { routes: [{ url: "ftp://example.com" }] } },
    { x: { routes: [{ url: "/relative" }] } }, { x: { routes: [{ url: "https:relative" }] } }, { x: { routes: [{ ...route, endpoint: " " }] } },
    { x: { routes: [{ ...route, endpoint: null }] } },
    { x: { routes: [route], nodes: "https://node.example" } },
    { x: { routes: [route], nodes: [""] } }, { x: { routes: [route], nodes: ["node.example"] } },
    { x: { routes: [route], nodes: ["ftp://node.example"] } },
  ])("rejects invalid policies %j", models => expect(() => parse(models)).toThrow());

  it("enforces all caps before deduplication", () => {
    expect(() => parse(Object.fromEntries(Array.from({ length: 101 }, (_,i) => [`m${i}`, { routes: [route] }])))).toThrow();
    expect(() => parse({ x: { routes: Array(201).fill(route) } })).toThrow();
    expect(() => parse({ x: { routes: [route], nodes: Array(51).fill("https://node.example") } })).toThrow();
  });

  it("rejects normalized/mapped collisions and resolves variant keys", () => {
    expect(() => parse({ X: { routes: [route] }, x: { routes: [route] } })).toThrow();
    expect(() => parseModelPathWhitelist(JSON.stringify({ models: {
      variant: { routes: [route] }, canonical: { routes: [route] },
    } }), { variant: "canonical" })).toThrow();
    const policy = parse({ variant: { routes: [route] } });
    expect(modelPathPolicyFor("canonical", policy, { variant: "canonical" })).toEqual(policy.variant);
    expect(modelPathPolicyFor(" Variant ", policy, { variant: "canonical" })).toEqual(policy.variant);
    expect(modelPathPolicyFor("constructor", policy, {})).toBeUndefined();
  });

  it("preserves exact case-sensitive mapping identities for lookup and collisions", () => {
    const mappings = { variant: "Canonical" };
    const policy = parseModelPathWhitelist(JSON.stringify({ models: { variant: { routes: [route] } } }), mappings);
    expect(modelPathPolicyFor("Canonical", policy, mappings)).toEqual(policy.variant);
    expect(modelPathPolicyFor("variant", policy, mappings)).toEqual(policy.variant);
    expect(() => parseModelPathWhitelist(JSON.stringify({ models: {
      variant: { routes: [route] }, Canonical: { routes: [route] },
    } }), mappings)).toThrow("colliding model keys");
    const canonicalPolicy = parseModelPathWhitelist(JSON.stringify({ models: { Canonical: { routes: [route] } } }), mappings);
    expect(modelPathPolicyFor("variant", canonicalPolicy, mappings)).toEqual(canonicalPolicy.Canonical);
  });

  it("ignores annotations, retains route order, dedupes equivalents, and is JSON-safe", () => {
    const policy = parse({ x: { routes: [
      { url: "HTTPS://UPSTREAM.EXAMPLE:443", note: "first" },
      { url: "https://second.example" }, { url: "https://upstream.example/" },
    ], annotation: true, nodes: [] } }, { note: true });
    expect(Object.getPrototypeOf(policy)).toBeNull();
    expect(policy.x.routes.map(r => r.url)).toEqual(["https://upstream.example/", "https://second.example/"]);
    expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
    expect(parse({ x: { routes: [route] } }).x.nodes).toBeUndefined();
    expect(policy.x.nodes).toEqual([]);
  });

  it("normalizes only documented URL equivalences idempotently", () => {
    const identity = normalizeRoute("HTTPS://EXAMPLE.COM:443/a/../v1");
    expect(identity).toBe(normalizeRoute("https://example.com/v1"));
    const [url, endpoint] = JSON.parse(identity);
    expect(normalizeRoute(url, endpoint ?? undefined)).toBe(identity);
    expect(normalizeRoute("https://example.com")).toBe(normalizeRoute("https://example.com/"));
    for (const distinct of ["https://example.com/v1/", "https://example.com/V1", "https://example.com:444/v1",
      "https://example.com/v1?a=1", "https://example.com/v1?b=2&a=1"]) {
      expect(normalizeRoute(distinct)).not.toBe(identity);
    }
    expect(normalizeRoute("https://example.com/?a=1&b=2")).not.toBe(normalizeRoute("https://example.com/?b=2&a=1"));
    expect(normalizeRoute(url, "Tag")).not.toBe(normalizeRoute(url, "tag"));
    expect(normalizeRoute(url, "tag")).not.toBe(normalizeRoute(url));
    for (const invalid of ["https://u:p@example.com", "https://example.com/#frag", "https://example.com/#"]) {
      expect(() => normalizeRoute(invalid)).toThrow();
    }
  });

  it("matches normalized identities but returns advertised bytes and per-route metadata", () => {
    const selector = "url=HTTPS%3A%2F%2FEXAMPLE.COM%3A443&model-id=native&provider-id=legacy";
    const node = { data: [{ id: "native", alias_ids: ["canonical"], paths: [
      { path: selector, model: { sats_pricing: { completion: 2, max_cost: 50 } } },
    ] }], updatedAt: null };
    expect(resolveModelPathSelectors(node, "canonical", [{ url: "https://example.com/" }], {}))
      .toEqual({ selectors: [selector], satsPricing: [{ completion: 2, max_cost: 50 }] });
    expect(resolveModelPathSelectors(node, "canonical", [{ url: "https://other.example/" }], {})?.selectors).toEqual([null]);
  });
});
