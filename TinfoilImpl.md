# Tinfoil EHBP Integration

Tinfoil support is enabled for models whose id starts with `tinfoil-`.

Example:

```txt
tinfoil-llama3-3-70b
```

The SDK **strips** the `tinfoil-` prefix from the model id inside the encrypted
request body. The attested enclave receives the bare model id it expects (e.g.
`llama3-3-70b`). The full caller-facing id (e.g. `tinfoil-llama3-3-70b`) is sent in
the `X-Routstr-Model` header for proxy-side model lookup, cost calculation, and
routing without parsing the encrypted body.

## Files

| File | Role |
|---|---|
| `client/TinfoilSecure.ts` | Tinfoil model detection, `SecureClient` creation/cache, attestation helpers, EHBP fetch wrapper that preserves plaintext proxy errors |
| `client/TinfoilCacheSecret.ts` | `user_cache_secret` resolution (option → env → persisted default) and splice-injection into eligible request bodies before EHBP sealing |
| `client/RoutstrClient.ts` | Detects `tinfoil-*`, attests before token spend, uses the Tinfoil EHBP fetch wrapper for the request |
| `client/index.ts` | Re-exports Tinfoil helpers |

## Request flow

```txt
Client SDK                         Routstr Provider / Proxy              Tinfoil Enclave
   │                                         │                                  │
   │── model starts with tinfoil- ─────────▶│                                  │
   │── SecureClient.ready() ───────────────▶│/ ATC attestation bundle          │
   │←─ verified codeFingerprint ───────────│                                  │
   │                                         │                                  │
   │── spend token as usual ───────────────▶│                                  │
   │                                         │                                  │
   │── POST /v1/chat/completions ──────────▶│── EHBP ciphertext body ─────────▶│
   │   X-Routstr-Model: tinfoil-...         │   X-Tinfoil-Enclave-Url          │
   │   body.model = bare id (stripped)      │   X-Private-Model: private/...   │
   │   body encrypted by EHBP fetch wrapper │                                  │
   │←─ decrypted Response stream ──────────│←─ EHBP encrypted response ───────│
```

## Behavior

- `isTinfoilModel(modelId)` returns true for `modelId.startsWith("tinfoil-")`.
- `getTinfoilUpstreamModelId(modelId)` strips the `tinfoil-` prefix for the
  model id inside the encrypted body (e.g. `tinfoil-kimi-k2-6` → `kimi-k2-6`).
- `RoutstrClient` runs Tinfoil attestation **before** spending the main token.
- The actual API request uses Tinfoil/EHBP request encryption. The SDK wraps
  Tinfoil's lower-level EHBP primitives so plaintext proxy-side error responses
  (for example 402 balance errors before the enclave is reached) are returned
  with their real status/body instead of being hidden behind a missing-nonce
  `ProtocolError`.
- The full caller-facing model id is sent in the `X-Routstr-Model` header so the
  proxy can do model lookup, cost calculation, and routing without parsing the
  encrypted body.
- No custom stream transform is needed; Tinfoil decrypts the response before the
  SDK's normal SSE processing sees it.
- Request debug storage redacts the body for Tinfoil requests because encryption
  happens inside the Tinfoil EHBP fetch path.
- EHBP key-config mismatch responses still trigger one fresh attestation and one
  retry, matching stock `SecureClient.fetch` key-rotation behavior.

## Proxy-side error handling

Stock `SecureClient.fetch` from `tinfoil` uses EHBP's `Transport.request()`
internally. That code requires `Ehbp-Response-Nonce` on the response before
returning anything:

```ts
const responseNonceHeader = response.headers.get(PROTOCOL.RESPONSE_NONCE_HEADER);
if (!responseNonceHeader) {
  throw new ProtocolError(`Missing ${PROTOCOL.RESPONSE_NONCE_HEADER} header`);
}
```

This breaks when the Routstr proxy returns a plaintext error **before** the
request reaches the enclave (e.g. 402 insufficient balance, 401 unauthorized,
403 forbidden, 429 rate limit, 500 server error). These responses are real and
useful, but stock `SecureClient.fetch` throws a `ProtocolError` before the SDK
can inspect them.

The proxy cannot EHBP-encrypt its own error responses because it doesn't have
the HPKE response context / session secret — only the enclave can produce valid
encrypted responses with `Ehbp-Response-Nonce`.

### Design decision

We explicitly do **not** blindly map missing-nonce `ProtocolError` to a
synthetic 402. That would lose the actual status/body and be incorrect for
401, 403, 429, 500, and other proxy-side errors.

Instead, the SDK uses a custom EHBP fetch wrapper
(`fetchTinfoilPreservingPlaintextErrors`) that uses lower-level `ehbp`
primitives directly:

- `Identity.fromPublicKeyHex(...)`
- `encryptRequestWithContext(...)`
- `extractSessionRecoveryToken(...)`
- `decryptResponseWithToken(...)`

If the response has `Ehbp-Response-Nonce`, it decrypts and returns the
decrypted response. If the response does **not** have the nonce header, it
returns the plaintext response unchanged — letting `_makeRequest()` and
`_handleErrorResponse()` process the real status and body.

EHBP key-config mismatch (`422 application/problem+json`) still triggers one
fresh attestation and one retry, matching stock `SecureClient.fetch`
key-rotation behavior.

### End-to-end flows

**Success path:**

```txt
SDK
  X-Routstr-Model: tinfoil-kimi-k2-6
  encrypted body: { model: "kimi-k2-6", user_cache_secret: "<secret>", ... }
    ↓
Routstr proxy
  reads X-Routstr-Model for billing/routing
  adds X-Private-Model: private/kimi-k2-6
  forwards raw EHBP body to upstream /private/
    ↓
Upstream / Tinfoil enclave
  billing layer reads X-Private-Model
  enclave decrypts body and sees model "kimi-k2-6"
  returns EHBP encrypted response + Ehbp-Response-Nonce
    ↓
SDK custom EHBP fetch
  decrypts response
  returns plaintext Response to normal SDK handling
```

**Proxy-side error path:**

```txt
SDK sends encrypted request
    ↓
Routstr proxy rejects before enclave, e.g. 402 insufficient balance
    ↓
Plaintext 402 response has no Ehbp-Response-Nonce
    ↓
Custom SDK EHBP fetch returns plaintext 402 Response unchanged
    ↓
_makeRequest sees !response.ok and calls _handleErrorResponse with real status/body
```

## Configuration

By default, the SDK uses Tinfoil's public ATC and binds EHBP requests to the
selected provider `baseUrl`.

Optional environment overrides:

| Variable | Purpose |
|---|---|
| `ROUTSTR_TINFOIL_ATTESTATION_BUNDLE_URL` | Custom attestation bundle origin. `SecureClient` fetches `${url}/attestation`. |
| `ROUTSTR_TINFOIL_ENCLAVE_URL` | Explicit enclave URL for custom deployments. |
| `ROUTSTR_TINFOIL_CONFIG_REPO` | Repo used by Tinfoil verifier for custom enclave code verification. |
| `TINFOIL_USER_CACHE_SECRET` | Optional stable secret scoping Tinfoil's prompt cache. Overrides the generated `~/.tinfoil/user_cache_secret` default. |

## Prompt caching (`user_cache_secret`)

Tinfoil salts its prompt cache so one tenant cannot time another tenant's cached
prefixes. The cache namespace is derived from the authenticated Tinfoil API
identity (the tenant) plus a client-held `user_cache_secret` carried inside the
encrypted request body.

The SDK injects this field for eligible POST requests (`/chat/completions`,
`/completions`, `/responses`) **before** the EHBP transport seals the body, so
neither Routstr nor any network observer ever sees it. Resolution order:

1. Per-request `RouteRequestParams.userCacheSecret`,
2. Client-level `RoutstrClientConfig.userCacheSecret`,
3. `TINFOIL_USER_CACHE_SECRET` environment variable,
4. A generated secret persisted at `~/.tinfoil/user_cache_secret` (Node/Bun),
   falling back to a process-lifetime in-memory secret in browsers. Set
   `RoutstrClientConfig.tinfoilCacheSecretPath` to persist at a custom file
   instead (analogous to `options.dbPath` on the sqlite storage driver) —
   useful to keep an app's secret isolated inside its own data directory
   rather than the location shared with Tinfoil's own SDKs.

> **Multi-user deployments:** Routstr-core authenticates to Tinfoil with a single
> API key shared by all of its users. Without a distinct per-user secret, those
> users share one Tinfoil cache namespace and can observe each other's cache
> timing. Applications serving multiple users must set a stable, opaque,
> per-user `userCacheSecret` on every request (or per-user client instance).

## Important notes

- The `tinfoil-` prefix is stripped from the model id inside the encrypted body.
  The full id is sent in the `X-Routstr-Model` header for proxy-side lookup.
- Tinfoil support requires the `tinfoil` package dependency and imports `ehbp`
  directly for the custom plaintext-error-preserving fetch wrapper.
- Provider/proxy infrastructure must understand EHBP-wrapped requests and forward
  them to the attested Tinfoil enclave. If a provider does not support Tinfoil
  proxying, `tinfoil-*` requests will fail.
