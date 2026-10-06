/**
 * Loader for the tlsn wasm package (built from the vendored workspace at
 * tlsn/crates/wasm/pkg via build.sh). Loading is lazy and cached; the
 * spawner/rayon initialization happens exactly once.
 *
 * Resolution order:
 *  1. `(globalThis as any).__TLSN_WASM_MODULE` — pre-imported module escape
 *     hatch for embedders that bundle the pkg themselves.
 *  2. `TLSN_WASM_PATH` env (Bun/Node) — path to tlsn_wasm.js.
 *  3. Repo-relative default (development inside provable-ai).
 */

export interface TlsnWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  initialize: (loggingConfig: unknown, threadCount: number) => Promise<void>;
  Verifier: new (config: {
    max_sent_data: number;
    max_recv_data: number;
    max_sent_records: number | undefined;
    max_recv_records_online: number | undefined;
    root_certs: number[][] | undefined;
  }) => TlsnWasmVerifier;
}

export interface TlsnWasmVerifier {
  connect(proverIo: unknown): Promise<void>;
  setup(): Promise<string | undefined>;
  set_server_socket(serverIo: unknown): void;
  run(): Promise<void>;
  verify(): Promise<TlsnWasmVerifierOutput>;
  finish(): Promise<void>;
  free(): void;
}

export interface TlsnWasmVerifierOutput {
  server_name: string | undefined;
  connection_info: unknown;
  transcript:
    | {
        sent: number[];
        sent_authed: { start: number; end: number }[];
        recv: number[];
        recv_authed: { start: number; end: number }[];
      }
    | undefined;
}

const REPO_RELATIVE = "../../../tlsn/crates/wasm/pkg/tlsn_wasm.js";

let modulePromise: Promise<TlsnWasmModule> | null = null;
let initPromise: Promise<void> | null = null;

export async function loadTlsnWasm(): Promise<TlsnWasmModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const injected = (globalThis as any).__TLSN_WASM_MODULE;
      if (injected) return injected as TlsnWasmModule;

      const envPath =
        typeof process !== "undefined" ? process.env?.TLSN_WASM_PATH : undefined;
      const specifier = envPath ?? REPO_RELATIVE;
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ specifier);
      } catch (error) {
        throw new Error(
          `tlsn wasm package not found at ${specifier} — build it with ` +
            `tlsn/crates/wasm/build.sh or set TLSN_WASM_PATH: ${String(error)}`
        );
      }

      // target=web init: default fetch-based init first, bytes fallback.
      try {
        await mod.default();
      } catch {
        const wasmUrl = specifier.replace(/tlsn_wasm\.js$/, "tlsn_wasm_bg.wasm");
        const Bun = (globalThis as any).Bun;
        if (!Bun?.file) throw new Error("tlsn wasm init failed and no Bun.file fallback");
        const bytes = await Bun.file(wasmUrl).arrayBuffer();
        await mod.default({ module_or_path: bytes });
      }

      if (!initPromise) {
        // One rayon thread. JSC (Bun) miscomputes proxy-tls preprocessing
        // intermittently with a multi-threaded pool (SPCOT consistency
        // failures on the prover); serial execution is reliable and the
        // latency cost is small at chat transcript sizes.
        const threads =
          typeof process !== "undefined" && process.env?.TLSN_WASM_THREADS
            ? parseInt(process.env.TLSN_WASM_THREADS, 10)
            : 1;
        initPromise = mod.initialize(undefined, threads);
      }
      await initPromise;
      return mod as TlsnWasmModule;
    })();
  }
  return modulePromise;
}
