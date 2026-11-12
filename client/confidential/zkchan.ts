/**
 * The proof channel: one long-lived `cu-prover --channel` process per
 * session, bridged to the node's `zkchan` websocket
 * (`/v1/confidential/zk?proof=zkchan`). The OT/VOLE setup of π_NK, π_WIN and
 * π_C3S (base OT → KOS → Ferret, ~1 MB and several round trips per proof on
 * the per-proof path) runs once, while the session is armed; each proof at
 * claim time then only runs QuickSilver over correlations that already exist.
 *
 * stdin/stdout carry the same `[channel u8][len u32 BE][payload]` frames as
 * cu-2pc: channel 0 is the proof protocol (relayed to and from the websocket),
 * channel 1 is control JSON (`ready`, `done`, `error` events; `prove`,
 * `verify`, `topup` and `close` commands). On a kept connection the chain is
 * topped up between requests (`topup`), so later proofs only consume. Witnesses travel to the process on stdin
 * only and are never logged.
 *
 * If the channel fails before any proof started on it, the session falls back
 * to the per-proof path (`CuProverBackend.run`); once a proof started on it, a
 * failure ends the session (the node aborts it as for any failed proof).
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProverError, ProverMissingError } from "./errors";
import { resolveProverPath, StdinBudget } from "./prover";
import {
  encodeTwoPcFrame,
  TWOPC_CHANNEL_CONTROL,
  TWOPC_CHANNEL_NET,
  TwoPcFrameDecoder,
  type TwoPcFrame,
  type TwoPcTiming,
} from "./twopc";

export interface ProofChannelOptions {
  /** Explicit path to cu-prover. */
  binaryPath?: string;
  /** Override the preallocated correlation counts (the smaller of the two sides' values is used). */
  prealloc?: { nk?: number; cp?: number };
  /** Injectable spawn (tests). */
  spawnImpl?: typeof nodeSpawn;
  /** Injectable WebSocket constructor (tests). */
  webSocketImpl?: typeof WebSocket;
}

export interface ProofChannelResult {
  proof: string;
  ok: boolean;
  checks?: { label: string; ok: boolean }[];
  /** Time inside cu-prover for this proof. */
  ms?: number;
  bytes_sent?: number;
  bytes_recv?: number;
  err?: string;
}

/** What one top-up did (PROTOCOL-V3.md §9.2). */
export interface ProofChannelTopup {
  /** The node granted a step and the chain was extended. */
  granted: boolean;
  /** Correlations on the proof chain before and after. */
  before: number;
  after: number;
  /** Bytes the top-up moved (both ways). */
  bytes: number;
  ms: number;
}

type Pending = { res: (m: ProofChannelResult) => void; rej: (e: Error) => void };

export class ProofChannel {
  readonly binary: string;
  /** Setup timings reported by cu-prover (hello, preprocess). */
  readonly timings: TwoPcTiming[] = [];
  readonly tStart = Date.now();
  tReady = 0;
  /** True once a proof was started on the channel: no per-proof fallback after that. */
  used = false;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly WS: typeof WebSocket;
  private readonly prealloc?: { nk?: number; cp?: number };
  /** Bytes on the proof-channel websocket, each way. */
  bytesSent = 0;
  bytesRecv = 0;
  /** Top-ups the node granted, in order. */
  readonly topups: ProofChannelTopup[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private ws?: WebSocket;
  private wsOpen = false;
  private outbox: Uint8Array[] = [];
  private decoder = new TwoPcFrameDecoder();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdinBudget = new StdinBudget();
  private failureErr: Error | undefined;
  private closed = false;
  private readyP: Promise<void>;
  private readyRes!: () => void;
  private readyRej!: (e: Error) => void;

  constructor(options: ProofChannelOptions = {}) {
    this.binary = resolveProverPath(options.binaryPath);
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.WS = options.webSocketImpl ?? WebSocket;
    this.prealloc = options.prealloc;
    this.readyP = new Promise<void>((res, rej) => {
      this.readyRes = res;
      this.readyRej = rej;
    });
    this.readyP.catch(() => {
      /* surfaced via ready() / failure */
    });
  }

  /** Spawn `cu-prover --channel` and connect it to the node's zkchan websocket. */
  start(url: string): void {
    const args = ["--channel"];
    if (this.prealloc?.nk) args.push("--prealloc-nk", String(this.prealloc.nk));
    if (this.prealloc?.cp) args.push("--prealloc-cp", String(this.prealloc.cp));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(this.binary, args, {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.fail(
        new ProverMissingError(
          `could not spawn cu-prover at ${this.binary}`,
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }
    this.child = child;
    child.on("error", (e) => this.fail(new ProverMissingError(`cu-prover at ${this.binary}: ${e.message}`)));
    child.on("close", (code) => {
      if (!this.closed) this.fail(new ProverError(`cu-prover --channel exited ${code}`));
    });
    child.stdin.on("error", () => {
      /* EPIPE after exit: reported via 'close' */
    });
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));

    const ws = new this.WS(url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.wsOpen = true;
      for (const b of this.outbox) ws.send(b);
      this.outbox.length = 0;
    };
    ws.onmessage = (ev: MessageEvent) => {
      const d = ev.data as ArrayBuffer | ArrayBufferView | string;
      if (typeof d === "string") {
        this.fail(new ProverError("proof channel websocket sent a text frame"));
        return;
      }
      const bytes =
        d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      this.bytesRecv += bytes.length;
      this.writeChild(TWOPC_CHANNEL_NET, bytes);
    };
    ws.onerror = () => this.fail(new ProverError("proof channel websocket error"));
    ws.onclose = () => {
      if (!this.closed) this.fail(new ProverError("proof channel websocket closed"));
    };
  }

  private writeChild(channel: number, payload: Uint8Array): void {
    if (!this.child || this.failureErr) return;
    try {
      if (!this.stdinBudget.write(this.child.stdin, encodeTwoPcFrame(channel, payload))) {
        this.fail(new ProverError(`cu-prover stdin: more than ${this.stdinBudget.limit} bytes not yet read`));
      }
    } catch (e) {
      this.fail(new ProverError(`cu-prover stdin: ${e instanceof Error ? e.message : e}`));
    }
  }

  private onStdout(chunk: Buffer): void {
    let frames: TwoPcFrame[];
    try {
      frames = this.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (e) {
      this.fail(e instanceof Error ? e : new ProverError(String(e)));
      return;
    }
    for (const f of frames) {
      if (f.channel === TWOPC_CHANNEL_NET) {
        this.bytesSent += f.payload.length;
        if (this.wsOpen && this.ws) this.ws.send(f.payload);
        else this.outbox.push(f.payload);
      } else if (f.channel === TWOPC_CHANNEL_CONTROL) {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(new TextDecoder().decode(f.payload));
        } catch {
          this.fail(new ProverError("cu-prover: bad control JSON"));
          return;
        }
        this.onControl(m);
      }
    }
  }

  private onControl(m: Record<string, unknown>): void {
    const ev = typeof m.ev === "string" ? m.ev : "";
    if (ev === "ready") {
      for (const t of (m.timings as TwoPcTiming[] | undefined) ?? []) this.timings.push(t);
      this.tReady = Date.now();
      this.readyRes();
    } else if (ev === "done") {
      const id = Number(m.id);
      const w = this.pending.get(id);
      if (w) {
        this.pending.delete(id);
        w.res(m as unknown as ProofChannelResult);
      }
    } else if (ev === "error") {
      this.fail(new ProverError(`cu-prover --channel: ${String(m.msg ?? "unknown error")}`));
    }
  }

  private fail(e: Error): void {
    if (this.failureErr) return;
    this.failureErr = e;
    this.readyRej(e);
    for (const w of this.pending.values()) w.rej(e);
    this.pending.clear();
    // Nothing more runs on this channel: drop the socket and the process now.
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
  }

  /** True once the process or its socket failed. */
  get failed(): boolean {
    return this.failureErr !== undefined;
  }

  get failure(): Error | undefined {
    return this.failureErr;
  }

  /** Waits for both correlation chains; false (never throws) if the channel failed or timed out. */
  async ready(ms = 120_000): Promise<boolean> {
    if (this.failureErr) return false;
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyP,
        new Promise<never>((_, rej) => {
          t = setTimeout(() => rej(new ProverError("proof channel not ready in time")), ms);
        }),
      ]);
      return !this.failureErr;
    } catch (e) {
      this.fail(e instanceof Error ? e : new ProverError(String(e)));
      return false;
    } finally {
      if (t) clearTimeout(t);
    }
  }

  /**
   * Run one proof on the channel: `verify` for π_NK (the node proves),
   * `prove` for π_WIN/π_C3S with the witness. Throws if it fails.
   */
  async run(
    cmd: "prove" | "verify",
    proof: string,
    params: unknown,
    witness?: unknown,
    ms = 60_000,
  ): Promise<ProofChannelResult> {
    if (this.failureErr) throw this.failureErr;
    this.used = true;
    const id = this.nextId++;
    const p = new Promise<ProofChannelResult>((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new ProverError(`proof channel: ${proof} timed out (${ms}ms)`));
      }, ms);
      this.pending.set(id, {
        res: (m) => {
          clearTimeout(t);
          res(m);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
    });
    const payload = new TextEncoder().encode(JSON.stringify({ cmd, id, proof, params, witness: witness ?? null }));
    this.writeChild(TWOPC_CHANNEL_CONTROL, payload);
    payload.fill(0);
    const m = await p;
    if (!m.ok) throw new ProverError(`proof channel: ${proof} failed: ${m.err ?? "unknown"}`);
    // A verification must report its checks, and every one must hold: an
    // empty list proves nothing.
    if (cmd === "verify" && (!m.checks?.length || !m.checks.every((c) => c.ok))) {
      throw new ProverError(`proof channel: ${proof} checks failed or none were reported`);
    }
    return m;
  }

  /**
   * Between requests on a kept connection: ask the node to top the proof
   * chain up to one more request's worth (PROTOCOL-V3.md §9.2). cu-prover runs
   * its commands in order, so a proof sent meanwhile waits for it. Resolves
   * undefined when there is nothing to do (no proof ran on the channel yet,
   * or it is closed); throws, and fails the channel, when the top-up fails.
   */
  async topup(ms = 60_000): Promise<ProofChannelTopup | undefined> {
    if (this.failureErr || this.closed || !this.used) return undefined;
    const id = this.nextId++;
    const m = await new Promise<ProofChannelResult & Partial<ProofChannelTopup>>((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new ProverError(`proof channel: top-up timed out (${ms}ms)`));
      }, ms);
      this.pending.set(id, {
        res: (r) => {
          clearTimeout(t);
          res(r);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
      this.writeChild(TWOPC_CHANNEL_CONTROL, new TextEncoder().encode(JSON.stringify({ cmd: "topup", id })));
    }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new ProverError(String(e));
      this.fail(err);
      throw err;
    });
    if (!m.ok) {
      const err = new ProverError(`proof channel: top-up failed: ${m.err ?? "unknown"}`);
      this.fail(err);
      throw err;
    }
    const done: ProofChannelTopup = {
      granted: m.granted === true,
      before: Number(m.before ?? 0),
      after: Number(m.after ?? 0),
      bytes: Number(m.bytes ?? 0),
      ms: Number(m.ms ?? 0),
    };
    if (done.granted) this.topups.push(done);
    return done;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeChild(TWOPC_CHANNEL_CONTROL, new TextEncoder().encode('{"cmd":"close"}'));
      this.child?.stdin.end();
    } catch {
      /* ignore */
    }
    // Let cu-prover flush its last bytes to the socket before it goes away.
    const t = setTimeout(() => {
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      try {
        this.child?.kill();
      } catch {
        /* ignore */
      }
    }, 500);
    (t as { unref?: () => void }).unref?.();
  }
}
