/**
 * Protocol v2 proof channel (`cu-prover --channel` bridge) against a fake
 * process and a fake websocket: relaying, ready, proof commands and results,
 * failure handling (the session falls back only before the first proof).
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { encodeTwoPcFrame, TwoPcFrameDecoder } from "../../client/confidential/twopc";
import { ProofChannel } from "../../client/confidential/zkchan";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeChannel(prealloc?: { nk?: number; cp?: number }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => true });
  let spawnArgs: string[] = [];
  const fromClient = new TwoPcFrameDecoder();
  const controlIn: Record<string, unknown>[] = [];
  const netIn: Uint8Array[] = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const f of fromClient.push(new Uint8Array(chunk))) {
      if (f.channel === 1) controlIn.push(JSON.parse(new TextDecoder().decode(f.payload)));
      else netIn.push(f.payload);
    }
  });
  const sent: Uint8Array[] = [];
  class FakeWs {
    static last: FakeWs;
    binaryType = "";
    onopen?: () => void;
    onmessage?: (ev: { data: unknown }) => void;
    onerror?: () => void;
    onclose?: () => void;
    constructor(readonly url: string) {
      FakeWs.last = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(b: Uint8Array) {
      sent.push(new Uint8Array(b));
    }
    close() {}
  }
  const emit = (ch: number, payload: Uint8Array | string) =>
    stdout.write(encodeTwoPcFrame(ch, typeof payload === "string" ? new TextEncoder().encode(payload) : payload));
  const chan = new ProofChannel({
    binaryPath: "/fake/cu-prover",
    prealloc,
    spawnImpl: ((_bin: string, args: string[]) => {
      spawnArgs = args;
      return child;
    }) as never,
    webSocketImpl: FakeWs as never,
  });
  return { chan, child, emit, controlIn, netIn, sent, FakeWs, args: () => spawnArgs };
}

describe("proof channel bridge (v2)", () => {
  it("spawns cu-prover --channel, relays bytes, reports ready and runs proofs", async () => {
    const t = fakeChannel({ nk: 400000 });
    t.chan.start("ws://node/v1/confidential/zk?proof=zkchan&session_id=s");
    expect(t.args()).toEqual(["--channel", "--prealloc-nk", "400000"]);
    t.emit(0, bytes(3, 7)); // queued until the socket opens
    t.emit(1, JSON.stringify({ ev: "ready", timings: [{ step: "preprocess", ms: 12 }], avail: [1, 2] }));
    expect(await t.chan.ready(1000)).toBe(true);
    await tick();
    expect(t.sent[0]).toEqual(bytes(3, 7));
    expect(t.chan.timings[0]!.step).toBe("preprocess");
    t.FakeWs.last.onmessage?.({ data: bytes(4, 9).buffer });
    await tick();
    expect(t.netIn[0]).toEqual(bytes(4, 9));

    expect(t.chan.used).toBe(false);
    const v = t.chan.run("verify", "pi_nk", { PiNK: {} }, undefined, 1000);
    await tick();
    expect(t.chan.used).toBe(true);
    expect(t.controlIn[0]).toMatchObject({ cmd: "verify", id: 1, proof: "pi_nk", witness: null });
    t.emit(1, JSON.stringify({ ev: "done", id: 1, proof: "pi_nk", ok: true, checks: [{ label: "c", ok: true }], ms: 80 }));
    expect((await v).ms).toBe(80);

    const p = t.chan.run("prove", "pi_c2s", { PiC2S: {} }, { Secret: [1, 2] }, 1000);
    await tick();
    expect(t.controlIn[1]).toMatchObject({ cmd: "prove", id: 2, proof: "pi_c2s", witness: { Secret: [1, 2] } });
    t.emit(1, JSON.stringify({ ev: "done", id: 2, proof: "pi_c2s", ok: false, err: "closed" }));
    await expect(p).rejects.toThrow(/pi_c2s failed: closed/);
    t.chan.close();
    await tick();
    expect(t.controlIn[2]).toEqual({ cmd: "close" });
  });

  it("rejects a verification whose checks did not all pass", async () => {
    const t = fakeChannel();
    t.chan.start("ws://x");
    t.emit(1, JSON.stringify({ ev: "ready" }));
    await t.chan.ready(1000);
    const v = t.chan.run("verify", "pi_nk", {}, undefined, 1000);
    t.emit(1, JSON.stringify({ ev: "done", id: 1, proof: "pi_nk", ok: true, checks: [{ label: "c", ok: false }] }));
    await expect(v).rejects.toThrow(/checks failed/);
  });

  it("a channel lost before any proof reports not-ready (the caller falls back)", async () => {
    const t = fakeChannel();
    t.chan.start("ws://x");
    await tick();
    t.FakeWs.last.onclose?.();
    expect(await t.chan.ready(1000)).toBe(false);
    expect(t.chan.used).toBe(false);
    expect(t.chan.failed).toBe(true);
    await expect(t.chan.run("verify", "pi_nk", {})).rejects.toThrow(/websocket closed/);
  });

  it("fails an in-flight proof on a process error or exit", async () => {
    const t = fakeChannel();
    t.chan.start("ws://x");
    t.emit(1, JSON.stringify({ ev: "ready" }));
    await t.chan.ready(1000);
    const p = t.chan.run("prove", "pi_c3s", {}, { Secret: [] }, 1000);
    t.child.emit("close", 1);
    await expect(p).rejects.toThrow(/exited 1/);
  });

  it("not ready in time counts as a failure", async () => {
    const t = fakeChannel();
    t.chan.start("ws://x");
    expect(await t.chan.ready(10)).toBe(false);
    expect(t.chan.failed).toBe(true);
  });
});
