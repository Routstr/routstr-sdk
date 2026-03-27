import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "index.ts",
    "storage/index.ts",
    "wallet/index.ts",
    "discovery/index.ts",
    "client/index.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["better-sqlite3", "bun:sqlite"],
  treeshake: true,
});
