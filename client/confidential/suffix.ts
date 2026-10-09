/**
 * Body/suffix construction and everything the client proves or checks about
 * its own request and the upstream response:
 *
 *  - `canonicalSuffix` — the byte-exact JSON suffix the sidecar reconstructs
 *    and requires (GAP-1). Must match `crypto/relay/src/main.rs::canonical_suffix`.
 *  - `buildConfidentialBody` — a body whose last bytes are that suffix.
 *  - `checkPiNParams` — rebuild π_N's statement from the published template,
 *    our own body length and the keystream we sent (review #10).
 *  - `parseHttpResponse` — split the decrypted upstream bytes into status,
 *    headers and body (the TLS fork has already verified every GCM tag).
 *  - `extractUsageDisclosure` — locate the π_C3 disclosure window `R`.
 */

import { concat } from "./advice";
import { ResponseVerificationError, SessionProtocolError } from "./errors";

/**
 * The public JSON suffix that pins every cost-relevant parameter. Byte-exact
 * with the sidecar's reconstruction; a mismatch aborts the session (GAP-1).
 */
export function canonicalSuffix(model: string, maxTokens: number): string {
  return (
    `,"model":${JSON.stringify(model)},"max_tokens":${maxTokens},` +
    `"max_completion_tokens":${maxTokens},"n":1,"stream":true,` +
    `"stream_options":{"include_usage":true},` +
    `"venice_parameters":{"include_venice_system_prompt":false,"enable_web_search":"off"}}`
  );
}

/**
 * Build a confidential request body: an object whose *last* bytes are the
 * canonical suffix. `privateJson` is the JSON text of the private part up to
 * (and excluding) its closing brace, e.g. `{"messages":[{"role":"user",...}]`.
 * Duplicate keys in the private part are harmless: the provider keeps the last
 * occurrence, which is always the suffix.
 */
export function buildConfidentialBody(
  privateJson: string,
  suffix: string,
  encoder: TextEncoder = new TextEncoder(),
): Uint8Array {
  return encoder.encode(privateJson + suffix);
}

// ─── π_N statement rebuild ──────────────────────────────────────────────────

export interface PiNParams {
  template: number[];
  key_len: number;
  key_offsets: number[];
  head_len: number;
  header: number[];
  s: number[];
  key_alphabet?: string;
}

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Verify that the π_N public statement the node handed us is exactly the one we
 * can rebuild from our own knowledge: the published head template, our body
 * length, and the keystream `s` we sent. A node must not be able to prove a
 * different path/headers, a different `s`, or key offsets over non-key bytes.
 */
export function checkPiNParams(
  params: unknown,
  ready: { offer?: { head_template?: string; key_length?: number; key_alphabet?: string } },
  s: Uint8Array,
  bodyLen: number,
): void {
  const p = (params as { PiN?: PiNParams } | null)?.PiN;
  if (!p) throw new SessionProtocolError("π_N params missing from c_commit");
  const tpl: string = ready.offer?.head_template ?? "";
  const keyLen: number = ready.offer?.key_length ?? p.key_len;
  const alphabet: string = ready.offer?.key_alphabet ?? "[A-Za-z0-9_-]";
  const token = `{KEY:${keyLen}}`;
  if (!tpl.includes(token)) {
    throw new SessionProtocolError("π_N: published template lacks the {KEY:n} token");
  }
  if (p.key_alphabet !== undefined && p.key_alphabet !== alphabet) {
    throw new SessionProtocolError("π_N: key alphabet differs from the signed offer");
  }
  const filled = new TextEncoder().encode(
    tpl.replace(token, "\u0000".repeat(keyLen)).replace("{LEN}", String(bodyLen)),
  );
  const offs: number[] = [];
  filled.forEach((b, i) => {
    if (b === 0) offs.push(i);
  });
  if (p.key_len !== keyLen || offs.length !== keyLen) {
    throw new SessionProtocolError("π_N: key length mismatch");
  }
  if (!arraysEqual(p.template, filled)) {
    throw new SessionProtocolError("π_N: template differs from the published one");
  }
  if (!arraysEqual(p.key_offsets, offs)) {
    throw new SessionProtocolError("π_N: key offsets differ from the template");
  }
  if (p.head_len !== filled.length) {
    throw new SessionProtocolError("π_N: head_len mismatch");
  }
  if (!arraysEqual(p.s, s)) {
    throw new SessionProtocolError("π_N: keystream differs from the one we sent");
  }
  const n = filled.length + 1;
  if (!arraysEqual(p.header, [0x17, 0x03, 0x03, (n + 16) >> 8, (n + 16) & 0xff])) {
    throw new SessionProtocolError("π_N: record header mismatch");
  }
}

// ─── HTTP response parsing (plaintext after TLS) ────────────────────────────

export interface ParsedHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw decrypted plaintext, including status line + headers. */
  raw: Uint8Array;
  /** Body bytes (after the header terminator). */
  body: Uint8Array;
  bodyText: string;
  contentType: string;
}

/** Split the decrypted upstream plaintext into an HTTP/1.1 response. */
export function parseHttpResponse(bytes: Uint8Array): ParsedHttpResponse {
  let headerEnd = -1;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd < 0) {
    throw new ResponseVerificationError("upstream response has no HTTP header terminator");
  }
  const headText = Buffer.from(bytes.subarray(0, headerEnd)).toString("latin1");
  const lines = headText.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const m = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine);
  if (!m) {
    throw new ResponseVerificationError(`malformed status line: ${JSON.stringify(statusLine)}`);
  }
  const status = Number(m[1]);
  const statusText = m[2] ?? "";
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const rawBody = bytes.subarray(headerEnd + 4);
  const body = /chunked/i.test(headers["transfer-encoding"] ?? "")
    ? dechunkAll(rawBody)
    : rawBody;
  return {
    status,
    statusText,
    headers,
    raw: bytes,
    body,
    bodyText: Buffer.from(body).toString("utf8"),
    contentType: headers["content-type"] ?? "",
  };
}

// ─── π_C3 disclosure extraction (chunked transfer encoding) ─────────────────

interface Chunk {
  start: number;
  data: Uint8Array;
}

function parseChunks(b: Uint8Array): Chunk[] | null {
  let off = 0;
  const out: Chunk[] = [];
  for (;;) {
    let nl = -1;
    for (let i = off; i + 1 < b.length; i++) {
      if (b[i] === 13 && b[i + 1] === 10) {
        nl = i;
        break;
      }
    }
    if (nl < 0) return null;
    const line = Buffer.from(b.subarray(off, nl)).toString("ascii").trim();
    if (!/^[0-9a-fA-F]+$/.test(line)) return null;
    const len = parseInt(line, 16);
    const dataStart = nl + 2;
    if (len === 0) {
      if (b.length !== dataStart + 2) return null;
      return out;
    }
    if (b.length < dataStart + len + 2) return null;
    if (b[dataStart + len] !== 13 || b[dataStart + len + 1] !== 10) return null;
    out.push({ start: off, data: b.subarray(dataStart, dataStart + len) });
    off = dataStart + len + 2;
  }
}

function endsWithUsageEvent(joined: Uint8Array): boolean {
  const text = Buffer.from(joined).toString("utf8");
  const tail = "data: [DONE]\n\n";
  if (!text.endsWith(tail)) return false;
  const before = text.slice(0, text.length - tail.length);
  const idx = before.lastIndexOf("data: ");
  const evText = (idx >= 0 ? before.slice(idx + 6) : before).trim();
  if (!evText) return false;
  try {
    const v = JSON.parse(evText) as { choices?: unknown[]; usage?: { prompt_tokens?: number } };
    return Array.isArray(v.choices) && v.choices.length === 0 && !!v.usage && v.usage.prompt_tokens !== undefined;
  } catch {
    return false;
  }
}

/**
 * Locate the minimal suffix of the chunked body that still ends with the final
 * usage event + `[DONE]` — the π_C3 disclosure window `R`.
 */
export function extractUsageDisclosure(responseBytes: Uint8Array): Uint8Array | null {
  const parsedBodyStart = findBodyStart(responseBytes);
  const body = responseBytes.subarray(parsedBodyStart);
  const all = parseChunks(body);
  if (!all) return null;
  for (let i = all.length - 1; i >= 0; i--) {
    const r = body.subarray(all[i]!.start);
    const chunks = parseChunks(r);
    if (!chunks) continue;
    const joined = concat(...chunks.map((c) => c.data));
    if (endsWithUsageEvent(joined)) return r;
  }
  return null;
}

function findBodyStart(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i + 4;
  }
  return 0;
}

/** Parse the usage event out of a disclosure window (the node's pricing key). */
export interface UpstreamUsageEvent {
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; [k: string]: unknown };
  cost?: unknown;
  [k: string]: unknown;
}

export function usageEventFromDisclosure(r: Uint8Array): UpstreamUsageEvent | null {
  const text = Buffer.from(r).toString("utf8");
  const parts = text.split("data: ");
  const seg = parts.length >= 2 ? parts[parts.length - 2]! : "{}";
  try {
    const parsed = JSON.parse(seg.split("\r\n")[0]!.split("\n\n")[0]!.trim());
    if (typeof parsed?.model !== "string" || !parsed?.usage) return null;
    return parsed as UpstreamUsageEvent;
  } catch {
    return null;
  }
}

/**
 * The tail record ciphertext lengths (content + inner type byte) covering `R`,
 * taken from the end of the response record list. Mirrors the reference
 * client's computation.
 */
export function disclosureTailLens(responseChunkLens: number[], rLength: number): number[] {
  const tailLens: number[] = [];
  let acc = 0;
  for (let i = responseChunkLens.length - 1; i >= 0 && acc < rLength; i--) {
    const len = responseChunkLens[i]! + 1;
    tailLens.push(len);
    acc += responseChunkLens[i]!;
  }
  return tailLens;
}

/** Best-effort effective model from the streamed plaintext (last `"model":"…"`). */
export function effectiveModelFromText(text: string): string | undefined {
  const matches = [...text.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
  return matches[matches.length - 1];
}


/** Hop-by-hop / framing headers that must not be copied onto a rebuilt response. */
export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
]);

function dechunkAll(raw: Uint8Array): Uint8Array {
  const d = new ChunkedDecoder();
  const parts = d.push(raw);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Incremental HTTP/1.1 response decoder: feed decrypted TLS application data,
 * get the parsed head once and the (de-chunked) body bytes as they arrive.
 * Used to stream a confidential response to the caller while the session's
 * proofs and settlement are still running.
 */
export class IncrementalHttpResponse {
  private buf = new Uint8Array(0);
  private headDone = false;
  private chunked = false;
  private decoder = new ChunkedDecoder();
  head?: { status: number; statusText: string; headers: Record<string, string> };

  /** Returns body bytes made available by this push (possibly empty). */
  push(data: Uint8Array): Uint8Array[] {
    if (this.headDone) return this.chunked ? this.decoder.push(data) : [data];
    const merged = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf);
    merged.set(data, this.buf.length);
    this.buf = merged;
    for (let i = 0; i + 3 < merged.length; i++) {
      if (merged[i] === 13 && merged[i + 1] === 10 && merged[i + 2] === 13 && merged[i + 3] === 10) {
        const parsed = parseHttpResponse(merged.subarray(0, i + 4));
        this.head = { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers };
        this.chunked = /chunked/i.test(parsed.headers["transfer-encoding"] ?? "");
        this.headDone = true;
        const rest = merged.subarray(i + 4);
        this.buf = new Uint8Array(0);
        if (rest.length === 0) return [];
        return this.chunked ? this.decoder.push(rest) : [rest];
      }
    }
    return [];
  }

  get complete(): boolean {
    return this.headDone && (!this.chunked || this.decoder.done);
  }
}

/** Streaming `Transfer-Encoding: chunked` decoder. */
export class ChunkedDecoder {
  private pending = new Uint8Array(0);
  private remaining = -1; // bytes left in the current chunk; -1 = expecting a size line
  private needCrlf = false;
  done = false;

  push(data: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let buf = new Uint8Array(this.pending.length + data.length);
    buf.set(this.pending);
    buf.set(data, this.pending.length);
    let off = 0;
    while (off < buf.length && !this.done) {
      if (this.needCrlf) {
        if (buf.length - off < 2) break;
        if (buf[off] !== 13 || buf[off + 1] !== 10) {
          throw new ResponseVerificationError("chunked body: missing CRLF after chunk data");
        }
        off += 2;
        this.needCrlf = false;
        continue;
      }
      if (this.remaining < 0) {
        let nl = -1;
        for (let i = off; i + 1 < buf.length; i++) {
          if (buf[i] === 13 && buf[i + 1] === 10) {
            nl = i;
            break;
          }
        }
        if (nl < 0) break;
        const line = Buffer.from(buf.subarray(off, nl)).toString("latin1").split(";")[0]!.trim();
        const size = Number.parseInt(line, 16);
        if (!Number.isFinite(size) || size < 0 || !/^[0-9a-fA-F]+$/.test(line)) {
          throw new ResponseVerificationError(`chunked body: bad chunk size ${JSON.stringify(line)}`);
        }
        off = nl + 2;
        if (size === 0) {
          this.done = true; // trailers (if any) are ignored
          break;
        }
        this.remaining = size;
        continue;
      }
      const take = Math.min(this.remaining, buf.length - off);
      out.push(buf.slice(off, off + take));
      off += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        this.remaining = -1;
        this.needCrlf = true;
      }
    }
    this.pending = buf.slice(off);
    return out;
  }
}
