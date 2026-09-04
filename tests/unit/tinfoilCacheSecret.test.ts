import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    await expect(
      resolveUserCacheSecret({ explicit: "explicit-secret" })
    ).resolves.toBe("explicit-secret");
  });

  it("prefers the environment variable over the persisted default", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");

    await expect(resolveUserCacheSecret()).resolves.toBe("env-secret");
  });

  it("treats an empty explicit value as unset and falls back to the env", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");

    await expect(resolveUserCacheSecret({ explicit: "" })).resolves.toBe(
      "env-secret"
    );
  });

  it("lets an explicit value win over the environment variable", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");

    await expect(
      resolveUserCacheSecret({ explicit: "explicit-secret" })
    ).resolves.toBe("explicit-secret");
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

describe("resolveUserCacheSecret with a custom persistPath", () => {
  // Each test uses its own path: resolved secrets are memoized per path at
  // module scope, so reusing a path would make tests order-dependent.
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "routstr-cache-secret-test-")
  );
  let counter = 0;
  const freshPath = () =>
    path.join(tmpRoot, `data-${counter++}`, "tinfoil-cache-secret");

  it("generates and persists the secret at the custom path", async () => {
    const persistPath = freshPath();
    const resolved = await resolveUserCacheSecret({ persistPath });

    expect(resolved).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(persistPath, "utf8")).toBe(resolved);
    if (process.platform !== "win32") {
      expect((fs.statSync(persistPath).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("memoizes the secret for a repeated custom path", async () => {
    const persistPath = freshPath();
    const first = await resolveUserCacheSecret({ persistPath });
    fs.rmSync(persistPath); // a second lookup must not regenerate

    await expect(resolveUserCacheSecret({ persistPath })).resolves.toBe(first);
  });

  it("reads back a secret persisted by an earlier process run", async () => {
    const persistPath = freshPath();
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, "preexisting-secret", { mode: 0o600 });

    await expect(resolveUserCacheSecret({ persistPath })).resolves.toBe(
      "preexisting-secret"
    );
  });

  it("lets the environment variable win over a custom path", async () => {
    vi.stubEnv(USER_CACHE_SECRET_ENV, "env-secret");
    const persistPath = freshPath();

    await expect(resolveUserCacheSecret({ persistPath })).resolves.toBe(
      "env-secret"
    );
    expect(fs.existsSync(persistPath)).toBe(false);
  });
});
