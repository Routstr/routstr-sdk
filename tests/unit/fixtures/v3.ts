/**
 * Shared fixtures for the protocol-v3 confidential client tests: a signed v3
 * offer, and stand-ins for a connection's network side (so the transport and
 * the pool are tested without a node).
 */

import { vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { VENICE_CHAT } from "./chat";
import { canonicalJson } from "../../../client/confidential/canonical";
import { chatSuffixKeys } from "../../../client/confidential/suffix";
import { RequestRefusedError, SessionRejectedError } from "../../../client/confidential/errors";
import { ConfidentialConnection, type ConnectionRequestOptions } from "../../../client/confidential/connection";

export const NODE_PRIV = new Uint8Array(32).fill(7);
export const NODE_PUB = bytesToHex(schnorr.getPublicKey(NODE_PRIV));

export const CHAT_HEAD =
  "POST /api/v1/chat/completions HTTP/1.1\r\nHost: api.venice.ai\r\nAuthorization: Bearer {KEY:42}\r\n" +
  "Content-Type: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: {LEN}\r\n\r\n";
export const IMAGES_HEAD = CHAT_HEAD.replace("/api/v1/chat/completions", "/api/v1/image/generate");

/** The `h2` block of an offer that lists framing "2". */
export const H2_BLOCK = { probe_path: "/api/v1/models", idle_secs: 300, max_requests: 100, max_lifetime_s: 3600 };
/** Both framings, "2" first (the operator's preference). */
export const BOTH = { http: ["2", "1.1"], h2: H2_BLOCK };
export const ONLY_11 = { http: ["1.1"] };

export const IMAGES = {
  head_template: IMAGES_HEAD,
  response_shape: "venice",
  response_idle_s: 300,
  max_count: 4,
  count_key: "variants",
  fixed_pins: [["return_binary", false]],
  param_space: { format: ["webp"] },
  price_list: { "z-image-turbo": [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 12100 }] },
};
/** An offer that serves images on both framings. */
export const BOTH_IMAGES = {
  http: ["2", "1.1"],
  h2: { ...H2_BLOCK, kinds: ["chat", "images"] },
  capabilities: ["chat", "images"],
  images: IMAGES,
};
export const IMAGE_BODY = JSON.stringify({ id: "x", images: ["aGVsbG8="], request: { model: "z-image-turbo", variants: 1 } });

/** The unsigned fields of a v3 offer. */
export function v3OfferFields(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 3,
    twopc: "split-public-1",
    upstream_host: "api.venice.ai",
    notary_pubkey: NODE_PUB,
    max_tokens_cap: 4096,
    key_length: 42,
    key_alphabet: "[A-Za-z0-9_-]",
    head_template: CHAT_HEAD,
    suffix_keys: chatSuffixKeys(VENICE_CHAT),
    chat: VENICE_CHAT,
    price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } },
    connection_deposit_msat: 1000,
    idle_timeout_s: 120,
    ...extra,
  };
}

/** A v3 offer signed the way the node does: BIP-340 over sha256(canonical). */
export function signedV3Offer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const o = v3OfferFields(extra);
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  const payload = canonicalJson(o);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), NODE_PRIV));
  return { ...o, sig, sig_payload: payload };
}

const realFetch = globalThis.fetch;
/** `fetch` answers every request with the signed offer (and records the URLs asked). */
export function mockNodeOffer(extra: Record<string, unknown> = BOTH): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(JSON.stringify(signedV3Offer(extra)), { status: 200 });
  }) as typeof fetch;
  return { urls };
}
export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

const enc = (t: string) => new TextEncoder().encode(t);
export const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

export type Behaviour = (
  conn: any,
  n: number,
  opts: ConnectionRequestOptions,
) => {
  /** The request's body was released before it failed. */
  released?: boolean;
  /** The request fails with this (the connection ends). */
  fail?: Error;
  /** The node refuses the request: the connection stays as it was. */
  refuse?: { status: number; reason: string; detail?: unknown };
  wait?: Promise<void>;
  status?: number;
};

/**
 * Stand-ins for the connection's network side: `arm` and `connect` succeed at
 * once (unless `connectFails` says otherwise), `request` follows `behave`.
 */
export function fakeConnections(
  behave: Behaviour = () => ({}),
  hooks: { connectFails?: (conn: any) => Error | undefined; armMs?: number } = {},
) {
  let sids = 0;
  const armNow = (conn: any, prewarm: boolean) => {
    if (conn.phaseNow !== "new") return;
    conn.connectStarted = true;
    conn.prewarmed = prewarm;
    conn.sid = (++sids).toString(16).padStart(8, "0").padEnd(64, "0");
    conn.phaseNow = "armed";
    conn.tArmed = Date.now();
    conn.armBytes = { relaySent: 0, relayRecv: 0, controlSent: 10, controlRecv: 20, twoPcSent: 100, twoPcRecv: 1000, zkSent: 30, zkRecv: 40 };
    if (conn.framing === "1.1") {
      conn.opened = true;
      conn.tOpen = conn.tLastSettled = Date.now();
    }
  };
  const arm = vi.spyOn(ConfidentialConnection.prototype, "arm").mockImplementation(async function (this: any, prewarm = false) {
    if (hooks.armMs) await new Promise((r) => setTimeout(r, hooks.armMs));
    if (this.failure) throw this.failure;
    armNow(this, prewarm);
  });
  const connect = vi.spyOn(ConfidentialConnection.prototype, "connect").mockImplementation(async function (this: any) {
    if (this.failure) throw this.failure;
    armNow(this, false);
    const e = hooks.connectFails?.(this);
    if (e) {
      this.fail(e);
      throw e;
    }
    if (this.framing === "2") {
      this.opened = true;
      this.phaseNow = "ready";
      if (!this.tOpen) this.tOpen = this.tLastSettled = Date.now();
    }
  });
  const request = vi.spyOn(ConfidentialConnection.prototype, "request").mockImplementation(function (
    this: any,
    opts: ConnectionRequestOptions,
  ) {
    const conn = this;
    if (!conn.idle) throw conn.failure ?? new SessionRejectedError("the connection cannot take a request now");
    const n = conn.requests + 1;
    conn.cur = { n };
    const b = behave(conn, n, opts);
    let over = false;
    const done = (async () => {
      await b.wait;
      if (b.refuse) {
        conn.cur = undefined;
        over = true;
        throw new RequestRefusedError(b.refuse.status, b.refuse.reason, b.refuse.detail);
      }
      conn.requests = n;
      if (b.fail) {
        conn.fail(b.fail);
        throw b.fail;
      }
      const image = opts.image !== undefined;
      const status = b.status ?? 200;
      const type = image ? "application/json" : "text/event-stream";
      opts.onResponseHead?.({ status, statusText: "", headers: { "content-type": type } });
      opts.onResponseBody?.(enc(image ? IMAGE_BODY : SSE));
      conn.cur = undefined;
      conn.settled++;
      conn.tLastSettled = Date.now();
      if (conn.framing === "1.1") conn.goaway = true;
      over = true;
      return {
        sid: conn.sid,
        http: conn.framing,
        n,
        stream: conn.framing === "2" ? 2 * n + 1 : undefined,
        model: opts.model,
        status,
        headers: { "content-type": type },
        body: image ? new Uint8Array(0) : enc(SSE),
        bodyChunks: image ? [enc(IMAGE_BODY.slice(0, 10)), enc(IMAGE_BODY.slice(10))] : undefined,
        receipt: { sid: conn.sid, model: opts.model, usage: {}, cost_msats: image ? 12100 : 7, http: conn.framing, n },
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
        if (!over) conn.close("request aborted");
      },
    } as never;
  });
  return { arm, connect, request };
}
