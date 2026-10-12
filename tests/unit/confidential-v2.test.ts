/**
 * Confidential-upstream protocol v2 (two-party handshake) unit tests:
 * the client-side checks of the π_NK / π_C2S / π_C3S parameters the node
 * sends, the cu-2pc stdio frame codec, binary resolution, and the 2PC bridge
 * against a fake cu-2pc process.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  checkPiC2SParams,
  checkPiC3SParams,
  checkPiNKParams,
} from "../../client/confidential/params";
import {
  encodeTwoPcFrame,
  resolveTwoPcPath,
  TwoPcFrameDecoder,
  TwoPcSession,
  TWOPC_MAX_FRAME,
} from "../../client/confidential/twopc";
import { ProverError, SessionProtocolError } from "../../client/confidential/errors";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("π_NK statement rebuild (v2)", () => {
  const keyLen = 4;
  const alphabet = "[A-Za-z0-9_-]";
  const tpl =
    "POST /x HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer {KEY:4}\r\nContent-Length: {LEN}\r\n\r\n";
  const offer = { head_template: tpl, key_length: keyLen, key_alphabet: alphabet, upstream_host: "api.example.com" };
  const hk = bytes(32, 0x5a);
  const filled = new TextEncoder().encode(
    tpl.replace("{KEY:4}", "\u0000".repeat(keyLen)).replace("{LEN}", "10"),
  );
  const offs: number[] = [];
  filled.forEach((b, i) => {
    if (b === 0) offs.push(i);
  });
  const n = filled.length + 1;
  const honest = () => ({
    PiNK: {
      hk: Array.from(hk),
      head_len: filled.length,
      key_len: keyLen,
      key_alphabet: alphabet,
      key_offsets: offs.slice(),
      template: Array.from(filled),
      c_commit: Array.from(bytes(32, 1)),
      header: [0x17, 0x03, 0x03, (n + 16) >> 8, (n + 16) & 0xff],
    },
  });
  const own = { offer, hk, bodyLen: 10 };

  it("accepts the statement the node builds for our body and our hk", () => {
    expect(() => checkPiNKParams(honest(), own)).not.toThrow();
  });

  it("holds the published template to one POST head for the upstream host", () => {
    const withTpl = (t: string, host = "api.example.com") => () =>
      checkPiNKParams(honest(), { ...own, offer: { ...offer, head_template: t, upstream_host: host } });
    const bad = [
      tpl.replace("Host: api.example.com", "Host: other.example.com"),
      tpl.replace("Host: api.example.com\r\n", ""),
      tpl.replace("POST /x", "GET /x"),
      tpl.replace("{LEN}", "10"),
      tpl.replace("\r\n\r\n", "\r\nX-Key: {KEY:4}\r\n\r\n"),
      tpl.replace("\r\n\r\n", "\r\nTransfer-Encoding: chunked\r\n\r\n"),
      tpl + "POST /y HTTP/1.1\r\n\r\n",
      tpl.replace("\r\n\r\n", "\r\nX-A: {OTHER}\r\n\r\n"),
    ];
    for (const t of bad) expect(withTpl(t)).toThrow(/template/);
    expect(withTpl(tpl, "API.EXAMPLE.COM")).not.toThrow();
  });

  it("rejects a K_0 other than the one our 2PC anchored", () => {
    const p = honest();
    p.PiNK.hk = Array.from(bytes(32, 0x5b));
    expect(() => checkPiNKParams(p, own)).toThrow(SessionProtocolError);
  });

  it("rejects a different template, key placement, alphabet, length or header", () => {
    const tamper = (f: (p: ReturnType<typeof honest>["PiNK"]) => void) => {
      const p = honest();
      f(p.PiNK);
      return () => checkPiNKParams(p, own);
    };
    expect(tamper((p) => (p.template[0] = 0x47))).toThrow(SessionProtocolError);
    expect(tamper((p) => (p.key_offsets[0] = p.key_offsets[0]! - 1))).toThrow(SessionProtocolError);
    expect(tamper((p) => (p.key_alphabet = "[\\x00-\\xff]"))).toThrow(SessionProtocolError);
    expect(tamper((p) => (p.key_len = 3))).toThrow(SessionProtocolError);
    expect(tamper((p) => (p.head_len = p.head_len + 1))).toThrow(SessionProtocolError);
    expect(tamper((p) => (p.header[4] = p.header[4]! ^ 1))).toThrow(SessionProtocolError);
    expect(tamper((p) => (p.c_commit = []))).toThrow(SessionProtocolError);
    // Another body length (Content-Length) than ours.
    expect(() => checkPiNKParams(honest(), { ...own, bodyLen: 11 })).toThrow(SessionProtocolError);
    // v1 parameters in a v2 session.
    expect(() => checkPiNKParams({ PiN: honest().PiNK }, own)).toThrow(SessionProtocolError);
  });
});

describe("π_C2S / π_C3S parameter checks (v2)", () => {
  const suffix = new TextEncoder().encode(',"model":"m","max_tokens":8}');
  const payloadLen = 50 + suffix.length + 1 + 16; // header + (body + suffix + type byte + tag)
  const record = new Uint8Array(5 + payloadLen);
  record.set([0x17, 0x03, 0x03, payloadLen >> 8, payloadLen & 0xff]);
  for (let i = 5; i < record.length; i++) record[i] = (i * 31) & 0xff;
  const ctLen = payloadLen - 16;
  const w = Math.min(suffix.length + 1 + 13, ctLen);
  const off = ctLen - w;
  const h1 = bytes(32, 0x11);
  const h2 = bytes(32, 0x22);
  const honestC2 = () => ({
    PiC2S: {
      h1: Array.from(h1),
      seq: 3,
      ct_window: Array.from(record.subarray(5 + off, 5 + off + w)),
      off,
      w,
      sel_start: w - 1 - suffix.length,
      sel_len: suffix.length + 1,
      expected: [...Array.from(suffix), 0x17],
    },
  });
  const ownC2 = { h1, seq: 3, record, suffix };

  it("accepts a window over our own final epoch-1 record anchored on our h1", () => {
    expect(() => checkPiC2SParams(honestC2(), ownC2)).not.toThrow();
  });

  it("rejects another anchor, another record or a moved window", () => {
    const otherAnchor = honestC2();
    otherAnchor.PiC2S.h1 = Array.from(h2);
    expect(() => checkPiC2SParams(otherAnchor, ownC2)).toThrow(SessionProtocolError);
    const earlier = honestC2();
    earlier.PiC2S.seq = 2;
    expect(() => checkPiC2SParams(earlier, ownC2)).toThrow(SessionProtocolError);
    const moved = honestC2();
    moved.PiC2S.off = 0;
    moved.PiC2S.ct_window = Array.from(record.subarray(5, 5 + w));
    expect(() => checkPiC2SParams(moved, ownC2)).toThrow(SessionProtocolError);
    const otherSuffix = honestC2();
    otherSuffix.PiC2S.expected[0] = 0x20;
    expect(() => checkPiC2SParams(otherSuffix, ownC2)).toThrow(SessionProtocolError);
    // A v1-shaped statement is not a v2 one.
    expect(() => checkPiC2SParams({ PiC2: honestC2().PiC2S }, ownC2)).toThrow(SessionProtocolError);
  });

  it("requires the suffix followed by the content type byte 0x17", () => {
    const bare = honestC2();
    bare.PiC2S.expected = bare.PiC2S.expected.slice(0, -1);
    bare.PiC2S.sel_len -= 1;
    expect(() => checkPiC2SParams(bare, ownC2)).toThrow(SessionProtocolError);
    const otherType = honestC2();
    otherType.PiC2S.expected[otherType.PiC2S.expected.length - 1] = 0x16;
    expect(() => checkPiC2SParams(otherType, ownC2)).toThrow(SessionProtocolError);
    const longer = honestC2();
    longer.PiC2S.expected = [...longer.PiC2S.expected, 0x00];
    longer.PiC2S.sel_len += 1;
    expect(() => checkPiC2SParams(longer, ownC2)).toThrow(SessionProtocolError);
  });

  it("π_C3S must cover exactly the final records we received, anchored on our h2", () => {
    const recs = [bytes(60, 1), bytes(80, 2), bytes(70, 3)];
    const r = bytes(40, 9);
    const params = (records: { seq: number; ct: number[] }[], opts: { skip?: number; h2?: Uint8Array } = {}) => ({
      PiC3S: {
        h2: Array.from(opts.h2 ?? h2),
        records,
        expected: Array.from(r),
        skip: opts.skip ?? 0,
      },
    });
    const tail = [
      { seq: 1, ct: Array.from(recs[1]!.subarray(0, 64)) },
      { seq: 2, ct: Array.from(recs[2]!.subarray(0, 54)) },
    ];
    const own = { h2, serverRecords: recs, r, skip: 0 };
    expect(() => checkPiC3SParams(params(tail), own)).not.toThrow();
    // A trailing close_notify-sized record is tolerated.
    expect(() =>
      checkPiC3SParams(params(tail), { ...own, serverRecords: [...recs, bytes(19, 4)] }),
    ).not.toThrow();
    expect(() => checkPiC3SParams(params(tail, { h2: h1 }), own)).toThrow(SessionProtocolError);
    expect(() =>
      checkPiC3SParams(params([{ seq: 0, ct: Array.from(recs[0]!.subarray(0, 44)) }]), own),
    ).toThrow(SessionProtocolError);
    expect(() => checkPiC3SParams(params(tail, { skip: 5 }), own)).toThrow(SessionProtocolError);
    const gap = [tail[0]!, { ...tail[1]!, seq: 3 }];
    expect(() => checkPiC3SParams(params(gap), own)).toThrow(SessionProtocolError);
    // Not enough coverage for the disclosure.
    expect(() =>
      checkPiC3SParams(params([tail[1]!]), { ...own, r: bytes(60, 9) }),
    ).toThrow(SessionProtocolError);
  });

  it("π_C3S after a server KeyUpdate: our epoch count and exact sequence numbers", () => {
    const recs = [bytes(60, 1), bytes(80, 2), bytes(70, 3), bytes(70, 4)];
    const r = bytes(40, 9);
    // The covered records' epoch starts at wire index 2: their seqs are 0, 1.
    const tail = [
      { seq: 0, ct: Array.from(recs[2]!.subarray(0, 54)) },
      { seq: 1, ct: Array.from(recs[3]!.subarray(0, 54)) },
    ];
    const params = (ku?: number, records = tail) => ({
      PiC3S: { h2: Array.from(h2), records, expected: Array.from(r), skip: 0, ...(ku ? { key_updates: ku } : {}) },
    });
    const own = { h2, serverRecords: recs, r, skip: 0, keyUpdates: 1, epochBase: 2 };
    expect(() => checkPiC3SParams(params(1), own)).not.toThrow();
    // The node may not drop or invent a key epoch.
    expect(() => checkPiC3SParams(params(), own)).toThrow(/key epoch/);
    expect(() => checkPiC3SParams(params(2), own)).toThrow(/key epoch/);
    // Sequence numbers must be the records' offsets in that epoch.
    const shifted = tail.map((t) => ({ ...t, seq: t.seq + 2 }));
    expect(() => checkPiC3SParams(params(1, shifted), own)).toThrow(/sequence numbers/);
  });
});

describe("cu-2pc frame codec", () => {
  it("encodes [channel][len BE][payload]", () => {
    const f = encodeTwoPcFrame(1, new TextEncoder().encode("{}"));
    expect(Array.from(f)).toEqual([1, 0, 0, 0, 2, 0x7b, 0x7d]);
    expect(Array.from(encodeTwoPcFrame(0, new Uint8Array(0)))).toEqual([0, 0, 0, 0, 0]);
    expect(() => encodeTwoPcFrame(256, new Uint8Array(0))).toThrow(RangeError);
  });

  it("decodes frames split and batched arbitrarily", () => {
    const a = encodeTwoPcFrame(0, bytes(300, 0xab));
    const b = encodeTwoPcFrame(1, new TextEncoder().encode('{"ev":"x"}'));
    const c = encodeTwoPcFrame(0, new Uint8Array(0));
    const stream = new Uint8Array([...a, ...b, ...c]);
    for (const step of [1, 2, 3, 5, 7, 64, stream.length]) {
      const dec = new TwoPcFrameDecoder();
      const out = [];
      for (let i = 0; i < stream.length; i += step) out.push(...dec.push(stream.subarray(i, i + step)));
      expect(out.map((f) => f.channel)).toEqual([0, 1, 0]);
      expect(out[0]!.payload).toEqual(bytes(300, 0xab));
      expect(new TextDecoder().decode(out[1]!.payload)).toBe('{"ev":"x"}');
      expect(out[2]!.payload.length).toBe(0);
      expect(dec.pending).toBe(0);
    }
  });

  it("refuses an oversized frame header", () => {
    const dec = new TwoPcFrameDecoder();
    const hdr = new Uint8Array(5);
    hdr[0] = 0;
    new DataView(hdr.buffer).setUint32(1, TWOPC_MAX_FRAME + 1, false);
    expect(() => dec.push(hdr)).toThrow(ProverError);
  });
});

describe("cu-2pc binary resolution", () => {
  it("prefers the explicit path, else sits next to cu-prover", () => {
    const saved = { a: process.env.CU_2PC_BIN, b: process.env.CU_2PC };
    delete process.env.CU_2PC_BIN;
    delete process.env.CU_2PC;
    try {
      expect(resolveTwoPcPath("/opt/x/cu-2pc")).toBe("/opt/x/cu-2pc");
      expect(resolveTwoPcPath(undefined, "/opt/bin/cu-prover")).toBe("/opt/bin/cu-2pc");
      expect(resolveTwoPcPath(undefined, "cu-prover")).toBe("cu-2pc");
      process.env.CU_2PC = "/env/cu-2pc";
      expect(resolveTwoPcPath(undefined, "/opt/bin/cu-prover")).toBe("/env/cu-2pc");
    } finally {
      if (saved.a === undefined) delete process.env.CU_2PC_BIN;
      else process.env.CU_2PC_BIN = saved.a;
      if (saved.b === undefined) delete process.env.CU_2PC;
      else process.env.CU_2PC = saved.b;
    }
  });
});

/** A fake cu-2pc process and a fake websocket, wired like the real ones. */
function fakeBridge() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    kill: () => true,
  });
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
    stdout.write(
      encodeTwoPcFrame(ch, typeof payload === "string" ? new TextEncoder().encode(payload) : payload),
    );
  const session = new TwoPcSession({
    binaryPath: "/fake/cu-2pc",
    spawnImpl: (() => child) as never,
    webSocketImpl: FakeWs as never,
  });
  return { session, child, emit, controlIn, netIn, sent, FakeWs };
}

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("cu-2pc bridge", () => {
  it("relays channel 0 both ways and runs key share → hs → ap", async () => {
    const t = fakeBridge();
    t.session.start("ws://node/v1/confidential/zk?proof=twopc&session_id=s");
    t.emit(0, bytes(3, 7)); // 2PC bytes before the socket opens are queued
    const p = bytes(65, 1);
    p[0] = 4;
    t.emit(1, JSON.stringify({ ev: "timing", step: "preprocess", ms: 1.5 }));
    t.emit(1, JSON.stringify({ ev: "key_share", p: hexOf(p) }));
    expect(await t.session.keyShare(1000)).toEqual(p);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent[0]).toEqual(bytes(3, 7));
    expect(t.session.timings[0]!.step).toBe("preprocess");

    t.FakeWs.last.onmessage?.({ data: bytes(4, 9).buffer });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.netIn[0]).toEqual(bytes(4, 9));

    const hsP = t.session.handshake(bytes(65, 4), bytes(32, 2), 1000);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.controlIn[0]).toEqual({ cmd: "handshake", s: hexOf(bytes(65, 4)), th_sh: hexOf(bytes(32, 2)) });
    t.emit(1, JSON.stringify({ ev: "hs", c_hs: hexOf(bytes(32, 0xc1)), s_hs: hexOf(bytes(32, 0x51)) }));
    expect(await hsP).toEqual({ clientHs: bytes(32, 0xc1), serverHs: bytes(32, 0x51) });

    const apP = t.session.application(bytes(32, 3), 1000);
    t.emit(
      1,
      JSON.stringify({
        ev: "ap",
        s_ap_0: hexOf(bytes(32, 0xa0)),
        c_ap_1: hexOf(bytes(32, 0xa1)),
        h1: hexOf(bytes(32, 1)),
        h2: hexOf(bytes(32, 2)),
        hk: hexOf(bytes(32, 3)),
      }),
    );
    const ap = await apP;
    expect(ap.serverAp0).toEqual(bytes(32, 0xa0));
    expect(ap.clientAp1).toEqual(bytes(32, 0xa1));
    expect(ap.hk).toEqual(bytes(32, 3));
    t.session.close();
  });

  it("fails pending waits on a cu-2pc error event or a bad exit", async () => {
    const t = fakeBridge();
    t.session.start("ws://x");
    const ks = t.session.keyShare(1000);
    t.emit(1, JSON.stringify({ ev: "error", msg: "equality check failed" }));
    await expect(ks).rejects.toThrow(/equality check failed/);
    await expect(t.session.handshake(bytes(65, 4), bytes(32, 2), 1000)).rejects.toThrow(ProverError);

    const u = fakeBridge();
    u.session.start("ws://x");
    const ks2 = u.session.keyShare(1000);
    u.child.emit("close", 1);
    await expect(ks2).rejects.toThrow(/exited 1/);
  });

  it("rejects malformed secrets from cu-2pc", async () => {
    const t = fakeBridge();
    t.session.start("ws://x");
    t.emit(1, JSON.stringify({ ev: "key_share", p: "04abcd" }));
    await expect(t.session.keyShare(1000)).rejects.toThrow(/bad p/);
  });
});
