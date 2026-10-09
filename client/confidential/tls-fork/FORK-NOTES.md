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

## Security patches (TLS-01 … TLS-10)

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

## Runtime dependencies

Installed via `client/package.json`: `@noble/{ciphers,curves,hashes}`,
`@peculiar/{asn1-cms,asn1-ecc,asn1-rsa,asn1-schema,asn1-x509,x509}`, `micro-rsa-dsa-dh`.
The webcrypto provider is selected explicitly:

```ts
import { setCryptoImplementation } from '../vendor/tls/lib/crypto/index.js'
import { webcryptoCrypto } from '../vendor/tls/lib/crypto/webcrypto.js'
setCryptoImplementation(webcryptoCrypto)
```
