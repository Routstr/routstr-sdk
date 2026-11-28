/**
 * EnclavaAttest - confidential-computing attestation for Enclava-hosted providers.
 *
 * An Enclava app exposes an AMD SEV-SNP proof bundle at
 * `/.well-known/confidential/proof-bundle`. Appraised against a trust policy the
 * caller pins independently, that bundle proves the host serving a provider URL
 * runs an image the policy admits. With a TLS-binding policy, it also binds
 * the evidence to the observed peer SPKI supplied by the caller.
 *
 * This module owns the protocol half: challenge nonce, bundle fetch, appraisal
 * caching, and fail-closed verdict handling. The cryptographic appraisal is
 * delegated to an {@link EnclavaAppraiser} so the SDK stays browser-safe and
 * dependency-free. Two appraisers ship here:
 *
 * - {@link createWasmEnclavaAppraiser} drives Enclava's own verifier
 *   (`enclava-verifier-wasm`, published as the `enclava-verifier-web` release
 *   asset of `enclava-labs/cap`). It is imported lazily and never hard-required.
 * - {@link createModuleEnclavaAppraiser} takes an already-loaded verifier module,
 *   for bundlers that refuse runtime imports.
 *
 * Custom appraisers must verify the exact supplied bundle and policy against
 * the supplied context, not independently fetch a new bundle.
 *
 * The policy MUST be pinned by the caller (bundled constant, checked-in file, or
 * a channel the provider cannot influence). A policy fetched from the provider
 * makes the whole check circular. See `enclava-labs/cap`
 * `docs/verification/contracts-v1.md` for the policy and bundle contracts.
 */

/** Where an Enclava app serves its proof bundle. */
export const ENCLAVA_PROOF_BUNDLE_PATH =
  "/.well-known/confidential/proof-bundle";

/** Media type the proof-bundle endpoint serves and expects. */
export const ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE =
  "application/vnd.enclava.proof-bundle.v1";

/** Hard cap from the bundle contract (1 MiB). */
export const MAX_ENCLAVA_PROOF_BUNDLE_BYTES = 1_048_576;

/** Challenge nonces are exactly 32 bytes, base64url without padding. */
export const ENCLAVA_NONCE_BYTES = 32;

/** How long a successful appraisal is reused before re-attesting. */
export const DEFAULT_ENCLAVA_ATTESTATION_TTL_MS = 5 * 60_000;

/** Default network budget for the bundle fetch. */
export const DEFAULT_ENCLAVA_FETCH_TIMEOUT_MS = 15_000;

/** Brief retry backoff for a rejected or unavailable attestation. */
const DEFAULT_FAILURE_TTL_MS = 5_000;
const MAX_CACHE_ENTRIES = 64;

const NATIVE_VERIFIER_MODULE = "enclava-verifier-wasm";
const ENCLAVA_VERIFIER_MODULE_ENV = "ROUTSTR_ENCLAVA_VERIFIER_MODULE";

/** Policy bytes, or the same JSON as a string. */
export type EnclavaPolicy = Uint8Array | string;

export type EnclavaCheckOutcome =
  | "PASS"
  | "FAIL"
  | "SKIPPED"
  | "INCONCLUSIVE";

export interface EnclavaAppraisalCheck {
  id: string;
  outcome: EnclavaCheckOutcome | string;
  reason_code?: string;
  observed?: unknown;
  expected?: unknown;
}

/**
 * Canonical appraisal result (`contracts-v1.md`): only `PASS` is acceptable.
 * Unknown fields are preserved so newer verifiers keep working.
 */
export interface EnclavaAppraisal {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  bundle_sha256?: string;
  policy_sha256?: string;
  target_origin?: string;
  challenge_nonce?: string;
  verified_at?: number | string;
  checks?: EnclavaAppraisalCheck[];
  warnings?: string[];
  [key: string]: unknown;
}

/**
 * Context the verifier needs beyond the bundle and policy. This is the exact
 * shape `enclava-verifier-wasm`'s `verify_bundle` accepts (`ContextInput`):
 * hashes are lowercase hex, and the nonce is hex of the same 32 bytes carried in
 * the request URL as base64url.
 */
export interface EnclavaAppraiseContext {
  /** Hex of the 32-byte challenge the bundle answered. */
  challenge_nonce: string;
  expected_target_origin: string;
  now_unix_seconds: number;
  /**
   * Hex SHA-256 of the SPKI of the TLS channel the caller actually observed, or
   * `null` when the runtime cannot see the socket (browsers). Required by
   * policies with `transport.require_tls_channel_spki: true`.
   */
  observed_channel_spki_sha256: string | null;
}

export interface EnclavaAppraiseInput {
  /** Raw CE-v1 proof-bundle bytes, exactly as served. */
  bundle: Uint8Array;
  /** Raw pinned policy bytes. */
  policy: Uint8Array;
  /** The same policy as UTF-8 JSON text. */
  policyJson: string;
  context: EnclavaAppraiseContext;
}

/**
 * Something that turns a bundle + policy into an appraisal. Async to allow the
 * wasm call, a CLI subprocess, or a remote appraiser service.
 */
export type EnclavaAppraiser = (
  input: EnclavaAppraiseInput
) => Promise<EnclavaAppraisal> | EnclavaAppraisal;

export type EnclavaAttestationErrorCode =
  | "ENCLAVA_ORIGIN_INVALID"
  | "ENCLAVA_NONCE_INVALID"
  | "ENCLAVA_SPKI_INVALID"
  | "ENCLAVA_BUNDLE_UNAVAILABLE"
  | "ENCLAVA_BUNDLE_MALFORMED"
  | "ENCLAVA_BUNDLE_TOO_LARGE"
  | "ENCLAVA_POLICY_INVALID"
  | "ENCLAVA_VERIFIER_UNAVAILABLE"
  | "ENCLAVA_APPRAISER_FAILED"
  | "ENCLAVA_ATTESTATION_REJECTED"
  | "ENCLAVA_ATTESTATION_INCONCLUSIVE"
  | "ENCLAVA_TLS_CHANNEL_UNVERIFIED";

export interface EnclavaAttestationErrorDetails {
  origin?: string;
  reasonCodes?: string[];
  checks?: EnclavaAppraisalCheck[];
  bundleSha256?: string;
  policySha256?: string;
  cause?: unknown;
}

/**
 * Raised whenever an enclave cannot be shown to satisfy the pinned policy.
 * Never thrown for a passing appraisal.
 */
export class EnclavaAttestationError extends Error {
  readonly code: EnclavaAttestationErrorCode;
  readonly origin?: string;
  readonly reasonCodes: string[];
  readonly checks?: EnclavaAppraisalCheck[];
  readonly bundleSha256?: string;
  readonly policySha256?: string;
  readonly cause?: unknown;

  constructor(
    code: EnclavaAttestationErrorCode,
    message: string,
    details: EnclavaAttestationErrorDetails = {}
  ) {
    super(message);
    this.name = "EnclavaAttestationError";
    this.code = code;
    this.origin = details.origin;
    this.reasonCodes = details.reasonCodes ?? [];
    this.checks = details.checks;
    this.bundleSha256 = details.bundleSha256;
    this.policySha256 = details.policySha256;
    this.cause = details.cause;
  }
}

export interface EnclavaFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EnclavaAttestOptions extends EnclavaFetchOptions {
  /** `https://host[:port]` of the provider, or... */
  origin?: string;
  /** ...a base URL; only its origin is used. */
  baseUrl?: string;
  policy: EnclavaPolicy;
  appraiser?: EnclavaAppraiser;
  /** SPKI of the connection being verified. A separate TLS probe does not bind later requests. */
  channelSpkiSha256?: string | null;
  /** Override the challenge nonce (tests, or a caller-managed challenge). */
  nonce?: string;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Reuse window for a passing appraisal. `0` disables reuse. */
  ttlMs?: number;
  /** Backoff for rejected, inconclusive or unavailable results (default 5 s). `0` disables it. */
  failureTtlMs?: number;
  /** Ignore the cached result and fetch again (may join an equivalent fetch in progress). */
  forceRefresh?: boolean;
}

export interface EnclavaAttestation {
  provider: "enclava";
  origin: string;
  verdict: "PASS";
  /** Full JSON-compatible appraisal result, including per-check outcomes. */
  appraisal: EnclavaAppraisal;
  /** SHA-256 of the exact bundle bytes that passed. */
  bundleSha256: string;
  /** SHA-256 of the policy those bytes were appraised against. */
  policySha256: string;
  bundle: Uint8Array;
  /** Challenge this bundle answered, base64url (the URL form). */
  nonce: string;
  /** The same challenge as hex (the verifier context form). */
  challengeNonce: string;
  /** SPKI used for appraisal, not a guarantee about subsequent sockets. */
  channelSpkiSha256: string | null;
  fetchedAt: number;
  expiresAt: number;
}

type CacheEntry = {
  storedAt: number;
  expiresAt: number;
} & ({ attestation: EnclavaAttestation } | { error: EnclavaAttestationError });

const attestationCache = new Map<string, CacheEntry>();
const inflightAttestations = new Map<string, Promise<EnclavaAttestation>>();
const functionIds = new WeakMap<object, number>();
let nextFunctionId = 0;
let cacheGeneration = 0;

function attestationKey(
  origin: string,
  policySha256: string,
  spki: string | null,
  appraiser: EnclavaAppraiser,
  clock: () => number,
  fetcher: typeof fetch | undefined
): string {
  // The fetcher is part of the identity: a caller that pins its own transport
  // must not be satisfied by bytes another transport fetched.
  return JSON.stringify([
    origin, policySha256, spki, functionId(appraiser), functionId(clock),
    fetcher ? functionId(fetcher) : null,
  ]);
}

function functionId(fn: object): number {
  let id = functionIds.get(fn);
  if (id === undefined) {
    id = ++nextFunctionId;
    functionIds.set(fn, id);
  }
  return id;
}

function storeAttestation(key: string, entry: CacheEntry): void {
  attestationCache.delete(key);
  attestationCache.set(key, entry);
  if (attestationCache.size > MAX_CACHE_ENTRIES) {
    const oldest = attestationCache.keys().next().value;
    if (oldest !== undefined) attestationCache.delete(oldest);
  }
}

/**
 * Heuristic discovery only. Do not use provider metadata to decide if a
 * pinned provider is required to pass attestation.
 */
export function isEnclavaProvider(
  info: unknown,
  baseUrl?: string
): boolean {
  if (info && typeof info === "object") {
    const record = info as Record<string, unknown>;
    const attestation = record.attestation as
      | Record<string, unknown>
      | undefined;
    if (attestation) {
      if (attestation.type === "enclava-proof-bundle") return true;
      if (attestation.provider === "enclava") return true;
    }
    const confidential = record.confidential as
      | Record<string, unknown>
      | string
      | undefined;
    if (
      confidential === "enclava" ||
      (confidential &&
        typeof confidential === "object" &&
        (confidential.provider === "enclava" ||
          confidential.type === "enclava-proof-bundle"))
    ) {
      return true;
    }
    const tee = record.tee as Record<string, unknown> | undefined;
    if (tee?.provider === "enclava") return true;
    for (const key of ["http_url", "url", "baseUrl", "base_url"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && isEnclavaHostname(candidate)) {
        return true;
      }
    }
  }
  return typeof baseUrl === "string" && isEnclavaHostname(baseUrl);
}

function isEnclavaHostname(url: string): boolean {
  try {
    const host = new URL(normalizeUrlInput(url)).hostname.toLowerCase().replace(/\.$/, "");
    return ["enclava.run", "enclava.work", "enclava.dev"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function normalizeUrlInput(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Canonical `https://host[:port]` origin for an Enclava provider. Enclava
 * verifies HTTPS origins only, so anything else is rejected up front rather
 * than being silently upgraded.
 */
export function enclavaOrigin(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(normalizeUrlInput(input));
  } catch (error) {
    throw new EnclavaAttestationError(
      "ENCLAVA_ORIGIN_INVALID",
      `Cannot attest ${input}: not a valid URL`,
      { cause: error }
    );
  }
  if (parsed.protocol !== "https:") {
    throw new EnclavaAttestationError(
      "ENCLAVA_ORIGIN_INVALID",
      `Cannot attest ${input}: Enclava verifies HTTPS origins only (got ${parsed.protocol})`,
      { origin: parsed.origin }
    );
  }
  return `https://${parsed.host}`;
}

/** Fresh 32-byte challenge nonce, base64url without padding (the URL form). */
export function generateEnclavaNonce(byteLength = ENCLAVA_NONCE_BYTES): string {
  return base64UrlEncode(randomBytes(byteLength));
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.getRandomValues) {
    throw new EnclavaAttestationError(
      "ENCLAVA_NONCE_INVALID",
      "No CSPRNG available: globalThis.crypto.getRandomValues is missing"
    );
  }
  cryptoImpl.getRandomValues(bytes);
  return bytes;
}

/**
 * A caller-supplied challenge, accepted as base64url or hex, normalised to the
 * 32 bytes both forms encode.
 */
function nonceToBytes(nonce: string): Uint8Array {
  const trimmed = nonce.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? hexToBytes(trimmed)
    : base64UrlToBytes(trimmed);
  if (!bytes || bytes.byteLength !== ENCLAVA_NONCE_BYTES) {
    throw new EnclavaAttestationError(
      "ENCLAVA_NONCE_INVALID",
      `Challenge nonce must encode exactly ${ENCLAVA_NONCE_BYTES} bytes ` +
        `(base64url or hex); got "${nonce}"`
    );
  }
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(
    normalised.length + ((4 - (normalised.length % 4)) % 4),
    "="
  );
  try {
    const binary =
      typeof globalThis.atob === "function"
        ? globalThis.atob(padded)
        : bufferToBinary(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof globalThis.btoa === "function"
      ? globalThis.btoa(binary)
      : bufferToBase64(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bufferToBase64(binary: string): string {
  return bufferImpl().from(binary, "binary").toString("base64");
}

function bufferToBinary(base64: string): string {
  return bufferImpl().from(base64, "base64").toString("binary");
}

function bufferImpl(): {
  from(input: string, encoding: string): { toString(encoding: string): string };
} {
  const maybeBuffer = (
    globalThis as typeof globalThis & {
      Buffer?: {
        from(input: string, encoding: string): { toString(encoding: string): string };
      };
    }
  ).Buffer;
  if (!maybeBuffer) {
    throw new EnclavaAttestationError(
      "ENCLAVA_NONCE_INVALID",
      "No base64 codec available in this runtime"
    );
  }
  return maybeBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return undefined;
    bytes[i] = byte;
  }
  return bytes;
}

/** Validate a 32-byte hex hash supplied by the caller. */
function assertHex32(value: string, what: string, code: EnclavaAttestationErrorCode): string {
  const normalised = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalised)) {
    throw new EnclavaAttestationError(
      code,
      `${what} must be 32 bytes of lowercase hex; got "${value}"`
    );
  }
  return normalised;
}

/** Lowercase hex SHA-256, browser- and Node-safe. */
export async function enclavaSha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new EnclavaAttestationError(
      "ENCLAVA_APPRAISER_FAILED",
      "No SHA-256 available: globalThis.crypto.subtle is missing"
    );
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", copy)));
}

/**
 * Fetch the proof bundle for an origin with a fresh challenge nonce. Returned
 * bytes are exactly what the enclave served; the caller hashes them.
 */
export async function fetchEnclavaProofBundle(
  origin: string,
  options: EnclavaFetchOptions & { nonce?: string } = {}
): Promise<{
  origin: string;
  nonce: string;
  challengeNonce: string;
  bundle: Uint8Array;
}> {
  const target = enclavaOrigin(origin);
  const nonceBytes = options.nonce !== undefined
    ? nonceToBytes(options.nonce)
    : randomBytes(ENCLAVA_NONCE_BYTES);
  const nonce = base64UrlEncode(nonceBytes);
  const url = `${target}${ENCLAVA_PROOF_BUNDLE_PATH}?nonce=${encodeURIComponent(nonce)}`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_UNAVAILABLE",
      "No fetch implementation available to retrieve the Enclava proof bundle",
      { origin: target }
    );
  }

  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENCLAVA_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelDeadline: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancelDeadline = () => {
      reject(options.signal?.reason);
      controller.abort();
    };
    options.signal?.addEventListener("abort", cancelDeadline, { once: true });
    timer = setTimeout(() => {
      reject(new EnclavaAttestationError(
        "ENCLAVA_BUNDLE_UNAVAILABLE",
        `Proof bundle request to ${target} timed out after ${timeoutMs} ms`,
        { origin: target }
      ));
      controller.abort();
    }, timeoutMs);
  });

  let bytes: Uint8Array;
  try {
    const download = async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw controller.signal.reason;
      }
      return readProofBody(response, target, controller.signal);
    };
    bytes = await Promise.race([deadline, download()]);
  } catch (error) {
    controller.abort();
    if (error instanceof EnclavaAttestationError) throw error;
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_UNAVAILABLE",
      `Proof bundle request to ${target} failed: ${describeError(error)}`,
      { origin: target, cause: error }
    );
  } finally {
    clearTimeout(timer);
    if (cancelDeadline) options.signal?.removeEventListener("abort", cancelDeadline);
  }

  return {
    origin: target,
    nonce,
    challengeNonce: bytesToHex(nonceBytes),
    bundle: bytes,
  };
}

async function readProofBody(
  response: Response,
  origin: string,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (!response.ok) {
      throw new EnclavaAttestationError(
        "ENCLAVA_BUNDLE_UNAVAILABLE",
        `Proof bundle request to ${origin} returned HTTP ${response.status}`,
        { origin }
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() !== ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE) {
      throw new EnclavaAttestationError(
        "ENCLAVA_BUNDLE_MALFORMED",
        `Unexpected proof bundle content type: ${contentType || "(none)"}`,
        { origin }
      );
    }
    const tooLarge = () => new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_TOO_LARGE",
      `Proof bundle exceeds ${MAX_ENCLAVA_PROOF_BUNDLE_BYTES} bytes`,
      { origin }
    );
    if (Number(response.headers.get("content-length")) > MAX_ENCLAVA_PROOF_BUNDLE_BYTES) {
      throw tooLarge();
    }
    // Use a bounded buffer instead of retaining an arbitrary number of chunks.
    let bytes = new Uint8Array(0);
    let length = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) break;
        const nextLength = length + value.byteLength;
        if (nextLength > MAX_ENCLAVA_PROOF_BUNDLE_BYTES) throw tooLarge();
        if (nextLength > bytes.byteLength) {
          const grown = new Uint8Array(Math.min(MAX_ENCLAVA_PROOF_BUNDLE_BYTES,
            Math.max(bytes.byteLength * 2, nextLength, 4096)));
          grown.set(bytes);
          bytes = grown;
        }
        bytes.set(value, length);
        length = nextLength;
      }
    }
    if (length === 0) {
      throw new EnclavaAttestationError("ENCLAVA_BUNDLE_MALFORMED", "Proof bundle response was empty", { origin });
    }
    return bytes.slice(0, length);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}

/**
 * Attest an Enclava provider against a pinned policy.
 *
 * Resolves only on `PASS`. Reuse is scoped to the origin, pinned policy,
 * observed channel SPKI, appraiser and fetch implementation. Caller-managed
 * nonces are never reused.
 */
export async function attestEnclavaProvider(
  options: EnclavaAttestOptions
): Promise<EnclavaAttestation> {
  const generation = cacheGeneration;
  options = { ...options };
  const origin = enclavaOrigin(options.origin ?? options.baseUrl ?? missingOrigin());
  const policyBytes = toBytes(options.policy);
  const policyJson = toJsonText(policyBytes);
  const observedSpki = validateChannelSpki(origin, policyJson, options.channelSpkiSha256);
  const policySha256 = await enclavaSha256Hex(policyBytes);
  const appraiser = options.appraiser ?? defaultAppraiser();
  const clock = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_ENCLAVA_ATTESTATION_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? (ttlMs > 0 ? DEFAULT_FAILURE_TTL_MS : 0);
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const input = { origin, policyBytes, policyJson, policySha256, observedSpki, options, appraiser, ttlMs };
  if (generation !== cacheGeneration || options.nonce !== undefined || options.signal || (ttlMs <= 0 && failureTtlMs <= 0)) {
    return runAttestation(input);
  }

  const key = attestationKey(origin, policySha256, observedSpki, appraiser, clock, fetcher);
  const nowMs = clock();
  const cached = attestationCache.get(key);
  if (cached) {
    if (options.forceRefresh || cached.expiresAt <= nowMs) {
      attestationCache.delete(key);
    } else if (!("error" in cached) && cached.storedAt + ttlMs > nowMs && ttlMs > 0) {
      return structuredClone({ ...cached.attestation,
        expiresAt: Math.min(cached.expiresAt, cached.storedAt + ttlMs),
      });
    } else if ("error" in cached && cached.storedAt + failureTtlMs > nowMs && failureTtlMs > 0) {
      throw copyAttestationError(cached.error);
    }
  }

  const inflightKey = JSON.stringify([
    key, ttlMs, failureTtlMs, options.timeoutMs ?? DEFAULT_ENCLAVA_FETCH_TIMEOUT_MS,
  ]);
  let pending = inflightAttestations.get(inflightKey);
  if (!pending) {
    pending = runAttestation(input).then((attestation) => {
      if (ttlMs > 0 && generation === cacheGeneration) {
        storeAttestation(key, { attestation, storedAt: attestation.fetchedAt, expiresAt: attestation.expiresAt });
      }
      return attestation;
    }, (error: unknown) => {
      if (generation === cacheGeneration && failureTtlMs > 0 &&
          error instanceof EnclavaAttestationError &&
          ["ENCLAVA_ATTESTATION_REJECTED", "ENCLAVA_ATTESTATION_INCONCLUSIVE", "ENCLAVA_BUNDLE_UNAVAILABLE"].includes(error.code)) {
        const storedAt = clock();
        storeAttestation(key, { error: copyAttestationError(error), storedAt, expiresAt: storedAt + failureTtlMs });
      }
      throw error;
    }).finally(() => {
      if (inflightAttestations.get(inflightKey) === pending) inflightAttestations.delete(inflightKey);
    });
    inflightAttestations.set(inflightKey, pending);
  }
  return structuredClone(await pending);
}

function copyAttestationError(error: EnclavaAttestationError): EnclavaAttestationError {
  return new EnclavaAttestationError(error.code, error.message, {
    ...error,
    reasonCodes: [...error.reasonCodes],
    checks: error.checks && structuredClone(error.checks),
  });
}

function validateChannelSpki(origin: string, policyJson: string, value?: string | null): string | null {
  if (value != null) return assertHex32(value, "channelSpkiSha256", "ENCLAVA_SPKI_INVALID");
  if (policyRequiresTlsChannel(policyJson)) {
    throw new EnclavaAttestationError(
      "ENCLAVA_TLS_CHANNEL_UNVERIFIED",
      `Policy for ${origin} requires transport.require_tls_channel_spki, but no observed channel SPKI was supplied.`,
      { origin }
    );
  }
  return null;
}

async function runAttestation(input: {
  origin: string;
  policyBytes: Uint8Array;
  policyJson: string;
  policySha256: string;
  observedSpki: string | null;
  options: EnclavaAttestOptions;
  appraiser: EnclavaAppraiser;
  ttlMs: number;
}): Promise<EnclavaAttestation> {
  const { origin, policyBytes, policyJson, policySha256, observedSpki, options, appraiser, ttlMs } = input;

  const { bundle, nonce, challengeNonce } = await fetchEnclavaProofBundle(origin, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    nonce: options.nonce,
  });
  const bundleSha256 = await enclavaSha256Hex(bundle);
  options.signal?.throwIfAborted();
  const fetchedAt = (options.now ?? Date.now)();
  const context: EnclavaAppraiseContext = {
    challenge_nonce: challengeNonce,
    expected_target_origin: origin,
    now_unix_seconds: Math.floor(fetchedAt / 1000),
    observed_channel_spki_sha256: observedSpki,
  };

  let appraisal: EnclavaAppraisal;
  try {
    appraisal = await appraiser({
      bundle: bundle.slice(),
      policy: policyBytes.slice(),
      policyJson,
      context,
    });
  } catch (error) {
    if (error instanceof EnclavaAttestationError) throw error;
    throw new EnclavaAttestationError(
      "ENCLAVA_APPRAISER_FAILED",
      `Appraiser failed for ${origin}: ${describeError(error)}`,
      {
        origin,
        bundleSha256,
        policySha256,
        cause: error,
      }
    );
  }

  options.signal?.throwIfAborted();
  const checks = Array.isArray(appraisal?.checks)
    ? appraisal.checks.filter((check) => check && typeof check.id === "string")
    : undefined;
  const reasonCodes = (checks ?? [])
    .filter((check) => check.outcome !== "PASS")
    .map((check) => check.reason_code ?? `${check.id}:${check.outcome}`);

  if (typeof appraisal?.verdict !== "string") {
    throw new EnclavaAttestationError(
      "ENCLAVA_APPRAISER_FAILED",
      `Appraiser for ${origin} returned no verdict`,
      { origin, bundleSha256, policySha256 }
    );
  }

  if (
    appraisal.bundle_sha256 !== undefined &&
    (typeof appraisal.bundle_sha256 !== "string" || appraisal.bundle_sha256.toLowerCase() !== bundleSha256)
  ) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_MALFORMED",
      `Appraiser hashed a different bundle (${appraisal.bundle_sha256}) than the ` +
        `one fetched (${bundleSha256}) for ${origin}`,
      { origin, bundleSha256, policySha256, checks, reasonCodes }
    );
  }
  if (
    appraisal.policy_sha256 !== undefined &&
    (typeof appraisal.policy_sha256 !== "string" || appraisal.policy_sha256.toLowerCase() !== policySha256)
  ) {
    throw new EnclavaAttestationError(
      "ENCLAVA_POLICY_INVALID",
      `Appraiser used a different policy (${appraisal.policy_sha256}) than the ` +
        `pinned one (${policySha256}) for ${origin}`,
      { origin, bundleSha256, policySha256, checks, reasonCodes }
    );
  }

  if (appraisal.verdict !== "PASS") {
    const inconclusive = appraisal.verdict === "INCONCLUSIVE";
    throw new EnclavaAttestationError(
      inconclusive
        ? "ENCLAVA_ATTESTATION_INCONCLUSIVE"
        : "ENCLAVA_ATTESTATION_REJECTED",
      `Enclava attestation for ${origin} was ${appraisal.verdict}` +
        (reasonCodes.length ? `: ${reasonCodes.join(", ")}` : ""),
      { origin, bundleSha256, policySha256, checks, reasonCodes }
    );
  }

  if ((appraisal.challenge_nonce !== undefined && appraisal.challenge_nonce !== challengeNonce) ||
      (appraisal.target_origin !== undefined && appraisal.target_origin !== origin)) {
    throw new EnclavaAttestationError(
      "ENCLAVA_APPRAISER_FAILED",
      `Appraiser returned a PASS for a different challenge or origin than requested`,
      { origin, bundleSha256, policySha256, checks, reasonCodes }
    );
  }

  return {
    provider: "enclava",
    origin,
    verdict: "PASS",
    appraisal: structuredClone(appraisal),
    bundleSha256,
    policySha256,
    bundle,
    nonce,
    challengeNonce,
    channelSpkiSha256: observedSpki,
    fetchedAt,
    expiresAt: fetchedAt + ttlMs,
  };
}

function policyRequiresTlsChannel(policyJson: string): boolean {
  try {
    const parsed = JSON.parse(policyJson) as {
      transport?: { require_tls_channel_spki?: unknown };
    };
    return parsed?.transport?.require_tls_channel_spki === true;
  } catch {
    // A malformed policy is the verifier's problem to reject, not ours.
    return false;
  }
}

/** Match Enclava hosting domain suffixes for discovery. */
export function isEnclavaOrigin(url: string): boolean {
  return isEnclavaHostname(url);
}

/**
 * Look up a passing appraisal for audit, never as a substitute for attesting a
 * request. Pass the same `fetchImpl` the appraisal was made with; entries are
 * scoped to it, and the lookup defaults to `globalThis.fetch`.
 */
export async function getCachedEnclavaAttestation(
  originOrBaseUrl: string,
  policy: EnclavaPolicy,
  options: Pick<EnclavaAttestOptions, "channelSpkiSha256" | "appraiser" | "now" | "fetchImpl"> = {}
): Promise<EnclavaAttestation | undefined> {
  let key: string;
  const clock = options.now ?? Date.now;
  try {
    const origin = enclavaOrigin(originOrBaseUrl);
    const bytes = toBytes(policy);
    const spki = validateChannelSpki(origin, toJsonText(bytes), options.channelSpkiSha256);
    key = attestationKey(
      origin, await enclavaSha256Hex(bytes), spki, options.appraiser ?? defaultAppraiser(), clock,
      options.fetchImpl ?? globalThis.fetch
    );
  } catch {
    return undefined;
  }
  const entry = attestationCache.get(key);
  if (!entry || !("attestation" in entry) || entry.expiresAt <= clock()) return undefined;
  return structuredClone(entry.attestation);
}

/** Drop all cache entries and prevent pending appraisals from repopulating them. */
export function clearEnclavaAttestationCache(): void {
  cacheGeneration++;
  attestationCache.clear();
  inflightAttestations.clear();
}

/**
 * SHA-256 of the SPKI of a peer certificate, for
 * `observed_channel_spki_sha256`. Obtain the certificate from the connection
 * you intend to authorize, not an independent probe.

 */
export async function spkiSha256FromPeerCertificate(cert: {
  publicKey: { export(options: { type: "spki"; format: "der" }): unknown };
}): Promise<string> {
  const exported = cert.publicKey.export({ type: "spki", format: "der" });
  const bytes =
    exported instanceof Uint8Array
      ? exported
      : ArrayBuffer.isView(exported)
        ? new Uint8Array(
            exported.buffer,
            exported.byteOffset,
            exported.byteLength
          )
        : new Uint8Array(exported as ArrayBuffer);
  return enclavaSha256Hex(bytes);
}

/** Verifier module surface that `enclava-verifier-web` publishes. */
export interface EnclavaWasmVerifier {
  verify_bundle(
    bundle: Uint8Array,
    policy: Uint8Array,
    contextJson: string
  ): string | EnclavaAppraisal;
  default?: (input?: unknown) => Promise<unknown> | unknown;
  init?: () => Promise<unknown> | unknown;
}

/**
 * Appraise using an already-loaded `enclava-verifier-wasm` module. Use this in
 * bundlers that reject runtime imports, or in React Native.
 */
export function createModuleEnclavaAppraiser(
  verifier: EnclavaWasmVerifier
): EnclavaAppraiser {
  let initialised: Promise<unknown> | undefined;
  return async ({ bundle, policy, context }) => {
    initialised ??= Promise.resolve().then(() =>
      typeof verifier.default === "function"
        ? verifier.default()
        : typeof verifier.init === "function"
          ? verifier.init()
          : undefined
    ).catch((error) => {
      initialised = undefined;
      throw error;
    });
    await initialised;
    const raw = verifier.verify_bundle(
      bundle,
      policy,
      JSON.stringify(context)
    );
    return typeof raw === "string" ? (JSON.parse(raw) as EnclavaAppraisal) : raw;
  };
}

/**
 * Appraise with Enclava's wasm verifier, imported lazily so the SDK stays
 * dependency-free. The module is resolved at call time from `specifier` (or
 * `ROUTSTR_ENCLAVA_VERIFIER_MODULE`), never at import time, so bundlers that do
 * not have it installed are unaffected.
 *
 * The verifier is not on npm: take `enclava-verifier-web.tar.gz` from the
 * `enclava-labs/cap` release you trust, verify it, and expose its `pkg/` on the
 * module resolution path (or alias it).
 */
export function createWasmEnclavaAppraiser(
  specifier?: string
): EnclavaAppraiser {
  const resolvedSpecifier =
    specifier ?? readEnv(ENCLAVA_VERIFIER_MODULE_ENV) ?? NATIVE_VERIFIER_MODULE;
  let appraiseWithModule: Promise<EnclavaAppraiser> | undefined;

  const load = async (): Promise<EnclavaAppraiser> => {
    appraiseWithModule ??= (async () => {
      let imported: EnclavaWasmVerifier;
      try {
        // The ignore comments are load-bearing: they keep bundlers from
        // statically resolving an optional dependency.
        imported = (await import(
          /* webpackIgnore: true */ /* @vite-ignore */ resolvedSpecifier
        )) as EnclavaWasmVerifier;
      } catch (error) {
        throw new EnclavaAttestationError(
          "ENCLAVA_VERIFIER_UNAVAILABLE",
          `Cannot load the Enclava verifier module "${resolvedSpecifier}". ` +
            `Pass \`appraiser\` (createModuleEnclavaAppraiser with a loaded ` +
            `verifier, or a custom one), install the module, or set ` +
            `${ENCLAVA_VERIFIER_MODULE_ENV}. Get it from the ` +
            `enclava-verifier-web release asset of enclava-labs/cap.`,
          { cause: error }
        );
      }
      if (typeof imported?.verify_bundle !== "function") {
        throw new EnclavaAttestationError(
          "ENCLAVA_VERIFIER_UNAVAILABLE",
          `Module "${resolvedSpecifier}" does not export verify_bundle(); ` +
            `it does not look like enclava-verifier-wasm`
        );
      }
      return createModuleEnclavaAppraiser(imported);
    })().catch((error) => {
      appraiseWithModule = undefined;
      throw error;
    });
    return appraiseWithModule;
  };

  return async (input) => (await load())(input);
}

let sharedDefaultAppraiser: EnclavaAppraiser | undefined;

function defaultAppraiser(): EnclavaAppraiser {
  sharedDefaultAppraiser ??= createWasmEnclavaAppraiser();
  return sharedDefaultAppraiser;
}

function toBytes(policy: EnclavaPolicy): Uint8Array {
  if (typeof policy === "string") return new TextEncoder().encode(policy);
  if (policy instanceof Uint8Array) return new Uint8Array(policy);
  throw new EnclavaAttestationError(
    "ENCLAVA_POLICY_INVALID",
    "Policy must be a JSON string or Uint8Array"
  );
}

function toJsonText(policy: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(policy);
    JSON.parse(text);
    return text;
  } catch (error) {
    throw new EnclavaAttestationError(
      "ENCLAVA_POLICY_INVALID",
      `Pinned policy is not valid JSON: ${describeError(error)}`,
      { cause: error }
    );
  }
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const value = maybeProcess.process?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
}

function missingOrigin(): string {
  throw new EnclavaAttestationError(
    "ENCLAVA_ORIGIN_INVALID",
    "attestEnclavaProvider requires `origin` or `baseUrl`"
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Optional discovery helper. Metadata is untrusted, and `undefined` means no
 * attestation was attempted. For a provider the caller requires to be attested,
 * call `attestEnclavaProvider` directly using a caller-pinned origin and policy.
 */
export async function attestEnclavaProviderIfNeeded(
  info: unknown,
  baseUrl: string,
  options: Omit<EnclavaAttestOptions, "origin" | "baseUrl">
): Promise<EnclavaAttestation | undefined> {
  if (!isEnclavaProvider(info, baseUrl)) return undefined;
  return attestEnclavaProvider({ ...options, origin: baseUrl });
}
