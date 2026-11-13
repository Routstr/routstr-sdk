/**
 * Canonical serialization + signature verification for node statements.
 *
 * The node signs every money-bearing statement (offer, attestation, receipt)
 * with its Nostr key as BIP-340 Schnorr over `sha256(canonical_json(payload))`,
 * where `canonical_json` is Python's
 * `json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False)`.
 *
 * The node also ships the exact signed bytes (`offer.sig_payload`,
 * `receipt.receipt_json`, `attestation.a_json`). Callers MUST verify against
 * those bytes when present; `canonicalJson` exists so a verifier that only has
 * the parsed object can still reproduce the payload, and for local tests.
 */

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";

/**
 * Deterministic JSON matching Python's `json.dumps(..., sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False)` for the value shapes the node
 * signs (string keys, strings/ints/floats/bools/null, nested objects/arrays).
 *
 * Float formatting is only exact for values JS and Python both render in the
 * shortest round-trip form; because the node also sends the literal signed
 * bytes, verification never depends on this for the money statements.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "string") return quotePythonLike(value as string);
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${quotePythonLike(k)}:${serialize(obj[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

/** JSON string escaping compatible with Python's ensure_ascii=False output. */
function quotePythonLike(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += ch;
    }
  }
  return out + '"';
}

/**
 * Verify a BIP-340 Schnorr signature (hex) over `sha256(utf8(payload))`.
 * Returns false on any parse/verify error rather than throwing.
 */
export function verifySchnorrSignature(
  payload: string,
  signatureHex: string | undefined,
  pubkeyHex: string | undefined,
): boolean {
  if (!signatureHex || !pubkeyHex) return false;
  try {
    const digest = sha256(utf8ToBytes(payload));
    return schnorr.verify(
      hexToBytes(signatureHex),
      digest,
      hexToBytes(pubkeyHex),
    );
  } catch {
    return false;
  }
}

/** sha256 of the canonical form, hex — the digest the node signs. */
export function statementDigestHex(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── npub (bech32) → hex ────────────────────────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/**
 * Decode a Nostr `npub1…` (bech32) to its 64-char hex x-only pubkey.
 * Returns null on any malformed input. `hex` input passes through lowercased.
 */
export function npubToHex(input: string): string | null {
  const s = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  const lower = s.toLowerCase();
  const idx = lower.lastIndexOf("1");
  if (idx < 1 || idx + 7 > lower.length) return null;
  const hrp = lower.slice(0, idx);
  if (hrp !== "npub") return null;
  const dataPart = lower.slice(idx + 1);
  const data: number[] = [];
  for (const c of dataPart) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) return null;
    data.push(v);
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) return null;
  const payload = data.slice(0, -6);
  const bytes = convertBits(payload, 5, 8, false);
  if (!bytes || bytes.length !== 32) return null;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
