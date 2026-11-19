import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "index.ts",
    "browser.ts",
    "node.ts",
    "bun.ts",
    "storage/index.ts",
    "storage/node.ts",
    "storage/bun.ts",
    "wallet/index.ts",
    "discovery/index.ts",
    "client/index.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "better-sqlite3",
    "bun:sqlite",
    "applesauce-sqlite",
    // Confidential-upstream TLS fork runtime deps: resolved from the consumer's
    // node_modules at runtime, never bundled.
    "@noble/ciphers",
    "@noble/curves",
    "@noble/hashes",
    "@peculiar/asn1-cms",
    "@peculiar/asn1-ecc",
    "@peculiar/asn1-rsa",
    "@peculiar/asn1-schema",
    "@peculiar/x509",
    "micro-rsa-dsa-dh",
  ],
  treeshake: true,
});
