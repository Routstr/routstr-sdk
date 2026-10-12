# Fork notes: `client/confidential/tls-fork`

Vendored from `@reclaimprotocol/tls@0.1.4` (`npm pack @reclaimprotocol/tls@0.1.4`).
The published tarball ships compiled JS in `lib/`; the patches below are applied
directly to the compiled `lib/` files and marked in-source with `// FORK PATCH`.

> **Licence: MIT** (CreatorOS Inc., text in `LICENSE` next to this file, from
> the upstream repository). The published package declares `"license": "See License in
> <https://github.com/reclaimprotocol/.github/blob/main/LICENSE>"` and ships no
> LICENSE file; the upstream repository licence (MIT) governs.

## Protocol hooks (six, all in `lib/make-tls-client.js`)

1. **Export the TLS 1.3 handshake traffic secrets.**
   `let handshakeSecrets` captures the `secretType: 'hs'` key set in
   `processServerPubKey`; a new `getHandshakeSecrets()` returns it (`masterSecret`
   = HS, `clientSecret` = client_hs, `serverSecret` = server_hs).

2. **Export the raw handshake messages.** New `getHandshakeMessages()` returns
   `handshakeMsgs.slice()`, so the driver can compute `th_SH = SHA256(CH‖SH)` and
   `th_SF = SHA256(CH‖SH‖EE‖Cert‖CV‖SFin)` itself.

3. **`skipSendSequence(n)`.** Advances `recordSendCount` (the node's credential
   record occupies epoch-1 sequence 0, so the client's KeyUpdate is seq 1).

4. **`updateTrafficKeysSilently()`.** `writeEncryptedPacket` is split into
   `sealEncryptedRecord(opts)` (returns `{header, content}` without writing) and
   `writeEncryptedPacket` (seals, writes, increments the counter). The new
   `updateTrafficKeysSilently` seals a KeyUpdate *without* sending it and rotates
   the traffic keys exactly as `updateTrafficKeys()` does.

5. **Transport injection, cipher suite, ALPN, key share, tickets.** No code change:
   the client is already driven by `write`/`onRead`/`handleReceivedBytes`. The
   driver passes `cipherSuites: ['TLS_AES_128_GCM_SHA256']`,
   `supportedProtocolVersions: ['TLS1_3']`, `namedCurves: ['X25519']`,
   `applicationLayerProtocols: ['http/1.1']`, and never requests a session ticket
   (the library throws on HelloRetryRequest, so a single key share is enforced).
   The ServerHello's version and suite are checked against these lists (TLS-01 below).

6. **Native advice helpers.** Implemented in `client/src/advice.ts` (node:crypto),
   not in the fork: HKDF-Expand-Label, `traffic upd`, AES-128-ECB keystream,
   `H1 = AES_K1(0)`, `T0 = AES_K1(J0)`, GHASH key. The driver asserts
   `advice.c_ap_1 === fork.getKeys().clientSecret` on every run, cross-checking the
   fork against `cu-crypto` at runtime (and the fixtures cross-check it offline).

## Protocol v2 hook: external key schedule

Marked `// FORK PATCH (v2)` (`lib/make-tls-client.js`, `lib/utils/client-hello.js`,
types in `lib/types/tls.d.ts`, `lib/make-tls-client.d.ts`, `lib/utils/client-hello.d.ts`).
Mirrored byte for byte from the reference client (`crypto/client/vendor/tls`).
Opt-in via the `external` option; without it the client behaves exactly as
before (protocol v1). Used by `session.ts` for v2 offers (docs/TWOPC-DESIGN.md).

```ts
external: {
  keyShare: Uint8Array,  // 65-byte uncompressed P-256 point (a_C + a_N)·G
  onServerHello(serverShare: Uint8Array /*65 B*/, thSH: Uint8Array): Promise<{ clientHs, serverHs }>,
  onServerFinished(thSF: Uint8Array): Promise<{ serverAp0, clientAp1 }>,
}
```

- ClientHello: one cipher suite (default `TLS_AES_128_GCM_SHA256`; any other
  configuration than one TLS 1.3 SHA-256 suite, TLS 1.3 only, throws),
  `supported_groups` = [secp256r1], one key share (the given point, checked on
  the curve), no `pre_shared_key`/`early_data`, and no `psk_key_exchange_modes`
  (so the server sends no NewSessionTicket). A PSK in `startHandshake` throws.
- ServerHello: a HelloRetryRequest (HRR random) is rejected; the server must
  pick TLS 1.3, secp256r1 and no PSK. No ECDHE is computed: `onServerHello`
  gets the server share and th_SH = SHA-256(CH‖SH), and c_hs/s_hs are installed.
- The server flight is verified as before (chain, hostname, CertificateVerify,
  server Finished under s_hs); the client Finished is sent under c_hs; then
  `onServerFinished(th_SF)` (th_SF = SHA-256(CH‖…‖server Finished)) and the
  client installs s_ap_0 (read, seq 0) and c_ap_1 (write, seq 0), then fires
  `onHandshake`. HS/MS are never computed locally (`getHandshakeSecrets().masterSecret`
  is `undefined`); client certificates are refused.
- `getTranscriptHashes()` returns `{ thSH, thSF }`.

## Security patches (TLS-01 … TLS-14)

Marked in-source with `// FORK PATCH (TLS-xx)`. The `.js` files are
identical in the SDK fork (`routstr-sdk/client/confidential/tls-fork`) and the
reference client (`crypto/client/vendor/tls`); only `.d.ts` import extensions differ.

- **TLS-01, version and suite** (`make-tls-client.js`, `assertOfferedVersionAndSuite`).
  The ServerHello must select a version in `supportedProtocolVersions` and a
  cipher suite in `cipherSuites` (each defaults to everything the library
  supports when not given), and the suite must belong to that version.
  Otherwise the handshake fails.
- **TLS-02, certificate path validation** (`utils/parse-certificate.js`
  `verifyCertificateChain`/`buildPath`/`checkIssuer`/`checkNameConstraints`;
  accessors in `utils/x509.js`). RFC 5280 checks: every certificate in the
  path is within validity and has no critical extension other than
  basicConstraints, keyUsage, extendedKeyUsage, subjectAltName and
  nameConstraints. Every issuer, trust anchors included, has
  basicConstraints CA:TRUE and must honour pathLenConstraint. If keyUsage is
  present it must include keyCertSign. If extendedKeyUsage is present it must
  include serverAuth or anyExtendedKeyUsage. The leaf's extendedKeyUsage, if
  present, must include serverAuth or anyExtendedKeyUsage.
  nameConstraints are enforced for dNSName (against the SAN dNSNames of every
  certificate below the constraining CA and the hostname) and for
  directoryName (subject prefix). A constraint of any other name type rejects
  the path if names of that type appear below the CA. Path building
  backtracks over every candidate issuer (trust anchors first) and is bounded
  by 8 certificates and 64 attempts. Root-store entries without CA:TRUE are
  ignored, whether bundled, from `TLS_ADDITIONAL_ROOT_CA_LIST` or passed as
  `rootCAs`. The non-CA `connect.dca.ca.gov` entry was removed from
  `utils/additional-root-cas.js`. nameConstraints are decoded with
  `@peculiar/asn1-x509`, a direct dependency.
- **TLS-04, hostname matching** (`matchHostname`). Follows RFC 6125. If the
  leaf has SAN dNSNames, only those are matched; CN is used only when there
  are none. Matching is case-insensitive and one trailing dot is stripped.
  `*` matches only as the whole leftmost label, matches exactly one label,
  and needs at least two labels after it, so `*.x.y` does not match `x.y`.
- **TLS-05, nonces** (`utils/generics.js` `generateIV`/`packRecordSequence`;
  `utils/wrapped-record.js`). The full 64-bit big-endian sequence number is
  XORed into the IV, and the TLS 1.2 explicit nonce and MAC header also carry
  all 64 bits. A sequence number above 2^48 (`MAX_RECORD_SEQUENCE_NUMBER`) or
  that is not a non-negative safe integer throws, and the record is neither
  sealed nor opened.
- **TLS-06, constant-time compare** (`areUint8ArraysEqualConstantTime`). Used for
  the TLS 1.3 and TLS 1.2 Finished checks and the TLS 1.2 record MAC.
- **TLS-07, extensions** (`utils/parse-extensions.js`). Types are read as
  16-bit values, a repeated extension type aborts parsing, and unknown types
  are skipped.
- **TLS-08, KeyUpdate** (`make-tls-client.js`). A received KeyUpdate is
  accepted only after the TLS 1.3 handshake, with a 1-byte body of 0 or 1.
  `update_requested` (1) is a protocol error that ends the client. There is no
  automatic response, because the client's epoch accounting (KU0/KU1) is fixed
  by the protocol. With 0, the server keys rotate as before.
- **TLS-09, AIA** (`verifyCertificateChain`). Issuer certificates are fetched
  from AIA only when the caller passes `fetchCertificateBytes`. By default,
  as in this SDK, the chain must be complete from the server-sent
  intermediates and the root store.
- **TLS-10, record errors** (`make-tls-client.js` `processPacketUnsafe`). Any
  failure while processing a received record (decryption, parsing,
  validation, alerts aside) marks the client ended at once, so queued records
  are dropped, and calls `end(err)`. `handleReceivedBytes()` and
  `handleReceivedPacket()` then reject with that error.
- **TLS-11, server flight order and CertificateVerify** (`make-tls-client.js`
  `processRecord`, `processServerFinish`). The TLS 1.3 server flight must be
  ServerHello, EncryptedExtensions, Certificate, CertificateVerify, Finished,
  each once; after the handshake only NewSessionTicket and KeyUpdate are
  accepted. Finished is accepted only after a CertificateVerify over the
  verified chain succeeded (unless a PSK is in use). Before this patch the
  Finished check required only that a chain had been validated, so a flight
  without CertificateVerify, or with a second Certificate message carrying
  the attacker's own certificate after the validated one, passed: anyone who
  knew the ECDHE secret (in protocol v2, the node, by answering the
  ClientHello itself) could impersonate the provider to the client.
- **TLS-12, record padding** (`make-tls-client.js` `processPacketInner`). The
  TLS 1.3 inner content type is the last non-zero byte of the plaintext
  (RFC 8446 §5.4); trailing zero padding is stripped, and a record whose inner
  type is unknown, or that has no content type, ends the client instead of
  being delivered as application data.
- **TLS-13, root store** (`utils/mozilla-root-cas.js`, `utils/additional-root-cas.js`).
  The bundled roots are generated by `crypto/tools/gen-client-roots.py` from
  the `webpki-roots` version pinned in `crypto/Cargo.lock`, the node's own
  root store, so client and node trust the same set. Upstream's four
  intermediate CA certificates used as extra trust anchors were removed.
- **TLS-14, leaf keyUsage** (`utils/parse-certificate.js`
  `verifyCertificateChain`). The leaf key signs the CertificateVerify, so a
  leaf keyUsage extension, if present, must include digitalSignature
  (RFC 8446 §4.4.2.2).

Not done: revocation. Neither this client nor the sidecar (rustls/webpki
with no CRLs) checks CRLs or OCSP; a revoked but unexpired provider
certificate is accepted by both, until it expires.

## Runtime dependencies

Installed via `client/package.json`: `@noble/{ciphers,curves,hashes}`,
`@peculiar/{asn1-cms,asn1-ecc,asn1-rsa,asn1-schema,asn1-x509,x509}`, `micro-rsa-dsa-dh`.
The webcrypto provider is selected explicitly:

```ts
import { setCryptoImplementation } from '../vendor/tls/lib/crypto/index.js'
import { webcryptoCrypto } from '../vendor/tls/lib/crypto/webcrypto.js'
setCryptoImplementation(webcryptoCrypto)
```
