/**
 * Client-side checks on what the node chooses or sends: pin keys and values
 * (chat and images), the head template syntax, the session id, and the
 * bounds on node data queued for the session or its helper processes. The
 * production offer fixture must pass every one of them.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import offerFixture from "../fixtures/confidential/venice-offer.json";
import { VENICE_CHAT } from "./fixtures/chat";
import { canonicalJson } from "../../client/confidential/canonical";
import { OfferMalformedError, ProverError, SessionProtocolError } from "../../client/confidential/errors";
import {
  offerSupportsImages,
  validateImagesOffer,
  verifyConfidentialOffer,
  type ConfidentialImagesOffer,
} from "../../client/confidential/offer";
import { headTemplateProblem } from "../../client/confidential/params";
import { CuProverBackend, MAX_UNFLUSHED_STDIN, StdinBudget } from "../../client/confidential/prover";
import { NodeProtocolOutdatedError } from "../../client/confidential/errors";
import { offerSupportsHttp2Images } from "../../client/confidential/offer";
import { ConfidentialConnection } from "../../client/confidential/connection";
import { timeout } from "../../client/confidential/wire";
import { chatSuffixKeys, pinKeyProblem, validateChatSuffix } from "../../client/confidential/suffix";
import { TwoPcSession } from "../../client/confidential/twopc";
import { ProofChannel } from "../../client/confidential/zkchan";

/** The production node's offer (captured while it still ran protocol v2). */
const OFFER = offerFixture as unknown as Record<string, unknown>;
const SIGNED_V2 = JSON.parse(OFFER.sig_payload as string) as Record<string, unknown>;
/** Its terms as a v3 node offers them (§2.2): the same blocks, `v: 3` and the connection-level fields. */
const { min_v: _minV, max_v: _maxV, ...V2_TERMS } = SIGNED_V2;
const SIGNED: Record<string, unknown> = {
  ...V2_TERMS,
  v: 3,
  twopc: "split-public-1",
  http: ["2", "1.1"],
  h2: { probe_path: "/api/v1/models", max_requests: 100, max_lifetime_s: 3600, idle_secs: 300, kinds: ["chat", "images"] },
  connection_deposit_msat: 2000,
  idle_timeout_s: 120,
};
const IMAGES = SIGNED.images as ConfidentialImagesOffer;
const CHAT_TPL = SIGNED.head_template as string;
const IMAGE_TPL = IMAGES.head_template;
const HOST = "api.venice.ai";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("the production offer passes every client check", () => {
  it("verifies, with its chat block, both head templates and its images block", () => {
    // As captured it is a v2 offer: a v3 client does not use that node (§11).
    expect(() =>
      verifyConfidentialOffer(OFFER, { pinnedPubkey: OFFER.notary_pubkey as string, trustedHosts: [HOST] }),
    ).toThrow(NodeProtocolOutdatedError);
    const priv = new Uint8Array(32).fill(9);
    const pub = bytesToHex(schnorr.getPublicKey(priv));
    const offer = { ...SIGNED, notary_pubkey: pub };
    const payload = canonicalJson(offer);
    const signed = { ...offer, sig: bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv)), sig_payload: payload };
    const v = verifyConfidentialOffer(signed, { pinnedPubkey: pub, trustedHosts: [HOST] });
    expect(v.imagesRefused).toBeUndefined();
    expect(v.http2Refused).toBeUndefined();
    expect(v.http).toEqual(["2", "1.1"]);
    expect(offerSupportsHttp2Images(v)).toBe(true);
    expect(offerSupportsImages(v)).toBe(true);
    expect(() => validateChatSuffix(SIGNED.chat, SIGNED.suffix_keys)).not.toThrow();
    expect(headTemplateProblem(CHAT_TPL, HOST, "chat")).toBeUndefined();
    expect(headTemplateProblem(IMAGE_TPL, HOST, "images")).toBeUndefined();
    expect(() => validateImagesOffer(IMAGES, HOST)).not.toThrow();
  });
});

describe("pin keys", () => {
  it("refuses keys that negate a feature or name a protection, at any depth", () => {
    for (const k of ["disable_thinking", "Disable", "no_log", "skip_x", "without_x", "exclude", "omit_x", "hide_reasoning"]) {
      expect(pinKeyProblem(k, false)).toMatch(/negates a feature/);
    }
    for (const k of ["safe_mode", "SafeMode", "moderation", "content_filter", "nsfw", "censored", "guardrails"]) {
      expect(pinKeyProblem(k, false)).toMatch(/protection/);
    }
    expect(pinKeyProblem("reasoning", { exclude: false })).toMatch(/"exclude"/);
    expect(pinKeyProblem("extras", { a: { b: { safe: false } } })).toMatch(/"safe"/);
    expect(pinKeyProblem("venice_parameters", { enable_web_search: "off", include_venice_system_prompt: false })).toBeUndefined();
    expect(pinKeyProblem("parallel_tool_calls", false)).toBeUndefined();
  });

  it("refuses the same in a chat block, and keeps the shipped Venice pins", () => {
    const withPin = (pin: [string, unknown]) => {
      const chat = { ...VENICE_CHAT, fixed_pins: [...VENICE_CHAT.fixed_pins, pin] };
      return () => validateChatSuffix(chat, chatSuffixKeys(chat));
    };
    expect(() => validateChatSuffix(VENICE_CHAT, chatSuffixKeys(VENICE_CHAT))).not.toThrow();
    expect(withPin(["safety_filter", false])).toThrow(OfferMalformedError);
    expect(withPin(["web_search_options", {}])).toThrow(/web_search_options/);
    expect(withPin(["extras", { search: {} }])).toThrow(OfferMalformedError);
    expect(withPin(["extras", { search: "off" }])).not.toThrow();
  });

  it("refuses image fixed pins under such keys, and keeps the shipped image pins", () => {
    const bad = (pins: [string, unknown][]) => () => validateImagesOffer({ ...IMAGES, fixed_pins: pins }, HOST);
    expect(bad([["safe_mode", false]])).toThrow(/safe_mode/);
    expect(bad([["disable_watermark", false]])).toThrow(/negates a feature/);
    expect(bad([["nsfw_filter", []]])).toThrow(/protection/);
    expect(bad([["hide_watermark", false]])).toThrow(OfferMalformedError);
    expect(bad([["safe_mode", true]])).toThrow(/switched off/);
    expect(() =>
      validateImagesOffer(
        {
          ...IMAGES,
          fixed_pins: [
            ["return_binary", false],
            ["enhance_prompt", false],
            ["enable_web_search", false],
            ["style_references", []],
          ],
        },
        HOST,
      ),
    ).not.toThrow();
  });
});

describe("head template syntax", () => {
  const variants: [string, string][] = [
    ["a bare LF", CHAT_TPL.replace("Connection: close\r\n", "Connection: close\n")],
    ["a bare CR", CHAT_TPL.replace("Connection: close\r\n", "Connection: close\r")],
    ["LF LF", CHAT_TPL.replace("Connection: close\r\n", "Connection: close\r\n\n")],
    ["an obs-fold line", CHAT_TPL.replace("Connection: close\r\n", "Connection: close\r\n x\r\n")],
    ["space before the colon", CHAT_TPL.replace("Host: ", "Host : ")],
    ["a tab", CHAT_TPL.replace("Host: ", "Host:\t")],
    ["no space after the colon", CHAT_TPL.replace("Host: ", "Host:")],
    ["two spaces after the colon", CHAT_TPL.replace("Host: ", "Host:  ")],
    ["a trailing space", CHAT_TPL.replace("Connection: close\r\n", "Connection: close \r\n")],
    ["a NUL", CHAT_TPL.replace("Connection: close", "Connection: clo\u0000se")],
    ["DEL", CHAT_TPL.replace("Connection: close", "Connection: close\u007f")],
    ["Authorization with trailing bytes", CHAT_TPL.replace("Bearer {KEY:63}", "Bearer {KEY:63} x")],
    ["Authorization with leading bytes", CHAT_TPL.replace("Bearer {KEY:63}", "Basic {KEY:63}")],
    ["Authorization glued to the key", CHAT_TPL.replace("Bearer {KEY:63}", "Bearer{KEY:63}")],
  ];

  it("accepts the honest chat and image templates", () => {
    expect(headTemplateProblem(CHAT_TPL, HOST, "chat")).toBeUndefined();
    expect(headTemplateProblem(IMAGE_TPL, HOST, "images")).toBeUndefined();
  });

  for (const [what, tpl] of variants) {
    it(`refuses ${what}`, () => {
      expect(tpl).not.toBe(CHAT_TPL);
      expect(headTemplateProblem(tpl, HOST, "chat")).toBeDefined();
    });
  }

  it("refuses a signed offer whose chat head template is malformed, before any session", () => {
    const priv = new Uint8Array(32).fill(9);
    const pub = bytesToHex(schnorr.getPublicKey(priv));
    const sign = (tpl: string) => {
      const offer = { ...SIGNED, notary_pubkey: pub, head_template: tpl };
      const payload = canonicalJson(offer);
      return { ...offer, sig: bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv)), sig_payload: payload };
    };
    const verify = (tpl: string) => () => verifyConfidentialOffer(sign(tpl), { pinnedPubkey: pub, trustedHosts: [HOST] });
    expect(verify(CHAT_TPL)).not.toThrow();
    for (const [, tpl] of variants) expect(verify(tpl)).toThrow(OfferMalformedError);
  });
});

/** A control socket that answers the setup with `ready` and lets the test send more frames. */
function fakeControlSocket(ready: Record<string, unknown>) {
  class Ws {
    static last: Ws;
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor() {
      Ws.last = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send() {
      setTimeout(() => this.frame(ready), 0);
    }
    frame(m: unknown) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
    close() {}
  }
  return Ws;
}

describe("connection id and node frames", () => {
  const opts = (extra: Record<string, unknown> = {}) =>
    ({
      baseUrl: "http://127.0.0.1:8010",
      offer: { v: 3, notary_pubkey: "00".repeat(32), chat: VENICE_CHAT, suffix_keys: chatSuffixKeys(VENICE_CHAT) },
      auth: "sk-x",
      prover: new CuProverBackend({ binaryPath: process.execPath }),
      proofChannelFactory: () => ({ start() {}, ready: async () => false, failed: false, used: false, close() {} }) as never,
      ...extra,
    }) as never;
  const ready = (sid: unknown) => ({ type: "ready", v: 3, http: "1.1", sid, pubkey: "00".repeat(32), zk_token: "t/k" });

  async function withSocket<T>(Ws: unknown, f: () => Promise<T>): Promise<T> {
    const real = (globalThis as { WebSocket: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = Ws;
    try {
      return await f();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = real;
    }
  }

  it("refuses a session id outside the sidecar's format before the 2PC starts", async () => {
    for (const sid of ["ab".repeat(31), "AB".repeat(32), `${"ab".repeat(31)}&x`, "../../v1/x", 7, undefined]) {
      let started = 0;
      await withSocket(fakeControlSocket(ready(sid)), async () => {
        const session = new ConfidentialConnection(
          opts({
            twoPcFactory: () => {
              started++;
              throw new Error("2PC started");
            },
          }),
        );
        await expect(session.arm()).rejects.toThrow(/malformed connection id/);
      });
      expect(started).toBe(0);
    }
  });

  it("puts a well-formed sid and the token into the /zk URL, encoded", async () => {
    const sid = "ab".repeat(32);
    const urls: string[] = [];
    await withSocket(fakeControlSocket(ready(sid)), async () => {
      const session = new ConfidentialConnection(
        opts({
          twoPcFactory: () =>
            ({
              start: (u: string) => urls.push(u),
              keyShare: () => Promise.reject(new Error("stop here")),
              failed: false,
              close() {},
            }) as never,
        }),
      );
      await expect(session.arm()).rejects.toThrow(/stop here/);
      expect(session.sid).toBe(sid);
    });
    expect(urls).toEqual([`ws://127.0.0.1:8010/v1/confidential/zk?proof=twopc&sid=${sid}&session_id=${sid}&zk_token=t%2Fk`]);
  });

  it("fails the session on the 17th unanswered frame of one type", async () => {
    const Ws = fakeControlSocket(ready("cd".repeat(32)));
    await withSocket(Ws, async () => {
      const session = new ConfidentialConnection(
        opts({
          twoPcFactory: () =>
            ({ start() {}, keyShare: () => new Promise(() => {}), failed: false, close() {} }) as never,
        }),
      );
      const armed = session.arm();
      armed.catch(() => {});
      await tick(20);
      for (let i = 0; i < 16; i++) Ws.last.frame({ type: "hs_verified" });
      await tick();
      expect(session.failureReason).toBeUndefined();
      Ws.last.frame({ type: "hs_verified" });
      await expect(armed).rejects.toThrow(SessionProtocolError);
      await expect(armed).rejects.toThrow(/too many unanswered/);
    });
  });

  it("fails the session when the node queues more than 32 MiB of TLS bytes", async () => {
    const Ws = fakeControlSocket(ready("ab".repeat(32)));
    await withSocket(Ws, async () => {
      const session = new ConfidentialConnection(
        opts({
          twoPcFactory: () =>
            ({ start() {}, keyShare: () => new Promise(() => {}), failed: false, close() {} }) as never,
        }),
      );
      const armed = session.arm();
      armed.catch(() => {});
      await tick(20);
      const MiB = new ArrayBuffer(1 << 20);
      const ws = Ws.last as unknown as { onmessage: (ev: { data: unknown }) => void };
      for (let i = 0; i < 33; i++) ws.onmessage({ data: MiB });
      await expect(armed).rejects.toThrow(/faster than they could be processed/);
    });
  });

  it("fails the connection on a frame without a type", async () => {
    const Ws = fakeControlSocket(ready("ef".repeat(32)));
    await withSocket(Ws, async () => {
      const session = new ConfidentialConnection(
        opts({
          twoPcFactory: () =>
            ({ start() {}, keyShare: () => new Promise(() => {}), failed: false, close() {} }) as never,
        }),
      );
      const armed = session.arm();
      armed.catch(() => {});
      await tick(20);
      Ws.last.frame(null);
      await expect(armed).rejects.toThrow(/without a type/);
    });
  });
});

/** A child whose stdin never reports a flush (a process that stopped reading), or one that drains. */
function fakeChild(drains: boolean) {
  const stdout = new PassThrough();
  let killed = 0;
  const stdin = drains
    ? new PassThrough()
    : Object.assign(new EventEmitter(), {
        write: (_b: Uint8Array, _cb?: () => void) => false,
        end() {},
      });
  if (drains) (stdin as PassThrough).on("data", () => {});
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    kill: () => {
      killed++;
      return true;
    },
  });
  return { child, killed: () => killed };
}

function fakeSocketClass() {
  class FakeWs {
    static last: FakeWs;
    static OPEN = 1;
    binaryType = "";
    readyState = 1;
    closed = 0;
    onopen?: () => void;
    onmessage?: (ev: { data: unknown }) => void;
    onerror?: () => void;
    onclose?: () => void;
    constructor(readonly url: string) {
      FakeWs.last = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send() {}
    close() {
      this.closed++;
    }
  }
  return FakeWs;
}

const MiB = new Uint8Array(1 << 20).buffer;

describe("unflushed bytes to the helper processes", () => {
  it("counts bytes until the write callback runs", () => {
    const held: (() => void)[] = [];
    const b = new StdinBudget(10);
    const stdin = { write: (_c: Uint8Array, cb: () => void) => held.push(cb) };
    expect(b.write(stdin, new Uint8Array(6))).toBe(true);
    expect(b.write(stdin, new Uint8Array(6))).toBe(false);
    held.shift()!();
    expect(b.pending).toBe(0);
    expect(b.write(stdin, new Uint8Array(10))).toBe(true);
    expect(MAX_UNFLUSHED_STDIN).toBe(32 << 20);
  });

  it("cu-2pc: fails past 32 MiB unread, closing the socket and killing the process", async () => {
    const { child, killed } = fakeChild(false);
    const Ws = fakeSocketClass();
    const s = new TwoPcSession({ binaryPath: "/fake/cu-2pc", spawnImpl: (() => child) as never, webSocketImpl: Ws as never });
    s.start("ws://node/zk?proof=twopc");
    const ks = s.keyShare(5_000);
    ks.catch(() => {});
    await tick();
    // Each 1 MiB message is a frame of 1 MiB + 5 bytes on cu-2pc's stdin.
    for (let i = 0; i < 31; i++) Ws.last.onmessage?.({ data: MiB });
    expect(s.failed).toBe(false);
    Ws.last.onmessage?.({ data: MiB });
    expect(s.failed).toBe(true);
    await expect(ks).rejects.toThrow(/not yet read/);
    expect(Ws.last.closed).toBe(1);
    expect(killed()).toBe(1);
  });

  it("cu-2pc: a process that keeps reading is not limited", async () => {
    const { child } = fakeChild(true);
    const Ws = fakeSocketClass();
    const s = new TwoPcSession({ binaryPath: "/fake/cu-2pc", spawnImpl: (() => child) as never, webSocketImpl: Ws as never });
    s.start("ws://node/zk?proof=twopc");
    await tick();
    for (let i = 0; i < 40; i++) {
      Ws.last.onmessage?.({ data: MiB });
      await tick(0);
    }
    expect(s.failed).toBe(false);
    s.close();
  });

  it("proof channel: fails past 32 MiB unread, closing the socket and killing the process", async () => {
    const { child, killed } = fakeChild(false);
    const Ws = fakeSocketClass();
    const c = new ProofChannel({ binaryPath: "/fake/cu-prover", spawnImpl: (() => child) as never, webSocketImpl: Ws as never });
    c.start("ws://node/zk?proof=zkchan");
    await tick();
    for (let i = 0; i < 33; i++) Ws.last.onmessage?.({ data: MiB });
    expect(c.failed).toBe(true);
    expect(c.failure).toBeInstanceOf(ProverError);
    expect(await c.ready(100)).toBe(false);
    expect(Ws.last.closed).toBe(1);
    expect(killed()).toBe(1);
  });

  it("per-proof prover: fails the proof past 32 MiB unread", async () => {
    const { child, killed } = fakeChild(false);
    const Ws = fakeSocketClass();
    const real = (globalThis as { WebSocket: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = Ws;
    try {
      const prover = new CuProverBackend({ binaryPath: "/fake/cu-prover", spawnImpl: (() => child) as never });
      const run = prover.run("ws://node/zk?proof=pi_c3s", { proof: "pi_c3s", role: "prover", params: {} }, 5_000);
      run.catch(() => {});
      await tick();
      for (let i = 0; i < 33; i++) Ws.last.onmessage?.({ data: MiB });
      await expect(run).rejects.toThrow(/not yet read/);
      expect(killed()).toBe(1);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = real;
    }
  });

  it("per-proof prover: a write to an exited cu-prover fails the proof, never the process", async () => {
    // cu-prover exited early: the next write to its stdin is an EPIPE 'error'
    // event, which without a listener is an uncaught exception in the host.
    const { child, killed } = fakeChild(true);
    const Ws = fakeSocketClass();
    const real = (globalThis as { WebSocket: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = Ws;
    try {
      const prover = new CuProverBackend({ binaryPath: "/fake/cu-prover", spawnImpl: (() => child) as never });
      const run = prover.run("ws://node/zk?proof=pi_c3s", { proof: "pi_c3s", role: "prover", params: {} }, 5_000);
      run.catch(() => {});
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      // Before the proof socket opened, and after.
      expect(() => child.stdin.emit("error", epipe)).not.toThrow();
      await tick();
      expect(() => child.stdin.emit("error", epipe)).not.toThrow();
      child.emit("close", 1);
      await expect(run).rejects.toThrow(/cu-prover exited 1/);
      expect(killed()).toBe(1);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = real;
    }
  });

  it("per-proof prover: a spawn failure reported before the proof socket opens fails the proof", async () => {
    const { child } = fakeChild(true);
    const Ws = fakeSocketClass();
    const real = (globalThis as { WebSocket: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = Ws;
    try {
      const prover = new CuProverBackend({ binaryPath: "/fake/cu-prover", spawnImpl: (() => child) as never });
      const run = prover.run("ws://node/zk?proof=pi_nk", { proof: "pi_nk", role: "verifier", params: {} }, 5_000);
      run.catch(() => {});
      // Node reports a missing binary as an 'error' event after spawn() returned.
      expect(() => child.emit("error", new Error("spawn /fake/cu-prover ENOENT"))).not.toThrow();
      await expect(run).rejects.toThrow(/ENOENT/);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = real;
    }
  });
});

describe("session wait timers", () => {
  it("do not keep the process alive after the wait they bounded", async () => {
    // Each wait of a session races a timer of up to 60 s that is never
    // cleared: left ref'd, a script could not exit for a minute after its
    // last request.
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const p = timeout(20, "ready");
      const handle = spy.mock.results[spy.mock.results.length - 1]!.value as { hasRef?: () => boolean };
      expect(typeof handle.hasRef).toBe("function");
      expect(handle.hasRef!()).toBe(false);
      // It still fires while something else keeps the process running.
      await expect(p).rejects.toThrow(/timeout waiting for ready/);
    } finally {
      spy.mockRestore();
    }
  });
});
