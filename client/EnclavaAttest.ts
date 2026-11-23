/**
 * EnclavaAttest - confidential-computing attestation for Enclava-hosted providers.
 *
 * An Enclava app exposes an AMD SEV-SNP proof bundle at
 * `/.well-known/confidential/proof-bundle`. Appraised against a trust policy the
 * caller pins independently, that bundle proves the host serving a provider URL
 * runs exactly the image the policy admits, and that the TLS connection the
 * verifier opened belongs to that enclave.
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
 * Node callers that already trust the `enclava` CLI can wrap
 * `enclava verify --policy <file> --json <origin>` in a custom appraiser instead.
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
}

export interface EnclavaAttestOptions extends EnclavaFetchOptions {
  /** `https://host[:port]` of the provider, or... */
  origin?: string;
  /** ...a base URL; only its origin is used. */
  baseUrl?: string;
  policy: EnclavaPolicy;
  appraiser?: EnclavaAppraiser;
  /** SPKI hash of the observed TLS channel, when the runtime can see it. */
  channelSpkiSha256?: string | null;
  /** Override the challenge nonce (tests, or a caller-managed challenge). */
  nonce?: string;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Reuse window for a passing appraisal. `0` disables reuse. */
  ttlMs?: number;
  /** Skip the cache and attest again. */
  forceRefresh?: boolean;
}

export interface EnclavaAttestation {
  provider: "enclava";
  origin: string;
  verdict: "PASS";
  /** Full appraisal result, including per-check outcomes. */
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
  fetchedAt: number;
  expiresAt: number;
}

interface CacheEntry {
  attestation: EnclavaAttestation;
  expiresAt: number;
}

const attestationCache = new Map<string, CacheEntry>();
const inflightAttestations = new Map<string, Promise<EnclavaAttestation>>();

/**
 * True when a provider advertises Enclava confidential computing, by explicit
 * marker or by hosting hostname.
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
      if (typeof attestation.proof_bundle_url === "string") return true;
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
    const tee = record.tee as
      | Record<string, unknown>
      | string
      | undefined;
    if (
      tee === "sev-snp" ||
      (tee &&
        typeof tee === "object" &&
        (tee.type === "sev-snp" || tee.provider === "enclava"))
    ) {
      return true;
    }
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
    const host = new URL(normalizeUrlInput(url)).hostname.toLowerCase();
    return (
      host.endsWith(".enclava.run") ||
      host.endsWith(".enclava.work") ||
      host === "enclava.run" ||
      host.endsWith(".enclava.dev")
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
        : BufferToBinary(padded);
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
      : BufferToBase64(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function BufferToBase64(binary: string): string {
  return bufferImpl().from(binary, "binary").toString("base64");
}

function BufferToBinary(base64: string): string {
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
  const nonceBytes = options.nonce
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_ENCLAVA_FETCH_TIMEOUT_MS;
  const controller =
    typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE },
      // Never let a proxy or service worker answer with a stale challenge.
      cache: "no-store",
      signal: controller?.signal,
    });
  } catch (error) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_UNAVAILABLE",
      `Proof bundle request to ${target} failed: ${describeError(error)}`,
      { origin: target, cause: error }
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!response.ok) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_UNAVAILABLE",
      `Proof bundle request to ${target} returned HTTP ${response.status}`,
      { origin: target }
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE)) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_MALFORMED",
      `Proof bundle has unexpected content type "${contentType || "(none)"}", ` +
        `expected ${ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE}`,
      { origin: target }
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ENCLAVA_PROOF_BUNDLE_BYTES) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_TOO_LARGE",
      `Proof bundle declares ${declaredLength} bytes, limit is ${MAX_ENCLAVA_PROOF_BUNDLE_BYTES}`,
      { origin: target }
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_UNAVAILABLE",
      `Could not read the proof bundle body: ${describeError(error)}`,
      { origin: target, cause: error }
    );
  }

  if (bytes.byteLength === 0) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_MALFORMED",
      "Proof bundle response was empty",
      { origin: target }
    );
  }
  if (bytes.byteLength > MAX_ENCLAVA_PROOF_BUNDLE_BYTES) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_TOO_LARGE",
      `Proof bundle is ${bytes.byteLength} bytes, limit is ${MAX_ENCLAVA_PROOF_BUNDLE_BYTES}`,
      { origin: target }
    );
  }

  return {
    origin: target,
    nonce,
    challengeNonce: bytesToHex(nonceBytes),
    bundle: bytes,
  };
}

/**
 * Attest an Enclava provider against a pinned policy.
 *
 * Resolves only when the appraisal verdict is `PASS`; every other outcome throws
 * {@link EnclavaAttestationError}. Successful appraisals are memoised per
 * `(origin, policy)` for `ttlMs`, with in-flight de-duplication so concurrent
 * requests share one bundle fetch.
 */
export async function attestEnclavaProvider(
  options: EnclavaAttestOptions
): Promise<EnclavaAttestation> {
  const origin = enclavaOrigin(
    options.origin ?? options.baseUrl ?? missingOrigin()
  );
  const policyBytes = toBytes(options.policy);
  const policyJson = toJsonText(policyBytes);
  const policySha256 = await enclavaSha256Hex(policyBytes);
  const cacheKey = `${origin}\u0000${policySha256}`;
  const nowMs = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? DEFAULT_ENCLAVA_ATTESTATION_TTL_MS;

  if (!options.forceRefresh && ttlMs > 0) {
    const cached = attestationCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return cached.attestation;
    if (cached) attestationCache.delete(cacheKey);
  }

  const inflight = inflightAttestations.get(cacheKey);
  if (inflight) return inflight;

  const pending = runAttestation({
    origin,
    policyBytes,
    policyJson,
    policySha256,
    options,
    ttlMs,
  }).finally(() => {
    inflightAttestations.delete(cacheKey);
  });

  inflightAttestations.set(cacheKey, pending);
  return pending;
}

async function runAttestation(input: {
  origin: string;
  policyBytes: Uint8Array;
  policyJson: string;
  policySha256: string;
  options: EnclavaAttestOptions;
  ttlMs: number;
}): Promise<EnclavaAttestation> {
  const { origin, policyBytes, policyJson, policySha256, options, ttlMs } =
    input;

  const { bundle, nonce, challengeNonce } = await fetchEnclavaProofBundle(
    origin,
    {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      nonce: options.nonce,
    }
  );
  const bundleSha256 = await enclavaSha256Hex(bundle);

  const appraiser = options.appraiser ?? defaultAppraiser();
  const observedSpki =
    options.channelSpkiSha256 === undefined || options.channelSpkiSha256 === null
      ? null
      : assertHex32(
          options.channelSpkiSha256,
          "channelSpkiSha256",
          "ENCLAVA_SPKI_INVALID"
        );
  const context: EnclavaAppraiseContext = {
    challenge_nonce: challengeNonce,
    expected_target_origin: origin,
    now_unix_seconds: Math.floor((options.now ?? Date.now)() / 1000),
    observed_channel_spki_sha256: observedSpki,
  };

  let appraisal: EnclavaAppraisal;
  try {
    appraisal = await appraiser({
      bundle,
      policy: policyBytes,
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

  const checks = Array.isArray(appraisal?.checks) ? appraisal.checks : undefined;
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
    typeof appraisal.bundle_sha256 === "string" &&
    appraisal.bundle_sha256.toLowerCase() !== bundleSha256
  ) {
    throw new EnclavaAttestationError(
      "ENCLAVA_BUNDLE_MALFORMED",
      `Appraiser hashed a different bundle (${appraisal.bundle_sha256}) than the ` +
        `one fetched (${bundleSha256}) for ${origin}`,
      { origin, bundleSha256, policySha256, checks, reasonCodes }
    );
  }
  if (
    typeof appraisal.policy_sha256 === "string" &&
    appraisal.policy_sha256.toLowerCase() !== policySha256
  ) {
    throw new EnclavaAttestationError(
      "ENCLAVA_POLICY_INVALID",
      `Appraiser used a different policy (${appraisal.policy_sha256}) than the ` +
        `pinned one (${policySha256}) for ${origin}`,
      { origin, bundleSha256, policySha256, checks, reasonCodes }
    );
  }

  // A policy that requires TLS channel binding cannot be satisfied when the
  // runtime cannot see the socket. Report that specifically: it is a caller
  // configuration problem, not a misbehaving enclave.
  if (
    policyRequiresTlsChannel(policyJson) && observedSpki === null
  ) {
    throw new EnclavaAttestationError(
      "ENCLAVA_TLS_CHANNEL_UNVERIFIED",
      `Policy for ${origin} requires transport.require_tls_channel_spki, but no ` +
        `observed_channel_spki_sha256 was supplied. Pass it from the socket that ` +
        `served the request (Node: spkiSha256FromPeerCertificate), or use a ` +
        `policy without that requirement in browsers.`,
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

  const nowMs = (options.now ?? Date.now)();
  const attestation: EnclavaAttestation = {
    provider: "enclava",
    origin,
    verdict: "PASS",
    appraisal,
    bundleSha256,
    policySha256,
    bundle,
    nonce,
    challengeNonce,
    fetchedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };

  if (ttlMs > 0) attestationCache.set(`${origin}\u0000${policySha256}`, {
    attestation,
    expiresAt: attestation.expiresAt,
  });

  return attestation;
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

/** Prefix scan of the domain suffixes Enclava hands out, for provider filters. */
export function isEnclavaOrigin(url: string): boolean {
  return isEnclavaHostname(url);
}

/**
 * A previously passed attestation for `(origin, policy)`, if it is still inside
 * its reuse window. Amenable to logging and UI: the `bundleSha256` +
 * `policySha256` pair is the audit trail for a served request.
 */
export async function getCachedEnclavaAttestation(
  originOrBaseUrl: string,
  policy?: EnclavaPolicy
): Promise<EnclavaAttestation | undefined> {
  let origin: string;
  try {
    origin = enclavaOrigin(originOrBaseUrl);
  } catch {
    return undefined;
  }
  const expectedPolicySha256 = policy ? await enclavaSha256Hex(toBytes(policy)) : undefined;
  const nowMs = Date.now();
  for (const [key, entry] of attestationCache) {
    if (entry.expiresAt <= nowMs) {
      attestationCache.delete(key);
      continue;
    }
    if (entry.attestation.origin !== origin) continue;
    if (
      expectedPolicySha256 === undefined ||
      entry.attestation.policySha256 === expectedPolicySha256
    ) {
      return entry.attestation;
    }
  }
  return undefined;
}

/** Drop every memoised appraisal (tests, or after a policy change). */
export function clearEnclavaAttestationCache(): void {
  attestationCache.clear();
  inflightAttestations.clear();
}

/**
 * SHA-256 of the SPKI of a peer certificate, for
 * `observed_channel_spki_sha256`. Node recipe:
 *
 * ```ts
 * import tls from "node:tls";
 * import { spkiSha256FromPeerCertificate } from "@routstr/sdk/client";
 *
 * const socket = tls.connect({ host, port: 443, servername: host });
 * await new Promise((resolve) => socket.once("secureConnect", resolve));
 * const spki = await spkiSha256FromPeerCertificate(socket.getPeerX509Certificate()!);
 * ```
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
 * Apprais* using an already-loaded `enclava-verifier-wasm` module. Use this in
 * bundlers that reject runtime imports, or in React Native.
 */
export function createModuleEnclavaAppraiser(
  verifier: EnclavaWasmVerifier
): EnclavaAppraiser {
  let initialised: Promise<unknown> | undefined;
  return async ({ bundle, policy, context }) => {
    initialised ??= Promise.resolve(
      typeof verifier.default === "function"
        ? verifier.default()
        : typeof verifier.init === "function"
          ? verifier.init()
          : undefined
    );
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
    })();
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
  if (policy instanceof Uint8Array) return policy;
  throw new EnclavaAttestationError(
    "ENCLAVA_POLICY_INVALID",
    "Policy must be a JSON string or Uint8Array"
  );
}

function toJsonText(policy: Uint8Array): string {
  const text = new TextDecoder().decode(policy);
  try {
    JSON.parse(text);
  } catch (error) {
    throw new EnclavaAttestationError(
      "ENCLAVA_POLICY_INVALID",
      `Pinned policy is not valid JSON: ${describeError(error)}`,
      { cause: error }
    );
  }
  return text;
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
 * Attest a provider only when it advertises Enclava confidential computing.
 *
 * Returns `undefined` for every other provider, so a caller can place this on
 * the request path without gating non-Enclava providers:
 *
 * ```ts
 * const attestation = await attestEnclavaProviderIfNeeded(
 *   info,
 *   providerBaseUrl,
 *   { policy: PINNED_ENCLAVA_POLICY, channelSpkiSha256: spki }
 * );
 * if (attestation) usage.attestation = {
 *   bundleSha256: attestation.bundleSha256,
 *   policySha256: attestation.policySha256,
 * };
 * ```
 */
export async function attestEnclavaProviderIfNeeded(
  info: unknown,
  baseUrl: string,
  options: Omit<EnclavaAttestOptions, "origin" | "baseUrl">
): Promise<EnclavaAttestation | undefined> {
  if (!isEnclavaProvider(info, baseUrl)) return undefined;
  return attestEnclavaProvider({ ...options, baseUrl });
}
