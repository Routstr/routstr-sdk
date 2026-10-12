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
    // twoPcPath: "/path/to/cu-2pc",        // v2 only; default: CU_2PC_BIN / CU_2PC, next to cu-prover, PATH
  },
});
```

Only `POST /v1/chat/completions` is supported; other endpoints are refused
before any credential or deposit. Only nodes whose `/v1/models` entry
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
decrypted response to disk. `ConfidentialSession`'s `insecureNoProofs` and
`allowUnsignedSettlement` are test hooks, refused unless the process sets
`ROUTSTR_CONFIDENTIAL_INSECURE_TESTING=1`.

## Protocol versions

The session follows the verified offer's `v`:

- **v1**: the client runs the TLS handshake alone (X25519) and discloses only
  the handshake traffic secrets; π_C1 proves the one-shot material for the
  node's credential record, π_N proves that record, π_C2/π_C3 anchor on the
  handshake values.
- **v2** (two-party handshake): the client and the node run the key schedule
  jointly with `cu-2pc` (spawned next to `cu-prover`, bridged to the node's
  `twopc` websocket), over a joint P-256 key share. The client gets c_hs/s_hs,
  s_ap_0 and c_ap_1 and never the node's epoch-0 key K_0; the node never gets
  the client's secrets. The node writes epoch 0 (credential + KeyUpdate) after
  π_NK, which the client verifies against the signed template and the hk
  anchor from its own 2PC output; π_C2S/π_C3S anchor on h1/h2. Receipts are
  checked exactly as in v1.

## Pre-warming (v2)

Most of a cold v2 request is the 2PC preprocessing (about 22 MB from the node
and 1.2 MB to it; about 7 s on a home link with a 2 Mbit/s uplink). Everything after the joint key share takes
about 2 s: the online 2PC, the handshake, π_NK, the body and π_C2S. A session
can be **armed** ahead of a request: `arm()` connects, sends the setup (the
node reserves funds), runs the 2PC preprocessing and the key share, and stops
before the ClientHello. `claim(body)` runs the rest. The sidecar dials the
provider only when the ClientHello arrives. The node ends a session 600 s
after accepting its websocket (the sidecar's own 600 s limit for an armed
session starts at setup, a little later), so an armed session must be claimed
before then. `run()` is `arm()` followed by `claim()`. v1 sessions are
never pooled.

Pass `confidential.prewarm` (`{}` = the defaults) to let `fetchConfidential`
keep a process-wide pool (`prewarm.ts`). It only reacts to traffic:

| Rule | Behaviour | Default |
|---|---|---|
| Pool key | (node, model, `max_tokens`, credential). `max_tokens` must match exactly because the suffix pins it | |
| No traffic, no arming | Nothing is armed at startup; a key with no request within `activityWindowMs` keeps no armed sessions | 10 min |
| `target(K)` | 1 while K is active; 2 after ≥ `burstCount` requests within `burstWindowMs`; at least the peak number of overlapping requests in the window; capped at `maxPerKey` | 3 in 5 min; max 6 |
| Global cap | `maxTotal` armed sessions, most recently active keys first (keep below the node's unused-sessions-per-address limit, default 12) | 6 |
| Arms | one in flight at a time (`maxConcurrentArms`). None starts while a cold request is still in its own preprocessing. Replenishing runs off the request path: after a warm claim, at a response head, at completion, and on a 15 s tick that runs only while some key has state | 1 |
| Body length | an armed session with length L serves any body ≤ L. The body is padded with spaces before the pinned suffix (valid JSON, and the suffix is still its own final record). L = max of the last `historySize` pinned bodies × `headroom`, rounded up to a power of two, between `minBucket` and `maxBucket`. A larger body goes cold and raises L, and smaller armed sessions are replaced | 20, ×1.25, 4 KiB to 8 MiB |
| Retire | close at `maxAgeMs` from setup (the node ends a session 600 s after its websocket accept); when K goes idle, close its sessions at once (the node releases each reservation; nothing is charged unless it has an abandon fee) | 480 s |
| Claim | the oldest healthy armed session that fits. If none is ready, an arm in progress is taken rather than starting a second preprocessing. If it fails before the credential record is released, the request runs on a fresh cold session. It is never retried after that point | |
| Failures | a failed arm backs the key off, `backoffBaseMs` doubling up to `backoffMaxMs` | 30 s to 10 min |
| Funds | each armed session holds a reservation on the credential: a full-context prompt plus `max_tokens` at the offer rates. A key arms only after one of its requests has settled (the receipt's `reserved_msats` is the estimate R), and only while `/v1/balance/info` shows an available balance ≥ `fundsHeadroom` × R: the new arm plus one cold request | ×2 |
| Abandon fee | a node may charge a fee for a session that ends without a request reaching the provider (`abandon_fee_msat` in its signed offer, at least `session_fee_msat`), so every armed session that is never used costs that fee. A key whose abandon fee (from the receipt, rechecked against the fresh offer before each arm) exceeds `maxSessionFeeMsat` is never armed (0 = never arm a node that charges one); otherwise such keys hold at most `maxArmedWithFee` armed sessions in total. Abandon fees paid for sessions retired unused are logged (`… abandon fee N msats paid`) and summed in `pool.unusedFeeMsats` | 5000 msats; 6 |

Pooling is skipped for one-off Cashu bearers (`returnChange`, xcashu mode)
and for v1 offers. The response carries `x-routstr-confidential-prewarmed:
1|0`. Pool events are logged at info level (`[confidential-prewarm]` arming,
armed, claim, retire, backoff) through `prewarm.log` (default
`console.info`). Logs never contain credentials. `closeConfidentialPrewarm()`
closes every armed session, for example on shutdown.

Available-balance accounting: while sessions are armed, the node's
`balance/info` reports the balance minus their reservations, so a client
that tops up to cover one request may top up earlier than without
pre-warming. Closing the pool releases the reservations.


**Proof channel.** Each v2 session (armed or cold) also opens one long-lived proof channel
(`/zk?proof=zkchan`, `cu-prover --channel`) that pre-generates the OT/VOLE correlations of all three
proofs while the session is being armed, so on the request path π_NK, π_C2S and π_C3S take tens to a few
hundred milliseconds instead of seconds. Correlations are fresh per session and used once; a failed proof
closes the channel. If the channel is unavailable (older node or prover), the session falls back to one
connection per proof. Options: `proofChannel` (default true), `proofChannelFactory`; timings in
`timings.proofs` and `timings.proofChannelReadyMs`. Measured against a production node: warm
requests reach the first token in about 2–3 s (mostly the provider; about 1 s for a session armed through
the handshake). Cold ones are dominated by receiving the ~22 MB of 2PC data: seconds on a fast connection,
about 14–16 s from a good home connection (100 Mbit/s down), about 45–70 s on a slow,
download-limited link.

## What is checked

- The node's offer: Schnorr signature, pinned node key, protocol version and a
  trusted upstream host, under the caller's policy on every request.
- The provider: TLS 1.3 with full certificate-path and hostname validation in
  the vendored TLS stack.
- The proofs: π_N (v1) / π_NK (v2) against the published template, and every
  parameter the node sends for π_C1/π_C2/π_C3 (v2: π_C2S/π_C3S) against the client's own records
  (`params.ts`), so the client only proves statements about data it chose to
  disclose. π_C2/π_C3 reveal one bit to the node, never plaintext.
- The attestation: the sidecar's record of the session (sid, certificate-chain
  hash, both handshake transcript hashes, record counts and the SHA-256 of all
  bytes in each direction, the credential-record commitment, the time), signed
  by the sidecar's per-process Ed25519 key and re-signed by the node's Nostr
  key. The client requires the node's signature and checks that the sid and
  both transcript hashes are its own (`checkAttestationBinding`).
- The receipt: required Schnorr signature over the exact signed bytes, this
  session's sid and attestation hash, the usage equal to the client's own
  plaintext, and a cost no higher than that usage at the signed offer's rates
  plus the offer's session fee (`maxChargeMsats`); a receipt naming larger
  fees than the signed ones is refused.

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

The prover gets its job, including the TLS handshake secret, on stdin; nothing
is written to disk. The same holds for `cu-2pc`, whose secrets come back on its
stdout control channel and are never logged.

## Files

| File | What |
|---|---|
| `transport.ts` | the transport: offer check, pinned body, session, streamed `Response`, SSE→JSON for non-stream callers |
| `session.ts` | one session: handshake through the relay, π_C1/π_N/π_C2/π_C3 (v1) or 2PC/π_NK/π_C2S/π_C3S (v2), receipt check |
| `twopc.ts` | `cu-2pc` runner (v2): stdio frame codec, websocket bridge |
| `prewarm.ts` | traffic-driven pool of armed v2 sessions, body-length buckets and padding |
| `offer.ts`, `hosts.ts`, `canonical.ts` | signed offer verification, trusted-host wildcards, Schnorr/canonical JSON |
| `suffix.ts`, `receipt.ts`, `params.ts`, `advice.ts`, `prover.ts` | pinned suffix and π_N statement, receipt checks, proof-parameter checks, key-schedule material, `cu-prover` runner |
| `tls-fork/` | vendored `@reclaimprotocol/tls@0.1.4` (MIT) with the patches in `FORK-NOTES.md` |
