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

## What is checked

- The node's offer: Schnorr signature, pinned node key, protocol version and a
  trusted upstream host, under the caller's policy on every request.
- The provider: TLS 1.3 with full certificate-path and hostname validation in
  the vendored TLS stack.
- The proofs: π_N (v1) / π_NK (v2) against the published template, and every
  parameter the node sends for π_C1/π_C2/π_C3 (v2: π_C2S/π_C3S) against the client's own records
  (`params.ts`), so the client only proves statements about data it chose to
  disclose. π_C2/π_C3 reveal one bit to the node, never plaintext.
- The receipt: required Schnorr signature over the exact signed bytes, this
  session's sid and attestation, the usage equal to the client's own
  plaintext, and a cost no higher than that usage at the signed offer's rates.

A non-streaming call fails if any check after the response fails; a stream
ends with an error instead of a clean end. On an upstream HTTP error the node
learns only the status line and headers (the body stays private); 4xx and
503 cost nothing. The node reserves a full-context prompt plus the pinned
completion cap at the offer's rates, so the client deposits for that.

The prover gets its job, including the TLS handshake secret, on stdin; nothing
is written to disk. The same holds for `cu-2pc`, whose secrets come back on its
stdout control channel and are never logged.

## Files

| File | What |
|---|---|
| `transport.ts` | the transport: offer check, pinned body, session, streamed `Response`, SSE→JSON for non-stream callers |
| `session.ts` | one session: handshake through the relay, π_C1/π_N/π_C2/π_C3 (v1) or 2PC/π_NK/π_C2S/π_C3S (v2), receipt check |
| `twopc.ts` | `cu-2pc` runner (v2): stdio frame codec, websocket bridge |
| `offer.ts`, `hosts.ts`, `canonical.ts` | signed offer verification, trusted-host wildcards, Schnorr/canonical JSON |
| `suffix.ts`, `receipt.ts`, `params.ts`, `advice.ts`, `prover.ts` | pinned suffix and π_N statement, receipt checks, proof-parameter checks, key-schedule material, `cu-prover` runner |
| `tls-fork/` | vendored `@reclaimprotocol/tls@0.1.4` (MIT) with the patches in `FORK-NOTES.md` |
