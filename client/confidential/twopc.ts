/**
 * `cu-2pc` backend: the client side of the protocol v2 two-party handshake
 * (docs/TWOPC-DESIGN.md). Spawns the Rust `cu-2pc` binary and bridges it to
 * the node's `twopc` websocket (`/v1/confidential/zk?proof=twopc`).
 *
 * stdin/stdout carry frames `[channel u8][len u32 BE][payload]`: channel 0 is
 * the 2PC protocol (relayed to and from the websocket), channel 1 is control
 * JSON (`key_share`, `hs`, `ap`, `timing`, `error` events; `handshake` and
 * `app` commands). Nothing touches the disk; the secrets the process returns
 * (c_hs, s_hs, s_ap_0, c_ap_1) stay in this process and are never logged.
 *
 * Ported from the reference client `crypto/client/src/twopc.ts`, with the
 * binary resolved like `cu-prover` and an injectable spawn for tests.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fromHex, hex } from "./advice";
import { ProverError, ProverMissingError } from "./errors";
import { resolveProverPath } from "./prover";

export const CU_2PC_ENV_VARS = ["CU_2PC_BIN", "CU_2PC"] as const;

/** Largest frame accepted from cu-2pc (matches its own stdin limit). */
export const TWOPC_MAX_FRAME = 16 << 20;

export const TWOPC_CHANNEL_NET = 0;
export const TWOPC_CHANNEL_CONTROL = 1;

/**
 * Resolve the cu-2pc binary: explicit path, then `CU_2PC_BIN`/`CU_2PC`, then
 * next to the resolved `cu-prover` (they are built and shipped together),
 * else a PATH lookup.
 */
export function resolveTwoPcPath(explicit?: string, proverPath?: string): string {
  if (explicit) return explicit;
  if (typeof process !== "undefined" && process.env) {
    for (const key of CU_2PC_ENV_VARS) {
      const v = process.env[key];
      if (v) return v;
    }
  }
  const prover = proverPath ?? resolveProverPath();
  const slash = prover.lastIndexOf("/");
  if (slash >= 0) return `${prover.slice(0, slash + 1)}cu-2pc`;
  return "cu-2pc";
}

/** Encode one `[channel][len BE][payload]` frame. */
export function encodeTwoPcFrame(channel: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
    throw new RangeError(`bad 2PC channel ${channel}`);
  }
  if (payload.length > TWOPC_MAX_FRAME) throw new RangeError("2PC frame too large");
  const out = new Uint8Array(5 + payload.length);
  out[0] = channel;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

export interface TwoPcFrame {
  channel: number;
  payload: Uint8Array;
}

/** Incremental decoder for the cu-2pc stdout stream (frames may split or batch). */
export class TwoPcFrameDecoder {
  private buf = new Uint8Array(0);

  /** Feed bytes; returns every frame completed so far. Throws on an oversized frame. */
  push(chunk: Uint8Array): TwoPcFrame[] {
    if (chunk.length) {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const frames: TwoPcFrame[] = [];
    let off = 0;
    while (this.buf.length - off >= 5) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + off + 1, 4).getUint32(0, false);
      if (len > TWOPC_MAX_FRAME) throw new ProverError(`cu-2pc frame too large (${len} bytes)`);
      if (this.buf.length - off < 5 + len) break;
      frames.push({ channel: this.buf[off]!, payload: this.buf.slice(off + 5, off + 5 + len) });
      off += 5 + len;
    }
    if (off) this.buf = this.buf.slice(off);
    return frames;
  }

  /** Bytes buffered but not yet a whole frame. */
  get pending(): number {
    return this.buf.length;
  }
}

export interface TwoPcHandshakeSecrets {
  clientHs: Uint8Array;
  serverHs: Uint8Array;
}

export interface TwoPcApplicationSecrets {
  /** s_ap_0: the response epoch (never known to the node). */
  serverAp0: Uint8Array;
  /** c_ap_1: our body epoch (never known to the node). */
  clientAp1: Uint8Array;
  /** Public anchors: SHA256(c_ap_1), SHA256(s_ap_0), SHA256(K_0 ‖ IV_0). */
  h1: Uint8Array;
  h2: Uint8Array;
  hk: Uint8Array;
}

export interface TwoPcTiming {
  step: string;
  ms: number;
  bytes_sent?: number;
  bytes_recv?: number;
}

export interface TwoPcOptions {
  /** Explicit path to cu-2pc. */
  binaryPath?: string;
  /** cu-prover path, to find cu-2pc next to it. */
  proverPath?: string;
  /** Injectable spawn (tests). */
  spawnImpl?: typeof nodeSpawn;
  /** Injectable WebSocket constructor (tests). */
  webSocketImpl?: typeof WebSocket;
}

type Waiter = { res: (m: Record<string, unknown>) => void; rej: (e: Error) => void };

function hexField(m: Record<string, unknown>, key: string, len: number): Uint8Array {
  const v = m[key];
  if (typeof v !== "string" || v.length !== len * 2 || !/^[0-9a-fA-F]*$/.test(v)) {
    throw new ProverError(`cu-2pc: bad ${key}`);
  }
  return fromHex(v);
}

/** One 2PC run: preprocessing + key share, phase A (handshake), phase B (application). */
export class TwoPcSession {
  readonly binary: string;
  readonly timings: TwoPcTiming[] = [];
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly WS: typeof WebSocket;
  private child?: ChildProcessWithoutNullStreams;
  private ws?: WebSocket;
  private wsOpen = false;
  private outbox: Uint8Array[] = [];
  private decoder = new TwoPcFrameDecoder();
  private waiters = new Map<string, Waiter>();
  private queued = new Map<string, Record<string, unknown>>();
  private failureErr: Error | undefined;
  private closed = false;
  /** Phase B delivered: the node closing the 2PC socket afterwards is normal. */
  private done = false;

  constructor(options: TwoPcOptions = {}) {
    this.binary = resolveTwoPcPath(options.binaryPath, options.proverPath);
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.WS = options.webSocketImpl ?? WebSocket;
  }

  /** Spawn cu-2pc and connect it to the node's twopc websocket. */
  start(url: string): void {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(this.binary, [], {
        stdio: ["pipe", "pipe", "inherit"],
        env: process.env,
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new ProverMissingError(
        `could not spawn cu-2pc at ${this.binary}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.child = child;
    child.on("error", (e) => this.fail(new ProverMissingError(`cu-2pc at ${this.binary}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !this.closed) this.fail(new ProverError(`cu-2pc exited ${code}`));
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
        this.fail(new ProverError("2PC websocket sent a text frame"));
        return;
      }
      const bytes =
        d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      this.writeChild(TWOPC_CHANNEL_NET, bytes);
    };
    ws.onerror = () => this.fail(new ProverError("2PC websocket error"));
    ws.onclose = () => {
      // Before phase B a closed socket is a failure even with nothing waiting
      // (an armed session idles between the key share and the handshake).
      if (!this.closed && !this.done) this.fail(new ProverError("2PC websocket closed"));
    };
  }

  private writeChild(channel: number, payload: Uint8Array): void {
    try {
      this.child?.stdin.write(encodeTwoPcFrame(channel, payload));
    } catch (e) {
      this.fail(new ProverError(`cu-2pc stdin: ${e instanceof Error ? e.message : e}`));
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
        if (this.wsOpen && this.ws) this.ws.send(f.payload);
        else this.outbox.push(f.payload);
      } else if (f.channel === TWOPC_CHANNEL_CONTROL) {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(new TextDecoder().decode(f.payload));
        } catch {
          this.fail(new ProverError("cu-2pc: bad control JSON"));
          return;
        }
        this.onControl(m);
      }
    }
  }

  private onControl(m: Record<string, unknown>): void {
    const ev = typeof m.ev === "string" ? m.ev : "";
    if (ev === "timing") {
      this.timings.push({
        step: String(m.step),
        ms: Number(m.ms),
        bytes_sent: m.bytes_sent as number | undefined,
        bytes_recv: m.bytes_recv as number | undefined,
      });
      return;
    }
    if (ev === "error") {
      this.fail(new ProverError(`cu-2pc: ${String(m.msg ?? "unknown error")}`));
      return;
    }
    if (ev === "ap") this.done = true;
    const w = this.waiters.get(ev);
    if (w) {
      this.waiters.delete(ev);
      w.res(m);
    } else this.queued.set(ev, m);
  }

  private fail(e: Error): void {
    if (this.failureErr) return;
    this.failureErr = e;
    for (const w of this.waiters.values()) w.rej(e);
    this.waiters.clear();
  }

  private wait(ev: string, ms: number): Promise<Record<string, unknown>> {
    if (this.failureErr) return Promise.reject(this.failureErr);
    const q = this.queued.get(ev);
    if (q) {
      this.queued.delete(ev);
      return Promise.resolve(q);
    }
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiters.delete(ev);
        rej(new ProverError(`timeout waiting for 2PC ${ev}`));
      }, ms);
      this.waiters.set(ev, {
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
  }

  private command(cmd: Record<string, unknown>): void {
    if (this.failureErr) throw this.failureErr;
    this.writeChild(TWOPC_CHANNEL_CONTROL, new TextEncoder().encode(JSON.stringify(cmd)));
  }

  /** Preprocessing plus the commit-then-open joint key share P = P_C + P_N (65-byte SEC1). */
  async keyShare(ms = 120_000): Promise<Uint8Array> {
    const m = await this.wait("key_share", ms);
    return hexField(m, "p", 65);
  }

  /** ECtF + phase A: the handshake traffic secrets. */
  async handshake(serverShare: Uint8Array, thSH: Uint8Array, ms = 15_000): Promise<TwoPcHandshakeSecrets> {
    this.command({ cmd: "handshake", s: hex(serverShare), th_sh: hex(thSH) });
    const m = await this.wait("hs", ms);
    return { clientHs: hexField(m, "c_hs", 32), serverHs: hexField(m, "s_hs", 32) };
  }

  /** Phase B: s_ap_0 and c_ap_1 for us; h1, h2, hk public. */
  async application(thSF: Uint8Array, ms = 30_000): Promise<TwoPcApplicationSecrets> {
    this.command({ cmd: "app", th_sf: hex(thSF) });
    const m = await this.wait("ap", ms);
    return {
      serverAp0: hexField(m, "s_ap_0", 32),
      clientAp1: hexField(m, "c_ap_1", 32),
      h1: hexField(m, "h1", 32),
      h2: hexField(m, "h2", 32),
      hk: hexField(m, "hk", 32),
    };
  }

  /** True once the 2PC process or its socket failed. */
  get failed(): boolean {
    return this.failureErr !== undefined;
  }

  get failure(): Error | undefined {
    return this.failureErr;
  }

  close(): void {
    this.closed = true;
    try {
      this.child?.stdin.end();
    } catch {
      /* ignore */
    }
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
}
