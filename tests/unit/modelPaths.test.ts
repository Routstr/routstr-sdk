import { describe, expect, it } from "vitest";
import {
  MODEL_PATH_HEADER,
  DEEPSEEK_MODEL_PATH_WHITELIST,
  deepSeekModelPath,
  deepSeekModelPathHeaders,
  isWhitelistedDeepSeekModelPath,
} from "../../utils/modelPaths";

// Byte-exact selectors ai.redsh1ft.com advertises for deepseek-v4.1-flash on
// GET /v1/models/paths (provider ids are node-specific; the whitelist itself
// matches on url + endpoint tag only).
const OFFICIAL_API_SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&provider-id=5&model-id=deepseek-v4.1-flash";
const OPENROUTER_DEEPSEEK_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash&endpoint=deepseek";

describe("DeepSeek model path whitelist", () => {
  it("contains exactly the two whitelisted routes", () => {
    expect(DEEPSEEK_MODEL_PATH_WHITELIST).toEqual([
      { url: "https://api.deepseek.com" },
      { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" },
    ]);
  });

  it("defaults to the official DeepSeek API route and matches the node-advertised selector", () => {
    expect(deepSeekModelPath("deepseek-v4.1-flash", 5)).toBe(
      OFFICIAL_API_SELECTOR
    );
  });

  it("builds the node-advertised selector through OpenRouter's deepseek subprovider", () => {
    expect(
      deepSeekModelPath("deepseek-v4.1-flash", 8, DEEPSEEK_MODEL_PATH_WHITELIST[1])
    ).toBe(OPENROUTER_DEEPSEEK_SELECTOR);
  });

  it("percent-encodes like the node's urlencode, e.g. :batch model ids", () => {
    expect(deepSeekModelPath("deepseek-v4-pro-0813:batch", 8)).toBe(
      "url=https%3A%2F%2Fapi.deepseek.com&provider-id=8&model-id=deepseek-v4-pro-0813%3Abatch"
    );
  });

  it("accepts both node-advertised selectors", () => {
    expect(isWhitelistedDeepSeekModelPath(OFFICIAL_API_SELECTOR)).toBe(true);
    expect(isWhitelistedDeepSeekModelPath(OPENROUTER_DEEPSEEK_SELECTOR)).toBe(
      true
    );
  });

  it("ignores the node-specific provider id when matching a route", () => {
    // Another node would advertise the same official-API route under a
    // different provider id; the whitelist must still accept it (the node
    // enforces that the id matches the pinned url).
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fapi.deepseek.com&provider-id=42&model-id=deepseek-v4.1-flash"
      )
    ).toBe(true);
  });

  it("rejects non-whitelisted upstreams and OpenRouter subproviders", () => {
    // PPQ advertises this path for deepseek-v4.1-flash, but is not whitelisted.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fapi.ppq.ai&provider-id=6&model-id=deepseek-v4.1-flash"
      )
    ).toBe(false);
    // A bare OpenRouter selector lets OpenRouter pick any subprovider.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash"
      )
    ).toBe(false);
    // An OpenRouter path pinned to a non-DeepSeek subprovider.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash&endpoint=deepinfra%2Ffp8"
      )
    ).toBe(false);
    // The official API route does not carry an endpoint tag.
    expect(
      isWhitelistedDeepSeekModelPath(
        `${OFFICIAL_API_SELECTOR}&endpoint=deepseek`
      )
    ).toBe(false);
  });

  it("rejects malformed or incomplete selectors", () => {
    expect(isWhitelistedDeepSeekModelPath("")).toBe(false);
    expect(isWhitelistedDeepSeekModelPath("not-a-selector")).toBe(false);
    expect(
      isWhitelistedDeepSeekModelPath("url=https%3A%2F%2Fapi.deepseek.com")
    ).toBe(false);
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fapi.deepseek.com&provider-id=abc&model-id=deepseek-v4.1-flash"
      )
    ).toBe(false);
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fapi.deepseek.com&provider-id=5&model-id=%zz"
      )
    ).toBe(false);
  });

  it("builds the headers object for routeRequests", () => {
    expect(deepSeekModelPathHeaders("deepseek-v4.1-flash", 5)).toEqual({
      [MODEL_PATH_HEADER]: OFFICIAL_API_SELECTOR,
    });
    expect(
      deepSeekModelPathHeaders("deepseek-v4.1-flash", 8, DEEPSEEK_MODEL_PATH_WHITELIST[1])
    ).toEqual({
      [MODEL_PATH_HEADER]: OPENROUTER_DEEPSEEK_SELECTOR,
    });
  });
});
