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
  external: ["better-sqlite3", "bun:sqlite", "applesauce-sqlite"],
  treeshake: true,
});
