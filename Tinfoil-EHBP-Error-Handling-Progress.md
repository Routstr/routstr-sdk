# Tinfoil EHBP Error Handling Progress

## Context

We are debugging `Missing Ehbp-Response-Nonce header` for Tinfoil/EHBP requests.

Normal 200 responses appear to work after the routstr-core EHBP proxy changes. The remaining problem happens for proxy-side non-200 responses, for example:

```txt
routstr-1 | Bearer token validation failed: HTTPException: 402: {'error': {'message': 'Insufficient balance: 434185 mSats required for this model. 122307 available.', ...}}
[daemon] Error: Missing Ehbp-Response-Nonce header
```

## Root cause

`SecureClient.fetch` from `tinfoil` uses `ehbp`'s `Transport.request()` internally. That code sends the encrypted request, then requires the response to include `Ehbp-Response-Nonce` before it returns anything:

```js
const response = await fetch(encryptedRequest);
const responseNonceHeader = response.headers.get(PROTOCOL.RESPONSE_NONCE_HEADER);
if (!responseNonceHeader) {
  throw new ProtocolError(`Missing ${PROTOCOL.RESPONSE_NONCE_HEADER} header`);
}
return await decryptResponseWithToken(response, token);
```

So if the Routstr proxy returns a plaintext proxy-side error (402/401/403/500/etc.) before the request reaches the enclave, the response is real and useful, but stock `SecureClient.fetch` throws before exposing it to our SDK.

The proxy cannot make its own 402/401/etc. response EHBP-encrypted because it does not have the HPKE response context/session secret. Only the enclave/EHBP transport can produce a valid encrypted response with `Ehbp-Response-Nonce`.

## Important decision

We should **not** blindly map missing-nonce `ProtocolError` to synthetic `402`. That would lose the actual status/body and is incorrect because plaintext proxy-side errors can be 401, 402, 403, 429, 500, etc.

Better approach: preserve and return the actual plaintext non-EHBP response.

## Work already committed in SDK

Commit `54b68bb`:

```txt
fix(tinfoil): strip tinfoil- prefix from body model, send X-Routstr-Model header
```

This committed:

- SDK strips `tinfoil-` from `body.model` before EHBP encryption.
  - `tinfoil-kimi-k2-6` → `kimi-k2-6`
- SDK sends full caller-facing model in `X-Routstr-Model` header.
  - `X-Routstr-Model: tinfoil-kimi-k2-6`
- Docs updated in `TinfoilImpl.md` for that flow.

## Uncommitted SDK changes made after that commit

These were made but **not committed**:

### `client/TinfoilSecure.ts`

Added a new custom EHBP fetch wrapper:

```ts
fetchTinfoilPreservingPlaintextErrors(options, input, init)
```

Purpose:

- Still uses `prepareTinfoilClient()` for attestation and verified HPKE public key.
- Uses lower-level `ehbp` primitives directly:
  - `Identity.fromPublicKeyHex(...)`
  - `encryptRequestWithContext(...)`
  - `extractSessionRecoveryToken(...)`
  - `decryptResponseWithToken(...)`
  - `PROTOCOL.RESPONSE_NONCE_HEADER`
- Sends the EHBP-encrypted request to the Routstr provider/proxy.
- If response has `Ehbp-Response-Nonce`, decrypts and returns decrypted response.
- If response does **not** have `Ehbp-Response-Nonce`, returns the actual plaintext response unchanged instead of throwing.
- Preserves stock `SecureClient.fetch` key-rotation behavior: an EHBP key-config mismatch `422 application/problem+json` triggers one fresh attestation and one retry.

This is meant to let `_makeRequest()` see the real 402/401/etc. and use the existing `_handleErrorResponse(...)` path with exact status/body.

### `client/RoutstrClient.ts`

Changed `_makeRequest()` from stock:

```ts
(await prepareTinfoilClient({ baseUrl })).client.fetch
```

to:

```ts
fetchTinfoilPreservingPlaintextErrors({ baseUrl }, url, { method, headers, body })
```

Also updated the debug redaction string from:

```txt
[redacted: Tinfoil EHBP encrypted inside SecureClient.fetch]
```

to:

```txt
[redacted: Tinfoil EHBP encrypted before upstream fetch]
```

### `TinfoilImpl.md`

Partially updated docs to say that plaintext proxy-side error responses are preserved with their real status/body instead of being hidden behind missing-nonce `ProtocolError`.

### `package.json`

Added direct dependency:

```json
"ehbp": "^0.2.3"
```

Reason: SDK source now imports lower-level `ehbp` primitives directly.

### `pnpm-lock.yaml`

The lockfile now has a direct root importer entry for `ehbp`:

```yaml
ehbp:
  specifier: ^0.2.3
  version: 0.2.3
```

`ehbp` was already present transitively via `tinfoil`, so only the importer section needed updating.

## Validation done

Ran:

```bash
npx tsc --noEmit --pretty false 2>&1 | grep -E "client/TinfoilSecure.ts|client/RoutstrClient.ts|ehbp" | head -100
```

No errors for touched SDK files.

Also ran:

```bash
pnpm build
```

Build succeeded, including DTS generation.

Note: full `tsc --noEmit` may still have unrelated pre-existing script errors in this repo.

## routstr-core changes already made earlier

In `/Users/r/projects/routstr_main/routstr-core`:

Update: these changes appear to have since been committed/refactored there (for example into `routstr/upstream/ehbp.py`, with commit `24b90af refactor: move EHBP logic to dedicated module with explicit opt-in`). Current core status only showed unrelated untracked docs/agent files when checked from this SDK worktree.

### `routstr/proxy.py`

- Detects EHBP requests via `Ehbp-Encapsulated-Key` header.
- Skips JSON body parsing for EHBP requests.
- Reads model from `X-Routstr-Model` header.
- Routes EHBP bearer-auth requests to `forward_ehbp_request(...)`.
- Routes EHBP x-cashu requests to `forward_ehbp_x_cashu_request(...)`.
- Skips reactive 400 correction for EHBP.

### `routstr/upstream/base.py`

Added EHBP forwarding helpers:

- `get_ehbp_base_url()`
- `get_ehbp_request_path(path)`
- `get_ehbp_extra_headers(model_obj)`
- `forward_ehbp_request(...)`
- `forward_ehbp_x_cashu_request(...)`

These forward raw encrypted body to upstream EHBP endpoint and stream raw encrypted response back untouched.

### `routstr/upstream/ppqai.py`

- `get_ehbp_base_url()` returns `https://api.ppq.ai/private`.
- `get_ehbp_extra_headers()` sends:

```python
{"X-Private-Model": model_obj.forwarded_model_id or model_obj.id}
```

So PPQ's billing layer gets e.g. `private/kimi-k2-6` while the enclave receives encrypted body with `model: "kimi-k2-6"`.

### routstr-core docs

Wrote:

```txt
/Users/r/projects/routstr_main/routstr-core/docs/ehbp-proxy-support.md
```

This explains the EHBP proxy/blind relay changes.

### Python syntax validation

Ran with project Python 3.11:

```bash
cd /Users/r/projects/routstr_main/routstr-core
.venv/bin/python -m py_compile routstr/proxy.py
.venv/bin/python -m py_compile routstr/upstream/base.py
.venv/bin/python -m py_compile routstr/upstream/ppqai.py
```

All passed.

## Current likely next steps

1. Review current SDK diff carefully.
2. Test a Tinfoil request where Routstr proxy returns 402 and verify SDK now sees real 402 body instead of missing-nonce ProtocolError.
3. Commit SDK changes if accepted.
4. Optionally add a focused test/mock around `fetchTinfoilPreservingPlaintextErrors` for plaintext non-EHBP responses and key-config mismatch retry.

## Current mental model

End-to-end success path:

```txt
SDK
  X-Routstr-Model: tinfoil-kimi-k2-6
  encrypted body: { model: "kimi-k2-6", ... }
    ↓
Routstr proxy
  reads X-Routstr-Model for billing/routing
  adds X-Private-Model: private/kimi-k2-6
  forwards raw EHBP body to PPQ /private/
    ↓
PPQ / Tinfoil enclave
  billing layer reads X-Private-Model
  enclave decrypts body and sees model "kimi-k2-6"
  returns EHBP encrypted response + Ehbp-Response-Nonce
    ↓
SDK custom EHBP fetch
  decrypts response if nonce exists
  returns plaintext Response to normal SDK handling
```

Proxy-side error path:

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
