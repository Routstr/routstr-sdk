/**
 * The confidential transport on protocol v3: the framing it chooses
 * (PROTOCOL-V3.md §2.3), the fallback from "2" to "1.1", connection reuse and
 * its scopes (§9.1), refused requests (§12.4), armed spares (§9.2), and what
 * a failure does before and after a request was released.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeConfidentialConnections,
  confidentialConnectionsSnapshot,
  chooseFraming,
  fetchConfidential,
  http2OpenFailure,
  qualifyConfidentialNode,
} from "../../client/confidential/transport";
import {
  ConfidentialError,
  ConnectionDepositError,
  NodeProtocolOutdatedError,
  ProverMissingError,
  RequestRefusedError,
  SessionProtocolError,
  SessionRejectedError,
  StreamNotProcessedError,
  TwoPcVersionMismatchError,
  UpgradeRequiredError,
} from "../../client/confidential/errors";
import { verifyConfidentialOffer } from "../../client/confidential/offer";
import { ConfidentialConnection, type ConnectionRequestOptions } from "../../client/confidential/connection";
import * as twopc from "../../client/confidential/twopc";
import {
  BOTH,
  BOTH_IMAGES,
  H2_BLOCK,
  IMAGES,
  NODE_PUB,
  ONLY_11,
  SSE,
  fakeConnections,
  mockNodeOffer,
  restoreFetch,
  signedV3Offer,
  type Behaviour,
} from "./fixtures/v3";

let node = 0;
const quiet = { log: () => {} };
const base = { trustedHosts: ["*.venice.ai"], nodePubkeys: [NODE_PUB], http2: quiet };
function call(baseUrl: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return fetchConfidential({
    baseUrl,
    body: { model: "cheap", messages: [{ role: "user", content: "x" }] },
    bearer: "sk-x",
    options: { ...base, ...options },
    ...extra,
  });
}
const image = (baseUrl: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  fetchConfidential({
    baseUrl,
    method: "POST",
    path: "/v1/images/generations",
    body: { model: "z-image-turbo", prompt: "a red circle", output_format: "webp" },
    bearer: "sk-x",
    options: { ...base, ...options },
    ...extra,
  });
const freshNode = () => `https://v3-${++node}.example`;
const verified = (extra: Record<string, unknown> = BOTH) =>
  verifyConfidentialOffer(signedV3Offer(extra), { pinnedPubkeys: [NODE_PUB], trustedHosts: ["*.venice.ai"] });
const framings = (connect: { mock: { contexts: unknown[] } }) => connect.mock.contexts.map((c: any) => c.framing);

afterEach(() => {
  vi.restoreAllMocks();
  restoreFetch();
  closeConfidentialConnections();
});

describe("v3 offer", () => {
  it("is fetched with ?v=3", async () => {
    const { urls } = mockNodeOffer();
    fakeConnections();
    await call(freshNode());
    expect(urls[0]).toMatch(/\/v1\/confidential\/offer\?v=3$/);
  });

  it("an offer below v3 is node_protocol_outdated, whatever its shape", () => {
    for (const raw of [
      signedV3Offer({ v: 2 }),
      { v: 2, min_v: 2, max_v: 2, upstream_host: "api.venice.ai" },
      { v: 1 },
    ]) {
      let err: unknown;
      try {
        verifyConfidentialOffer(raw, { pinnedPubkeys: [NODE_PUB], trustedHosts: ["*.venice.ai"] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NodeProtocolOutdatedError);
      expect((err as NodeProtocolOutdatedError).code).toBe("node_protocol_outdated");
      expect((err as Error).message).toMatch(/node_protocol_outdated.*v[12].*this client speaks v3/);
    }
  });

  it("the signed version counts, not the envelope's", () => {
    const signed = signedV3Offer({ v: 2 });
    expect(() =>
      verifyConfidentialOffer({ ...signed, v: 3 }, { pinnedPubkeys: [NODE_PUB], trustedHosts: ["*.venice.ai"] }),
    ).toThrow(NodeProtocolOutdatedError);
  });

  it("refuses a newer version, another key schedule, unknown or repeated framings and a bad deposit", () => {
    const check = (extra: Record<string, unknown>) => () => verified(extra);
    expect(check({ v: 4 })).toThrow(/update the client/);
    expect(check({ twopc: "split-proven-1" })).toThrow(/two-party key schedule/);
    expect(check({ twopc: undefined })).toThrow(/two-party key schedule/);
    expect(check({ http: [] })).toThrow(/offer.http/);
    expect(check({ http: ["3"] })).toThrow(/offer.http/);
    expect(check({ http: ["1.1", "1.1"] })).toThrow(/offer.http/);
    expect(check({ http: [2] })).toThrow(/offer.http/);
    expect(check({ connection_deposit_msat: -1 })).toThrow(/connection_deposit_msat/);
    expect(check({ connection_deposit_msat: 1.5 })).toThrow(/connection_deposit_msat/);
    expect(check({ idle_timeout_s: 5 })).toThrow(/idle_timeout_s/);
  });

  it("keeps the operator's order of framings, and drops a refused h2 block when 1.1 is offered", () => {
    expect(verified(BOTH).http).toEqual(["2", "1.1"]);
    expect(verified({ http: ["1.1", "2"], h2: H2_BLOCK }).http).toEqual(["1.1", "2"]);
    expect(verified({}).http).toEqual(["1.1"]);
    const badProbe = verified({ http: ["2", "1.1"], h2: { ...H2_BLOCK, probe_path: "/api/v1/api_keys" } });
    expect(badProbe.http).toEqual(["1.1"]);
    expect(badProbe.h2).toBeUndefined();
    expect(badProbe.http2Refused).toMatch(/probe_path/);
    expect(() => verified({ http: ["2"], h2: { ...H2_BLOCK, max_requests: 0 } })).toThrow(/only framing "2"/);
    expect(() => verified({ http: ["2", "1.1"], h2: H2_BLOCK, idle_timeout_s: 301 }).h2).not.toThrow();
    expect(verified({ http: ["2", "1.1"], h2: H2_BLOCK, idle_timeout_s: 301 }).http).toEqual(["1.1"]);
    expect(verified({ http: ["2", "1.1"], h2: { ...H2_BLOCK, max_lifetime_s: 59 } }).http).toEqual(["1.1"]);
  });
});

describe("choosing the framing (§2.3)", () => {
  it("auto takes the offer's first entry that serves the request", () => {
    expect(chooseFraming(verified(BOTH), "chat")).toBe("2");
    expect(chooseFraming(verified({ http: ["1.1", "2"], h2: H2_BLOCK }), "chat")).toBe("1.1");
    expect(chooseFraming(verified(ONLY_11), "chat")).toBe("1.1");
    // Images on "2" only when h2.kinds lists them.
    expect(chooseFraming(verified(BOTH_IMAGES), "images")).toBe("2");
    expect(chooseFraming(verified({ ...BOTH_IMAGES, h2: H2_BLOCK }), "images")).toBe("1.1");
    expect(() => chooseFraming(verified(BOTH), "images")).toThrow(/no confidential images/);
  });

  it("skips a framing marked bad, and still uses it when nothing else is offered", () => {
    expect(chooseFraming(verified(BOTH), "chat", { bad: true })).toBe("1.1");
    expect(chooseFraming(verified({ http: ["2"], h2: H2_BLOCK }), "chat", { bad: true })).toBe("2");
  });

  it("a configured framing is the only one used", () => {
    expect(chooseFraming(verified(BOTH), "chat", { http: "1.1" })).toBe("1.1");
    expect(chooseFraming(verified(BOTH), "chat", { http: "2", bad: true })).toBe("2");
    expect(() => chooseFraming(verified(ONLY_11), "chat", { http: "2" })).toThrow(/does not serve chat requests with framing "2"/);
    expect(() => chooseFraming(verified(BOTH), "chat", { http: "3" as never })).toThrow(/confidential.http/);
  });

  it("a one-off bearer prefers 1.1", () => {
    expect(chooseFraming(verified(BOTH), "chat", { oneOff: true })).toBe("1.1");
    expect(chooseFraming(verified({ http: ["2"], h2: H2_BLOCK }), "chat", { oneOff: true })).toBe("2");
    expect(chooseFraming(verified(BOTH), "chat", { oneOff: true, http: "2" })).toBe("2");
  });

  it("which failures of a framing-2 open the fallback covers", () => {
    const withCode = (code: string, status?: number) => {
      const e = new SessionRejectedError("node rejected", undefined, status);
      e.nodeCode = code;
      return e;
    };
    expect(http2OpenFailure(withCode("h2_withdrawn", 400))).toBe(true);
    expect(http2OpenFailure(withCode("h2_not_selected"))).toBe(true);
    expect(http2OpenFailure(withCode("upstream_unreachable", 502))).toBe(true);
    expect(http2OpenFailure(new SessionRejectedError("connection closed"))).toBe(true);
    expect(http2OpenFailure(new SessionProtocolError("handshake"))).toBe(true);
    expect(http2OpenFailure(new SessionRejectedError("no funds", undefined, 402))).toBe(false);
    expect(http2OpenFailure(new SessionRejectedError("bad key", undefined, 401))).toBe(false);
    expect(http2OpenFailure(new ConnectionDepositError("deposit", 1000, 402))).toBe(false);
    expect(http2OpenFailure(new RequestRefusedError(409, "offer_changed"))).toBe(false);
    expect(http2OpenFailure(new UpgradeRequiredError("upgrade", 4))).toBe(false);
    expect(http2OpenFailure(new TwoPcVersionMismatchError("tag"))).toBe(false);
    expect(http2OpenFailure(new ProverMissingError("no cu-prover"))).toBe(false);
    expect(http2OpenFailure(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

describe("v3 transport: framing 2 connections", () => {
  it("runs sequential requests on one connection", async () => {
    mockNodeOffer();
    const { connect, request } = fakeConnections();
    const url = freshNode();
    const stats: any[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await call(url, {}, { http2: { ...quiet, onRequest: (s: unknown) => stats.push(s) } });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-routstr-confidential-http")).toBe("2");
      expect(res.headers.get("x-routstr-confidential-connection")).toBe(`${i === 1 ? "new" : "reused"}; request=${i}`);
      expect(res.headers.has("x-routstr-confidential-prewarmed")).toBe(false);
      expect(res.headers.get("x-routstr-cost-msats")).toBe("7");
      expect((await res.json()).choices[0].message.content).toBe("hi");
    }
    expect(connect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(confidentialConnectionsSnapshot()).toMatchObject([{ http: "2", state: "idle", requests: 3 }]);
    expect(stats.map((s) => [s.http, s.n, s.warm, s.reused])).toEqual([
      ["2", 1, "cold", false],
      ["2", 2, "open", true],
      ["2", 3, "open", true],
    ]);
    expect(stats[0]).toMatchObject({ bytesSent: 9, bytesRecv: 12, status: 200, armBytesSent: 140, armBytesRecv: 1060 });
    expect(stats[1].armBytesSent).toBeUndefined();
  });

  it("streams, and ends the stream with [DONE] once the request settled", async () => {
    mockNodeOffer();
    fakeConnections();
    const res = await call(freshNode(), { body: { model: "cheap", messages: [{ role: "user", content: "x" }], stream: true } });
    expect(await res.text()).toBe(SSE);
    expect(await (res as any).confidentialSettled).toMatchObject({ costMsats: 7 });
  });

  it("opens a second connection for an overlapping request", async () => {
    mockNodeOffer();
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
    expect(confidentialConnectionsSnapshot()).toHaveLength(2);
  });

  it("does not share a connection across credentials, nodes or reuse scopes", async () => {
    mockNodeOffer();
    const { connect } = fakeConnections();
    const url = freshNode();
    await call(url);
    await call(url, { bearer: "sk-y" });
    await call(freshNode());
    await call(url, { reuseScope: "user-2" });
    // The per-request option in the options object is the same thing.
    await call(url, {}, { reuseScope: "user-3" });
    expect(connect).toHaveBeenCalledTimes(5);
    await call(url);
    await call(url, { reuseScope: "user-2" });
    await call(url, {}, { reuseScope: "user-3" });
    expect(connect).toHaveBeenCalledTimes(5);
    const sids = confidentialConnectionsSnapshot().map((s) => s.sid);
    expect(new Set(sids).size).toBe(5);
  });

  it("reuse none closes the connection after its request", async () => {
    mockNodeOffer();
    const { connect } = fakeConnections();
    const url = freshNode();
    const options = { http2: { ...quiet, reuse: "none" } };
    await call(url, {}, options);
    expect(confidentialConnectionsSnapshot()).toHaveLength(0);
    const res = await call(url, {}, options);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("an image request runs on the connection a chat request left, and its body is taken out piece by piece", async () => {
    const { connect, request } = fakeConnections();
    mockNodeOffer(BOTH_IMAGES);
    const url = freshNode();
    await ((await call(url)) as any).confidentialSettled;
    const stats: any[] = [];
    const res = await image(url, {}, { http2: { ...quiet, onRequest: (s: unknown) => stats.push(s) } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-http")).toBe("2");
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("reused; request=2");
    expect(res.headers.get("x-routstr-confidential-variant")).toBe("webp");
    expect(res.headers.get("x-routstr-cost-msats")).toBe("12100");
    // The provider's shape, presented as an OpenAI images response.
    const json = (await res.json()) as { data: { b64_json: string }[] };
    expect(json.data).toEqual([{ b64_json: "aGVsbG8=" }]);
    expect(connect).toHaveBeenCalledTimes(1);
    const opts = request.mock.calls[1]![0] as ConnectionRequestOptions;
    expect(opts.image).toEqual({ variant: "webp", count: 1 });
    expect(new TextDecoder().decode(opts.body)).toMatch(
      /^\{"prompt":"a red circle","model":"z-image-turbo","variants":1,"return_binary":false,"format":"webp"\}$/,
    );
    // The connection's result was emptied as the response was built.
    const result = await (request.mock.results[1]!.value as { done: Promise<{ bodyChunks: Uint8Array[] }> }).done;
    expect(result.bodyChunks).toEqual([]);
    expect(stats[0]).toMatchObject({ kind: "images", http: "2", warm: "open" });
    const again = await call(url);
    expect(again.headers.get("x-routstr-confidential-connection")).toBe("reused; request=3");
  });

  it("an image request uses 1.1 when the h2 block does not list images", async () => {
    const { connect } = fakeConnections();
    mockNodeOffer({ ...BOTH_IMAGES, h2: H2_BLOCK });
    const res = await image(freshNode());
    expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
    expect(framings(connect)).toEqual(["1.1"]);
    expect(((await res.json()) as any).data).toHaveLength(1);
  });
});

describe("v3 transport: framing 1.1", () => {
  it("runs each request on a connection of its own, in the same connection object", async () => {
    mockNodeOffer(ONLY_11);
    const { connect, request } = fakeConnections();
    const url = freshNode();
    for (let i = 0; i < 2; i++) {
      const res = await call(url);
      expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
      expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    }
    expect(framings(connect)).toEqual(["1.1", "1.1"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(confidentialConnectionsSnapshot()).toHaveLength(0);
  });

  it("is forced by confidential.http, also when the offer prefers 2", async () => {
    mockNodeOffer(BOTH);
    const { connect } = fakeConnections();
    const res = await call(freshNode(), {}, { http: "1.1" });
    expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
    expect(framings(connect)).toEqual(["1.1"]);
  });

  it("a node that does not offer the forced framing is not used", async () => {
    mockNodeOffer(ONLY_11);
    const { connect } = fakeConnections();
    await expect(call(freshNode(), {}, { http: "2" })).rejects.toThrow(/does not serve chat requests with framing "2"/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("serves a one-off Cashu bearer, and closes its connection", async () => {
    mockNodeOffer(BOTH);
    const { connect } = fakeConnections();
    const close = vi.spyOn(ConfidentialConnection.prototype, "close");
    const res = await call(freshNode(), { bearer: "cashuBtoken" });
    expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
    expect(framings(connect)).toEqual(["1.1"]);
    expect(close).toHaveBeenCalled();
    expect(confidentialConnectionsSnapshot()).toHaveLength(0);
  });

  it("a one-off bearer on a node with only framing 2 gets a connection of its own (reuse none)", async () => {
    mockNodeOffer({ http: ["2"], h2: H2_BLOCK });
    const { connect } = fakeConnections();
    const url = freshNode();
    for (let i = 0; i < 2; i++) {
      const res = await call(url, { bearer: "cashuBtoken", returnChange: false });
      expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    }
    expect(framings(connect)).toEqual(["2", "2"]);
    expect(confidentialConnectionsSnapshot()).toHaveLength(0);
  });
});

describe("v3 transport: fallback from 2 to 1.1 (§2.3)", () => {
  it("a connection that fails to open is served on 1.1 on the same node, and 2 is not tried for 10 minutes", async () => {
    mockNodeOffer(BOTH);
    const logs: string[] = [];
    const { connect } = fakeConnections(undefined, {
      connectFails: (c) => {
        if (c.framing !== "2") return undefined;
        const e = new SessionRejectedError("node rejected: h2 not selected");
        e.nodeCode = "h2_not_selected";
        return e;
      },
    });
    const url = freshNode();
    const options = { http2: { log: (m: string) => logs.push(m) } };
    const res = await call(url, {}, options);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
    expect(framings(connect)).toEqual(["2", "1.1"]);
    expect(logs.some((l) => /framing "2" marked bad .* for 10 min/.test(l))).toBe(true);
    // The mark holds: the next request goes straight to 1.1.
    await call(url, {}, options);
    expect(framings(connect)).toEqual(["2", "1.1", "1.1"]);
    // Another node is not affected.
    const other = freshNode();
    await call(other, {}, options);
    expect(framings(connect).slice(3)).toEqual(["2", "1.1"]);
    // After 10 minutes "2" is tried again.
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 + 1, toFake: ["Date"] });
    try {
      await call(url, {}, options);
    } finally {
      vi.useRealTimers();
    }
    expect(framings(connect).slice(5)).toEqual(["2", "1.1"]);
  });

  it("the first request failing before its body was released falls back too", async () => {
    mockNodeOffer(BOTH);
    const { connect, request } = fakeConnections((c) =>
      c.framing === "2" ? { fail: new SessionRejectedError("connection closed") } : {},
    );
    const res = await call(freshNode());
    expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
    expect(framings(connect)).toEqual(["2", "1.1"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never after the body was released", async () => {
    mockNodeOffer(BOTH);
    const { connect } = fakeConnections(() => ({ released: true, fail: new SessionRejectedError("connection closed") }));
    await expect(call(freshNode())).rejects.toThrow(/connection closed/);
    expect(framings(connect)).toEqual(["2"]);
  });

  it("not for a refusal with a status, not when 2 is forced, not when 1.1 is not offered", async () => {
    mockNodeOffer(BOTH);
    let fail: Error = new SessionRejectedError("node rejected: no funds", undefined, 402);
    const { connect } = fakeConnections(undefined, { connectFails: (c) => (c.framing === "2" ? fail : undefined) });
    expect((await call(freshNode())).status).toBe(402);
    expect(framings(connect)).toEqual(["2"]);
    fail = new SessionRejectedError("connection closed");
    await expect(call(freshNode(), {}, { http: "2" })).rejects.toThrow(/connection closed/);
    mockNodeOffer({ http: ["2"], h2: H2_BLOCK });
    await expect(call(freshNode())).rejects.toThrow(/connection closed/);
    expect(framings(connect)).toEqual(["2", "2", "2"]);
  });

  it("an image request falls back only when 1.1 serves images", async () => {
    mockNodeOffer(BOTH_IMAGES);
    const { connect } = fakeConnections(undefined, {
      connectFails: (c) => (c.framing === "2" ? new SessionRejectedError("connection closed") : undefined),
    });
    const res = await image(freshNode());
    expect(res.headers.get("x-routstr-confidential-http")).toBe("1.1");
    expect(framings(connect)).toEqual(["2", "1.1"]);
  });
});

describe("v3 transport: a refused request (§12.4)", () => {
  it("is the node's HTTP error, and the connection serves the next request", async () => {
    mockNodeOffer();
    let behave: Behaviour = () => ({});
    const { connect, request } = fakeConnections((c, n, o) => behave(c, n, o));
    const url = freshNode();
    await call(url);
    behave = () => ({ refuse: { status: 402, reason: "Insufficient balance", detail: { error: { code: "insufficient_balance" } } } });
    const refused = await call(url);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ detail: { error: { code: "insufficient_balance" } } });
    expect(confidentialConnectionsSnapshot()).toMatchObject([{ state: "idle", requests: 1 }]);
    behave = () => ({});
    const res = await call(url);
    // The refused request did not use up its number.
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("reused; request=2");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("a refused first request does not fall back to 1.1 and keeps the connection", async () => {
    mockNodeOffer();
    let first = true;
    const { connect } = fakeConnections(() => {
      if (!first) return {};
      first = false;
      return { refuse: { status: 400, reason: "model not served" } };
    });
    const url = freshNode();
    expect((await call(url)).status).toBe(400);
    const res = await call(url);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("reused; request=1");
    expect(framings(connect)).toEqual(["2"]);
  });

  it("offer_expired refetches the offer and runs the request again on the same connection", async () => {
    const { urls } = mockNodeOffer();
    let refusals = 0;
    const { connect, request } = fakeConnections((_c, n) =>
      n === 2 && refusals++ === 0 ? { refuse: { status: 409, reason: "offer_expired" } } : {},
    );
    const url = freshNode();
    await call(url);
    const res = await call(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("reused; request=2");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(urls).toHaveLength(2);
  });

  it("offer_changed opens a new connection on the new offer's terms", async () => {
    mockNodeOffer();
    let changed = false;
    const { connect } = fakeConnections((_c, n) => {
      if (n !== 2 || changed) return {};
      changed = true;
      // The node re-signed its offer with another deposit: a connection-level field.
      mockNodeOffer({ ...BOTH, connection_deposit_msat: 2000 });
      return { refuse: { status: 409, reason: "offer_changed" } };
    });
    const url = freshNode();
    await call(url);
    const res = await call(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    expect(connect).toHaveBeenCalledTimes(2);
    expect((connect.mock.contexts[1] as any).depositMsat).toBe(2000);
  });
});

describe("v3 transport: a pooled connection is a cache, never a promise", () => {
  it("runs the request on a fresh connection when the pooled one fails before the release", async () => {
    mockNodeOffer();
    const logs: string[] = [];
    const { connect, request } = fakeConnections((conn, n) =>
      conn.sid.startsWith("00000001") && n === 2 ? { fail: new SessionRejectedError("connection closed by the node: idle") } : {},
    );
    const url = freshNode();
    const options = { http2: { log: (m: string) => logs.push(m) } };
    await call(url, {}, options);
    const res = await call(url, {}, options);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-routstr-confidential-connection")).toBe("new; request=1");
    expect(framings(connect)).toEqual(["2", "2"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(logs.some((l) => /failed before release/.test(l))).toBe(true);
  });

  it("opens a new connection when the pooled one died while idle", async () => {
    mockNodeOffer();
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
    mockNodeOffer();
    const { connect } = fakeConnections((_c, n) =>
      n === 2 ? { released: true, fail: new SessionRejectedError("connection closed") } : {},
    );
    const url = freshNode();
    await call(url);
    await expect(call(url)).rejects.toThrow(/connection closed/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(confidentialConnectionsSnapshot()).toHaveLength(0);
    expect((await call(url)).status).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("runs a request the provider did not process again, even after its release (REFUSED_STREAM, GOAWAY)", async () => {
    mockNodeOffer();
    const logs: string[] = [];
    let calls = 0;
    const { connect } = fakeConnections(() =>
      calls++ === 0 ? { released: true, fail: new StreamNotProcessedError("the provider refused stream 3 (REFUSED_STREAM)") } : {},
    );
    const res = await call(freshNode(), {}, { http2: { log: (l: string) => logs.push(l) } });
    expect(res.status).toBe(200);
    // Not a failure of framing "2": the retry stays on it.
    expect(framings(connect)).toEqual(["2", "2"]);
    expect(logs.some((l) => /not processed by the provider/.test(l))).toBe(true);
    expect(http2OpenFailure(new StreamNotProcessedError("x"))).toBe(false);
  });

  // Run with NODE_OPTIONS=--expose-gc to include it.
  it.runIf(typeof (globalThis as { gc?: unknown }).gc === "function")(
    "keeps no request body reachable from a kept connection's key (finding 25)",
    async () => {
      mockNodeOffer();
      const mocks = fakeConnections();
      const url = freshNode();
      const ref = await (async () => {
        const body = { model: "cheap", messages: [{ role: "user", content: "x".repeat(1 << 16) }] };
        // Pre-warming on: the pool keeps the key's state and its opener.
        await fetchConfidential({ baseUrl: url, body, bearer: "sk-x", options: { ...base, prewarm: { log: () => {} } } });
        return new WeakRef(body);
      })();
      // The kept connection is still pooled (the key's opener is remembered for pre-warming).
      expect(confidentialConnectionsSnapshot()).toHaveLength(1);
      for (const m of Object.values(mocks)) m.mockClear();
      for (let i = 0; i < 10 && ref.deref(); i++) {
        await new Promise((r) => setTimeout(r, 0));
        (globalThis as unknown as { gc: () => void }).gc();
      }
      expect(ref.deref()).toBeUndefined();
    },
  );

  it("a setup the node refuses with a status is the HTTP error", async () => {
    mockNodeOffer(ONLY_11);
    fakeConnections(undefined, { connectFails: () => new SessionRejectedError("node rejected: no funds", undefined, 402) });
    const res = await call(freshNode());
    expect(res.status).toBe(402);
    expect(confidentialConnectionsSnapshot()).toHaveLength(0);
  });
});

describe("v3 transport: the connection deposit", () => {
  it("a node asking for more than the caller's maximum is not used, before anything is sent", async () => {
    const { connect } = fakeConnections();
    vi.spyOn(twopc, "requireHelperBinaries").mockImplementation(() => {});
    mockNodeOffer({ ...BOTH, connection_deposit_msat: 100_001 });
    const url = freshNode();
    await expect(call(url)).rejects.toThrow(ConnectionDepositError);
    await expect(qualifyConfidentialNode(url, "cheap", base as never)).rejects.toThrow(
      /connection deposit of 100001 msat, above the maximum of 100000 msat/,
    );
    expect(connect).not.toHaveBeenCalled();
    // A caller that accepts it gets the connection (either place of the option).
    expect((await call(freshNode(), {}, { maxConnectionDepositMsat: 100_001 })).status).toBe(200);
    expect((await call(freshNode(), {}, { http2: { ...quiet, maxConnectionDepositMsat: 100_001 } })).status).toBe(200);
    mockNodeOffer({ ...BOTH, connection_deposit_msat: 7000 });
    await expect(call(freshNode(), {}, { maxConnectionDepositMsat: 6999 })).rejects.toThrow(ConnectionDepositError);
    await expect(call(freshNode(), {}, { maxConnectionDepositMsat: 0 })).rejects.toThrow(ConnectionDepositError);
    mockNodeOffer({ ...BOTH, connection_deposit_msat: 0 });
    expect((await call(freshNode(), {}, { maxConnectionDepositMsat: 0 })).status).toBe(200);
  });

  it("qualifying a node checks the framing the caller allows", async () => {
    vi.spyOn(twopc, "requireHelperBinaries").mockImplementation(() => {});
    mockNodeOffer(ONLY_11);
    await expect(qualifyConfidentialNode(freshNode(), "cheap", { ...base, http: "2" } as never)).rejects.toThrow(
      ConfidentialError,
    );
    await expect(qualifyConfidentialNode(freshNode(), "cheap", { ...base, http: "1.1" } as never)).resolves.toBeTruthy();
    mockNodeOffer({ ...ONLY_11, capabilities: ["chat", "images"], images: IMAGES });
    await expect(
      qualifyConfidentialNode(freshNode(), "z-image-turbo", { ...base, http: "2" } as never, "images"),
    ).rejects.toThrow(/framing "2"/);
  });
});

describe("v3 transport: pre-warm (§9.2)", () => {
  const prewarm = { log: () => {} };
  const settle = () => new Promise((r) => setTimeout(r, 15));

  it("framing 1.1: after a settled request an armed connection waits for the next one", async () => {
    mockNodeOffer(ONLY_11);
    const { arm, connect } = fakeConnections();
    const url = freshNode();
    const first = await call(url, {}, { prewarm });
    expect(first.headers.get("x-routstr-confidential-prewarmed")).toBe("0");
    await settle();
    expect(arm).toHaveBeenCalledWith(true);
    expect(confidentialConnectionsSnapshot()).toMatchObject([{ http: "1.1", state: "armed", requests: 0 }]);
    const second = await call(url, {}, { prewarm });
    expect(second.headers.get("x-routstr-confidential-prewarmed")).toBe("1");
    expect(second.headers.get("x-routstr-confidential-connection")).toBe("armed; request=1");
    await settle();
    // The claimed spare is replaced.
    expect(confidentialConnectionsSnapshot()).toMatchObject([{ state: "armed" }]);
    expect(connect.mock.contexts.every((c: any) => c.framing === "1.1")).toBe(true);
  });

  it("framing 2: a spare is armed only while every open connection of the key is busy", async () => {
    mockNodeOffer(BOTH);
    let free!: () => void;
    let gate: Promise<void> | undefined;
    const { arm } = fakeConnections(() => ({ wait: gate }));
    const url = freshNode();
    await call(url, {}, { prewarm });
    await settle();
    // One idle open connection: nothing to arm.
    expect(arm.mock.calls.filter((c) => c[0] === true)).toHaveLength(0);
    expect(confidentialConnectionsSnapshot()).toMatchObject([{ http: "2", state: "idle" }]);
    // A request in flight on it: now a burst would wait for a 2PC, so one spare is armed.
    gate = new Promise<void>((r) => (free = r));
    const busy = call(url, {}, { prewarm });
    await settle();
    expect(confidentialConnectionsSnapshot().map((s) => s.state).sort()).toEqual(["armed", "busy"]);
    // The overlapping request claims it.
    gate = undefined;
    const second = await call(url, {}, { prewarm });
    expect(second.headers.get("x-routstr-confidential-connection")).toBe("armed; request=1");
    expect(second.headers.get("x-routstr-confidential-prewarmed")).toBe("1");
    free();
    await busy;
  });

  it("never arms for a one-off bearer, without a settled request, or above prewarm.maxDepositMsat", async () => {
    mockNodeOffer(ONLY_11);
    const { arm } = fakeConnections((_c, _n) => ({}));
    await call(freshNode(), { bearer: "cashuBtoken" }, { prewarm });
    await settle();
    expect(arm.mock.calls.filter((c) => c[0] === true)).toHaveLength(0);
    mockNodeOffer({ ...ONLY_11, connection_deposit_msat: 5001 });
    await call(freshNode(), {}, { prewarm });
    await settle();
    expect(arm.mock.calls.filter((c) => c[0] === true)).toHaveLength(0);
    closeConfidentialConnections();
    await call(freshNode(), {}, { prewarm: { ...prewarm, maxDepositMsat: 5001 } });
    await settle();
    expect(arm.mock.calls.filter((c) => c[0] === true)).toHaveLength(1);
  });

  it("a refused request does not arm a spare", async () => {
    mockNodeOffer(ONLY_11);
    const { arm } = fakeConnections(() => ({ refuse: { status: 402, reason: "Insufficient balance" } }));
    const url = freshNode();
    expect((await call(url, {}, { prewarm })).status).toBe(402);
    await settle();
    expect(arm.mock.calls.filter((c) => c[0] === true)).toHaveLength(0);
    // The connection its request left armed is kept for the next request.
    expect(confidentialConnectionsSnapshot()).toMatchObject([{ http: "1.1", state: "armed" }]);
  });
});
