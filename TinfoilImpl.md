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
| `client/TinfoilOutputTokens.ts` | Visible output-token cap (`X-Tinfoil-Max-Output-Tokens`): endpoint/field precedence, strict value grammar, caller-header passthrough, never duplicated |
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
- The caller's reasoning effort is translated to the model's own vocabulary
  before sealing (see below).

## Reasoning effort

Tinfoil's gateway and its models do not agree on the `reasoning_effort`
vocabulary. The gateway accepts
`none|minimal|low|medium|high|xhigh|max`, but a model's chat template can be
narrower: DeepSeek V4.1 only accepts `low`, `high`, `xhigh`, `max` (or an
integer 1-100) inside `chat_template_kwargs` and rejects a literal `medium` with
`400 invalid_request_error`.

Because EHBP encrypts the body end to end, the Routstr proxy is a blind relay
and cannot rewrite the field, so the translation happens here, before sealing.
Nodes running routstr-core with routstr#848 publish the map per model on
`/v1/models`:

```json
{
  "reasoning": {
    "effort_map": { "low": "low", "medium": "high", "high": "xhigh" },
    "mandatory": false
  }
}
```

The map's keys are the coarse levels a UI offers; its values are the spellings
the model's template accepts. `effort_map` is published alone — Tinfoil
publishes no `supported_efforts`, and the SDK must not derive one from the
map's values, because routstr-core *applies* that field by snapping requests
onto it (that is how a deliberate `none` used to become `low` and `max` was
downgraded to `xhigh`).

`applyTinfoilReasoningEffort` rewrites all three shapes a caller may use —
`reasoning_effort`, `reasoning.effort`, and `chat_template_kwargs.reasoning_effort`
— in one pass, each in the shape it was sent (copy-on-write, so retries still
rebuild from the caller's untouched body). A body that carries more than one
shape has every one of them translated, not just the first.

Only levels the model rejects are translated:

- A value that is already one of the model's own spellings is left exactly as
  sent. Keys overlap values (DeepSeek maps `high` -> `xhigh` while accepting
  `high`), so a key never wins over an already-legal value — otherwise a caller
  asking for `high` would silently get `xhigh`.
- Levels the map does not mention (`none`, `max`, `minimal`, integers) pass
  through unchanged, since `none` disables reasoning and `max` outranks `xhigh`.

This mirrors the node's own readable-body translation, so a model behaves the
same whether its body is plaintext or sealed. The mapping runs per attempt: a
failover target applies its own map. When the target does not advertise the
model it publishes no map, and the retry forwards the caller's effort untouched
rather than reusing the failed node's vocabulary — `effort_map` describes one
node's enclave. Without metadata the SDK does not guess. Models with no effort
levels (a plain on/off reasoning toggle) publish no `reasoning` object and are
unaffected.

## Output-token cap (`X-Tinfoil-Max-Output-Tokens`)

A sealed body is opaque to the node: it cannot read `max_tokens` /
`max_completion_tokens` / `max_output_tokens`, so it used to hold the model's
whole `max_cost` envelope for every Tinfoil request, even a 64-token answer.
[tinfoilsh/confidential-model-router#518](https://github.com/tinfoilsh/confidential-model-router/pull/518)
makes the cap visible in a request header that travels *outside* the EHBP body
and that the enclave enforces **in place of** any body cap, larger or smaller.

> **Single-choice capability, not a request-total token cap.**
>
> Router PR #518 enforces the output cap **per choice**. Router PR #532 adds
> `X-Tinfoil-Completion-Count`, which replaces hidden `n` on chat/completions
> but leaves `best_of` unchanged. For capped single-choice chat, the SDK sends
> count `1` before EHBP sealing. This bounds one completion in one inference
> call; it is not an aggregate budget for multiple requests or agent/tool loops.
>
> Discounting requires a verified deployment: core must advertise
> `features.ehbp_single_choice_output_token_reservation === true` plus
> `features.ehbp_single_choice_output_token_reservation_routes` containing
> `chat/completions`. This is a capability
> statement, not an operator toggle. **Reservation remains OFF:** core leaves
> this capability disabled/unadvertised pending a request-total cost guarantee.
> PR #532 is already deployed at `inference.tinfoil.sh`: hidden `n=3` with
> count `1` and cap `8` produced one choice / eight completion tokens. A
> `best_of=3` probe also reported eight tokens on the tested backend only.
> Neither observation proves request-total safety: hidden tool profiles can
> trigger repeated model calls and aggregate usage (`toolruntime/tool_loop.go`
> lines 139–218; `main.go` lines 917–953 in the researched router version).
> Thus activation is blocked on request-total accounting/enforcement, **not**
> on deploying #532. This SDK patch only integrates the paired headers;
> legacy flags or absent capability keep the full reserve.

The SDK therefore derives the header before sealing, on sealed (`tinfoil-*`)
requests only:

| Endpoint | Fields the engine reads (precedence) | Header emitted |
|---|---|---|
| `/v1/chat/completions` | `max_completion_tokens`, then `max_tokens` (`max_output_tokens` is ignored) | yes |
| `/v1/responses` | `max_output_tokens` | yes |
| `/v1/completions` | — | no: deployed enclaves 404 it and routstr-core does not discount it |
| every other route | — | no: the enclave ignores the header there |

Rules, all mirroring the enclave and routstr-core exactly:

- **The caller's header wins.** If the caller set the header it is forwarded
  verbatim and the body cap is ignored for pricing, because the enclave ignores
  it too. The SDK never emits a second value: two values (a repeated header, a
  comma list, or one the caller spelled twice) are a 400.
- **Strict grammar.** Only `^[1-9][0-9]*$` after stripping space/tab, at most
  `2147483647`, becomes a header. `0`, negatives, fractions, `"+16"`, `"1e3"`,
  numeric strings and newline-padded values emit **nothing** and leave the
  request exactly as it was, so a caller whose body cap the engine would have
  ignored (or rejected) does not start getting 400s from the SDK.
- **A cap the engine would not read is never invented.** A chat body carrying
  only `max_output_tokens` gets no header; a present-but-unusable preferred
  field does not fall through to the next one.
- **No body rewrite.** The enclave deletes the body caps itself when the header
  is present, and leaving them untouched keeps old nodes — which ignore the
  header and read the body — working unchanged.
- **Multi-choice requests are excluded.** The cap applies *per choice*
  (probe-verified: header `8` with `n=3` billed 24 completion tokens), and `n`
  is invisible to the node behind the sealed body, so quoting one cap would let
  the enclave bill up to `n * cap` against a hold sized for a single completion.
  With `n > 1` (or `best_of > 1`) the SDK emits no derived header and quotes
  nothing — a caller-supplied header is still forwarded, just not priced — so
  those requests keep the full-envelope reserve they had before this feature.

The header is attached when the request is prepared (so retries and failover
inherit it from `baseHeaders`) and re-asserted in `_makeRequest`, the last stop
before the EHBP transport.

### Reservation

Emitting the header is unconditional; *reserving* against it is not.

Quoting requires **both visible headers**: a valid output cap and exactly one
canonical completion-count value equal to `1`, on chat/completions only.
The SDK also requires these `/v1/info` capabilities:

| Key | Meaning |
|---|---|
| `features.ehbp_single_choice_output_token_reservation` | exactly `true`: node supports the verified single-choice cap/count contract |
| `features.ehbp_single_choice_output_token_reservation_routes` | authoritative nonempty canonical route list, including `chat/completions` |

The old `ehbp_output_token_reservation` and
`ehbp_output_token_reservation_total_cap` booleans and legacy
`ehbp_output_token_reservation_routes` list do **not** enable this quote.
The dedicated and legacy route sets are separate protocols: they are never
unioned, even when both flags are true.
Responses ignores completion-count, so it always keeps the full sealed reserve,
even if advertised in the route list. Count headers supplied by callers are
forwarded verbatim, never replaced or duplicated; malformed, repeated, or
count-greater-than-one values are never quoted. Without a usable cap no count
is derived. With `n > 1` or `best_of > 1`, no paired headers are derived and no
quote is made, even if the caller supplies count `1` (which the enclave would
otherwise use to override `n`). Either header nominated in `Connection` also
suppresses derivation and quoting. The exact prepared cap/count decision is
reused for transport, retries and failover, rather than re-derived after header
sanitization has dropped `Connection`.

When a node advertises the full set, `getRequiredSatsForModel` prices a sealed request
from the cap using routstr-core's worst case over the whole context window —
never with the plaintext subtraction, which would spend an input allowance the
node cannot see:

```
W     = max((window - cap) * promptPrice + cap * completionPrice, window * promptPrice)
hold  = max(min_request_msat, min(base_msats, ceil(W * 1000 * tolerance)))
```

`window` is `top_provider.context_length`, else `model.context_length`. A
completion-only limit (`top_provider.max_completion_tokens`) is **never** used
as the window: a model can advertise a 10k completion cap inside a 100k
window, and treating 10k as the window under-reserves every longer request
(13-sat hold vs a 34-sat true cost for 30k input + 1k output). An unknown
window, a cap that already covers it, or an unusable (non-finite/negative) rate
keeps the full envelope.

Two more fail-closed conditions apply to the quote itself:

- **Missing/malformed/empty route list** — a capability we cannot trust is not
  permission to quote every route; the full envelope is kept.
- **Caller nominates the cap header in `Connection`** — the hop strips the field
  before the enclave sees it, so a quote computed from it is not a bound. The
  SDK keeps the full envelope (core refuses the quote on its side too), and a
  cold `/v1/info` probe is bounded by a deadline (10s) with caller cancellation
  threaded through, so a stalled discovery can never block inference or hold a
  request past its abort.

When the node advertises less than the full set — an older node, a node whose
discount is not yet sound, or one that quotes only some routes — the SDK keeps
the full-envelope reserve even though the header is sent: such a node ignores the header (or would answer a cap-sized
deposit with 402 `insufficient_balance`). A fallback provider that ignores the
header is re-priced the same way on failover.

Settlement is unaffected: billing still comes from actual usage
(`X-Tinfoil-Usage-Metrics`), never from the cap.

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
- `X-Tinfoil-Max-Output-Tokens` is a plaintext header, so the node sees the
  request's output limit even though the prompt stays sealed. It carries no
  content — only the cap the caller already declared in the body. It is sent
  **today**; the reservation discount that would ride on it stays **off** until
  the enclave's cap bounds the whole request (see "Output-token cap" above).
- **A `Connection` header nomination strips the cap header.** If the request
  names `X-Tinfoil-Max-Output-Tokens` in its `Connection` header, the hop that
  honors that nomination removes the field before the enclave sees it. The
  quote was already computed from the stripped value, so the reservation no
  longer matches what the enclave will enforce. The SDK cannot fix node-side
  security: the node must refuse to quote when the cap header is nominated in
  `Connection`, or refuse the request outright. Until it does, a caller that
  sets such a nomination gets an over- or under-reserve against a header the
  enclave never received — a node-side integrity gap this client cannot close.
