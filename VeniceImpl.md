# Venice E2EE Integration

End-to-end encryption support for Venice TEE models (`e2ee-*`) in the Routstr SDK.

## Overview

When the SDK sends a request for a model whose ID starts with `e2ee-`
(e.g. `e2ee-qwen3-5-122b-a10b`), the request is transparently intercepted
and E2EE-encrypted before it reaches the wire. Responses are transparently
decrypted before any downstream code sees them.

```
┌──────────────┐     encrypted messages     ┌───────────────┐     ┌─────────┐
│  Routstr SDK │ ──────────────────────────▶ │ Routstr Proxy │ ──▶ │ Venice  │
│              │                             │  (has API key)│     │   TEE   │
│  encrypt ◀──┼────── attestation ─────────▶│               │     │         │
│  decrypt ◀──┼── encrypted SSE chunks ──── │               │ ◀── │         │
└──────────────┘                             └───────────────┘     └─────────┘
```

No separate Venice API key is required on the client — the attestation and
chat requests both use the same auth mechanism (X-Cashu or Bearer token)
that the SDK already manages. The proxy/server holds the Venice API key.

## Files

| File | Role |
|------|------|
| `client/VeniceE2EE.ts` | Crypto primitives, attestation, encryption, SSE-decrypt transform |
| `client/RoutstrClient.ts` | Interception points in `fetchAIResponse()` and `_prepareRoutedRequest()` |
| `client/index.ts` | Re-exports `VeniceE2EE` |

## Trigger

Detection is a simple prefix check:

```ts
export function isE2EEModel(modelId: string): boolean {
  return modelId.startsWith("e2ee-");
}
```

Any model matching `e2ee-*` triggers the E2EE pipeline. This covers all
current Venice TEE models:

```
e2ee-venice-uncensored-24b-p
e2ee-gemma-3-27b-p
e2ee-glm-4-7-p
e2ee-glm-4-7-flash-p
e2ee-gpt-oss-20b-p
e2ee-gpt-oss-120b-p
e2ee-qwen-2-5-7b-p
e2ee-qwen3-30b-a3b-p
e2ee-qwen3-vl-30b-a3b-p
e2ee-glm-5
e2ee-qwen3-5-122b-a10b
```

## Request flow

### 0. Ordering guarantee

**Attestation always happens *before* `_spendToken()`.** If attestation
fails (wrong nonce, unverified key, model mismatch, server error), no
tokens have been spent yet — the error surfaces before any cashu or API
key deduction.

This is enforced in both `fetchAIResponse()` and `_prepareRoutedRequest()`.

### 1. Attestation

Before encrypting — and before spending — the SDK verifies the model's
identity:

```
GET {baseUrl}/tee/attestation?model={model}&nonce={random32bytes}
```

For `apikeys` mode the stored API key is used; for `xcashu` mode a
minimal (1 sat) spend provides the auth header. If attestation passes,
the same xcashu token is reused for the main request to avoid a double
spend.

The server returns a signed attestation containing the model's secp256k1
public key. The SDK verifies:
- `verified` is `true`
- `nonce` matches what we sent
- `model` matches the requested model

The model's public key is a 65-byte uncompressed secp256k1 key (hex, `04` prefix).

### 2. Key exchange & message encryption

A **session key pair** is created (ECDH secp256k1). The public half is sent
in the `X-Venice-TEE-Client-Pub-Key` header; the private half is kept for
response decryption.

Each user/system message is encrypted independently with a **per-message
ephemeral key pair**:

```
for each message:
  ephemeral_key = ECDH.generate()
  shared_secret = ECDH(ephemeral_key.private, model_public_key)
  aes_key = HKDF-SHA256(shared_secret, info="ecdsa_encryption", len=32)
  ciphertext = AES-256-GCM(aes_key, random_12byte_nonce, plaintext)
  wire_format = hex(ephemeral_key.public || nonce || ciphertext || tag)
```

The ephemeral public key (65 bytes), nonce (12 bytes), and ciphertext+tag are
concatenated and hex-encoded. The model can recover the AES key by computing
`ECDH(model_private, ephemeral_public)`.

### 3. Request

The encrypted messages replace the originals in the request body, and three
extra headers are added:

```
POST {baseUrl}/v1/chat/completions
X-Venice-TEE-Client-Pub-Key:  {session public key, 130 hex chars}
X-Venice-TEE-Model-Pub-Key:   {model public key from attestation}
X-Venice-TEE-Signing-Algo:    ecdsa

{
  "model": "e2ee-qwen3-5-122b-a10b",
  "messages": [...encrypted...],
  "stream": true,
  "venice_parameters": { "enable_e2ee": true }
}
```

The existing SDK auth (X-Cashu or Bearer token) is preserved — no separate
Venice API key is needed.

## Response decryption

Venice returns an SSE stream. Each `choices[0].delta.content` value is a
hex-encoded blob:

```
server_ephemeral_pub (65 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
```

Decryption uses the session private key (from step 2) with the server's
ephemeral public key:

```
server_ephemeral_pub = raw[0:65]
nonce = raw[65:77]
ciphertext_and_tag = raw[77:]
shared = ECDH(session_private, server_ephemeral_pub)
aes_key = HKDF-SHA256(shared, info="ecdsa_encryption", len=32)
plaintext = AES-256-GCM-Decrypt(aes_key, nonce, ciphertext_and_tag)
```

### TransformStream approach

Rather than modifying `StreamProcessor` or any downstream code, a
`TransformStream<Uint8Array, Uint8Array>` is spliced into the response
pipeline:

```
Raw SSE bytes
  │
  ▼
┌─────────────────────────┐
│ E2EE Decrypt Transform  │  ← createE2EEDecryptTransform(sessionEcdh)
│                         │
│ • buffers SSE events    │
│ • parses data: payloads │
│ • detects encrypted hex │
│ • decrypts content field│
│ • re-emits as SSE bytes │
└─────────────────────────┘
  │
  ▼
StreamProcessor / SSE client
(sees plaintext, unchanged)
```

Detection uses `looksEncryptedChunk()` — a hex string ≥186 chars that passes a
hex regex. Failed decryptions are silently passed through (unencrypted content
or non-content SSE fields).

## Integration points in RoutstrClient

### `fetchAIResponse()` — streaming via `StreamProcessor`

```ts
// E2EE attestation happens BEFORE _spendToken():
if (isE2EEModel(modelIdForRequest)) {
  const attestAuth = await this._getAttestationAuth({ baseUrl, mintUrl });
  const prep = await prepareE2EERequest({
    baseUrl, authHeaders: attestAuth.authHeaders, modelId, body,
  });
  finalBody = prep.modifiedBody;       // encrypted messages + venice_parameters
  e2eeHeaders = prep.e2eeHeaders;
  e2eeSessionEcdh = prep.sessionEcdh;
  e2eeSpendResult = attestAuth.spendResult; // reused for xcashu to avoid double spend
}

// Then spend (reuses attestation spend for xcashu mode):
spendResult = e2eeSpendResult && mode === "xcashu"
  ? e2eeSpendResult
  : await this._spendToken({ ... });

// Build final headers:
finalHeaders = e2eeSessionEcdh
  ? { ..._withAuthHeader(baseHeaders, token), ...e2eeHeaders }
  : _withAuthHeader(baseHeaders, token);

// After _makeRequest(), before StreamProcessor:
if (e2eeSessionEcdh) {
  const decryptedBody = response.body.pipeThrough(
    createE2EEDecryptTransform(e2eeSessionEcdh)
  );
  processedResponse = new Response(decryptedBody, response);
}
```

`StreamProcessor.process()` receives an already-decrypted SSE stream and works
unchanged.

### `_prepareRoutedRequest()` — for `routeRequest()`

Same attestation-before-spend ordering. For SSE responses, the tee'd client
stream is piped through the decrypt transform:

```ts
const [rawClientStream, inspectStream] = response.body.tee();
const clientStream = e2eeSessionEcdh
  ? rawClientStream.pipeThrough(createE2EEDecryptTransform(e2eeSessionEcdh))
  : rawClientStream;
```

The inspect stream (used for usage/responseId extraction) stays raw — those
fields are never encrypted.

## Exports

From `client/VeniceE2EE.ts`:

| Export | Type | Purpose |
|--------|------|---------|
| `isE2EEModel` | `(modelId: string) => boolean` | Check if model needs E2EE |
| `prepareE2EERequest` | `async (params) => { modifiedBody, e2eeHeaders, sessionEcdh }` | Full pre-request setup |
| `createE2EEDecryptTransform` | `(ecdh: ECDH) => TransformStream` | SSE decrypt pipeline |
| `createSessionKeyPair` | `() => { ecdh, publicKeyHex }` | ECDH key generation |
| `fetchVeniceAttestation` | `async (params) => { modelPublicKey, attestation }` | Attestation only |
| `encryptMessages` | `(messages, modelPubKey) => messages` | Encrypt message array |
| `decryptResponseChunk` | `(ecdh, hex) => string` | Decrypt single chunk |
| `looksEncryptedChunk` | `(content: string) => boolean` | Encrypted content detection |

## Crypto summary

| Primitive | Detail |
|-----------|--------|
| Key exchange | ECDH secp256k1 |
| KDF | HKDF-SHA256, info=`ecdsa_encryption`, 32-byte output, no salt |
| Encryption | AES-256-GCM, random 12-byte nonce per message |
| Message key | Per-message ephemeral ECDH key pair |
| Response key | Server ephemeral public key + session private key |

## Ported from

`venice-integration/venice-e2ee-cli.mjs` — the crypto logic, attestation
verification, and wire format are identical. The main difference is that the
CLI calls `api.venice.ai` directly with a `VENICE_API` key, while the SDK
routes through a Routstr proxy that holds the Venice key server-side.
