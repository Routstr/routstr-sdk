import { afterEach, describe, expect, it, vi } from "vitest";
import {
  injectUserCacheSecret,
  isUserCacheSecretEligible,
  resolveUserCacheSecret,
  USER_CACHE_SECRET_ENV,
} from "../../client/TinfoilCacheSecret";

describe("Tinfoil user_cache_secret eligibility", () => {
  it("accepts POSTs to cacheable endpoints by path suffix", () => {
    expect(isUserCacheSecretEligible("POST", "/v1/chat/completions")).toBe(true);
    expect(isUserCacheSecretEligible("post", "/chat/completions")).toBe(true);
    expect(isUserCacheSecretEligible("POST", "/v1/responses")).toBe(true);
    expect(isUserCacheSecretEligible("POST", "/v1/completions")).toBe(true);
  });

  it("rejects non-POST methods and non-cacheable endpoints", () => {
    expect(isUserCacheSecretEligible("GET", "/v1/chat/completions")).toBe(false);
    expect(isUserCacheSecretEligible("POST", "/v1/embeddings")).toBe(false);
    expect(isUserCacheSecretEligible("POST", "/v1/audio/transcriptions")).toBe(
      false
    );
  });
});

describe("injectUserCacheSecret", () => {
  it("adds the field to a JSON object body", () => {
    const injected = injectUserCacheSecret(
      JSON.stringify({ model: "kimi-k2-6", messages: [] }),
      "secret-123"
    );

    expect(JSON.parse(injected!)).toMatchObject({
      model: "kimi-k2-6",
      user_cache_secret: "secret-123",
    });
  });

  it("preserves int64-range literals instead of re-serializing through float64", () => {
    const raw = '{"model":"kimi-k2-6","seed":9007199254740993}';
    const injected = injectUserCacheSecret(raw, "secret-123");

    expect(injected).toContain("9007199254740993");
    expect(JSON.parse(injected!).seed).toBe(9007199254740992); // JS number repr
    expect(JSON.parse(injected!).user_cache_secret).toBe("secret-123");
  });

  it("replaces an empty-string existing field", () => {
    const injected = injectUserCacheSecret(
      JSON.stringify({ model: "x", user_cache_secret: "" }),
      "secret-456"
    );

    expect(JSON.parse(injected!)).toEqual({
      model: "x",
      user_cache_secret: "secret-456",
    });
  });

  it("leaves a non-empty existing field untouched", () => {
    const raw = JSON.stringify({
      model: "x",
      user_cache_secret: "caller-set",
    });

    expect(injectUserCacheSecret(raw, "secret-456")).toBeNull();
  });

  it("passes through non-object bodies", () => {
    expect(injectUserCacheSecret("[1,2,3]", "secret")).toBeNull();
    expect(injectUserCacheSecret("42", "secret")).toBeNull();
    expect(injectUserCacheSecret('"hello"', "secret")).toBeNull();
    expect(injectUserCacheSecret("{not json", "secret")).toBeNull();
  });
});

describe("resolveUserCacheSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a non-empty explicit value verbatim", async () => {
    await expect(resolveUserCacheSecret("explicit-secret")).resolves.toBe(
      "explicit-secret"
    );
  });

  it("prefers the environment variable over the persisted default", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");

    await expect(resolveUserCacheSecret()).resolves.toBe("env-secret");
  });

  it("treats an empty explicit value as unset and falls back to the env", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");

    await expect(resolveUserCacheSecret("")).resolves.toBe("env-secret");
  });

  it("lets an explicit value win over the environment variable", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");

    await expect(resolveUserCacheSecret("explicit-secret")).resolves.toBe(
      "explicit-secret"
    );
  });

  it("ignores whitespace-only environment values", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "   ");

    // Falls through to the generated (persisted or in-memory) default. The
    // default is a 256-bit hex string whenever crypto randomness is available.
    const resolved = await resolveUserCacheSecret();
    if (resolved !== "") {
      expect(resolved).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
