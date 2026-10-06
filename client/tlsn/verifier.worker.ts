/**
 * tlsn verifier worker: owns the wasm module and both IO channels.
 *
 * The tlsn wasm must run off the main thread (it uses Atomics.wait via
 * parking_lot's wasm backend and a rayon pool of nested workers; see
 * tlsn/crates/harness/static — upstream does the same via Comlink).
 *
 * Protocol (postMessage, structured clone):
 *   in:  {op: "begin", id, wsUrl, rootCerts?, allowlist?, dialTo?, maxSentData?, maxRecvData?}
 *   out: {op: "ready", id, serverName}
 *        {op: "output", id, output}   — verified VerifierOutput
 *        {op: "error", id, phase, message}
 *
 * After "begin" the worker autonomously runs: ws connect → setup → policy →
 * TCP dial → relay → verify, then posts "output".
 */

import { loadTlsnWasm } from "./wasm";
import { bunTcpDialer, webSocketIo } from "./io";

interface BeginMsg {
  op: "begin";
  id: number;
  wsUrl: string;
  rootCerts?: number[][];
  allowlist?: string[];
  dialTo?: { hostname: string; port: number };
  maxSentData?: number;
  maxRecvData?: number;
}

declare const self: {
  onmessage: ((ev: MessageEvent<BeginMsg>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

function toArrays(u8: Uint8Array): number[] {
  return Array.from(u8);
}

async function run(msg: BeginMsg): Promise<void> {
  const wasm = await loadTlsnWasm();

  const proverIo = await webSocketIo(msg.wsUrl);
  const verifier = new wasm.Verifier({
    max_sent_data: msg.maxSentData ?? 1 << 20,
    max_recv_data: msg.maxRecvData ?? 4 << 20,
    max_sent_records: undefined,
    max_recv_records_online: undefined,
    root_certs: msg.rootCerts,
  });
  await verifier.connect(proverIo);

  const serverName = await verifier.setup();
  if (!serverName) {
    throw new Error("prover requested MPC mode; only proxy mode is supported");
  }

  if (msg.allowlist && msg.allowlist.length > 0 && !msg.allowlist.includes(serverName)) {
    try {
      await proverIo.close();
    } catch {
      /* ignore */
    }
    throw new Error(
      `tlsn policy: upstream host ${serverName} not in allowlist [${msg.allowlist.join(", ")}]`
    );
  }

  self.postMessage({ op: "ready", id: msg.id, serverName });

  const target = msg.dialTo ?? { hostname: serverName, port: 443 };
  const serverIo = await bunTcpDialer(target.hostname, target.port);
  verifier.set_server_socket(serverIo);

  await verifier.run();
  const output = await verifier.verify();
  try {
    verifier.free();
  } catch {
    /* ignore */
  }

  self.postMessage({
    op: "output",
    id: msg.id,
    output: {
      server_name: output.server_name,
      transcript: output.transcript
        ? {
            sent: toArrays(new Uint8Array(output.transcript.sent)),
            recv: toArrays(new Uint8Array(output.transcript.recv)),
          }
        : undefined,
    },
  });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.op !== "begin") return;
  run(msg).catch((error) => {
    self.postMessage({
      op: "error",
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
