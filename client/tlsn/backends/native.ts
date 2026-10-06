/**
 * Native-binary verifier backend (Bun/Node): spawns the `tlsn-verifier`
 * Rust binary from the proverd repo per session and parses its progress.
 *
 * This is the reliable backend for routstrd: the tlsn wasm verifier is only
 * upstream-tested in real Chrome workers and miscomputes proxy-tls
 * preprocessing in Bun/JSC (see STATUS.md, M3 design fork).
 *
 * Binary resolution: `binaryPath` option, else TLSN_VERIFIER_BIN env, else
 * the repo-relative debug build.
 */

import type {
  TlsnBackendBeginParams,
  TlsnBackendSession,
  TlsnVerifierBackend,
} from "../backend";

export interface NativeBackendOptions {
  binaryPath?: string;
  /** Extra root certificates as PEM file paths (fixtures/self-signed). */
  rootCertPemFiles?: string[];
}

function defaultBinaryPath(): string {
  const env =
    typeof process !== "undefined" ? process.env?.TLSN_VERIFIER_BIN : undefined;
  if (env) return env;
  // Repo-relative debug build (development inside provable-ai).
  const dir = (import.meta as { dir?: string }).dir;
  if (dir) {
    return `${dir}/../../../../proverd/target/debug/tlsn-verifier`;
  }
  return "tlsn-verifier"; // PATH lookup
}

export class NativeVerifierBackend implements TlsnVerifierBackend {
  private readonly binary: string;
  private readonly rootCertPemFiles: string[];

  constructor(options: NativeBackendOptions = {}) {
    this.binary = options.binaryPath ?? defaultBinaryPath();
    this.rootCertPemFiles = options.rootCertPemFiles ?? [];
  }

  async begin(params: TlsnBackendBeginParams): Promise<TlsnBackendSession> {
    const Bun = (globalThis as any).Bun;
    if (!Bun?.spawn) {
      throw new Error("NativeVerifierBackend requires Bun.spawn (Bun runtime)");
    }
    const upstream = params.dialTo;
    if (!upstream) {
      throw new Error(
        "NativeVerifierBackend requires dialTo (no DNS resolution yet — see STATUS.md)"
      );
    }

    const [fs, os, path] = await Promise.all([
      import("node:fs"),
      import("node:os"),
      import("node:path"),
    ]);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlsn-verifier-"));
    const transcriptPath = path.join(outDir, "transcript.json");

    const wsUrl = `${params.proverWsBase}${params.proverWsBase.includes("?") ? "&" : "?"}session_id=${encodeURIComponent(params.sessionId)}`;
    const args = [
      this.binary,
      "--proverd", wsUrl,
      "--upstream", `${upstream.hostname}:${upstream.port}`,
      "--transcript-out", transcriptPath,
    ];
    for (const pem of this.rootCertPemFiles) {
      args.push("--root-cert-pem", pem);
    }

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stderrChunks: string[] = [];
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrChunks.push(new TextDecoder().decode(value));
      }
    })();

    let resolveReady!: (v: string) => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<string>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    let resolveOutput!: (v: TlsnBackendSession["output"] extends Promise<infer T> ? T : never) => void;
    let rejectOutput!: (e: Error) => void;
    const output = new Promise<any>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });
    ready.catch(() => {});
    output.catch(() => {});

    let readySeen = false;
    (async () => {
      let buffer = "";
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.startsWith("READY ")) {
            readySeen = true;
            const serverName = line.slice(6).trim();
            if (
              params.allowlist &&
              params.allowlist.length > 0 &&
              !params.allowlist.includes(serverName)
            ) {
              const error = new Error(
                `tlsn policy: upstream host ${serverName} not in allowlist [${params.allowlist.join(", ")}]`
              );
              proc.kill();
              rejectReady(error);
              rejectOutput(error);
              return;
            }
            resolveReady(serverName);
          }
        }
      }
    })();

    void (async () => {
      const code = await proc.exited;
      if (code !== 0) {
        const error = new Error(
          `tlsn-verifier exited ${code}: ${stderrChunks.join("").slice(-400)}`
        );
        if (!readySeen) rejectReady(error);
        rejectOutput(error);
        return;
      }
      try {
        const json = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
        const sent = Uint8Array.from(atob(json.sent_b64), (c) => c.charCodeAt(0));
        const recv = Uint8Array.from(atob(json.recv_b64), (c) => c.charCodeAt(0));
        resolveOutput({ server_name: json.server_name, transcript: { sent, recv } });
      } catch (error) {
        rejectOutput(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return {
      ready,
      output,
      cancel: () => {
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
      },
    };
  }
}
