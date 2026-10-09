/**
 * `cu-prover` backend: spawn the Rust prover binary and bridge its stdio to a
 * ZK websocket (the node's `/v1/confidential/zk` proxy or the sidecar's `/zk`).
 *
 * Same shape as the TLSN native verifier backend
 * (`client/tlsn/backends/native.ts`): binary resolved from an env var, else a
 * repo-relative path, else PATH lookup. Ported from the prototype
 * `crypto/client/src/zkbridge.ts`, with an injectable spawn for tests.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProverError, ProverMissingError } from "./errors";

export const CU_PROVER_ENV_VARS = ["CU_PROVER_BIN", "CU_PROVER"] as const;

export interface ProverBackendOptions {
  /** Explicit path to the cu-prover binary. Highest precedence. */
  binaryPath?: string;
  /** Per-proof timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Injectable spawn (tests). */
  spawnImpl?: typeof nodeSpawn;
}

export interface ZkJob {
  proof: string;
  role: "prover" | "verifier";
  params: unknown;
  witness?: unknown;
}

/** Resolve the prover binary from env / repo-relative path / PATH. */
export function resolveProverPath(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof process !== "undefined" && process.env) {
    for (const key of CU_PROVER_ENV_VARS) {
      const v = process.env[key];
      if (v) return v;
    }
  }
  // Repo-relative build for development inside the monorepo.
  const dir = (import.meta as { dir?: string }).dir;
  if (dir) {
    return `${dir}/../../../../crypto/zkbench/target/release/cu-prover`;
  }
  return "cu-prover"; // PATH lookup
}

export class CuProverBackend {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly spawnImpl: typeof nodeSpawn;

  constructor(options: ProverBackendOptions = {}) {
    this.binary = resolveProverPath(options.binaryPath);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
  }

  get path(): string {
    return this.binary;
  }

  /**
   * Run one proof end-to-end: spawn cu-prover, hand it the job (params and
   * witness) as a length-prefixed frame on its stdin — the witness never
   * touches the disk — then pipe its stdout to the ZK websocket and the
   * websocket's bytes back to its stdin. Resolves only when the prover has
   * fully drained and exited 0.
   */
  async run(zkUrl: string, job: ZkJob, timeoutMs = this.timeoutMs): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(this.binary, ["--job-stdin", "--role", job.role], {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new ProverMissingError(
        `could not spawn cu-prover at ${this.binary}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const jobBytes = Buffer.from(
      JSON.stringify({ proof: job.proof, params: job.params, witness: job.witness ?? null }),
    );
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(jobBytes.length);
    child.stdin.write(Buffer.concat([lenPrefix, jobBytes]));
    jobBytes.fill(0);

    const ws = new WebSocket(zkUrl);
    ws.binaryType = "arraybuffer";
    const pending: Buffer[] = [];
    let wsOpen = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (wsOpen && ws.readyState === WebSocket.OPEN) ws.send(chunk);
      else pending.push(chunk);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProverError(`zk timeout (${timeoutMs}ms) for ${job.proof}`)),
          timeoutMs,
        );
        ws.onopen = () => {
          wsOpen = true;
          for (const chunk of pending) ws.send(chunk);
          pending.length = 0;
          ws.onmessage = (ev: MessageEvent) => {
            const data = ev.data as ArrayBuffer | ArrayBufferView;
            if (data instanceof ArrayBuffer) child.stdin.write(Buffer.from(data));
            else if (ArrayBuffer.isView(data)) {
              child.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
            }
          };
          ws.onerror = () => reject(new ProverError(`zk ws error for ${job.proof}`));
          ws.onclose = () => {
            try {
              child.stdin.end();
            } catch {
              /* ignore */
            }
          };
          child.on("close", (code) => {
            // 'close' (not 'exit') so all stdout is delivered before resolving;
            // resolving on 'exit' can drop the prover's final flush and stall
            // the peer's verifier (PROGRESS-CONFIDENTIAL Deviation 5).
            if (code === 0) resolve();
            else reject(new ProverError(`cu-prover exited ${code} for ${job.proof}`));
          });
          child.on("error", (err) => reject(new ProverError(String(err))));
        };
      });
    } finally {
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
