import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoints = ["index.ts", "browser.ts", "client/index.ts"];
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, ""))
);

const result = await build({
  absWorkingDir: root,
  entryPoints,
  bundle: true,
  platform: "browser",
  format: "esm",
  conditions: ["browser"],
  mainFields: ["browser", "module", "main"],
  write: false,
  outdir: "browser-check",
  logLevel: "silent",
  plugins: [
    {
      name: "reject-node-builtins",
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const normalized = args.path.replace(/^node:/, "");
          if (normalized === "zlib") {
            return { path: join(root, "browser-zlib.ts") };
          }
          if (builtins.has(normalized)) {
            return {
              errors: [
                {
                  text: `Browser entrypoint depends on Node builtin: ${args.path}`,
                },
              ],
            };
          }
          return null;
        });
      },
    },
  ],
});

const bytes = result.outputFiles.reduce(
  (total, output) => total + output.contents.byteLength,
  0
);
console.log(
  `Browser bundle check passed for ${entryPoints.join(", ")} ` +
    `(${bytes} bytes, no Node builtins)`
);
