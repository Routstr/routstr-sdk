/**
 * Native TLS 1.3 key-schedule advice (node:crypto).
 *
 * These helpers mirror `cu-crypto` (the Rust key schedule) exactly; the session
 * driver cross-checks the derived `c_ap_1` against the TLS fork's own
 * `getKeys()` on every run, so a drift fails loudly before any proof runs.
 *
 * Ported from `crypto/client/src/advice.ts` in the prototype (read-only
 * reference). Only node/bun entrypoints may import this module.
 */

import { createCipheriv, createHash, createHmac } from "node:crypto";

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function hmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(msg).digest());
}

export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmac(salt, ikm);
}

export function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let t: Uint8Array = new Uint8Array(0);
  let counter = 1;
  let o = 0;
  while (o < len) {
    t = hmac(prk, concat(t, info, new Uint8Array([counter])));
    const take = Math.min(t.length, len - o);
    out.set(t.subarray(0, take), o);
    o += take;
    counter++;
  }
  return out;
}

export function hkdfLabel(label: string, context: Uint8Array, length: number): Uint8Array {
  const full = Buffer.from("tls13 " + label, "ascii");
  const buf = Buffer.alloc(2 + 1 + full.length + 1 + context.length);
  buf.writeUInt16BE(length, 0);
  buf.writeUInt8(full.length, 2);
  full.copy(buf, 3);
  buf.writeUInt8(context.length, 3 + full.length);
  Buffer.from(context).copy(buf, 4 + full.length);
  return new Uint8Array(buf);
}

export function expandLabel(
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  len: number,
): Uint8Array {
  const info = hkdfLabel(label, context, len);
  return hkdfExpand(secret, info, len).subarray(0, len);
}

export function trafficUpdate(secret: Uint8Array): Uint8Array {
  return expandLabel(secret, "traffic upd", new Uint8Array(0), 32);
}

export function aesEcbBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(block)), c.final()]));
}

export function j0(iv: Uint8Array, seq: bigint): Uint8Array {
  const nonce = new Uint8Array(iv);
  const s = Buffer.alloc(8);
  s.writeBigUInt64BE(seq);
  for (let i = 0; i < 8; i++) nonce[4 + i] ^= s[i]!;
  const block = new Uint8Array(16);
  block.set(nonce.subarray(0, 12), 0);
  block[12] = 0;
  block[13] = 0;
  block[14] = 0;
  block[15] = 1;
  return block;
}

export function ctrKeystream(
  key: Uint8Array,
  iv: Uint8Array,
  seq: bigint,
  len: number,
): Uint8Array {
  const ctr = j0(iv, seq);
  const blocks = Math.ceil(len / 16);
  const out = new Uint8Array(blocks * 16);
  for (let i = 0; i < blocks; i++) {
    let c = (ctr[12]! << 24) | (ctr[13]! << 16) | (ctr[14]! << 8) | ctr[15]!;
    c = (c + 1) >>> 0;
    ctr[12] = (c >>> 24) & 0xff;
    ctr[13] = (c >>> 16) & 0xff;
    ctr[14] = (c >>> 8) & 0xff;
    ctr[15] = c & 0xff;
    out.set(aesEcbBlock(key, ctr), i * 16);
  }
  return out.subarray(0, len);
}

export function ghashKey(key: Uint8Array): Uint8Array {
  return aesEcbBlock(key, new Uint8Array(16));
}

export interface Epoch1Material {
  cHs: Uint8Array;
  sHs: Uint8Array;
  ms: Uint8Array;
  cAp0: Uint8Array;
  cAp1: Uint8Array;
  cAp2: Uint8Array;
  k1: Uint8Array;
  iv1: Uint8Array;
  s: Uint8Array;
  h1: Uint8Array;
  t0: Uint8Array;
}

/** Record material for the epoch-1 credential record slot (seq 0). */
export function epoch1Material(
  handshakeSecret: Uint8Array,
  thSH: Uint8Array,
  thSF: Uint8Array,
  headLen: number,
): Epoch1Material {
  const cHs = expandLabel(handshakeSecret, "c hs traffic", thSH, 32);
  const sHs = expandLabel(handshakeSecret, "s hs traffic", thSH, 32);
  const derived = expandLabel(handshakeSecret, "derived", sha256(new Uint8Array(0)), 32);
  const ms = hkdfExtract(derived, new Uint8Array(32));
  const cAp0 = expandLabel(ms, "c ap traffic", thSF, 32);
  const cAp1 = trafficUpdate(cAp0);
  const cAp2 = trafficUpdate(cAp1);
  const k1 = expandLabel(cAp1, "key", new Uint8Array(0), 16);
  const iv1 = expandLabel(cAp1, "iv", new Uint8Array(0), 12);
  const s = ctrKeystream(k1, iv1, 0n, headLen);
  const h1 = ghashKey(k1);
  const t0 = aesEcbBlock(k1, j0(iv1, 0n));
  return { cHs, sHs, ms, cAp0, cAp1, cAp2, k1, iv1, s, h1, t0 };
}
