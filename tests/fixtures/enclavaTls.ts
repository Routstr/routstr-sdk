/**
 * Test-only TLS material for the loopback HTTPS server in
 * `tests/unit/enclavaTransport.test.ts`.
 *
 * This Ed25519 keypair and its self-signed certificate (CN
 * `enclava-fixture.invalid`, SAN `127.0.0.1`, valid to 2120) were generated for
 * this fixture and are used nowhere else. They are deliberately public: the
 * transport test needs a real TLS socket to assert that no paid bytes are
 * written before appraisal.
 *
 * Keep the pair in this module rather than as `.pem`/`.key` files: `.gitignore`
 * ignores `*.pem`, which silently dropped the certificate from the commit and
 * left the suite unable to load on a clean checkout.
 */

export const ENCLAVA_TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIIR956+erEfyFDeiKSJOC6u1J1fpSoMmhdvAfY/8YvmB
-----END PRIVATE KEY-----`;

export const ENCLAVA_TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBbDCCAR6gAwIBAgIUD7jKSZojx7AuZ1AFFAJNS7sytTwwBQYDK2VwMCIxIDAe
BgNVBAMMF2VuY2xhdmEtZml4dHVyZS5pbnZhbGlkMCAXDTIwMDEwMTAwMDAwMFoY
DzIxMjAwMTAxMDAwMDAwWjAiMSAwHgYDVQQDDBdlbmNsYXZhLWZpeHR1cmUuaW52
YWxpZDAqMAUGAytlcAMhAOKznn5R5zAaHni+4bQcVF6m7rxk1tE1V/xLOBY/rbx+
o2QwYjAdBgNVHQ4EFgQUrELZQPgHwKUek5/pSDF3SuiAxr8wHwYDVR0jBBgwFoAU
rELZQPgHwKUek5/pSDF3SuiAxr8wDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAG
hwR/AAABMAUGAytlcANBALtr5hlUYruEb3zhrmPoJwbbJPaEF2n0u3OOgvybnSWB
auI+f6xkm8pRswwHRzW4jnu2JP7aIMDznxp2ZGSLHwM=
-----END CERTIFICATE-----`;
