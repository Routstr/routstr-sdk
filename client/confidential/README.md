# Confidential upstream (client side)

Node/Bun-only. A request can run as a confidential-upstream session: the
client is the TLS 1.3 client of the node's upstream provider, so the node
relays ciphertext and never sees the prompt or response, while the node's API
key stays in the one record the node writes. Protocol, proofs and the node's
Rust sidecar: <https://github.com/jooray/routstr-confidential>.

## Use

```ts
import { routeRequests } from "@routstr/sdk/bun"; // or /node

await routeRequests({
  // …the usual options…
  confidential: {
    trustedHosts: ["*.venice.ai"],          // upstream TLS hostnames you accept
    nodePubkeys: ["npub1…"],                // node keys whose offers you accept
    proverPath: "/path/to/cu-prover",       // or CU_PROVER_BIN / CU_PROVER / PATH
    // twoPcPath: "/path/to/cu-2pc",        // default: CU_2PC_BIN / CU_2PC, next to cu-prover, PATH
  },
});
```

`POST /v1/chat/completions` and the image paths `POST /v1/images/generations`
(OpenAI shape) and `POST /v1/image/generate` (Venice shape) are supported;
other endpoints are refused before any credential or deposit. Only nodes whose `/v1/models` entry
advertises `confidential_upstream` for the model are selected. Credentials, top-ups, failover, usage tracking and balance
accounting are the client's normal ones: `RoutstrClient` runs
`fetchConfidential` (`transport.ts`) in place of `fetch()`. The Bun/Node
entrypoints register the transport, so the browser-safe bundle never imports
this directory.

The node URL must be `https:`, an onion service or loopback: pinned keys
authenticate the offer, not the connection, and the session's setup carries
the node credential (`allowInsecureTransport` is a development opt-out).
A stream's final `data: [DONE]` line is delivered only after the settlement
checks passed; a failed check ends the stream with an error instead.
Confidential requests skip the client's raw request/response log sink unless
`logPlaintext` is set, and `runsDir` (development evidence) writes the
decrypted response to disk (unused since v3).

## Images

A node whose signed offer lists `capabilities: ["chat", "images"]` also
serves images confidentially. The offer's `images` block carries the head
template, `count_key`, `fixed_pins`, `param_space`, `max_count` and a
`price_list` of variants per model (`{id, pins, msat_per_image}`, e.g.
`1K-webp`). `planImageRequest` splits the caller's body: model, count
(`n`/`variants`) and the variant (from `resolution`, `quality`, `size` or
`format`; WebP only; no match is an error, never a substitute) are pinned in
the suffix (`renderImageSuffix`), everything else (prompt, `aspect_ratio`,
`seed`, ...) stays private. The `request` names `kind: "images"`, the variant
and the count; after the response it sends `accept` for a 2xx (no usage
proof; `accept_retry` when the node holds more records) or discloses the
error head for a 4xx/5xx as for chat. Images run on framing "2" when
`h2.kinds` lists them, else on "1.1"; the image body is handed on in the
pieces it arrived in and decoded once (it was held about three times). `verifyFlatReceipt`
requires `cost_msats == ceil(msat_per_image × count + session fee)`. The
response is OpenAI-shaped (`{created, data: [{b64_json}]}`); a node without the
capability is refused with `offer_no_images`. An armed connection serves an image request too (it is bound to the credential only). `confidentialImageRequiredSats` sizes the deposit (also on a
failover node) and throws for a request the offer cannot serve. The offer's
`count_key` must be the key its route reads (`n` for `/images/generations`,
`variants` for `/image/generate`): the charge is the price × count, so a
count pinned under a key the endpoint ignores would be paid and not made.

## Before the deposit

`RoutstrClient` qualifies a node before it spends a token on it
(`qualifyConfidentialNode`): cu-prover and cu-2pc can be run, the node's
signed offer verifies under the caller's policy and prices the model (under
the id the body carries to that node, its own spelling of the requested
model), and the request can be pinned under that offer (no parameter pinned
to another value, `n` at most one, an image variant and count the offer
serves). A node that does not qualify costs nothing and the next node that
lists confidential sessions for the model is tried; a missing helper binary
fails the request at once. In xcashu mode a one-off token minted for a
session that then throws without change is received back, and the change of
an upstream error returned through a session is received although such a
response is passed through without `finalize()`.

`confidentialSettled` resolves `{ change, costMsats }`: the one-off bearer's
change and the verified receipt's cost, which `finalize()` accounts (a chat
stream's headers left before the receipt existed). A stream ends when the
session's settlement checks passed; it does not wait for the change.

## Protocol version (v3)

The client speaks routstr-confidential **protocol v3** only
(`PROTOCOL-V3.md` in routstr-confidential is normative). Offers are fetched
as `/v1/confidential/offer?v=3` and must name `v: 3` and
`twopc: "split-public-1"`. An offer with `v < 3` is refused with
`NodeProtocolOutdatedError` (`code: "node_protocol_outdated"`): the node is
not used for confidential requests (`onNodeProtocolOutdated` tells the
caller, routstrd logs it once per node per day). A node that speaks a newer
protocol answers the setup with 426 `upgrade_required`, raised as
`UpgradeRequiredError` (update the client). A `cu-2pc` that reads another
2PC version tag exits with status 3, raised as `TwoPcVersionMismatchError`
(`twopc_version_mismatch`: the helper binaries and the node's sidecar are of
different releases). There is no v2 fallback.

## Connections and framings

The unit is a **connection** (`connection.ts`, `ConfidentialConnection`)
that carries requests `(sid, n)`. One object serves both framings towards
the provider:

| | framing `"2"` (HTTP/2) | framing `"1.1"` (HTTP/1.1) |
|---|---|---|
| setup | `{type:"setup", v:3, http, nonce_c, armed, auth, offer_sig}`: no request terms | same |
| ARMED | 2PC preprocessing, key share, proof channel; deposit held; no provider connection | same |
| connection head (epoch 0, by the node) | preface, SETTINGS, the probe putting the credential in the HPACK table | the request head of request 1 |
| order | handshake, π_NK, `release_head`, `settings_seen`, then `request` k | `request` 1, then the ClientHello, handshake, π_NK, `release_head` |
| a request | HEADERS + DATA, one frame per record, π_WIN over them, `release` by the provider's windows | the body, the suffix alone in the final record, π_WIN over that record |
| end of a request | `disclose` (π_C3S) / `accept` / `disclose_head` (π_WIN under `s_ap_0`); READY again after a 2xx | the attestation when the provider closes, then `disclose` / `accept` / `disclose_head` (π_C3S); `closed` |
| requests | up to `h2.max_requests`, one at a time | exactly 1 |

`request_refused` (402 for the balance, 409 `offer_expired` /
`offer_changed` / `session_fee_not_accepted`, 400 for terms) leaves the
connection as it was and does not use up the request number: the call gets
the node's HTTP error (`RequestRefusedError`), the connection goes back to
the pool. `offer_expired` and `offer_changed` refetch the offer and run the
request once more (`offer_changed` on a new connection: the pool key includes
the offer's connection-level fields, `connectionTerms`). π_C2S and the v2
one-request session are gone.

**Choosing the framing** (§2.3; `confidential.http`, default `auto`):
the first entry of the signed offer's `http` that serves the request (images
on `"2"` only when `h2.kinds` lists them) and is not marked bad for the node.
When a framing-`"2"` connection fails before the body of its first request
was released (handshake, ALPN, connection head, the provider closing, the
sidecar's `h2_withdrawn`), the node's `"2"` is marked bad for 10 minutes and
the request is served on `"1.1"` on the same node. A refusal with a status
(credential, balance), the upgrade and 2PC-version errors and local faults do
not fall back. After a body was released nothing is retried. `"2"` or
`"1.1"` uses only that framing; a node that does not offer it is not used.

## Money

- The node reserves the offer's `connection_deposit_msat` at the setup, for
  both framings, and releases it with the connection's first settled request
  (`deposit_released_msat` in that receipt, required, and only there). A
  connection that ends without a settled request loses it, unless the node,
  its sidecar or the provider failed (the signed `deposit` of the last frame
  says which; `conn.deposit`).
- A node whose deposit exceeds `maxConnectionDepositMsat` (default 100 000
  msat; also read from `http2.maxConnectionDepositMsat`) is not used: the
  check runs when the node is qualified, before any token is spent.
- Each request is reserved at its `request`: a full-context prompt plus
  `max_tokens` (images: price × count), plus max(session fee if still due,
  abandon fee). `confidentialRequiredSats` / `confidentialImageRequiredSats`
  size the deposit as that reservation **plus the connection deposit**, the
  balance needed before a connection is opened.
- The session fee falls due once per connection, at its first settlement: the
  receipt checks bound request 1 by usage + fee and later requests by usage
  alone (`maxChargeMsats`, `verifyFlatReceipt`, `checkUpstreamErrorReceipt`).

## Pool, reuse scope and pre-warming

`pool.ts` (`ConnectionPool`, process-wide) keys connections by (node,
credential, `reuseScope`, the offer's connection terms). Requests of one
connection are linkable for the provider; `reuseScope` (in the confidential
options, per request; routstrd derives it from its local client) separates
what must not be linked: a scope never shares a connection with another.

- A framing-`"2"` request takes an idle open connection of its key, else an
  armed one, else opens one (up to `http2.maxConnectionsPerKey`, 4, and
  `http2.maxConnections`, 8, then it waits). Overlapping requests use separate
  connections. A connection is kept after a settled 2xx and after a refused
  request, and closed `idleMarginMs` (20 s, at most a quarter) before the
  node's `idle_timeout_s`, at `h2.max_requests`, before `h2.max_lifetime_s`,
  and on any failure. `http2.reuse: "none"` closes it after its request.
- One-off Cashu bearers (`returnChange`, `cashu…`): framing `"1.1"` when
  offered (a connection per token), else `"2"` with a connection of their own;
  never pooled, never pre-warmed. The xcashu change handling is unchanged.
- **Pre-warm** (`prewarm: {}`; off unless set): an *armed connection* (deposit
  held, 2PC preprocessing, key share and the proof channel's correlations
  done, no provider connection), bound to the credential only. Framing
  `"1.1"`: one per key while the key has traffic. Framing `"2"`: one per key
  while the key has traffic and every open connection of it is busy, so a
  burst does not wait for a 2PC. A key is armed only after one of its requests
  settled, only for nodes whose deposit is at most `prewarm.maxDepositMsat`
  (5000), at most `prewarm.maxTotal` (4) in all, one arm at a time; a spare
  is retired when its key had no request for `activityWindowMs` (10 min) or
  it is `maxAgeMs` (480 s) old, and that costs its deposit
  (`unusedDepositMsats`). A failed arm backs the key off (`backoffBaseMs`
  doubling to `backoffMaxMs`); a deposit the balance does not cover waits
  `backoffBaseMs` without escalating.
- The proof channel (`cu-prover --channel`) holds correlations for π_NK and
  the first π_WIN and π_C3S. On a kept framing-"2" connection it is **topped
  up while idle** (after the head and after each settled 2xx; PROTOCOL-V3.md
  §9.2): the node grants one Ferret step (about 0.6 MB from the node) while
  the chain holds less than one request's worth, so later requests prove from
  preprocessed correlations. The top-up is queued with the proofs: a request
  that starts during one waits for it (about 0.2 s on loopback). A proof that
  still runs short extends the chain online. `ConfidentialConnectionOptions.topUp:
  false` turns it off. A request refused with `offer_changed` closes its
  connection (the node takes no further request on it).

**Ending a process.** A kept connection holds its WebSocket and the helper
processes (`cu-2pc`, `cu-prover --channel`) until the pool retires it, so a
process that made confidential requests stays alive for up to the node's idle
time (about 100 s by default; with a spare armed, up to `maxAgeMs`). A script
or CLI calls `closeConfidentialConnections()` after its last request: every
connection closes and every wait on it ends at once. A connection that never
settled a request (an unused spare) loses its deposit.

`x-routstr-confidential-http` names the framing, and
`x-routstr-confidential-connection` what the request found (`new`, `armed`,
`reused`) and its number (`request=n`). `http2.onRequest` reports per request
the framing, `warm` (`cold` | `armed` | `open`), time to first token and the
bytes each way (the arming bytes separately).

## Measured (loopback, Venice, 2026-11-12)

Time to first token at the API, bytes between client and node per request
(`scripts/confidential-v3-e2e.ts`; arming = 2PC preprocessing, key share,
proof-channel setup, paid before the request when armed):

| framing | found | ttft | sent | received | arming sent / received |
|---|---|---|---|---|---|
| "2" | cold | 1.7–2.1 s | 82 kB | 12 kB | 2.55 MB / 17.9 MB |
| "2" | open | 0.6–1.1 s | 81 kB | 12 kB (620 kB¹) | – |
| "1.1" | cold | 1.3–1.8 s | 77 kB | 93 kB | 2.55 MB / 17.9 MB |

¹ The script sends its requests back to back, so the proof channel's top-up
after one settlement runs while the next request starts and its 0.6 MB count
in that request's bytes (every second request or so); with a pause between
requests the top-up is done before the next one and the request downloads
about 12 kB. Before the top-up existed, an open-connection request downloaded
up to 1.45 MB on its path when its proofs ran out of correlations and the
chain extended online (from the third request of a connection on).

## What is checked

- The node's offer: Schnorr signature, pinned node key, protocol version and a
  trusted upstream host, under the caller's policy on every request.
- The provider: TLS 1.3 with full certificate-path and hostname validation in
  the vendored TLS stack.
- The proofs: π_NK against the connection head rebuilt from the signed offer
  (framing "2": §5.2; "1.1": the head template with the body length), and
  every parameter the node sends for π_WIN and π_C3S against the client's own
  records (`h2.ts` `checkPiWinParams` / `checkPiWinFinalRecord`, `params.ts`),
  so the client only proves statements about data it chose to disclose.
  π_C3S must cover exactly the tail records the client named in its
  disclosure. Both reveal one bit to the node, never plaintext.
- The attestation (per request): `sid`, `http`, `n`, and in framing "2"
  `stream` and an interval `s_k` that starts at the request and ends at the
  disclosure, with the hash of exactly those records (an accepted image
  response is hashed as it arrives and not kept); the sidecar's record of the session (sid, certificate-chain
  hash, both handshake transcript hashes, record counts and the SHA-256 of all
  bytes in each direction, the credential-record commitment, the time), signed
  by the sidecar's per-process Ed25519 key and re-signed by the node's Nostr
  key. The client requires the node's signature and checks that the sid,
  both transcript hashes and the credential-record commitment (the one π_NK
  proved) are its own (`checkAttestationBinding`).
- The receipt: required Schnorr signature over the exact signed bytes, this
  connection's sid, its framing and request number, the attestation hash, the
  deposit released once (on the first settled request, the offer's amount), the usage equal to the client's own
  plaintext, and a cost no higher than that usage at the signed offer's rates
  plus the offer's session fee (`maxChargeMsats`); a receipt naming larger
  fees than the signed ones is refused. For an upstream HTTP error the
  receipt must name the status the client saw; 4xx/503 may cost at most the
  session fee, any other error at most the reservation the receipt names
  (`checkUpstreamErrorReceipt`).

A non-streaming call fails if any check after the response fails; a stream
ends with an error instead of a clean end. On an upstream HTTP error the node
learns only the status line and headers (the body stays private); 4xx and
503 cost nothing beyond the session fee. The node reserves a full-context
prompt plus the pinned completion cap at the offer's rates, plus the larger of
its session and abandon fees, so the client deposits for that
(`confidentialRequiredSats` reads the fees and the surcharge from the model
listing's `confidential_upstream` field).

**Node pricing.** A node may add a percentage surcharge to its per-token rates
(already included in the signed `price_list`; `rate_surcharge_pct` states it),
a `session_fee_msat` added to every completed request (and charged alone for a
provider refusal, 4xx/503), and an `abandon_fee_msat` (≥ the session fee,
`offerAbandonFeeMsat`) charged instead for a session that ends without a
request reaching the provider (set up but never used, aborted). The session
echoes both signed fees in its setup: the node refuses a setup that does not,
so older clients are never charged fees they do not check. An abandoned
session gets no receipt; its charge shows in the balance.

The prover gets its job, including the traffic secret it proves about, on stdin; nothing
is written to disk. The same holds for `cu-2pc`, whose secrets come back on its
stdout control channel and are never logged.

What this does not cover: JavaScript cannot wipe memory reliably. The witness buffers
handed to the prover are zeroed after the write, but the session's traffic secrets
(`c_ap_1`, `s_ap_0`), the TLS library's keys and the decrypted response live in ordinary
JS objects until the garbage collector reclaims them, and may be in a heap snapshot or core
dump taken before then. `cu-prover` and `cu-2pc` are spawned with the parent's
environment (`process.env`), so they see every variable the client process has; run the
client with only the environment it needs, and use only prover and 2PC binaries you trust.

## Files

| File | What |
|---|---|
| `transport.ts` | the transport: offer check, framing choice and fallback, pinned body, the pooled request, streamed `Response`, SSE→JSON for non-stream callers |
| `connection.ts` | one connection, both framings: setup, arm, handshake, π_NK, requests, π_WIN, disclosures, attestation, receipt and deposit checks |
| `pool.ts` | the connection pool: reuse keys and scopes, idle and lifetime limits, armed spares, bad marks |
| `wire.ts` | shared types and helpers (TLS handle, receipt shape, waits, image response) |
| `twopc.ts` | `cu-2pc` runner: stdio frame codec, websocket bridge, version mismatch |
| `zkchan.ts` | the pre-warmed proof channel (`cu-prover --channel`) |
| `h2.ts`, `hpack-tables.ts` | HTTP/2 framing and HPACK decoding, the π_NK (framing "2") and π_WIN parameter checks |
| `offer.ts`, `hosts.ts`, `canonical.ts` | signed offer verification (v3, framings, connection terms), trusted-host wildcards, Schnorr/canonical JSON |
| `suffix.ts`, `receipt.ts`, `params.ts`, `advice.ts`, `prover.ts` | pinned chat suffix (rendered from the offer's `chat` block and held to the pin policy, routstr-confidential `docs/CHAT-SUFFIX.md`) and response parsing, receipt checks, π_NK ("1.1") / π_C3S parameter checks, byte helpers, `cu-prover` runner |
| `tls-fork/` | vendored `@reclaimprotocol/tls@0.1.4` (MIT) with the patches in `FORK-NOTES.md` |

Gate: `bun scripts/confidential-v3-e2e.ts <node> <sk-key> <model> [cases]`
(header of the script).
