/**
 * wasm-worker verifier backend: runs the tlsn wasm verifier in a dedicated
 * Worker. This is upstream's supported architecture (Chrome via
 * harness/static). In Bun/JSC the wasm miscomputes proxy-tls preprocessing
 * intermittently — see STATUS.md M3 design fork; prefer the native backend
 * for routstrd.
 */

import type {
  TlsnBackendBeginParams,
  TlsnBackendSession,
  TlsnTranscriptOutput,
  TlsnVerifierBackend,
} from "../backend";

export interface WasmBackendOptions {
  /** Custom root certificates (DER) — defaults to Mozilla roots. */
  rootCerts?: number[][];
}

export class WasmWorkerBackend implements TlsnVerifierBackend {
  private readonly rootCerts?: number[][];

  constructor(options: WasmBackendOptions = {}) {
    this.rootCerts = options.rootCerts;
  }

  async begin(params: TlsnBackendBeginParams): Promise<TlsnBackendSession> {
    const worker = new Worker(new URL("../verifier.worker.ts", import.meta.url).href, {
      type: "module",
    });

    const wsUrl = `${params.proverWsBase}${params.proverWsBase.includes("?") ? "&" : "?"}session_id=${encodeURIComponent(params.sessionId)}`;

    let resolveReady!: (v: string) => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<string>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    let resolveOutput!: (v: TlsnTranscriptOutput) => void;
    let rejectOutput!: (e: Error) => void;
    const output = new Promise<TlsnTranscriptOutput>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });
    ready.catch(() => {});
    output.catch(() => {});

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as
        | { op: "ready"; serverName: string }
        | {
            op: "output";
            output: {
              server_name: string | undefined;
              transcript: { sent: number[]; recv: number[] } | undefined;
            };
          }
        | { op: "error"; message: string };
      if (msg.op === "ready") {
        resolveReady(msg.serverName);
      } else if (msg.op === "output") {
        resolveOutput({
          server_name: msg.output.server_name,
          transcript: msg.output.transcript
            ? {
                sent: new Uint8Array(msg.output.transcript.sent),
                recv: new Uint8Array(msg.output.transcript.recv),
              }
            : undefined,
        });
      } else if (msg.op === "error") {
        const error = new Error(msg.message);
        rejectReady(error);
        rejectOutput(error);
      }
    };
    worker.onerror = (ev) => {
      const error = new Error(`tlsn worker error: ${ev.message ?? "unknown"}`);
      rejectReady(error);
      rejectOutput(error);
    };

    worker.postMessage({
      op: "begin",
      id: 1,
      wsUrl,
      rootCerts: this.rootCerts,
      allowlist: params.allowlist,
      dialTo: params.dialTo,
      maxSentData: params.maxSentData,
      maxRecvData: params.maxRecvData,
    });

    return {
      ready,
      output,
      cancel: () => worker.terminate(),
    };
  }
}
