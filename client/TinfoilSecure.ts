/**
 * TinfoilSecure - EHBP transport encryption + enclave attestation for Tinfoil models.
 *
 * Any model whose id starts with `tinfoil-` is routed through Tinfoil's
 * `SecureClient.fetch`. SecureClient performs attestation (`ready()`), verifies
 * the enclave code fingerprint, and then encrypts request bodies using EHBP so
 * only the attested enclave can decrypt them.
 *
 * Unlike Venice E2EE, there is no per-field message encryption and no custom SSE
 * decrypt transform. The request body is passed to `SecureClient.fetch` as
 * normal JSON and the returned `Response` body is already decrypted.
 */

import type { SecureClient as SecureClientType, VerificationDocument } from "tinfoil";

export interface TinfoilClientContext {
  client: SecureClientType;
  verification: VerificationDocument;
}

export interface TinfoilClientOptions {
  /** Routstr/provider base URL that will receive the EHBP-wrapped request. */
  baseUrl: string;
  /** Optional explicit attestation bundle origin. Defaults to Tinfoil's ATC. */
  attestationBundleURL?: string;
  /** Optional explicit enclave URL for custom Tinfoil deployments. */
  enclaveURL?: string;
  /** Optional source repo for code verification when enclaveURL is explicit. */
  configRepo?: string;
}

const TINFOIL_MODEL_PREFIX = "tinfoil-";

// Cache SecureClient initialization per option set. SecureClient internally
// handles key rotation recovery and re-attestation on KeyConfigMismatchError.
const clientCache = new Map<string, Promise<TinfoilClientContext>>();

/** Check if a model ID should use Tinfoil EHBP transport. */
export function isTinfoilModel(modelId: string): boolean {
  return modelId.startsWith(TINFOIL_MODEL_PREFIX);
}

/**
 * Return the model id sent upstream for a Tinfoil request.
 *
 * Intentionally does NOT strip `tinfoil-`. Routstr/provider model registries can
 * use the prefix as the public model id and decide server-side how to map it.
 */
export function getTinfoilUpstreamModelId(modelId: string): string {
  return modelId;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function cacheKey(options: TinfoilClientOptions): string {
  return JSON.stringify({
    baseUrl: options.baseUrl,
    attestationBundleURL: options.attestationBundleURL,
    enclaveURL: options.enclaveURL,
    configRepo: options.configRepo,
  });
}

function envOrUndefined(name: string): string | undefined {
  // `process` may not exist in browser builds. Keep this safe and dynamic.
  const maybeProcess = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const value = maybeProcess.process?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Build SecureClient options.
 *
 * By default we use Tinfoil's public ATC for attestation and bind the encrypted
 * request transport to the Routstr/provider `baseUrl`. This is the standard
 * proxy-through-EHBP setup: the provider sees only EHBP ciphertext in the body
 * and forwards it to the attested Tinfoil enclave.
 *
 * Advanced/custom deployments can override the attestation/enclave parameters
 * with environment variables:
 *   - ROUTSTR_TINFOIL_ATTESTATION_BUNDLE_URL
 *   - ROUTSTR_TINFOIL_ENCLAVE_URL
 *   - ROUTSTR_TINFOIL_CONFIG_REPO
 */
function resolveOptions(options: TinfoilClientOptions): TinfoilClientOptions {
  return {
    ...options,
    baseUrl: normalizeBaseUrl(options.baseUrl),
    attestationBundleURL:
      options.attestationBundleURL ??
      envOrUndefined("ROUTSTR_TINFOIL_ATTESTATION_BUNDLE_URL"),
    enclaveURL:
      options.enclaveURL ?? envOrUndefined("ROUTSTR_TINFOIL_ENCLAVE_URL"),
    configRepo:
      options.configRepo ?? envOrUndefined("ROUTSTR_TINFOIL_CONFIG_REPO"),
  };
}

/**
 * Attest and return a cached Tinfoil SecureClient for a provider base URL.
 */
export async function prepareTinfoilClient(
  options: TinfoilClientOptions
): Promise<TinfoilClientContext> {
  const resolved = resolveOptions(options);
  const key = cacheKey(resolved);
  let pending = clientCache.get(key);

  if (!pending) {
    pending = (async () => {
      // Dynamic import keeps the SDK importable in contexts that never use
      // Tinfoil models and avoids loading the heavy OpenAI/tinfoil stack early.
      const { SecureClient } = await import("tinfoil");

      const client = new SecureClient({
        // baseURL is the proxy/provider URL that receives the EHBP request.
        baseURL: resolved.baseUrl,
        // Leave undefined by default so tinfoil uses its public ATC. If set,
        // SecureClient will fetch `${attestationBundleURL}/attestation`.
        attestationBundleURL: resolved.attestationBundleURL,
        enclaveURL: resolved.enclaveURL,
        configRepo: resolved.configRepo,
        transport: "ehbp",
      });

      await client.ready();
      const verification = client.getVerificationDocument();

      return { client, verification };
    })();

    clientCache.set(key, pending);
  }

  try {
    return await pending;
  } catch (error) {
    // Do not cache failed attestation attempts forever.
    clientCache.delete(key);
    throw error;
  }
}

/** Clear cached Tinfoil clients, mainly useful for tests or forced re-attest. */
export function clearTinfoilClientCache(): void {
  clientCache.clear();
}
