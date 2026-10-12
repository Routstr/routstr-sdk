import { describe, expect, it } from "vitest";
import {
  MODEL_PATH_HEADER,
  DEEPSEEK_MODEL_PATH_WHITELIST,
  canonicalModelPath,
  selectorModelId,
  deepSeekModelPath,
  deepSeekModelPathHeaders,
  isWhitelistedDeepSeekModelPath,
} from "../../utils/modelPaths";

// Byte-exact selectors the nodes advertise for deepseek-v4.1-flash on
// GET /v1/models/paths. Paths are unique by themselves (no provider id);
// the whitelist matches on url + endpoint tag only.
const OPENROUTER_DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
const OPENROUTER_FIREWORKS_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks";
const OPENROUTER_VENICE_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=venice%2Ffp8";
const OPENROUTER_WAFER_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=wafer";
const PPQ_SELECTOR =
  "url=https%3A%2F%2Fapi.ppq.ai&model-id=deepseek-v4.1-flash";
// Direct upstreams are advertised under the spelling the node files them as.
const VENICE_DIRECT_SELECTOR =
  "url=https%3A%2F%2Fapi.venice.ai%2Fapi%2Fv1&model-id=deepseek-v4-1-flash";
const FIREWORKS_DIRECT_SELECTOR =
  "url=https%3A%2F%2Fapi.fireworks.ai%2Finference%2Fv1&model-id=accounts%2Ffireworks%2Fmodels%2Fdeepseek-v4p1-flash";
// Still not whitelisted: the official DeepSeek API route.
const OFFICIAL_API_SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&model-id=deepseek-v4.1-flash";

describe("DeepSeek model path whitelist", () => {
  it("contains the whitelisted routes, in preference order, appended after the OpenRouter pins", () => {
    expect(DEEPSEEK_MODEL_PATH_WHITELIST).toEqual([
      { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
      { url: "https://openrouter.ai/api/v1", endpoint: "fireworks" },
      { url: "https://api.ppq.ai" },
      { url: "https://openrouter.ai/api/v1", endpoint: "venice/fp8" },
      { url: "https://openrouter.ai/api/v1", endpoint: "wafer" },
      { url: "https://api.venice.ai/api/v1" },
      { url: "https://api.fireworks.ai/inference/v1" },
    ]);
    // The default pin must never move: it is the node ranking metric and the
    // source of the deposit gate's max_cost envelope.
    expect(DEEPSEEK_MODEL_PATH_WHITELIST[0]).toEqual({
      url: "https://openrouter.ai/api/v1",
      endpoint: "deepseek",
    });
  });

  it("builds each appended route byte-exact as the node advertises it", () => {
    const [
      ,
      ,
      ppqRoute,
      veniceRoute,
      waferRoute,
      veniceDirect,
      fireworksDirect,
    ] = DEEPSEEK_MODEL_PATH_WHITELIST;
    expect(deepSeekModelPath("deepseek-v4.1-flash", ppqRoute)).toBe(PPQ_SELECTOR);
    expect(deepSeekModelPath("deepseek-v4.1-flash", veniceRoute)).toBe(
      OPENROUTER_VENICE_SELECTOR
    );
    expect(deepSeekModelPath("deepseek-v4.1-flash", waferRoute)).toBe(
      OPENROUTER_WAFER_SELECTOR
    );
    // Direct upstreams carry no endpoint tag; the model-id is the node's
    // advertised spelling, not the canonical one.
    expect(deepSeekModelPath("deepseek-v4-1-flash", veniceDirect)).toBe(
      VENICE_DIRECT_SELECTOR
    );
    expect(
      deepSeekModelPath(
        "accounts/fireworks/models/deepseek-v4p1-flash",
        fireworksDirect
      )
    ).toBe(FIREWORKS_DIRECT_SELECTOR);
  });

  it("accepts the appended selectors", () => {
    for (const selector of [
      PPQ_SELECTOR,
      OPENROUTER_VENICE_SELECTOR,
      OPENROUTER_WAFER_SELECTOR,
      VENICE_DIRECT_SELECTOR,
      FIREWORKS_DIRECT_SELECTOR,
    ]) {
      expect(isWhitelistedDeepSeekModelPath(selector)).toBe(true);
    }
  });

  it("defaults to OpenRouter's deepseek subprovider and matches the node-advertised selector", () => {
    expect(deepSeekModelPath("deepseek-v4.1-flash")).toBe(
      OPENROUTER_DEEPSEEK_SELECTOR
    );
  });

  it("builds the node-advertised selector through OpenRouter's fireworks subprovider", () => {
    expect(
      deepSeekModelPath(
        "deepseek-v4.1-flash",
        DEEPSEEK_MODEL_PATH_WHITELIST[1]
      )
    ).toBe(OPENROUTER_FIREWORKS_SELECTOR);
  });

  it("percent-encodes like the node's urlencode, e.g. :batch model ids", () => {
    expect(deepSeekModelPath("deepseek-v4-pro-0813:batch")).toBe(
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4-pro-0813%3Abatch&endpoint=deepseek"
    );
  });

  it("accepts both node-advertised selectors", () => {
    expect(isWhitelistedDeepSeekModelPath(OPENROUTER_DEEPSEEK_SELECTOR)).toBe(
      true
    );
    expect(isWhitelistedDeepSeekModelPath(OPENROUTER_FIREWORKS_SELECTOR)).toBe(
      true
    );
  });

  it("tolerates a legacy provider-id parameter when matching a route", () => {
    // Older nodes advertised the same route with a node-internal provider id;
    // the parameter is ignored, never required.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=42&model-id=deepseek-v4.1-flash&endpoint=deepseek"
      )
    ).toBe(true);
  });

  it("rejects non-whitelisted upstreams and OpenRouter subproviders", () => {
    // The official DeepSeek API route is not whitelisted.
    expect(isWhitelistedDeepSeekModelPath(OFFICIAL_API_SELECTOR)).toBe(false);
    // A bare OpenRouter selector lets OpenRouter pick any subprovider.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash"
      )
    ).toBe(false);
    // An OpenRouter path pinned to a non-whitelisted subprovider.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepinfra%2Ffp8"
      )
    ).toBe(false);
    // A whitelisted endpoint tag on a non-whitelisted base URL.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fapi.deepseek.com&model-id=deepseek-v4.1-flash&endpoint=deepseek"
      )
    ).toBe(false);
    // A non-whitelisted subprovider tag on a whitelisted base URL.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepinfra%2Ffp4"
      )
    ).toBe(false);
  });

  it("rejects malformed or incomplete selectors", () => {
    expect(isWhitelistedDeepSeekModelPath("")).toBe(false);
    expect(isWhitelistedDeepSeekModelPath("not-a-selector")).toBe(false);
    expect(
      isWhitelistedDeepSeekModelPath("url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1")
    ).toBe(false);
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=%zz&endpoint=deepseek"
      )
    ).toBe(false);
  });

  it("canonicalModelPath gives selectors of the same route one identity", () => {
    // New-format selector and a legacy provider-id selector of the same
    // route share the canonical identity used for path-scoped cooldowns.
    expect(canonicalModelPath(OPENROUTER_DEEPSEEK_SELECTOR)).toBe(
      OPENROUTER_DEEPSEEK_SELECTOR
    );
    expect(
      canonicalModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash&endpoint=deepseek"
      )
    ).toBe(OPENROUTER_DEEPSEEK_SELECTOR);
    // Different routes have different identities.
    expect(canonicalModelPath(OPENROUTER_FIREWORKS_SELECTOR)).not.toBe(
      canonicalModelPath(OPENROUTER_DEEPSEEK_SELECTOR)
    );
    // Malformed selectors have no identity.
    expect(canonicalModelPath("not-a-selector")).toBeNull();
  });

  it("builds the headers object for routeRequests", () => {
    expect(deepSeekModelPathHeaders("deepseek-v4.1-flash")).toEqual({
      [MODEL_PATH_HEADER]: OPENROUTER_DEEPSEEK_SELECTOR,
    });
    expect(
      deepSeekModelPathHeaders(
        "deepseek-v4.1-flash",
        DEEPSEEK_MODEL_PATH_WHITELIST[1]
      )
    ).toEqual({
      [MODEL_PATH_HEADER]: OPENROUTER_FIREWORKS_SELECTOR,
    });
  });
});

describe("selectorModelId", () => {
  it("returns the selector's model-id spelling, including variant spellings", () => {
    // The direct Venice route is advertised only under the dash spelling.
    // The request body must carry exactly this id when the route is pinned,
    // or the node rejects the pair with 400 invalid_request.
    expect(selectorModelId(VENICE_DIRECT_SELECTOR)).toBe("deepseek-v4-1-flash");
    expect(selectorModelId(OPENROUTER_DEEPSEEK_SELECTOR)).toBe(
      "deepseek-v4.1-flash"
    );
    // Endpoint tags and legacy provider-id parameters do not disturb it.
    expect(
      selectorModelId(
        "url=https%3A%2F%2Fapi.venice.ai%2Fapi%2Fv1&provider-id=1&model-id=deepseek-v4-1-flash"
      )
    ).toBe("deepseek-v4-1-flash");
  });

  it("returns null for malformed selectors", () => {
    expect(selectorModelId("")).toBeNull();
    expect(selectorModelId("url=https%3A%2F%2Fapi.ppq.ai")).toBeNull();
    expect(selectorModelId("model-id=deepseek-v4.1-flash")).toBeNull();
  });
});
