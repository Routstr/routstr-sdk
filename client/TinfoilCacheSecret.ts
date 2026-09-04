/**
 * Tinfoil secure prompt-cache secret (`user_cache_secret`) support.
 *
 * Tinfoil's prompt cache is salted: the enclave derives a request's cache
 * namespace from the authenticated Tinfoil API identity (the tenant) plus a
 * client-held `user_cache_secret` field carried inside the encrypted request
 * body. Under the same API identity, requests with the same secret share
 * cached prefixes; requests with different secrets cannot observe each other's
 * cache timing.
 *
 * This is the exact field Tinfoil's own SDKs inject. We reimplement it here
 * (rather than reuse `SecureClient.fetch`) because Routstr performs its own
 * EHBP request encryption so it can preserve plaintext proxy-side error
 * responses. Injection happens inside the EHBP sealing boundary, so the secret
 * is only ever visible to the verified Tinfoil enclave — never to Routstr or
 * to anyone on the wire.
 *
 * The secret is NOT an API credential or encryption key. It does not encrypt
 * prompts or cache entries. Treat it as sensitive application data and avoid
 * logging it.
 */

export const USER_CACHE_SECRET_FIELD = "user_cache_secret";
export const USER_CACHE_SECRET_ENV = "TINFOIL_USER_CACHE_SECRET";

/** Options accepted by {@link resolveUserCacheSecret}. */
export interface ResolveUserCacheSecretOptions {
  /** Explicit secret value. The first non-empty value wins. */
  explicit?: string;
  /**
   * Optional file path for the persisted default secret (analogous to
   * `options.dbPath` on the sqlite storage driver). When omitted, the
   * secret persists at `~/.tinfoil/user_cache_secret` — the same location
   * Tinfoil's own SDKs use, so one machine shares one cache namespace
   * across tools. Set this to keep an app's secret isolated (e.g. inside a
   * routstrd data directory).
   */
  persistPath?: string;
}

/**
 * OpenAI-compatible endpoints whose bodies carry the field. Matched by path
 * suffix so `/v1/chat/completions`, `/chat/completions`, and custom
 * path-prefixed proxies all qualify. Embeddings, audio, files, and other
 * endpoints do not prefix-cache and may reject unknown fields.
 */
const USER_CACHE_SECRET_PATHS = [
  "/chat/completions",
  "/completions",
  "/responses",
];

const USER_CACHE_SECRET_DIR_NAME = ".tinfoil";
const USER_CACHE_SECRET_FILE_NAME = "user_cache_secret";

// ---------------------------------------------------------------------------
// Secret generation & resolution
// ---------------------------------------------------------------------------

/** Returns a fresh 256-bit random secret, hex-encoded. */
function newUserCacheSecret(): string {
  try {
    const bytes = new Uint8Array(32);
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj?.getRandomValues) {
      throw new Error("Crypto.getRandomValues unavailable");
    }
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    console.warn(
      "[routstr] could not generate a user cache secret; automatic prompt-cache scoping is unavailable"
    );
    return "";
  }
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const value = maybeProcess.process?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
}

function isNodeLikeRuntime(): boolean {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { versions?: Record<string, string | undefined> };
  };
  const versions = maybeProcess.process?.versions;
  return Boolean(versions?.node || versions?.bun);
}

/**
 * The process-lifetime fallback for when the secret cannot be persisted. It
 * still isolates this process's cache namespace, but continuity is lost on
 * restart — like a session ID. We warn once in server-side runtimes where
 * persistence is expected, and stay silent in browsers where in-memory
 * storage is normal.
 */
let ephemeralUserCacheSecret: string | undefined;
let warnedEphemeral = false;

function getEphemeralUserCacheSecret(): string {
  if (ephemeralUserCacheSecret === undefined) {
    ephemeralUserCacheSecret = newUserCacheSecret();
    if (ephemeralUserCacheSecret !== "" && isNodeLikeRuntime() && !warnedEphemeral) {
      warnedEphemeral = true;
      console.warn(
        "[routstr] could not persist the user cache secret; using an in-memory secret, " +
          "so prompt-cache continuity resets when this process exits " +
          `(set ${USER_CACHE_SECRET_ENV} or userCacheSecret to pin one)`
      );
    }
  }
  return ephemeralUserCacheSecret;
}

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");

function readSecretFile(fs: NodeFs, file: string): string | undefined | null {
  try {
    const content = fs
      .readFileSync(file, { encoding: "utf8", flag: "r" })
      .trim();
    return content === "" ? null : content;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : null;
  }
}

/**
 * Resolve the file used for the persisted default secret. A `persistPath`
 * option wins; otherwise we use `~/.tinfoil/user_cache_secret` — the same
 * location Tinfoil's own SDKs use, so one machine gets one cache namespace
 * across Tinfoil SDKs. Returns null when no location is available.
 */
async function defaultPersistLocation(
  path: NodePath,
  persistPath?: string
): Promise<{ dir: string; file: string } | null> {
  if (persistPath !== undefined && persistPath !== "") {
    return { dir: path.dirname(persistPath), file: persistPath };
  }

  const os = await import("node:os");
  const home = os.homedir();
  if (!home) {
    return null;
  }

  const dir = path.join(home, USER_CACHE_SECRET_DIR_NAME);
  return { dir, file: path.join(dir, USER_CACHE_SECRET_FILE_NAME) };
}

/**
 * Persist the generated secret (see {@link defaultPersistLocation} for where).
 * Falls back to null when the filesystem is unavailable or unwritable, which
 * lets the caller use an in-memory secret.
 */
async function loadOrPersistUserCacheSecret(
  generate: () => string,
  persistPath?: string
): Promise<string | null> {
  if (!isNodeLikeRuntime()) {
    return null;
  }

  try {
    const [fs, path] = await Promise.all([
      import("node:fs"),
      import("node:path"),
    ]);

    const location = await defaultPersistLocation(path, persistPath);
    if (!location) {
      return null;
    }
    const { dir, file } = location;

    const existing = readSecretFile(fs, file);
    if (existing !== undefined) {
      return existing;
    }

    const secret = generate();
    if (secret === "") {
      return "";
    }

    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, secret, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return secret;
    } catch (err) {
      // Another process may have created the file between our read and write.
      // Adopt its complete value rather than overwriting it.
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        const persisted = readSecretFile(fs, file);
        return persisted === undefined ? null : persisted;
      }
      return null;
    }
  } catch {
    return null;
  }
}

let defaultUserCacheSecretPromise: Promise<string> | undefined;
const customPathSecretPromises = new Map<string, Promise<string>>();

function generateThenPersist(persistPath?: string): Promise<string> {
  return loadOrPersistUserCacheSecret(newUserCacheSecret, persistPath).then(
    (secret) => {
      if (secret === null || secret === "") {
        return getEphemeralUserCacheSecret();
      }
      return secret;
    }
  );
}

/**
 * Resolve the client-level secret. The first non-empty value wins:
 *
 *  1. an explicit `userCacheSecret` option,
 *  2. the `TINFOIL_USER_CACHE_SECRET` environment variable,
 *  3. a generated secret persisted at `options.persistPath` (or
 *     `~/.tinfoil/user_cache_secret` when unset), falling back to a
 *     process-lifetime in-memory secret.
 *
 * Persisted results are memoized per path, so callers share one lookup (and
 * one file) per location. Never throws.
 */
export function resolveUserCacheSecret(
  options?: ResolveUserCacheSecretOptions
): Promise<string> {
  const explicit = options?.explicit;
  if (explicit !== undefined && explicit !== "") {
    return Promise.resolve(explicit);
  }

  const env = readEnv(USER_CACHE_SECRET_ENV);
  if (env) {
    return Promise.resolve(env);
  }

  const persistPath = options?.persistPath;
  if (persistPath !== undefined && persistPath !== "") {
    let pending = customPathSecretPromises.get(persistPath);
    if (!pending) {
      pending = generateThenPersist(persistPath);
      customPathSecretPromises.set(persistPath, pending);
    }
    return pending;
  }

  if (!defaultUserCacheSecretPromise) {
    defaultUserCacheSecretPromise = generateThenPersist();
  }

  return defaultUserCacheSecretPromise;
}

// ---------------------------------------------------------------------------
// Body injection
// ---------------------------------------------------------------------------

export function isUserCacheSecretEligible(
  method: string,
  pathname: string
): boolean {
  if (method.toUpperCase() !== "POST") {
    return false;
  }
  return USER_CACHE_SECRET_PATHS.some((path) => pathname.endsWith(path));
}

/**
 * Add the field to a JSON-object body. Returns null — forward the original
 * body untouched — for non-object bodies, trailing data, or a body that
 * already carries a non-empty or non-string field. An empty-string existing
 * field is replaced with the resolved secret.
 *
 * The field is spliced into the original text rather than re-serializing the
 * parsed object, because JSON.parse round-trips numbers through float64 and
 * would corrupt int64-range values such as `"seed": 9007199254740993`.
 */
export function injectUserCacheSecret(
  raw: string,
  secret: string
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const object = parsed as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(object, USER_CACHE_SECRET_FIELD)) {
    const existing = object[USER_CACHE_SECRET_FIELD];
    if (existing !== "") {
      return null;
    }
    const range = topLevelValueRange(raw, USER_CACHE_SECRET_FIELD);
    if (range === null) {
      return null;
    }
    return raw.slice(0, range[0]) + JSON.stringify(secret) + raw.slice(range[1]);
  }

  const end = raw.lastIndexOf("}");
  const field = `${JSON.stringify(USER_CACHE_SECRET_FIELD)}:${JSON.stringify(secret)}`;
  const separator = Object.keys(object).length > 0 ? "," : "";
  return raw.slice(0, end) + separator + field + raw.slice(end);
}

function topLevelValueRange(
  raw: string,
  field: string
): [number, number] | null {
  let index = skipWhitespace(raw, 0);
  let matchingRange: [number, number] | null = null;

  if (raw[index] !== "{") {
    return null;
  }
  index += 1;

  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") {
      return null;
    }

    const keyEnd = stringEnd(raw, index);
    if (keyEnd === null) {
      return null;
    }

    let key: unknown;
    try {
      key = JSON.parse(raw.slice(index, keyEnd));
    } catch {
      return null;
    }

    index = skipWhitespace(raw, keyEnd);
    if (raw[index] !== ":") {
      return null;
    }

    const valueStart = skipWhitespace(raw, index + 1);
    const valueEnd = jsonValueEnd(raw, valueStart);
    if (valueEnd === null) {
      return null;
    }

    if (key === field) {
      matchingRange = [valueStart, valueEnd];
    }

    index = skipWhitespace(raw, valueEnd);
    if (raw[index] === ",") {
      index += 1;
    } else if (raw[index] === "}") {
      return matchingRange;
    } else {
      return null;
    }
  }

  return null;
}

function skipWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index])) {
    index += 1;
  }
  return index;
}

function stringEnd(raw: string, start: number): number | null {
  if (raw[start] !== '"') {
    return null;
  }
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    if (escaped) {
      escaped = false;
    } else if (raw[index] === "\\") {
      escaped = true;
    } else if (raw[index] === '"') {
      return index + 1;
    }
  }
  return null;
}

function jsonValueEnd(raw: string, start: number): number | null {
  if (raw[start] === '"') {
    return stringEnd(raw, start);
  }

  if (raw[start] === "{" || raw[start] === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
      } else if (character === '"') {
        inString = true;
      } else if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
    }
    return null;
  }

  let end = start;
  while (end < raw.length && raw[end] !== "," && raw[end] !== "}") {
    end += 1;
  }
  while (end > start && /\s/.test(raw[end - 1])) {
    end -= 1;
  }
  return end > start ? end : null;
}
