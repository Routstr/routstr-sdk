/**
 * The confidential transport's choice between `http: 2` connections
 * (protocol v3, option A) and the v2 flow, connection reuse, and what a
 * failure does before and after a request was released.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { VENICE_CHAT } from "./fixtures/chat";
import { canonicalJson } from "../../client/confidential/canonical";
import { chatSuffixKeys } from "../../client/confidential/suffix";
import {
  closeConfidentialHttp2,
  closeConfidentialPrewarm,
  confidentialHttp2Snapshot,
  fetchConfidential,
} from "../../client/confidential/transport";
import { SessionRejectedError } from "../../client/confidential/errors";
import { ConfidentialSession } from "../../client/confidential/session";
import { ConfidentialH2Connection, type H2RequestOptions } from "../../client/confidential/h2conn";

const priv = new Uint8Array(32).fill(7);
const pubHex = bytesToHex(schnorr.getPublicKey(priv));

function offer(extra: Record<string, unknown>): Record<string, unknown> {
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
    suffix_keys: chatSuffixKeys(VENICE_CHAT),
    chat: VENICE_CHAT,
    price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
    ...extra,
  };
  const payload = canonicalJson(o);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv));
  return { ...o, sig, sig_payload: payload };
}
const H2 = { http: ["1.1", "2"], h2: { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 100 } };

const IMAGES = {
  head_template:
    "POST /api/v1/image/generate HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
    "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n",
  response_shape: "venice",
  response_idle_s: 300,
  max_count: 4,
  count_key: "variants",
  fixed_pins: [["return_binary", false]],
  param_space: { format: ["webp"] },
  price_list: { "z-image-turbo": [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 12100 }] },
};
/** An offer that serves images, and (with `kinds`) serves them on `http: 2` connections too. */
const H2_IMAGES = {
  http: ["1.1", "2"],
  h2: { ...H2.h2, kinds: ["chat", "images"] },
  capabilities: ["chat", "images"],
  images: IMAGES,
};
const IMAGE_BODY = JSON.stringify({ id: "x", images: ["aGVsbG8="], request: { model: "z-image-turbo", variants: 1 } });

const realFetch = globalThis.fetch;
function mockNode(extra: Record<string, unknown> = H2) {
  globalThis.fetch = (async () => new Response(JSON.stringify(offer(extra)), { status: 200 })) as typeof fetch;
}

const enc = (t: string) => new TextEncoder().encode(t);
const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

type Behaviour = (conn: any, n: number, opts: H2RequestOptions) => { released?: boolean; fail?: Error; wait?: Promise<void> };

/** Stand-ins for the connection's network side: `connect` opens at once, `request` follows `behave`. */
function fakeConnections(behave: Behaviour = () => ({})) {
  let sids = 0;
  const connect = vi.spyOn(ConfidentialH2Connection.prototype, "connect").mockImplementation(async function (this: any) {
    this.opened = true;
    this.tOpen = this.tLastSettled = Date.now();
    this.sid = (++sids).toString(16).padStart(64, "0");
  });
  const request = vi.spyOn(ConfidentialH2Connection.prototype, "request").mockImplementation(function (
    this: any,
    opts: H2RequestOptions,
  ) {
    const conn = this;
    if (!conn.idle) throw conn.failure ?? new SessionRejectedError("the http: 2 connection is not idle");
    const n = ++conn.requests;
    conn.cur = { n };
    const b = behave(conn, n, opts);
    let settled = false;
    const done = (async () => {
      await b.wait;
      if (b.fail) {
        conn.fail(b.fail);
        throw b.fail;
      }
      const image = opts.image !== undefined;
      const type = image ? "application/json" : "text/event-stream";
      opts.onResponseHead?.({ status: 200, statusText: "", headers: { "content-type": type } });
      opts.onResponseBody?.(enc(image ? IMAGE_BODY : SSE));
      conn.cur = undefined;
      conn.tLastSettled = Date.now();
      settled = true;
      return {
        sid: conn.sid,
        n,
        stream: 2 * n + 1,
        model: opts.model,
        status: 200,
        headers: { "content-type": type },
        body: enc(image ? IMAGE_BODY : SSE),
        receipt: { sid: conn.sid, model: opts.model, usage: {}, cost_msats: image ? 12100 : undefined },
        attestation: {},
        timings: { startedAt: Date.now(), totalMs: 1, proofs: [] },
        bytes: { relaySent: 1, relayRecv: 2, controlSent: 3, controlRecv: 4, twoPcSent: 0, twoPcRecv: 0, zkSent: 5, zkRecv: 6 },
      };
    })();
    done.catch(() => {});
    return {
      n,
      sid: conn.sid,
      get bodyReleased() {
        return b.released === true;
      },
      credentialSent: true,
      done,
      close() {
        if (!settled) conn.close("request aborted");
      },
    } as never;
  });
  return { connect, request };
}

let node = 0;
const quiet = { log: () => {} };
function call(baseUrl: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return fetchConfidential({
    baseUrl,
    body: { model: "cheap", messages: [{ role: "user", content: "x" }] },
    bearer: "sk-x",
    options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex], http2: quiet, ...options },
    ...extra,
  });
}
const freshNode = () => `https://h2-${++node}.example`;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  closeConfidentialHttp2();
  closeConfidentialPrewarm();
});

describe("http 2 transport: when it is used", () => {
  it("runs sequential requests on one connection when the offer lists http 2", async () => {
    mockNode();
    const { connect, request } = fakeConnections();
    const v2 = vi.spyOn(ConfidentialSession.prototype, "run");
    const url = freshNode();
    const stats: any[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await call(url, {}, { http2: { ...quiet, onRequest: (s: unknown) => stats.push(s) } });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-routstr-confidential-http")).toBe("2");
      expect(res.headers.get("x-routstr-confidential-connection")).toBe(`${i === 1 ? "new" : "reused"}; request=${i}`);
      expect(res.headers.has("x-routstr-confidential-prewarmed")).toBe(false);
      expect((await res.json()).choices[0].message.content).toBe("hi");
    }
    expect(connect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(v2).not.toHaveBeenCalled();
    expect(confidentialHttp2Snapshot()).toMatchObject([{ state: "idle", requests: 3 }]);
    expect(stats.map((s) => [s.n, s.reused])).toEqual([[1, false], [2, true], [3, true]]);
    expect(stats[0]).toMatchObject({ bytesSent: 9, bytesRecv: 12, status: 200 });
  });

  it("streams, and ends the stream with [DONE] once the request settled", async () => {
    mockNode();
    fakeConnections();
    const res = await fetchConfidential({
      baseUrl: freshNode(),
      body: { model: "cheap", messages: [{ role: "user", content: "x" }], stream: true },
      bearer: "sk-x",
      options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex], http2: quiet },
    });
    expect(await res.text()).toBe(SSE);
    await (res as any).confidentialSettled;
  });

  it("keeps the v2 flow for an offer without http 2, with http2 disabled, and for one-off bearers", async () => {
    const { connect } = fakeConnections();
    const v2 = vi.spyOn(ConfidentialSession.prototype, "run").mockImplementation(async function (this: any) {
      this.sid = "ab".repeat(32);
      return {
        http: { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } },
        receipt: {},
        sid: this.sid,
      } as never;
    });
    mockNode({});
    expect((await call(freshNode())).headers.has("x-routstr-confidential-http")).toBe(false);
    mockNode({ http: ["1.1"] });
    await call(freshNode());
    mockNode();
    await call(freshNode(), {}, { http2: { enabled: false } });
    await call(freshNode(), { bearer: "cashuBtoken" });
    // A bad h2 block: http 2 is off for that offer, v2 still serves it.
    mockNode({ http: ["1.1", "2"], h2: { ...H2.h2, probe_path: "/api/v1/api_keys" } });
    await call(freshNode());
    expect(v2).toHaveBeenCalledTimes(5);
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps the v2 flow for a node whose connection deposit exceeds the caller's maximum", async () => {
    const { connect } = fakeConnections();
    const v2 = vi.spyOn(ConfidentialSession.prototype, "run").mockImplementation(async function (this: any) {
      this.sid = "ab".repeat(32);
      return {
        http: { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } },
        receipt: {},
        sid: this.sid,
      } as never;
    });
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    // Above the default maximum (100 000 msat): no connection is opened.
    mockNode({ http: ["1.1", "2"], h2: { ...H2.h2, connection_deposit_msat: 100_001, idle_timeout_s: 120 } });
    const dear = freshNode();
    await call(dear, {}, { http2: { log } });
    await call(dear, {}, { http2: { log } });
    expect(v2).toHaveBeenCalledTimes(2);
    expect(connect).not.toHaveBeenCalled();
    // Said once per node, with both numbers.
    expect(logs.filter((l) => /connection deposit of 100001 msat, above the maximum of 100000 msat/.test(l))).toHaveLength(1);
    // A caller that accepts it gets the connection; one that accepts less than a small deposit does not.
    await call(freshNode(), {}, { http2: { log, maxConnectionDepositMsat: 100_001 } });
    expect(connect).toHaveBeenCalledTimes(1);
    mockNode({ http: ["1.1", "2"], h2: { ...H2.h2, connection_deposit_msat: 7000, idle_timeout_s: 120 } });
    await call(freshNode(), {}, { http2: { log } });
    expect(connect).toHaveBeenCalledTimes(2);
    await call(freshNode(), {}, { http2: { log, maxConnectionDepositMsat: 0 } });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(v2).toHaveBeenCalledTimes(3);
  });

  it("opens a second connection for an overlapping request", async () => {
    mockNode();
    let free!: () => void;
    const gate = new Promise<void>((r) => (free = r));
    const { connect } = fakeConnections((_c, n) => (n === 1 ? { wait: gate } : {}));
    const url = freshNode();
    const first = call(url);
    await new Promise((r) => setTimeout(r, 20));
    const second = call(url);
    await new Promise((r) => setTimeout(r, 20));
    expect(connect).toHaveBeenCalledTimes(2);
    free();
    const [a, b] = await Promise.all([first, second]);
    expect(a.headers.get("x-routstr-confidential-sid")).not.toBe(b.headers.get("x-routstr-confidential-sid"));
    expect(confidentialHttp2Snapshot()).toHaveLength(2);
  });

  it("does not share a connection across credentials, nodes or reuse scopes", async () => {
    mockNode();
    const { connect } = fakeConnections();
    const url = freshNode();
    await call(url);
    await call(url, { bearer: "sk-y" });
    await call(freshNode());
    await call(url, { reuseScope: "user-2" });
    expect(connect).toHaveBeenCalledTimes(4);
    await call(url);
    expect(connect).toHaveBeenCalledTimes(4);
  });
});

describe("http 2 transport: image requests", () => {
  const image = (baseUrl: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    fetchConfidential({
      baseUrl,
      method: "POST",
      path: "/v1/images/generations",
      body: { model: "z-image-turbo", prompt: "a red circle", output_format: "webp" },
      bearer: "sk-x",
      options: { trustedHosts: ["*.venice.ai"], nodePubkeys: [pubHex], http2: quiet, ...options },
      ...extra,
    });

  it("runs an image request on the connection a chat request left", async () => {
    const { connect, request } = fakeConnections();
    const v2 = vi.spyOn(ConfidentialSession.prototype, "run");
    mockNode(H2_IMAGES);
    const node = freshNode();
    const chat = await call(node);
    await (chat as any).confidentialSettled;
    const stats: any[] = [];
    const res = await image(node, {}, { http2: { ...quiet, onRequest: (s: unknown) => stats.push(s) } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-http")).toBe("2");
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("reused; request=2");
    expect(res.headers.get("x-routstr-confidential-variant")).toBe("webp");
    expect(res.headers.get("x-routstr-cost-msats")).toBe("12100");
    // The provider's shape, presented as an OpenAI images response.
    const json = (await res.json()) as { data: { b64_json: string }[] };
    expect(json.data).toEqual([{ b64_json: "aGVsbG8=" }]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(v2).not.toHaveBeenCalled();
    // The request named the variant and the count, and its body ends with the image suffix.
    const opts = request.mock.calls[1]![0] as H2RequestOptions;
    expect(opts.image).toEqual({ variant: "webp", count: 1 });
    expect(new TextDecoder().decode(opts.body)).toMatch(
      /^\{"prompt":"a red circle","model":"z-image-turbo","variants":1,"return_binary":false,"format":"webp"\}$/,
    );
    expect(stats).toHaveLength(1);
    expect(stats[0].kind).toBe("images");
    expect(stats[0].reused).toBe(true);
    // A chat request follows on the same connection.
    const again = await call(node);
    expect(again.headers.get("x-routstr-confidential-connection")).toBe("reused; request=3");
    await (again as any).confidentialSettled;
  });

  it("keeps the v2 image flow when the offer does not serve images over http 2", async () => {
    const { connect } = fakeConnections();
    const v2 = vi.spyOn(ConfidentialSession.prototype, "run").mockImplementation(async function (this: any) {
      this.sid = "ab".repeat(32);
      return {
        http: { status: 200, statusText: "OK", headers: {} },
        image: { created: 1, data: [{ b64_json: "aGVsbG8=" }] },
        receipt: {},
        sid: this.sid,
      } as never;
    });
    // No `kinds` in the h2 block; http2 switched off; a one-off Cashu bearer;
    // a deposit above the caller's maximum.
    mockNode({ ...H2_IMAGES, h2: H2.h2 });
    expect((await image(freshNode())).headers.has("x-routstr-confidential-http")).toBe(false);
    mockNode(H2_IMAGES);
    await image(freshNode(), {}, { http2: { ...quiet, enabled: false } });
    await image(freshNode(), { bearer: "cashuBtoken" });
    mockNode({ ...H2_IMAGES, h2: { ...H2_IMAGES.h2, connection_deposit_msat: 7000, idle_timeout_s: 120 } });
    await image(freshNode(), {}, { http2: { ...quiet, maxConnectionDepositMsat: 6999 } });
    expect(v2).toHaveBeenCalledTimes(4);
    expect(connect).not.toHaveBeenCalled();
  });

  it("a node refusal before the release is the HTTP error; a released image request is never run again", async () => {
    mockNode(H2_IMAGES);
    let behave: Behaviour = () => ({ fail: new SessionRejectedError("node rejected: Insufficient balance", undefined, 402, { error: { code: "insufficient_balance" } }) });
    const { request } = fakeConnections((c, n, o) => behave(c, n, o));
    const refused = await image(freshNode());
    expect(refused.status).toBe(402);
    behave = (_c, _n, opts) => (opts.image ? { released: true, fail: new Error("connection closed") } : {});
    const node = freshNode();
    await (await call(node) as any).confidentialSettled;
    request.mockClear();
    await expect(image(node)).rejects.toThrow(/connection closed/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("http 2 transport: a pooled connection is a cache, never a promise", () => {
  it("runs the request on a fresh connection when the pooled one fails before the release", async () => {
    mockNode();
    const logs: string[] = [];
    const { connect, request } = fakeConnections((conn, n) =>
      conn.sid.endsWith("1") && n === 2 ? { fail: new SessionRejectedError("connection closed by the node: idle") } : {},
    );
    const url = freshNode();
    const options = { http2: { log: (m: string) => logs.push(m) } };
    await call(url, {}, options);
    const res = await call(url, {}, options);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(3);
    expect(logs.some((l) => /failed before release/.test(l))).toBe(true);
  });

  it("opens a new connection when the pooled one died while idle", async () => {
    mockNode();
    const conns: any[] = [];
    const { connect } = fakeConnections((conn) => (conns.push(conn), {}));
    const url = freshNode();
    await call(url);
    conns[0].close("the node's idle limit");
    const res = await call(url);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("never runs a released request again", async () => {
    mockNode();
    const { connect } = fakeConnections((_c, n) =>
      n === 2 ? { released: true, fail: new SessionRejectedError("connection closed") } : {},
    );
    const url = freshNode();
    await call(url);
    await expect(call(url)).rejects.toThrow(/connection closed/);
    expect(connect).toHaveBeenCalledTimes(1);
    // The failed connection is gone; the next request opens one.
    expect(confidentialHttp2Snapshot()).toHaveLength(0);
    expect((await call(url)).status).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("a node refusal with a status before the release is the HTTP error, not retried", async () => {
    mockNode();
    const { connect, request } = fakeConnections((_c, n) =>
      n === 2 ? { fail: new SessionRejectedError("insufficient balance", undefined, 402, { error: { type: "x" } }) } : {},
    );
    const url = freshNode();
    await call(url);
    const res = await call(url);
    expect(res.status).toBe(402);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("a failure on a connection opened for the request is not retried", async () => {
    mockNode();
    const { connect } = fakeConnections(() => ({ fail: new SessionRejectedError("connection closed") }));
    await expect(call(freshNode())).rejects.toThrow(/connection closed/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a connection that cannot be opened fails the request", async () => {
    mockNode();
    vi.spyOn(ConfidentialH2Connection.prototype, "connect").mockImplementation(async function (this: any) {
      const e = new SessionRejectedError("node rejected: no funds", undefined, 402);
      this.fail(e);
      throw e;
    });
    const res = await call(freshNode());
    expect(res.status).toBe(402);
    expect(confidentialHttp2Snapshot()).toHaveLength(0);
  });
});
