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
| `client/TinfoilSecure.ts` | Tinfoil model detection, `SecureClient` creation/cache, attestation helpers |
| `client/RoutstrClient.ts` | Detects `tinfoil-*`, attests before token spend, uses `SecureClient.fetch` for the request |
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
   │   body encrypted by SecureClient.fetch │                                  │
   │←─ decrypted Response stream ──────────│←─ EHBP encrypted response ───────│
```

## Behavior

- `isTinfoilModel(modelId)` returns true for `modelId.startsWith("tinfoil-")`.
- `getTinfoilUpstreamModelId(modelId)` strips the `tinfoil-` prefix for the
  model id inside the encrypted body (e.g. `tinfoil-kimi-k2-6` → `kimi-k2-6`).
- `RoutstrClient` runs Tinfoil attestation **before** spending the main token.
- The actual API request uses `SecureClient.fetch`, not global `fetch`.
- The full caller-facing model id is sent in the `X-Routstr-Model` header so the
  proxy can do model lookup, cost calculation, and routing without parsing the
  encrypted body.
- No custom stream transform is needed; Tinfoil decrypts the response before the
  SDK's normal SSE processing sees it.
- Request debug storage redacts the body for Tinfoil requests because encryption
  happens inside `SecureClient.fetch` at call time.

## Configuration

By default, the SDK uses Tinfoil's public ATC and binds EHBP requests to the
selected provider `baseUrl`.

Optional environment overrides:

| Variable | Purpose |
|---|---|
| `ROUTSTR_TINFOIL_ATTESTATION_BUNDLE_URL` | Custom attestation bundle origin. `SecureClient` fetches `${url}/attestation`. |
| `ROUTSTR_TINFOIL_ENCLAVE_URL` | Explicit enclave URL for custom deployments. |
| `ROUTSTR_TINFOIL_CONFIG_REPO` | Repo used by Tinfoil verifier for custom enclave code verification. |

## Important notes

- The `tinfoil-` prefix is stripped from the model id inside the encrypted body.
  The full id is sent in the `X-Routstr-Model` header for proxy-side lookup.
- Tinfoil support requires the `tinfoil` package dependency.
- Provider/proxy infrastructure must understand EHBP-wrapped requests and forward
  them to the attested Tinfoil enclave. If a provider does not support Tinfoil
  proxying, `tinfoil-*` requests will fail.
