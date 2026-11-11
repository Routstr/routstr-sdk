/**
 * `http: 2` sessions (protocol v3, option A): the HTTP/2 layer against the
 * vectors the sidecar's tests generate (`fixtures/h2-vectors.json`, the
 * reference client's copy: `cargo test -p cu-sidecar client_vectors`), the
 * client-side checks of π_NK and π_WIN parameters, the offer's `h2` block,
 * and the connection pool.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";

import { VENICE_CHAT } from "./fixtures/chat";
import { canonicalJson } from "../../client/confidential/canonical";
import {
  FLAG,
  FRAME,
  FrameReader,
  MAX_DATA_IN_RECORD,
  chatPath,
  checkH2Offer,
  checkPiNKParamsH2,
  checkPiWinParams,
  decodeBlock,
  frame,
  h2Head,
  huffmanDecode,
  requestBlock,
  requestStream,
  splitBody,
  type WinSource,
} from "../../client/confidential/h2";
import { Http2Pool, http2PoolKey } from "../../client/confidential/h2pool";
import { offerSupportsHttp2, verifyConfidentialOffer } from "../../client/confidential/offer";
import { ConfidentialH2Connection, h2ConnectionTerms } from "../../client/confidential/h2conn";
import { CuProverBackend } from "../../client/confidential/prover";

const v = JSON.parse(readFileSync(new URL("./fixtures/h2-vectors.json", import.meta.url), "utf8")) as {
  head: { host: string; probe_path: string; key_len: number; template: string; first_offset: number };
  request_block: { host: string; path: string; block: string };
  blocks: { block: string; fields: [string, string][] }[];
  refused_blocks: string[];
  huffman_all_bytes: string;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

describe("http 2: framing and HPACK (sidecar vectors)", () => {
  it("builds the connection head and the request block byte for byte", () => {
    const head = h2Head(v.head.host, v.head.probe_path, v.head.key_len);
    expect(hex(head.template)).toBe(v.head.template);
    expect(head.offsets[0]).toBe(v.head.first_offset);
    expect(head.offsets).toHaveLength(v.head.key_len);
    expect(head.offsets.every((o) => head.template[o] === 0)).toBe(true);
    expect(hex(requestBlock(v.request_block.host, v.request_block.path))).toBe(v.request_block.block);
    expect(requestStream(1)).toBe(3);
    expect(requestStream(4)).toBe(9);
  });

  it("decodes response header blocks without a dynamic table", () => {
    for (const b of v.blocks) expect(decodeBlock(unhex(b.block))).toEqual(b.fields);
    for (const b of v.refused_blocks) expect(() => decodeBlock(unhex(b)), b).toThrow();
  });

  it("decodes Huffman strings and refuses bad padding and EOS", () => {
    const all = huffmanDecode(unhex(v.huffman_all_bytes));
    expect(all).toHaveLength(256);
    expect(all.every((x, i) => x === i)).toBe(true);
    expect(() => huffmanDecode(Uint8Array.from([0x00]))).toThrow();
    expect(() => huffmanDecode(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toThrow();
  });

  it("reassembles frames across record boundaries and maps offsets to records", () => {
    const rd = new FrameReader();
    const stream = Buffer.concat([
      frame(FRAME.SETTINGS, 0, 0, new Uint8Array(6)),
      frame(FRAME.DATA, FLAG.END_STREAM, 3, new TextEncoder().encode("hello")),
    ]);
    const got = [...rd.push(stream.subarray(0, 11), 7), ...rd.push(stream.subarray(11, 20), 8), ...rd.push(stream.subarray(20), 9)];
    expect(got).toHaveLength(2);
    expect(got[0]!.type).toBe(FRAME.SETTINGS);
    expect(got[1]!.stream).toBe(3);
    expect(got[1]!.off).toBe(15);
    expect(Buffer.from(got[1]!.payload).toString()).toBe("hello");
    expect(rd.atBoundary()).toBe(true);
    expect(rd.recordAt(15).abs).toBe(8);
    expect(rd.recordAt(15).start).toBe(11);
    expect(Buffer.from(rd.slice(15, stream.length)).equals(stream.subarray(15))).toBe(true);
    rd.dropBefore(rd.total);
    expect(rd.records).toHaveLength(0);
  });

  it("splits a body so every frame fits a record and the last holds the suffix", () => {
    for (const [len, sfx, chunk] of [
      [10, 4, 100],
      [100, 30, 40],
      [81, 30, 40],
      [MAX_DATA_IN_RECORD * 3 + 5, 200, MAX_DATA_IN_RECORD],
      [200, 200, MAX_DATA_IN_RECORD],
    ] as const) {
      const parts = splitBody(new Uint8Array(len), sfx, chunk);
      expect(parts.reduce((n, p) => n + p.length, 0)).toBe(len);
      expect(parts.every((p) => p.length > 0 && p.length <= chunk)).toBe(true);
      expect(parts[parts.length - 1]!.length).toBeGreaterThanOrEqual(sfx);
    }
    expect(() => splitBody(new Uint8Array(10), 20, 100)).toThrow();
  });

  it("takes the request path from the head template", () => {
    expect(chatPath("POST /api/v1/chat/completions HTTP/1.1\r\nHost: x\r\n\r\n")).toBe("/api/v1/chat/completions");
    expect(() => chatPath("POST /api/v1/../x HTTP/1.1\r\n")).toThrow();
    expect(() => chatPath("GET /api/v1/chat/completions HTTP/1.1\r\n")).toThrow();
  });
});

describe("http 2: the offer's h2 block", () => {
  const offer = {
    http: ["1.1", "2"],
    upstream_host: "api.venice.ai",
    h2: { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 100 },
  };
  const bases = ["/v1", "/api/v1"];

  it("accepts the sidecar's block and refuses anything outside its limits", () => {
    expect(checkH2Offer(offer, bases).probe_path).toBe("/api/v1/models");
    expect(() => checkH2Offer({ ...offer, http: ["1.1"] }, bases)).toThrow(/offer_no_http2/);
    expect(() => checkH2Offer({ ...offer, h2: undefined }, bases)).toThrow();
    for (const probe_path of ["/api/v1/api_keys", "/api/v1/../v1/models", "/api/v1/models?x=1", "/models", "api/v1/models"]) {
      expect(() => checkH2Offer({ ...offer, h2: { ...offer.h2, probe_path } }, bases), probe_path).toThrow();
    }
    expect(() => checkH2Offer({ ...offer, h2: { ...offer.h2, idle_secs: 0 } }, bases)).toThrow();
    expect(() => checkH2Offer({ ...offer, h2: { ...offer.h2, max_requests: 100000 } }, bases)).toThrow();
    // The probe must sit under an API base the caller trusts for the host.
    expect(() => checkH2Offer(offer, ["/v1"])).toThrow();
  });

  function signedOffer(overrides: Record<string, unknown> = {}) {
    const priv = new Uint8Array(32).fill(7);
    const pubHex = bytesToHex(schnorr.getPublicKey(priv));
    const o: Record<string, unknown> = {
      v: 2,
      min_v: 2,
      max_v: 2,
      upstream_host: "api.venice.ai",
      notary_pubkey: pubHex,
      max_tokens_cap: 4096,
      key_length: 42,
      key_alphabet: "[A-Za-z0-9_-]",
      head_template:
        "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
        "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
      suffix_keys: ["model", "max_tokens", "max_completion_tokens", "n", "stream", "stream_options", "venice_parameters"],
      chat: VENICE_CHAT,
      price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
      ...overrides,
    };
    const payload = canonicalJson(o);
    const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
    return { offer: { ...o, sig, sig_payload: payload }, pubHex };
  }
  const policy = (pubHex: string) => ({ pinnedPubkey: pubHex, trustedHosts: ["api.venice.ai"] });

  it("a verified offer serves http 2 only when it lists it with a valid block", () => {
    const plain = signedOffer();
    expect(offerSupportsHttp2(verifyConfidentialOffer(plain.offer, policy(plain.pubHex)))).toBe(false);

    const good = signedOffer({ http: ["1.1", "2"], h2: offer.h2 });
    const verified = verifyConfidentialOffer(good.offer, policy(good.pubHex));
    expect(offerSupportsHttp2(verified)).toBe(true);
    expect(verified.h2).toEqual(offer.h2);
    expect(verified.http2Refused).toBeUndefined();
    // Verifying a verified offer again (the transport's cache) keeps it.
    expect(offerSupportsHttp2(verifyConfidentialOffer(verified, policy(good.pubHex)))).toBe(true);

    const only11 = signedOffer({ http: ["1.1"] });
    expect(offerSupportsHttp2(verifyConfidentialOffer(only11.offer, policy(only11.pubHex)))).toBe(false);
  });

  it("a bad h2 block switches http 2 off and leaves the v2 offer usable", () => {
    for (const h2 of [
      { ...offer.h2, probe_path: "/api/v1/api_keys" },
      { ...offer.h2, idle_secs: 5 },
      undefined,
    ]) {
      const bad = signedOffer(h2 ? { http: ["1.1", "2"], h2 } : { http: ["1.1", "2"] });
      const verified = verifyConfidentialOffer(bad.offer, policy(bad.pubHex));
      expect(offerSupportsHttp2(verified)).toBe(false);
      expect(verified.http).toEqual(["1.1"]);
      expect(verified.http2Refused).toBeTruthy();
      expect(verified.price_list.cheap).toBeDefined();
    }
    // A probe under another API base than the trusted host entry allows.
    const other = signedOffer({ http: ["1.1", "2"], h2: { ...offer.h2, probe_path: "/v1/models" } });
    const verified = verifyConfidentialOffer(other.offer, {
      pinnedPubkey: other.pubHex,
      trustedHosts: ["api.venice.ai/api/v1"],
    });
    expect(offerSupportsHttp2(verified)).toBe(false);
  });

  it("a re-signed offer with other rates keeps the connection terms; another route or h2 block does not", () => {
    const h2 = offer.h2;
    const first = signedOffer({ http: ["1.1", "2"], h2 });
    const a = verifyConfidentialOffer(first.offer, policy(first.pubHex));
    const repriced = signedOffer({ http: ["1.1", "2"], h2, price_list: { cheap: { in: 1100, cached_in: 1100, out: 1200 } }, session_fee_msat: 5 });
    const b = verifyConfidentialOffer(repriced.offer, policy(repriced.pubHex));
    expect(a.sig).not.toBe(b.sig);
    expect(h2ConnectionTerms(b)).toBe(h2ConnectionTerms(a));
    const key = (o: typeof a) => http2PoolKey({ baseUrl: "https://n", bearer: "sk", model: "cheap", terms: h2ConnectionTerms(o) }, "credential");
    expect(key(b)).toBe(key(a));
    const otherIdle = signedOffer({ http: ["1.1", "2"], h2: { ...h2, idle_secs: 60 } });
    expect(h2ConnectionTerms(verifyConfidentialOffer(otherIdle.offer, policy(otherIdle.pubHex)))).not.toBe(h2ConnectionTerms(a));
    const otherKeyLen = signedOffer({
      http: ["1.1", "2"],
      h2,
      key_length: 40,
      head_template: (first.offer.head_template as string).replace("{KEY:42}", "{KEY:40}"),
    });
    const c = verifyConfidentialOffer(otherKeyLen.offer, policy(otherKeyLen.pubHex));
    expect(h2ConnectionTerms(c)).not.toBe(h2ConnectionTerms(a));
    expect(key(c)).not.toBe(key(a));
  });

  it("a connection refuses an offer without the block, before anything is sent", () => {
    const plain = signedOffer();
    const verified = verifyConfidentialOffer(plain.offer, policy(plain.pubHex));
    expect(
      () =>
        new ConfidentialH2Connection({
          baseUrl: "http://127.0.0.1:1",
          offer: verified,
          auth: "sk-test",
          prover: new CuProverBackend({ binaryPath: "/nonexistent/cu-prover" }),
        }),
    ).toThrow(/no http: 2/);
  });
});

describe("http 2: π_NK is held to the connection head of the signed offer", () => {
  const head = h2Head("api.venice.ai", "/api/v1/models", 42);
  const hk = new Uint8Array(32).fill(9);
  const nk = () => ({
    PiNK: {
      hk: Array.from(hk),
      head_len: head.template.length,
      key_len: 42,
      key_alphabet: "[A-Za-z0-9_-]",
      key_offsets: head.offsets.slice(),
      template: Array.from(head.template),
      c_commit: new Array(32).fill(1),
      header: [0x17, 3, 3, (head.template.length + 17) >> 8, (head.template.length + 17) & 0xff],
    },
  });
  const own = { host: "api.venice.ai", probePath: "/api/v1/models", keyLength: 42, hk };
  const tamper = (f: (p: ReturnType<typeof nk>["PiNK"]) => void) => {
    const p = nk();
    f(p.PiNK);
    return p;
  };

  it("accepts exactly the rebuilt head", () => {
    expect(head.template.length).toBe(170);
    expect(() => checkPiNKParamsH2(nk(), own)).not.toThrow();
  });

  it("refuses a head that enables push or a response table, another probe, a moved key, another anchor", () => {
    expect(() => checkPiNKParamsH2(tamper((p) => (p.template[44] = 1)), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(tamper((p) => (p.template[38] = 0x10)), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(tamper((p) => (p.template[100]! ^= 1)), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(tamper((p) => p.key_offsets[0]!--), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(tamper((p) => (p.hk[0]! ^= 1)), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(tamper((p) => (p.key_alphabet = "[a-z]")), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(tamper((p) => p.head_len++), own)).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(nk(), { ...own, probePath: "/v1/models" })).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2(nk(), { ...own, host: "api.example.com" })).toThrow(/π_NK/);
    expect(() => checkPiNKParamsH2({}, own)).toThrow(/π_NK/);
  });
});

describe("http 2: π_WIN windows may compare only public bytes of our own records", () => {
  const anchor = new Uint8Array(32).fill(5);
  const plain = new Uint8Array(5001);
  plain.set(frame(FRAME.DATA, 0, 3, new Uint8Array(4991).fill(0x61)));
  plain[5000] = 0x17;
  const ct = plain.map((b, i) => b ^ ((i * 7 + 3) & 0xff));
  const src: WinSource = { ct, plain, pub: [[0, 9], [5000, 5001]] };
  const lookup = (seq: number) => (seq === 4 ? src : undefined);
  const win = (w: Record<string, unknown>[]) => ({ PiWin: { anchor: Array.from(anchor), windows: w } });
  const headWin = { seq: 4, ct: Array.from(ct.subarray(0, 16)), expected: Array.from(plain.subarray(0, 9)) };
  const lastWin = { seq: 4, off: 4992, ct: Array.from(ct.subarray(4992)), sel_start: 8, expected: [0x17] };
  const bad = (w: Record<string, unknown>[], own: Record<string, unknown> = {}) =>
    expect(() => checkPiWinParams(win(w), { anchor, lookup, ...own })).toThrow(/π_WIN/);

  it("accepts the node's honest windows", () => {
    expect(checkPiWinParams(win([headWin, lastWin]), { anchor, lookup, covered: [4] })).toEqual({
      windows: 2,
      ctBytes: 16 + 9,
    });
  });

  it("refuses a guess at private payload bytes (the equality bit would confirm it)", () => {
    bad([{ seq: 4, ct: Array.from(ct.subarray(0, 16)), expected: Array.from(plain.subarray(0, 10)) }]);
    bad([{ seq: 4, off: 16, ct: Array.from(ct.subarray(16, 32)), expected: Array.from(plain.subarray(16, 32)) }]);
    bad([{ ...lastWin, sel_start: 7, expected: [0x61, 0x17] }]);
  });

  it("refuses wrong public bytes, foreign ciphertext, other records, bad ranges", () => {
    bad([{ ...headWin, expected: [0, 0x13, 0x7f, 1, 4, 0, 0, 0, 3] }]);
    bad([{ ...headWin, ct: Array.from(ct.subarray(0, 16)).map((b, i) => (i === 3 ? b ^ 1 : b)) }]);
    bad([{ ...headWin, seq: 5 }]);
    bad([{ ...headWin, seq: "4" }]);
    bad([{ ...headWin, off: 8, ct: Array.from(ct.subarray(8, 24)) }]);
    bad([{ ...lastWin, ct: [...Array.from(ct.subarray(4992)), 1, 2] }]);
    bad([{ ...headWin, expected: [] }]);
    bad([{ ...headWin, sel_start: -1 }]);
    bad([]);
    expect(() => checkPiWinParams({}, { anchor, lookup })).toThrow(/π_WIN/);
  });

  it("requires every record of the batch to be covered", () => {
    bad([headWin], { covered: [4, 5] });
  });

  it("refuses another anchor or key epoch", () => {
    expect(() =>
      checkPiWinParams({ PiWin: { anchor: Array.from(anchor), windows: [headWin] } }, { anchor: new Uint8Array(32).fill(6), lookup }),
    ).toThrow(/π_WIN/);
    expect(() =>
      checkPiWinParams({ PiWin: { anchor: Array.from(anchor), key_updates: 1, windows: [headWin] } }, { anchor, lookup }),
    ).toThrow(/π_WIN/);
    expect(() =>
      checkPiWinParams({ PiWin: { anchor: Array.from(anchor), key_updates: 1, windows: [headWin] } }, { anchor, lookup, keyUpdates: 1 }),
    ).not.toThrow();
  });

  it("treats adjacent public ranges as one (a last DATA frame that is all suffix)", () => {
    const small = frame(FRAME.DATA, FLAG.END_STREAM, 3, new TextEncoder().encode(',"model":"m"}'));
    const sp = Uint8Array.from([...small, 0x17]);
    const sc = sp.map((b) => b ^ 0x5a);
    const whole = { seq: 1, ct: Array.from(sc), expected: Array.from(sp) };
    expect(
      checkPiWinParams(
        { PiWin: { anchor: Array.from(anchor), windows: [whole] } },
        { anchor, lookup: () => ({ ct: sc, plain: sp, pub: [[0, 9], [9, sp.length]] }) },
      ).windows,
    ).toBe(1);
  });

  it("limits the windows and the ciphertext of one proof", () => {
    const many = Array.from({ length: 2201 }, () => headWin);
    bad(many);
    const big = new Uint8Array(70_000).fill(1);
    const bigSrc: WinSource = { ct: big, plain: big, pub: [[0, big.length]] };
    expect(() =>
      checkPiWinParams(
        { PiWin: { anchor: Array.from(anchor), windows: [{ seq: 0, ct: Array.from(big), expected: Array.from(big) }] } },
        { anchor, lookup: () => bigSrc },
      ),
    ).toThrow(/π_WIN/);
  });
});

/** A stand-in connection for the pool. */
class FakeConn {
  static opened = 0;
  sid = `${(++FakeConn.opened).toString(16).padStart(8, "0")}`;
  h2 = { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 3 };
  requests = 0;
  tOpen = 0;
  tLastSettled = 0;
  busy = false;
  dead?: Error;
  failConnect = false;
  private endedRes!: (e: Error) => void;
  ended = new Promise<Error>((r) => (this.endedRes = r));
  get failureReason() {
    return this.dead;
  }
  get usable() {
    return !this.dead && this.tOpen > 0 && this.requests < this.h2.max_requests;
  }
  get idle() {
    return this.usable && !this.busy;
  }
  async connect() {
    await new Promise((r) => setTimeout(r, 5));
    if (this.failConnect) {
      this.close("connect failed");
      throw new Error("connect failed");
    }
    this.tOpen = this.tLastSettled = Date.now();
  }
  close(why = "closed") {
    if (this.dead) return;
    this.dead = new Error(why);
    this.endedRes(this.dead);
  }
  /** One request: busy until `finish()`. */
  start() {
    this.requests++;
    this.busy = true;
  }
  finish() {
    this.busy = false;
    this.tLastSettled = Date.now();
  }
}

describe("http 2: the connection pool", () => {
  const quiet = { log: () => {} };

  it("keys by node, credential and offer; by model only when asked", () => {
    const a = { baseUrl: "https://n1/", bearer: "sk-a", model: "m1", terms: "s" };
    expect(http2PoolKey(a, "credential")).toBe(http2PoolKey({ ...a, baseUrl: "https://n1", model: "m2" }, "credential"));
    expect(http2PoolKey(a, "credential")).not.toBe(http2PoolKey({ ...a, bearer: "sk-b" }, "credential"));
    expect(http2PoolKey(a, "credential")).not.toBe(http2PoolKey({ ...a, baseUrl: "https://n2" }, "credential"));
    expect(http2PoolKey(a, "credential")).not.toBe(http2PoolKey({ ...a, terms: "t" }, "credential"));
    expect(http2PoolKey(a, "credential")).not.toBe(http2PoolKey({ ...a, scope: "user-1" }, "credential"));
    expect(http2PoolKey(a, "model")).not.toBe(http2PoolKey({ ...a, model: "m2" }, "model"));
    expect(http2PoolKey(a, "credential")).not.toContain("sk-a");
  });

  it("reuses an idle connection for sequential requests", async () => {
    const pool = new Http2Pool<FakeConn>(quiet);
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    for (let i = 0; i < 3; i++) {
      const lease = await pool.acquire("k", open);
      expect(lease.reused).toBe(i > 0);
      lease.conn.start();
      lease.conn.finish();
      lease.release();
    }
    expect(conns).toHaveLength(1);
    // The connection reached the offer's request limit (3): it was closed.
    expect(conns[0]!.dead).toBeDefined();
    expect(pool.snapshot()).toHaveLength(0);
    const again = await pool.acquire("k", open);
    expect(again.reused).toBe(false);
    expect(conns).toHaveLength(2);
    pool.close();
  });

  it("opens another connection for an overlapping request, and one per key", async () => {
    const pool = new Http2Pool<FakeConn>(quiet);
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    const [l1, l2] = await Promise.all([pool.acquire("k", open), pool.acquire("k", open)]);
    expect(l1.conn).not.toBe(l2.conn);
    expect(l1.reused || l2.reused).toBe(false);
    l1.conn.start();
    l2.conn.start();
    const other = await pool.acquire("other", open);
    expect(conns).toHaveLength(3);
    l1.conn.finish();
    l1.release();
    const l3 = await pool.acquire("k", open);
    expect(l3.conn).toBe(l1.conn);
    expect(l3.reused).toBe(true);
    expect(pool.snapshot().map((s) => s.state).sort()).toEqual(["busy", "busy", "busy"]);
    other.release();
    pool.close();
    expect(conns.every((c) => c.dead)).toBe(true);
  });

  it("waits at the per-key limit until a connection is free", async () => {
    const pool = new Http2Pool<FakeConn>({ ...quiet, maxConnectionsPerKey: 1 });
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    const l1 = await pool.acquire("k", open);
    l1.conn.start();
    let got = false;
    const second = pool.acquire("k", open).then((l) => ((got = true), l));
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toBe(false);
    l1.conn.finish();
    l1.release();
    const l2 = await second;
    expect(l2.conn).toBe(l1.conn);
    expect(conns).toHaveLength(1);
    pool.close();
  });

  it("times out when no connection becomes free", async () => {
    const pool = new Http2Pool<FakeConn>({ ...quiet, maxConnectionsPerKey: 1, acquireTimeoutMs: 40 });
    const l1 = await pool.acquire("k", () => new FakeConn());
    l1.conn.start();
    await expect(pool.acquire("k", () => new FakeConn())).rejects.toThrow(/timeout/);
    pool.close();
  });

  it("makes room at the total limit by closing another key's idle connection", async () => {
    const pool = new Http2Pool<FakeConn>({ ...quiet, maxConnections: 1 });
    const a = await pool.acquire("a", () => new FakeConn());
    a.conn.start();
    a.conn.finish();
    a.release();
    const b = await pool.acquire("b", () => new FakeConn());
    expect(a.conn.dead).toBeDefined();
    expect(b.reused).toBe(false);
    pool.close();
  });

  it("never hands out a connection that died while idle", async () => {
    const pool = new Http2Pool<FakeConn>(quiet);
    const l1 = await pool.acquire("k", () => new FakeConn());
    l1.conn.start();
    l1.conn.finish();
    l1.release();
    l1.conn.close("the node's idle limit");
    const l2 = await pool.acquire("k", () => new FakeConn());
    expect(l2.conn).not.toBe(l1.conn);
    expect(l2.reused).toBe(false);
    pool.close();
  });

  it("does not keep a connection whose request failed, or with reuse off", async () => {
    const pool = new Http2Pool<FakeConn>(quiet);
    const l1 = await pool.acquire("k", () => new FakeConn());
    l1.conn.start();
    l1.conn.close("request failed");
    l1.release();
    expect(pool.snapshot()).toHaveLength(0);

    const none = new Http2Pool<FakeConn>({ ...quiet, reuse: "none" });
    const l2 = await none.acquire("k", () => new FakeConn());
    l2.conn.start();
    l2.conn.finish();
    l2.release();
    expect(l2.conn.dead).toBeDefined();
    expect(none.snapshot()).toHaveLength(0);
  });

  it("closes an idle connection before the node's idle limit, and after maxRequestsPerConnection", async () => {
    const pool = new Http2Pool<FakeConn>({ ...quiet, maxIdleMs: 30, maxRequestsPerConnection: 2 });
    const l1 = await pool.acquire("k", () => new FakeConn());
    l1.conn.start();
    l1.conn.finish();
    l1.release();
    expect(pool.snapshot()[0]!.state).toBe("idle");
    await new Promise((r) => setTimeout(r, 80));
    expect(l1.conn.dead).toBeDefined();
    expect(pool.snapshot()).toHaveLength(0);

    const l2 = await pool.acquire("k", () => new FakeConn());
    l2.conn.start();
    l2.conn.finish();
    l2.release();
    const l3 = await pool.acquire("k", () => new FakeConn());
    expect(l3.conn).toBe(l2.conn);
    l3.conn.start();
    l3.conn.finish();
    l3.release();
    expect(l2.conn.dead?.message).toMatch(/request limit/);
    pool.close();
  });

  it("surfaces a failed connect and forgets the connection", async () => {
    const pool = new Http2Pool<FakeConn>(quiet);
    await expect(
      pool.acquire("k", () => {
        const c = new FakeConn();
        c.failConnect = true;
        return c;
      }),
    ).rejects.toThrow(/connect failed/);
    expect(pool.snapshot()).toHaveLength(0);
  });

  it("respects an aborted caller", async () => {
    const pool = new Http2Pool<FakeConn>(quiet);
    const ac = new AbortController();
    ac.abort(new Error("gone"));
    await expect(pool.acquire("k", () => new FakeConn(), ac.signal)).rejects.toThrow(/gone/);
  });
});
