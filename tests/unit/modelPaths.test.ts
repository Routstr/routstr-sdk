import { describe, expect, it } from "vitest";
import {
  MODEL_PATH_HEADER,
  DEEPSEEK_MODEL_PATH_WHITELIST,
  deepSeekModelPath,
  deepSeekModelPathHeaders,
  isWhitelistedDeepSeekModelPath,
} from "../../utils/modelPaths";

// Byte-exact selectors ai.redsh1ft.com advertises for deepseek-v4.1-flash on
// GET /v1/models/paths (provider-id 5 = api.deepseek.com, 8 = openrouter).
const OFFICIAL_API_SELECTOR =
  "url=https%3A%2F%2Fapi.deepseek.com&provider-id=5&model-id=deepseek-v4.1-flash";
const OPENROUTER_SELECTOR =
  "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4.1-flash";

describe("DeepSeek model path whitelist", () => {
  it("contains exactly the two whitelisted routes", () => {
    expect(DEEPSEEK_MODEL_PATH_WHITELIST).toEqual([
      { url: "https://api.deepseek.com", providerId: 5 },
      { url: "https://openrouter.ai/api/v1", providerId: 8 },
    ]);
  });

  it("defaults to the official DeepSeek API route and matches the node-advertised selector", () => {
    expect(deepSeekModelPath("deepseek-v4.1-flash")).toBe(OFFICIAL_API_SELECTOR);
  });

  it("builds the node-advertised selector through OpenRouter", () => {
    expect(
      deepSeekModelPath("deepseek-v4.1-flash", DEEPSEEK_MODEL_PATH_WHITELIST[1])
    ).toBe(OPENROUTER_SELECTOR);
  });

  it("percent-encodes like the node's urlencode, e.g. :batch model ids", () => {
    expect(
      deepSeekModelPath("deepseek-v4-pro-0813:batch", DEEPSEEK_MODEL_PATH_WHITELIST[1])
    ).toBe(
      "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=8&model-id=deepseek-v4-pro-0813%3Abatch"
    );
  });

  it("accepts both node-advertised selectors", () => {
    expect(isWhitelistedDeepSeekModelPath(OFFICIAL_API_SELECTOR)).toBe(true);
    expect(isWhitelistedDeepSeekModelPath(OPENROUTER_SELECTOR)).toBe(true);
  });

  it("still accepts an endpoint-pinned selector on a whitelisted route", () => {
    expect(
      isWhitelistedDeepSeekModelPath(`${OPENROUTER_SELECTOR}&endpoint=deepseek`)
    ).toBe(true);
  });

  it("rejects selectors on non-whitelisted routes, even if the node advertises them", () => {
    // PPQ advertises this path for deepseek-v4.1-flash, but only two entries
    // are whitelisted for now.
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fapi.ppq.ai&provider-id=6&model-id=deepseek-v4.1-flash"
      )
    ).toBe(false);
    expect(
      isWhitelistedDeepSeekModelPath(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=99&model-id=deepseek-v4.1-flash"
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
    expect(deepSeekModelPathHeaders("deepseek-v4.1-flash")).toEqual({
      [MODEL_PATH_HEADER]: OFFICIAL_API_SELECTOR,
    });
    expect(deepSeekModelPathHeaders("deepseek-v4.1-flash", DEEPSEEK_MODEL_PATH_WHITELIST[1])).toEqual({
      [MODEL_PATH_HEADER]: OPENROUTER_SELECTOR,
    });
  });
});
