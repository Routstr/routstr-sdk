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

## What is checked

- The node's offer: Schnorr signature, pinned node key, protocol version and a
  trusted upstream host, under the caller's policy on every request.
- The provider: TLS 1.3 with full certificate-path and hostname validation in
  the vendored TLS stack.
- The proofs: π_N against the published template, and every parameter the
  node sends for π_C1/π_C2/π_C3 against the client's own records
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
is written to disk.

## Files

| File | What |
|---|---|
| `transport.ts` | the transport: offer check, pinned body, session, streamed `Response`, SSE→JSON for non-stream callers |
| `session.ts` | one session: handshake through the relay, π_C1/π_N/π_C2/π_C3, receipt check |
| `offer.ts`, `hosts.ts`, `canonical.ts` | signed offer verification, trusted-host wildcards, Schnorr/canonical JSON |
| `suffix.ts`, `receipt.ts`, `params.ts`, `advice.ts`, `prover.ts` | pinned suffix and π_N statement, receipt checks, proof-parameter checks, key-schedule material, `cu-prover` runner |
| `tls-fork/` | vendored `@reclaimprotocol/tls@0.1.4` (MIT) with the patches in `FORK-NOTES.md` |
