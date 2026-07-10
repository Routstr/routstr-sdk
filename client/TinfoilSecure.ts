/**
 * TinfoilSecure - EHBP transport encryption + enclave attestation for Tinfoil models.
 *
 * Any model whose id starts with `tinfoil-` is routed through Tinfoil EHBP.
 * SecureClient performs attestation (`ready()`) and verifies the enclave code
 * fingerprint. The SDK then uses EHBP request encryption so only the attested
 * enclave can decrypt request bodies.
 *
 * Unlike Venice E2EE, there is no per-field message encryption and no custom SSE
 * decrypt transform. Successful enclave responses are decrypted before normal
 * SDK response handling sees them. Plaintext proxy-side errors (for example
 * auth/balance failures before the request reaches the enclave) are preserved
 * with their real status/body.
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
 * Return the model id sent inside the EHBP-encrypted request body.
 *
 * Strips the `tinfoil-` prefix so the attested enclave receives the bare
 * model id it expects (e.g. "kimi-k2-6"), not the caller-facing routstr id.
 */
export function getTinfoilUpstreamModelId(modelId: string): string {
  return modelId.slice(TINFOIL_MODEL_PREFIX.length);
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

function normalizeFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit
): { url: string; init?: RequestInit } {
  if (typeof input === "string") {
    return { url: input, init };
  }
  if (input instanceof URL) {
    return { url: input.toString(), init };
  }

  const cloned = input.clone();
  return {
    url: cloned.url,
    init: {
      method: cloned.method,
      headers: new Headers(cloned.headers),
      body: cloned.body ?? undefined,
      signal: cloned.signal,
      ...init,
    },
  };
}

type EhbpModule = typeof import("ehbp");
type NormalizedFetchArgs = ReturnType<typeof normalizeFetchArgs>;

function isProblemJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/problem+json";
}

async function isEhbpKeyConfigMismatchResponse(
  response: Response,
  protocol: EhbpModule["PROTOCOL"]
): Promise<boolean> {
  if (response.status !== 422) {
    return false;
  }

  if (!isProblemJsonContentType(response.headers.get("content-type"))) {
    return false;
  }

  try {
    const problem = await response.clone().json();
    return problem?.type === protocol.KEY_CONFIG_PROBLEM_TYPE;
  } catch {
    return false;
  }
}

async function fetchTinfoilEhbpOnce(
  context: TinfoilClientContext,
  options: TinfoilClientOptions,
  normalized: NormalizedFetchArgs,
  ehbp: EhbpModule
): Promise<Response> {
  const { Identity, PROTOCOL, decryptResponseWithToken, extractSessionRecoveryToken } =
    ehbp;

  const resolved = resolveOptions(options);
  const baseURL = context.client.getBaseURL() ?? resolved.baseUrl;
  const enclaveURL = context.client.getEnclaveURL();
  const baseOrigin = new URL(baseURL).origin;
  const allowedOrigins = new Set([baseOrigin]);

  if (enclaveURL) {
    allowedOrigins.add(new URL(enclaveURL).origin);
  }

  const targetUrl = new URL(normalized.url, baseURL);

  if (!allowedOrigins.has(targetUrl.origin)) {
    throw new Error(
      `refusing to send Tinfoil request to ${targetUrl.origin}: client is bound to the verified enclave/proxy`
    );
  }

  const headers = new Headers(normalized.init?.headers);
  if (enclaveURL && new URL(enclaveURL).origin !== baseOrigin) {
    headers.set("X-Tinfoil-Enclave-Url", enclaveURL);
  }

  const method = normalized.init?.method ?? "GET";
  const body = normalized.init?.body ?? null;
  const serverIdentity = await Identity.fromPublicKeyHex(
    context.verification.hpkePublicKey
  );

  const request = new Request(targetUrl.toString(), {
    method,
    headers,
    body,
    duplex: "half",
    signal: normalized.init?.signal,
  } as RequestInit & { duplex: "half" });

  const { request: encryptedRequest, context: requestContext } =
    await serverIdentity.encryptRequestWithContext(request);

  const response = await fetch(encryptedRequest, {
    signal: normalized.init?.signal,
  });
  if (!requestContext) {
    return response;
  }

  if (await isEhbpKeyConfigMismatchResponse(response, PROTOCOL)) {
    throw new ehbp.KeyConfigMismatchError("EHBP key configuration mismatch");
  }

  if (!response.headers.get(PROTOCOL.RESPONSE_NONCE_HEADER)) {
    return response;
  }

  const token = await extractSessionRecoveryToken(requestContext);
  return await decryptResponseWithToken(response, token);
}

/**
 * Fetch through Tinfoil EHBP while preserving plaintext proxy error responses.
 *
 * Tinfoil's stock SecureClient.fetch throws ProtocolError when a response to an
 * encrypted request lacks Ehbp-Response-Nonce. That is correct for successful
 * enclave responses, but Routstr proxy-side auth/balance errors are plaintext
 * and need to flow through the SDK's normal error handling with their real
 * status/body. This wrapper performs the same request-body encryption and
 * response decryption, but returns non-EHBP responses unchanged.
 *
 * It also keeps SecureClient's key-rotation behavior: an EHBP key-config
 * mismatch response triggers one fresh attestation and one retry.
 */
export async function fetchTinfoilPreservingPlaintextErrors(
  options: TinfoilClientOptions,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const context = await prepareTinfoilClient(options);
  const ehbp = await import("ehbp");
  const normalized = normalizeFetchArgs(input, init);

  try {
    return await fetchTinfoilEhbpOnce(context, options, normalized, ehbp);
  } catch (error) {
    // Channel recovery: server rotated EHBP keys, request was never processed.
    // Mirror tinfoil SecureClient.fetch by re-attesting and retrying once.
    if (error instanceof ehbp.KeyConfigMismatchError) {
      context.client.reset();
      try {
        await context.client.ready();
        context.verification = context.client.getVerificationDocument();
      } catch (reattestError) {
        // Do not keep a failed post-rotation attestation in the shared cache.
        clientCache.delete(cacheKey(resolveOptions(options)));
        throw reattestError;
      }

      return await fetchTinfoilEhbpOnce(context, options, normalized, ehbp);
    }

    throw error;
  }
}

/** Clear cached Tinfoil clients, mainly useful for tests or forced re-attest. */
export function clearTinfoilClientCache(): void {
  clientCache.clear();
}
