/**
 * `http: 2` sessions (protocol v3, option A): the HTTP/2 layer against the
 * vectors the sidecar's tests generate (`fixtures/h2-vectors.json`, the
 * reference client's copy: `cargo test -p cu-sidecar client_vectors`), the
 * client-side checks of π_NK and π_WIN parameters, the offer's `h2` block,
 * and the connection pool.
 */

import { describe, expect, it, vi } from "vitest";
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
  errorHeadPrefixProblem,
  frame,
  frameHeader,
  h2Head,
  huffmanDecode,
  requestBlock,
  requestStream,
  splitBody,
  type WinSource,
} from "../../client/confidential/h2";
import { MAX_BODY_LEN, padBody, paddedBodyLength } from "../../client/confidential/suffix";
import { ConnectionPool, PoolBusyError, poolIdleMs, poolKey } from "../../client/confidential/pool";
import { ConfidentialTimeoutError, ConnectionDepositError } from "../../client/confidential/errors";
import { http2OpenFailure } from "../../client/confidential/transport";
import { offerSupportsHttp2, verifyConfidentialOffer } from "../../client/confidential/offer";
import { ConfidentialConnection, connectionTerms } from "../../client/confidential/connection";
import { CuProverBackend } from "../../client/confidential/prover";
import { deriveTrafficKeysForSide } from "../../client/confidential/tls-fork/lib/utils/decryption-utils.js";
import { encryptWrappedRecord } from "../../client/confidential/tls-fork/lib/utils/wrapped-record.js";

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

  it("refuses a frame above 16 KiB (FRAME_SIZE_ERROR) as soon as its header arrives", () => {
    // The node's head never raises SETTINGS_MAX_FRAME_SIZE above the default 2^14.
    const ok = new FrameReader();
    expect(ok.push(frame(FRAME.DATA, 0, 3, new Uint8Array(16384)), 0)).toHaveLength(1);
    const rd = new FrameReader();
    const big = frameHeader((1 << 24) - 1, FRAME.DATA, 0, 3);
    const t0 = Date.now();
    expect(() => rd.push(big, 0)).toThrow(/FRAME_SIZE_ERROR/);
    expect(Date.now() - t0).toBeLessThan(100);
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
    http: ["2", "1.1"],
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

  it("fills the block's defaults and holds the connection lifetime to its range", () => {
    expect(checkH2Offer(offer, bases)).toEqual({
      probe_path: "/api/v1/models",
      idle_secs: 300,
      max_requests: 100,
      max_lifetime_s: 3600,
      kinds: ["chat"],
    });
    expect(checkH2Offer({ ...offer, h2: { ...offer.h2, max_lifetime_s: 60 } }, bases).max_lifetime_s).toBe(60);
    for (const max_lifetime_s of [59, 86401, 12.5, "3600", null]) {
      expect(() => checkH2Offer({ ...offer, h2: { ...offer.h2, max_lifetime_s } }, bases)).toThrow(/max_lifetime_s/);
    }
  });

  it("the deposit and the idle timeout are the offer's own fields (§12.1), held to their ranges", () => {
    const node = (extra: Record<string, unknown>) => {
      const o = signedOffer({ http: ["2", "1.1"], h2: offer.h2, ...extra });
      return verifyConfidentialOffer(o.offer, policy(o.pubHex));
    };
    const v3 = node({ connection_deposit_msat: 7000, idle_timeout_s: 120 });
    expect(v3.connection_deposit_msat).toBe(7000);
    expect(v3.idle_timeout_s).toBe(120);
    // Absent: no deposit.
    expect(node({}).connection_deposit_msat).toBe(0);
    for (const connection_deposit_msat of [-1, 1.5, "7000", null, 2 ** 60]) {
      expect(() => node({ connection_deposit_msat })).toThrow(/connection_deposit_msat/);
    }
    for (const idle_timeout_s of [9, 12.5, "120", null]) {
      expect(() => node({ idle_timeout_s })).toThrow(/idle_timeout_s/);
    }
    // Longer than the sidecar's own limit: framing "2" is not used with that offer.
    expect(node({ idle_timeout_s: 301 }).http).toEqual(["1.1"]);
  });

  it("reads the request kinds: chat, or chat and images", () => {
    expect(checkH2Offer(offer, bases).kinds).toEqual(["chat"]);
    const kinds = (k: unknown) => () => checkH2Offer({ ...offer, h2: { ...offer.h2, kinds: k } }, bases);
    expect(kinds(["chat"])().kinds).toEqual(["chat"]);
    expect(kinds(["chat", "images"])().kinds).toEqual(["chat", "images"]);
    for (const bad of [[], ["images"], ["images", "chat"], ["chat", "video"], ["chat", "images", "images"], "chat", null]) {
      expect(kinds(bad), JSON.stringify(bad)).toThrow(/h2 kinds/);
    }
  });

  it("an image request needs a connection that serves images, an offered variant and a count in range", () => {
    const images = {
      head_template:
        "POST /api/v1/image/generate HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
        "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
      response_shape: "venice",
      response_idle_s: 300,
      max_count: 2,
      count_key: "variants",
      fixed_pins: [["return_binary", false]],
      param_space: { format: ["webp"] },
      price_list: { img: [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 12100 }] },
    };
    const open = (h2: Record<string, unknown>) => {
      const good = signedOffer({ http: ["2", "1.1"], h2, capabilities: ["chat", "images"], images });
      const conn = new ConfidentialConnection({
        baseUrl: "https://node.example",
        offer: verifyConfidentialOffer(good.offer, policy(good.pubHex)),
        framing: "2",
        auth: "sk-x",
        prover: new CuProverBackend({ binaryPath: "/nonexistent" }),
      });
      (conn as unknown as { phaseNow: string }).phaseNow = "ready";
      return conn;
    };
    const body = (suffix: string) => new TextEncoder().encode(`{"prompt":"x"${suffix}`);
    const sfx = ',"model":"img","variants":1,"return_binary":false,"format":"webp"}';
    const req = (conn: ConfidentialConnection, image: { variant: string; count: number }, b = body(sfx)) => () =>
      conn.request({ model: "img", maxTokens: 0, image, body: b });
    // A connection whose offer serves images only with framing "1.1".
    expect(req(open({ ...offer.h2 }), { variant: "webp", count: 1 })).toThrow(/no image requests on framing "2"/);
    const conn = open({ ...offer.h2, kinds: ["chat", "images"] });
    expect(req(conn, { variant: "png", count: 1 })).toThrow(/no variant png/);
    expect(req(conn, { variant: "webp", count: 3 })).toThrow(/outside 1\.\.2/);
    expect(req(conn, { variant: "webp", count: 0 })).toThrow(/outside 1\.\.2/);
    // The body must end with the image suffix of the signed offer (here: another count).
    expect(req(conn, { variant: "webp", count: 2 })).toThrow(/does not end with the pinned suffix/);
    expect(conn.requests).toBe(0);
  });

  it("the pool's idle time stays below the node's idle timeout", () => {
    // The default margin (20 s) below the node's timeout.
    expect(poolIdleMs(120_000)).toBe(100_000);
    // A caller's shorter idle time is kept; a longer one is clamped.
    expect(poolIdleMs(120_000, { maxIdleMs: 30_000 })).toBe(30_000);
    expect(poolIdleMs(120_000, { maxIdleMs: 600_000 })).toBe(100_000);
    expect(poolIdleMs(120_000, { idleMarginMs: 0, maxIdleMs: 600_000 })).toBe(120_000);
    // A short node timeout: the margin shrinks to a quarter of it.
    expect(poolIdleMs(12_000)).toBe(9_000);
  });

  it("refuses to open a connection whose deposit exceeds the client's maximum (both framings)", () => {
    const good = signedOffer({ http: ["2", "1.1"], h2: offer.h2, connection_deposit_msat: 7000, idle_timeout_s: 120 });
    const verified = verifyConfidentialOffer(good.offer, policy(good.pubHex));
    expect(verified.h2).toEqual({ ...offer.h2, max_lifetime_s: 3600, kinds: ["chat"] });
    for (const framing of ["2", "1.1"] as const) {
      const open = (maxDepositMsat?: number) =>
        new ConfidentialConnection({
          baseUrl: "https://node.example",
          offer: verified,
          framing,
          auth: "sk-x",
          prover: new CuProverBackend({ binaryPath: "/nonexistent" }),
          maxDepositMsat,
        });
      expect(open().depositMsat).toBe(7000);
      expect(open().nodeIdleMs).toBe(120_000);
      expect(open().maxRequests).toBe(framing === "2" ? 100 : 1);
      expect(open(7000).depositMsat).toBe(7000);
      let refused: unknown;
      try {
        open(6999);
      } catch (e) {
        refused = e;
      }
      expect(refused).toBeInstanceOf(ConnectionDepositError);
      expect((refused as ConnectionDepositError).depositMsat).toBe(7000);
      expect((refused as Error).message).toMatch(/7000 msat exceeds the client's maximum of 6999/);
    }
  });

  function signedOffer(overrides: Record<string, unknown> = {}) {
    const priv = new Uint8Array(32).fill(7);
    const pubHex = bytesToHex(schnorr.getPublicKey(priv));
    const o: Record<string, unknown> = {
      v: 3,
      twopc: "split-public-1",
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

  it("takes nothing from a record under the handshake traffic secret (the node holds s_hs)", async () => {
    // Application data is not in the handshake transcript: a node could put
    // its own HTTP/2 frames (a SETTINGS shrinking our window, a HEADERS)
    // between the ServerHello and the real server flight.
    const good = signedOffer({ http: ["2", "1.1"], h2: offer.h2 });
    const conn = new ConfidentialConnection({
      baseUrl: "https://node.example",
      offer: verifyConfidentialOffer(good.offer, policy(good.pubHex)),
      auth: "sk-x",
      prover: new CuProverBackend({ binaryPath: "/nonexistent" }),
    });
    const internals = conn as unknown as {
      makeTls(external: unknown): void;
      tls: { startHandshake(): Promise<void>; handleReceivedBytes(b: Uint8Array): Promise<void> };
      gotSettings: boolean;
      initialWindow: number;
    };
    const point = async () => {
      const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      return new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    };
    const sHs = crypto.getRandomValues(new Uint8Array(32));
    internals.makeTls({
      keyShare: await point(),
      onServerHello: async () => ({ clientHs: crypto.getRandomValues(new Uint8Array(32)), serverHs: sHs }),
      onServerFinished: async () => ({
        serverAp0: crypto.getRandomValues(new Uint8Array(32)),
        clientAp1: crypto.getRandomValues(new Uint8Array(32)),
      }),
    });
    const windowBefore = internals.initialWindow;
    await internals.tls.startHandshake();
    const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
    const ext = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];
    const exts = [...ext(0x002b, [0x03, 0x04]), ...ext(0x0033, [0x00, 0x17, ...u16(65), ...Array.from(await point())])];
    const sh = [0x03, 0x03, ...Array.from(crypto.getRandomValues(new Uint8Array(32))), 0x00, 0x13, 0x01, 0x00, ...u16(exts.length), ...exts];
    await internals.tls.handleReceivedBytes(
      new Uint8Array([0x16, 0x03, 0x03, ...u16(sh.length + 4), 0x02, 0x00, ...u16(sh.length), ...sh]),
    );
    // SETTINGS with INITIAL_WINDOW_SIZE = 1, as application data under s_hs.
    const settings = frame(FRAME.SETTINGS, 0, 0, new Uint8Array([0x00, 0x04, 0x00, 0x00, 0x00, 0x01]));
    const { encKey, iv } = await deriveTrafficKeysForSide(sHs, "TLS_AES_128_GCM_SHA256");
    const { ciphertext } = (await encryptWrappedRecord(new Uint8Array([...settings, 0x17]), {
      key: encKey,
      iv,
      recordNumber: 0,
      cipherSuite: "TLS_AES_128_GCM_SHA256",
      version: "TLS1_3",
      recordHeaderOpts: { type: "WRAPPED_RECORD", version: "TLS1_2" },
    } as never)) as { ciphertext: Uint8Array };
    await expect(
      internals.tls.handleReceivedBytes(new Uint8Array([0x17, 0x03, 0x03, ...u16(ciphertext.length), ...ciphertext])),
    ).rejects.toThrow(/application data before the handshake completed/);
    expect(internals.gotSettings).toBe(false);
    expect(internals.initialWindow).toBe(windowBefore);
    conn.close();
  });

  it("a verified offer serves http 2 only when it lists it with a valid block", () => {
    const plain = signedOffer();
    expect(offerSupportsHttp2(verifyConfidentialOffer(plain.offer, policy(plain.pubHex)))).toBe(false);

    const good = signedOffer({ http: ["2", "1.1"], h2: offer.h2 });
    const verified = verifyConfidentialOffer(good.offer, policy(good.pubHex));
    expect(offerSupportsHttp2(verified)).toBe(true);
    // The node's two terms default to "no deposit" and the sidecar's idle limit.
    expect(verified.h2).toEqual({ ...offer.h2, max_lifetime_s: 3600, kinds: ["chat"] });
    expect(verified.http).toEqual(["2", "1.1"]);
    expect(verified.http2Refused).toBeUndefined();
    // Verifying a verified offer again (the transport's cache) keeps it.
    expect(offerSupportsHttp2(verifyConfidentialOffer(verified, policy(good.pubHex)))).toBe(true);

    const only11 = signedOffer({ http: ["1.1"] });
    expect(offerSupportsHttp2(verifyConfidentialOffer(only11.offer, policy(only11.pubHex)))).toBe(false);
  });

  it("a bad h2 block switches framing 2 off and leaves the offer usable with 1.1", () => {
    for (const h2 of [
      { ...offer.h2, probe_path: "/api/v1/api_keys" },
      { ...offer.h2, idle_secs: 5 },
      undefined,
    ]) {
      const bad = signedOffer(h2 ? { http: ["2", "1.1"], h2 } : { http: ["2", "1.1"] });
      const verified = verifyConfidentialOffer(bad.offer, policy(bad.pubHex));
      expect(offerSupportsHttp2(verified)).toBe(false);
      expect(verified.http).toEqual(["1.1"]);
      expect(verified.http2Refused).toBeTruthy();
      expect(verified.price_list.cheap).toBeDefined();
    }
    // A probe under another API base than the trusted host entry allows.
    const other = signedOffer({ http: ["2", "1.1"], h2: { ...offer.h2, probe_path: "/v1/models" } });
    const verified = verifyConfidentialOffer(other.offer, {
      pinnedPubkey: other.pubHex,
      trustedHosts: ["api.venice.ai/api/v1"],
    });
    expect(offerSupportsHttp2(verified)).toBe(false);
  });

  it("a re-signed offer with other rates keeps the connection terms; another route or h2 block does not", () => {
    const h2 = offer.h2;
    const first = signedOffer({ http: ["2", "1.1"], h2 });
    const a = verifyConfidentialOffer(first.offer, policy(first.pubHex));
    const repriced = signedOffer({ http: ["2", "1.1"], h2, price_list: { cheap: { in: 1100, cached_in: 1100, out: 1200 } }, session_fee_msat: 5 });
    const b = verifyConfidentialOffer(repriced.offer, policy(repriced.pubHex));
    expect(a.sig).not.toBe(b.sig);
    expect(connectionTerms(b)).toBe(connectionTerms(a));
    const key = (o: typeof a) => poolKey({ baseUrl: "https://n", bearer: "sk", scope: connectionTerms(o) });
    expect(key(b)).toBe(key(a));
    const otherIdle = signedOffer({ http: ["2", "1.1"], h2: { ...h2, idle_secs: 60 } });
    expect(connectionTerms(verifyConfidentialOffer(otherIdle.offer, policy(otherIdle.pubHex)))).not.toBe(connectionTerms(a));
    // The other connection-level fields of §12.1: the deposit, the idle timeout, the chat block.
    for (const extra of [{ connection_deposit_msat: 5 }, { idle_timeout_s: 60 }]) {
      const o = signedOffer({ http: ["2", "1.1"], h2, ...extra });
      expect(connectionTerms(verifyConfidentialOffer(o.offer, policy(o.pubHex)))).not.toBe(connectionTerms(a));
    }
    const otherKeyLen = signedOffer({
      http: ["2", "1.1"],
      h2,
      key_length: 40,
      head_template: (first.offer.head_template as string).replace("{KEY:42}", "{KEY:40}"),
    });
    const c = verifyConfidentialOffer(otherKeyLen.offer, policy(otherKeyLen.pubHex));
    expect(connectionTerms(c)).not.toBe(connectionTerms(a));
    expect(key(c)).not.toBe(key(a));
  });

  it("a connection refuses a framing the offer does not list, before anything is sent", () => {
    const plain = signedOffer();
    const verified = verifyConfidentialOffer(plain.offer, policy(plain.pubHex));
    const open = (framing?: "2" | "1.1") =>
      new ConfidentialConnection({
        baseUrl: "http://127.0.0.1:1",
        offer: verified,
        framing,
        auth: "sk-test",
        prover: new CuProverBackend({ binaryPath: "/nonexistent/cu-prover" }),
      });
    expect(() => open("2")).toThrow(/does not serve framing "2"/);
    // Without a choice: the offer's first framing.
    expect(open().framing).toBe("1.1");
    const both = signedOffer({ http: ["2", "1.1"], h2: offer.h2 });
    const conn = new ConfidentialConnection({
      baseUrl: "http://127.0.0.1:1",
      offer: verifyConfidentialOffer(both.offer, policy(both.pubHex)),
      auth: "sk-test",
      prover: new CuProverBackend({ binaryPath: "/nonexistent/cu-prover" }),
    });
    expect(conn.framing).toBe("2");
    expect(conn.phase).toBe("new");
    expect(conn.idle).toBe(false);
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
  framing: "2" | "1.1";
  h2 = { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 3, max_lifetime_s: 3600, kinds: ["chat"] };
  maxRequests: number;
  nodeIdleMs = 120_000;
  depositMsat = 1000;
  requests = 0;
  settled = 0;
  tCreated = Date.now();
  tOpen = 0;
  tLastSettled = 0;
  busy = false;
  isArmed = false;
  dead?: Error;
  failConnect = false;
  failArm = false;
  private endedRes!: (e: Error) => void;
  ended = new Promise<Error>((r) => (this.endedRes = r));
  constructor(framing: "2" | "1.1" = "2") {
    this.framing = framing;
    this.maxRequests = framing === "2" ? 3 : 1;
  }
  get failureReason() {
    return this.dead;
  }
  get usable() {
    return !this.dead && (this.tOpen > 0 || this.isArmed) && this.requests < this.maxRequests;
  }
  get idle() {
    return this.usable && !this.busy;
  }
  get armed() {
    return this.isArmed && this.tOpen === 0 && this.usable;
  }
  async arm(_prewarm = false) {
    await new Promise((r) => setTimeout(r, 5));
    if (this.dead) throw this.dead;
    if (this.failArm) {
      this.close("arm failed");
      throw new Error("arm failed");
    }
    this.isArmed = true;
  }
  async connect() {
    if (!this.isArmed) await this.arm();
    await new Promise((r) => setTimeout(r, 5));
    if (this.failConnect) {
      this.close("connect failed");
      throw new Error("connect failed");
    }
    if (this.framing === "2") this.tOpen = this.tLastSettled = Date.now();
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
    this.settled++;
    this.tLastSettled = Date.now();
  }
}

describe("http 2: the connection pool", () => {
  const quiet = { log: () => {} };

  it("keys by node, credential and scope (§9.1)", () => {
    const a = { baseUrl: "https://n1/", bearer: "sk-a" };
    expect(poolKey(a)).toBe(poolKey({ ...a, baseUrl: "https://n1" }));
    expect(poolKey(a)).not.toBe(poolKey({ ...a, bearer: "sk-b" }));
    expect(poolKey(a)).not.toBe(poolKey({ ...a, baseUrl: "https://n2" }));
    expect(poolKey(a)).not.toBe(poolKey({ ...a, scope: "user-1" }));
    expect(poolKey({ ...a, scope: "user-1" })).not.toBe(poolKey({ ...a, scope: "user-2" }));
    expect(poolKey(a)).not.toContain("sk-a");
  });

  it("reuses an idle connection for sequential requests", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    for (let i = 0; i < 3; i++) {
      const lease = await pool.acquire("k", "2", open);
      expect(lease.reused).toBe(i > 0);
      lease.conn.start();
      lease.conn.finish();
      lease.release();
    }
    expect(conns).toHaveLength(1);
    // The connection reached the offer's request limit (3): it was closed.
    expect(conns[0]!.dead).toBeDefined();
    expect(pool.snapshot()).toHaveLength(0);
    const again = await pool.acquire("k", "2", open);
    expect(again.reused).toBe(false);
    expect(conns).toHaveLength(2);
    pool.close();
  });

  it("opens another connection for an overlapping request, and one per key", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    const [l1, l2] = await Promise.all([pool.acquire("k", "2", open), pool.acquire("k", "2", open)]);
    expect(l1.conn).not.toBe(l2.conn);
    expect(l1.reused || l2.reused).toBe(false);
    l1.conn.start();
    l2.conn.start();
    const other = await pool.acquire("other", "2", open);
    expect(conns).toHaveLength(3);
    l1.conn.finish();
    l1.release();
    const l3 = await pool.acquire("k", "2", open);
    expect(l3.conn).toBe(l1.conn);
    expect(l3.reused).toBe(true);
    expect(pool.snapshot().map((s) => s.state).sort()).toEqual(["busy", "busy", "busy"]);
    other.release();
    pool.close();
    expect(conns.every((c) => c.dead)).toBe(true);
  });

  it("waits at the per-key limit until a connection is free", async () => {
    const pool = new ConnectionPool<FakeConn>({ ...quiet, maxConnectionsPerKey: 1 });
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    const l1 = await pool.acquire("k", "2", open);
    l1.conn.start();
    let got = false;
    const second = pool.acquire("k", "2", open).then((l) => ((got = true), l));
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
    const pool = new ConnectionPool<FakeConn>({ ...quiet, maxConnectionsPerKey: 1, acquireTimeoutMs: 40 });
    const l1 = await pool.acquire("k", "2", () => new FakeConn());
    l1.conn.start();
    await expect(pool.acquire("k", "2", () => new FakeConn())).rejects.toThrow(/timeout/);
    pool.close();
  });

  it("a busy pool is not a failure of framing 2 (finding 19)", async () => {
    const pool = new ConnectionPool<FakeConn>({ ...quiet, maxConnectionsPerKey: 1, acquireTimeoutMs: 40 });
    const l1 = await pool.acquire("k", "2", () => new FakeConn());
    l1.conn.start();
    const error = await pool.acquire("k", "2", () => new FakeConn()).catch((e) => e);
    expect(error).toBeInstanceOf(PoolBusyError);
    expect(error).toBeInstanceOf(ConfidentialTimeoutError);
    // No §2.3 fallback, no bad mark.
    expect(http2OpenFailure(error)).toBe(false);
    pool.close();
  });

  it("an idle connection of the key's other framing makes room at the per-key limit (finding 19)", async () => {
    const pool = new ConnectionPool<FakeConn>({ ...quiet, maxConnectionsPerKey: 1, acquireTimeoutMs: 40 });
    const l1 = await pool.acquire("k", "2", () => new FakeConn("2"));
    l1.conn.start();
    l1.conn.finish();
    l1.release(true);
    expect(pool.snapshot().map((e) => e.state)).toEqual(["idle"]);
    // Framing "2" is marked bad meanwhile: the key's next request runs on "1.1".
    const l2 = await pool.acquire("k", "1.1", () => new FakeConn("1.1"));
    expect(l2.conn.framing).toBe("1.1");
    expect(l1.conn.dead?.message).toMatch(/framing-"1.1" request/);
    l2.release();
    pool.close();
  });

  it("makes room at the total limit by closing another key's idle connection", async () => {
    const pool = new ConnectionPool<FakeConn>({ ...quiet, maxConnections: 1 });
    const a = await pool.acquire("a", "2", () => new FakeConn());
    a.conn.start();
    a.conn.finish();
    a.release();
    const b = await pool.acquire("b", "2", () => new FakeConn());
    expect(a.conn.dead).toBeDefined();
    expect(b.reused).toBe(false);
    pool.close();
  });

  it("never hands out a connection that died while idle", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    const l1 = await pool.acquire("k", "2", () => new FakeConn());
    l1.conn.start();
    l1.conn.finish();
    l1.release();
    l1.conn.close("the node's idle limit");
    const l2 = await pool.acquire("k", "2", () => new FakeConn());
    expect(l2.conn).not.toBe(l1.conn);
    expect(l2.reused).toBe(false);
    pool.close();
  });

  it("does not keep a connection whose request failed, or with reuse off", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    const l1 = await pool.acquire("k", "2", () => new FakeConn());
    l1.conn.start();
    l1.conn.close("request failed");
    l1.release();
    expect(pool.snapshot()).toHaveLength(0);

    const none = new ConnectionPool<FakeConn>({ ...quiet, reuse: "none" });
    const l2 = await none.acquire("k", "2", () => new FakeConn());
    l2.conn.start();
    l2.conn.finish();
    l2.release();
    expect(l2.conn.dead).toBeDefined();
    expect(none.snapshot()).toHaveLength(0);
  });

  it("never hands out a kept connection once reuse is none (acquisition, not only release)", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    const l1 = await pool.acquire("k", "2", () => new FakeConn());
    l1.conn.start();
    l1.conn.finish();
    l1.release(true);
    expect(pool.snapshot()).toHaveLength(1); // kept idle under "shared"
    const kept = l1.conn;
    pool.configure({ ...quiet, reuse: "none" });
    expect(kept.dead).toBeDefined();
    const l2 = await pool.acquire("k", "2", () => new FakeConn());
    expect(l2.reused).toBe(false);
    expect(l2.conn).not.toBe(kept);
    l2.release();
    pool.close();
  });

  it("keeps each acquisition's reuse policy, whatever a later call configures (shared, none, shared)", async () => {
    const limits = { ...quiet, maxConnectionsPerKey: 1 };
    const pool = new ConnectionPool<FakeConn>(limits);
    const conns: FakeConn[] = [];
    const open = () => (conns.push(new FakeConn()), conns[conns.length - 1]!);
    // 1. A shared request holds the key's only connection.
    const first = await pool.acquire("k", "2", open, undefined, "shared");
    first.conn.start();
    // 2. A request with reuse none arrives and waits for the per-key limit.
    pool.configure({ ...limits, reuse: "none" });
    let none: Awaited<ReturnType<typeof pool.acquire>> | undefined;
    const waiting = pool.acquire("k", "2", open, undefined, "none").then((l) => (none = l));
    await new Promise((r) => setTimeout(r, 20));
    expect(none).toBeUndefined();
    // 3. A later shared call reconfigures the process-wide pool.
    pool.configure({ ...limits, reuse: "shared" });
    // The first request settles: its lease is shared, so its connection is kept.
    first.conn.finish();
    first.release(true);
    await waiting;
    // The none request never takes the connection another request used.
    expect(none!.conn).not.toBe(first.conn);
    expect(none!.reused).toBe(false);
    expect(first.conn.dead).toBeDefined(); // made room at the per-key limit
    none!.conn.start();
    none!.conn.finish();
    none!.release(true);
    // ...and its own connection is closed after it, although the pool now says shared.
    expect(none!.conn.dead).toBeDefined();
    expect(pool.snapshot()).toHaveLength(0);
    // A shared request after that opens a fresh one and keeps it.
    const later = await pool.acquire("k", "2", open, undefined, "shared");
    expect(later.reused).toBe(false);
    later.conn.start();
    later.conn.finish();
    later.release(true);
    expect(pool.snapshot().map((e) => e.state)).toEqual(["idle"]);
    expect(conns).toHaveLength(3);
    pool.close();
  });

  it("closes an idle connection before the node's idle limit, and after maxRequestsPerConnection", async () => {
    const pool = new ConnectionPool<FakeConn>({ ...quiet, maxIdleMs: 30, maxRequestsPerConnection: 2 });
    const l1 = await pool.acquire("k", "2", () => new FakeConn());
    l1.conn.start();
    l1.conn.finish();
    l1.release();
    expect(pool.snapshot()[0]!.state).toBe("idle");
    await new Promise((r) => setTimeout(r, 80));
    expect(l1.conn.dead).toBeDefined();
    expect(pool.snapshot()).toHaveLength(0);

    const l2 = await pool.acquire("k", "2", () => new FakeConn());
    l2.conn.start();
    l2.conn.finish();
    l2.release();
    const l3 = await pool.acquire("k", "2", () => new FakeConn());
    expect(l3.conn).toBe(l2.conn);
    l3.conn.start();
    l3.conn.finish();
    l3.release();
    expect(l2.conn.dead?.message).toMatch(/request limit/);
    pool.close();
  });

  it("surfaces a failed connect and forgets the connection", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    await expect(
      pool.acquire("k", "2", () => {
        const c = new FakeConn();
        c.failConnect = true;
        return c;
      }),
    ).rejects.toThrow(/connect failed/);
    expect(pool.snapshot()).toHaveLength(0);
  });

  it("respects an aborted caller", async () => {
    const pool = new ConnectionPool<FakeConn>(quiet);
    const ac = new AbortController();
    ac.abort(new Error("gone"));
    await expect(pool.acquire("k", "2", () => new FakeConn(), ac.signal)).rejects.toThrow(/gone/);
  });

  describe("armed spares (§9.2)", () => {
    const prewarm = { log: () => {}, backoffBaseMs: 20 };
    const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
    /** One settled request of `key` on `framing`, announced to the pool as the transport does. */
    async function request(pool: ConnectionPool<FakeConn>, key: string, framing: "2" | "1.1", conns: FakeConn[], o: { deposit?: number; prewarmable?: boolean; hold?: boolean } = {}) {
      const open = (f: "2" | "1.1") => (conns.push(new FakeConn(f)), conns[conns.length - 1]!);
      const traffic = pool.noteRequest(key, { baseUrl: "https://n", framing, depositMsat: o.deposit ?? 1000, prewarmable: o.prewarmable ?? true }, open);
      const lease = await pool.acquire(key, framing, open);
      lease.conn.start();
      const finish = () => {
        lease.conn.finish();
        lease.release(true);
        traffic.done();
      };
      if (!o.hold) finish();
      return { lease, finish };
    }

    it("framing 1.1: one spare per key after a settled request; the next request claims it and it is replaced", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      const first = await request(pool, "k", "1.1", conns);
      expect(first.lease.warm).toBe("cold");
      await tick();
      expect(pool.snapshot().map((s) => [s.http, s.state])).toEqual([["1.1", "armed"]]);
      const second = await request(pool, "k", "1.1", conns);
      expect(second.lease.warm).toBe("armed");
      expect(second.lease.reused).toBe(false);
      expect(second.lease.conn).toBe(conns[1]);
      await tick();
      // Never more than one spare for the key.
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      expect(conns).toHaveLength(3);
      pool.close();
    });

    it("a request that arrives while the spare is still arming waits for it", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      await request(pool, "k", "1.1", conns);
      // The arm has started (5 ms) and not finished.
      expect(pool.snapshot().map((s) => s.state)).toEqual(["arming"]);
      const second = await request(pool, "k", "1.1", conns);
      expect(second.lease.conn).toBe(conns[1]);
      expect(second.lease.warm).toBe("cold");
      pool.close();
    });

    it("framing 2: no spare while a connection of the key is idle; one while all are busy", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      await request(pool, "k", "2", conns);
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["idle"]);
      const busy = await request(pool, "k", "2", conns, { hold: true });
      expect(busy.lease.warm).toBe("open");
      await tick();
      expect(pool.snapshot().map((s) => s.state).sort()).toEqual(["armed", "busy"]);
      // The burst's second request does not wait for a 2PC.
      const burst = await request(pool, "k", "2", conns, { hold: true });
      expect(burst.lease.warm).toBe("armed");
      expect(burst.lease.conn.tOpen).toBeGreaterThan(0);
      busy.finish();
      burst.finish();
      pool.close();
    });

    it("no spare without pre-warming, for a key that is not prewarmable, before a settled request, or above maxDepositMsat", async () => {
      const off = new ConnectionPool<FakeConn>(quiet);
      const conns: FakeConn[] = [];
      await request(off, "k", "1.1", conns);
      await tick();
      expect(off.snapshot()).toEqual([]);
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      await request(pool, "one-off", "1.1", conns, { prewarmable: false });
      await request(pool, "dear", "1.1", conns, { deposit: 5001 });
      const held = await request(pool, "unsettled", "1.1", conns, { hold: true });
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["busy"]);
      held.finish();
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      pool.close();
    });

    it("a failed arm backs the key off; a deposit the balance does not cover retries without escalating", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      let fail = true;
      const open = (f: "2" | "1.1") => {
        const c = new FakeConn(f);
        c.failArm = fail && conns.length > 0;
        conns.push(c);
        return c;
      };
      const traffic = pool.noteRequest("k", { baseUrl: "https://n", framing: "1.1", depositMsat: 1000, prewarmable: true }, open);
      const lease = await pool.acquire("k", "1.1", open);
      lease.conn.start();
      lease.conn.finish();
      lease.release(true);
      traffic.done();
      await tick(12);
      // The arm failed: nothing armed, and no new attempt during the backoff.
      expect(pool.snapshot()).toEqual([]);
      const attempts = conns.length;
      fail = false;
      pool.noteRequest("k", { baseUrl: "https://n", framing: "1.1", depositMsat: 1000, prewarmable: true }, open).done();
      expect(conns.length).toBe(attempts);
      await tick(30);
      pool.noteRequest("k", { baseUrl: "https://n", framing: "1.1", depositMsat: 1000, prewarmable: true }, open).done();
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      pool.close();
    });

    it("retires a spare whose key went quiet or that is too old, and counts its deposit", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, { ...prewarm, activityWindowMs: 30, tickMs: 10 } as never);
      const conns: FakeConn[] = [];
      await request(pool, "k", "1.1", conns);
      await tick(15);
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      await tick(60);
      expect(pool.snapshot()).toEqual([]);
      expect(conns[1]!.dead?.message).toMatch(/armed and unused: its key has no traffic/);
      expect(pool.unusedDepositMsats).toBe(1000);
      pool.close();
    });

    it("a spare that died is not handed out, and a claimed 1.1 spare that fails to arm is replaced by a fresh connection", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      await request(pool, "k", "1.1", conns);
      await tick();
      conns[1]!.close("the node ended it");
      const next = await request(pool, "k", "1.1", conns);
      expect(next.lease.conn).not.toBe(conns[1]);
      expect(next.lease.warm).toBe("cold");
      pool.close();
    });

    it("keeps an armed connection whose request was refused, also with pre-warming off (finding 23)", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet);
      const conns: FakeConn[] = [];
      const open = (f: "2" | "1.1") => (conns.push(new FakeConn(f)), conns[conns.length - 1]!);
      const traffic = pool.noteRequest("k", { baseUrl: "https://n", framing: "1.1", depositMsat: 1000, prewarmable: true }, open);
      const refused = await pool.acquire("k", "1.1", open);
      // The node refused request 1 (402): nothing was released, the connection is still armed.
      refused.release();
      traffic.done();
      expect(conns[0]!.dead).toBeUndefined();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      // The retry (after a top-up) runs on it: no second 2PC, no second deposit.
      const retry = await pool.acquire("k", "1.1", open);
      expect(retry.conn).toBe(conns[0]);
      expect(retry.warm).toBe("armed");
      expect(conns).toHaveLength(1);
      pool.close();
    });

    it("another caller's request without prewarm does not close the spares (finding 23)", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      await request(pool, "k", "1.1", conns);
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      pool.configure(quiet, undefined);
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      expect(conns[1]!.dead).toBeUndefined();
      pool.close();
    });

    it("a spare that aged out is not replaced until the key has a request again (finding 24)", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      await request(pool, "k", "1.1", conns);
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      // The spare reaches maxAgeMs while the key is still within its activity window.
      conns[1]!.tCreated -= 500_000;
      (pool as any).housekeeping();
      await tick();
      expect(pool.snapshot()).toEqual([]);
      expect(conns).toHaveLength(2);
      expect(pool.unusedDepositMsats).toBe(1000);
      // The key's next request settles: a spare is armed again.
      await request(pool, "k", "1.1", conns);
      await tick();
      expect(pool.snapshot().map((s) => s.state)).toEqual(["armed"]);
      pool.close();
    });

    it("forgets the state of one-off keys and of keys it never pre-warms (finding 25)", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      for (let i = 0; i < 50; i++) await request(pool, `one-off-${i}`, "1.1", conns, { prewarmable: false });
      expect((pool as any).keys.size).toBe(0);
      const off = new ConnectionPool<FakeConn>(quiet);
      await request(off, "k", "2", conns);
      expect((off as any).keys.size).toBe(0);
      expect(off.snapshot().map((s) => s.state)).toEqual(["idle"]);
      pool.close();
      off.close();
    });

    it("marking framing 2 bad for a node closes its framing-2 spares and holds for 10 minutes", async () => {
      const pool = new ConnectionPool<FakeConn>(quiet, prewarm);
      const conns: FakeConn[] = [];
      await request(pool, "k", "2", conns);
      const busy = await request(pool, "k", "2", conns, { hold: true });
      await tick();
      expect(pool.snapshot().map((s) => s.state).sort()).toEqual(["armed", "busy"]);
      expect(pool.isBad("https://n/")).toBe(false);
      pool.markBad("https://n", "h2 not selected");
      expect(pool.isBad("https://n/")).toBe(true);
      expect(pool.isBad("https://other")).toBe(false);
      expect(pool.snapshot().map((s) => s.state)).toEqual(["busy"]);
      vi.useFakeTimers({ now: Date.now() + 10 * 60_000 + 1, toFake: ["Date"] });
      try {
        expect(pool.isBad("https://n")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
      busy.finish();
      pool.close();
    });
  });
});


describe("http 2: the error head's record prefix and the body-size bucket", () => {
  it("discloses only frames that carry nothing of ours before a response head", () => {
    const wu = (st: number) => frame(FRAME.WINDOW_UPDATE, 0, st, new Uint8Array([0, 0, 1, 0]));
    const ping = frame(FRAME.PING, FLAG.ACK, 0, new Uint8Array(8));
    const probe = frame(FRAME.DATA, FLAG.END_STREAM, 1, new TextEncoder().encode('{"data":[]}'));
    const cat = (...xs: Uint8Array[]) => Uint8Array.from(xs.flatMap((x) => [...x]));
    expect(errorHeadPrefixProblem(new Uint8Array(0), 3)).toBeUndefined();
    expect(errorHeadPrefixProblem(cat(wu(0), wu(3), ping, probe, frame(FRAME.SETTINGS, FLAG.ACK, 0)), 3)).toBeUndefined();
    expect(errorHeadPrefixProblem(frame(FRAME.DATA, 0, 3, new Uint8Array([1])), 3)).toMatch(/type 0 on stream 3/);
    expect(errorHeadPrefixProblem(wu(5), 3)).toBeDefined();
    expect(errorHeadPrefixProblem(ping.subarray(0, 12), 3)).toMatch(/runs into/);
  });

  it("pads to the bucket with whitespace before the suffix (off by default)", () => {
    const enc = new TextEncoder();
    const body = enc.encode('{"messages":[],"model":"m"}');
    const sfx = ',"model":"m"}'.length;
    expect(padBody(body, sfx, undefined)).toBe(body);
    const p = padBody(body, sfx, 64);
    expect(p.length).toBe(64);
    expect(JSON.parse(new TextDecoder().decode(p))).toEqual({ messages: [], model: "m" });
    expect(new TextDecoder().decode(p).endsWith(' ,"model":"m"}')).toBe(true);
    expect(paddedBodyLength(5000, "pow2")).toBe(8192);
    expect(paddedBodyLength(100, "pow2")).toBe(1024);
    expect(paddedBodyLength(MAX_BODY_LEN - 1, "pow2")).toBe(MAX_BODY_LEN);
    expect(() => paddedBodyLength(10, 3)).toThrow(/bucket/);
  });
});
