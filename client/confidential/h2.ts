// HTTP/2 for protocol v3, option A (`http: 2`; PROTOCOL-V3-DESIGN.md A): the
// minimal framing layer (ported from the reference client, crypto/client/src/h2.ts;
// tests/unit/confidential-h2.test.ts runs the vectors the sidecar generates), an HPACK decoder for
// response header blocks (static table, literals, Huffman; no dynamic table,
// which the node's epoch-0 SETTINGS switch off), and the client-side checks
// of the proof parameters the node sends for an `http: 2` session.
//
// The client is the prover of π_WIN and the node chooses its windows. The
// equality bit must never become an oracle on private bytes, so every window
// is checked against the client's own records: the ciphertext is the one it
// sent (or received), and the compared bytes lie in a region that is public
// anyway (a frame header, the pinned header block, the pinned suffix, the
// record's final content-type byte, the disclosed error head).

import { SessionProtocolError } from "./errors";
import { HPACK_HUFFMAN, HPACK_STATIC } from "./hpack-tables";

export const PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')

export const FRAME = { DATA: 0, HEADERS: 1, RST_STREAM: 3, SETTINGS: 4, PING: 6, GOAWAY: 7, WINDOW_UPDATE: 8, CONTINUATION: 9 } as const
export const FLAG = { END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20 } as const

/** The largest DATA payload in one record: one frame per record, 2^14 bytes of content. */
export const MAX_DATA_IN_RECORD = (1 << 14) - 9

function fail(what: string): never {
  throw new SessionProtocolError(what);
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const ascii = (s: string) => new TextEncoder().encode(s)

/** Bytes as a string, one character per byte. */
export function latin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return s
}

function eq(a: ArrayLike<number> | undefined, b: ArrayLike<number>): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function frameHeader(len: number, type: number, flags: number, stream: number): Uint8Array {
  return Uint8Array.from([
    (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, type, flags,
    (stream >>> 24) & 0x7f, (stream >>> 16) & 0xff, (stream >>> 8) & 0xff, stream & 0xff,
  ])
}

export function frame(type: number, flags: number, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  return cat(frameHeader(payload.length, type, flags, stream), payload)
}

/** The stream of request `n` (1, 2, …); stream 1 is the node's probe. */
export const requestStream = (n: number) => 2 * n + 1

/** An HPACK string literal without Huffman coding (under 127 bytes). */
function hstr(s: Uint8Array): Uint8Array {
  if (s.length >= 127) fail('h2: string too long for a one-byte length')
  return cat(Uint8Array.from([s.length]), s)
}

/**
 * The connection head the node writes as the one epoch-0 record (A.3), with
 * zeros at the key's positions, and those positions. Rebuilt here from the
 * signed offer; π_NK is held to exactly these bytes.
 */
export function h2Head(host: string, probePath: string, keyLen: number): { template: Uint8Array; offsets: number[] } {
  const u32 = (v: number) => Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
  const setting = (id: number, v: number) => cat(Uint8Array.from([0, id]), u32(v))
  const settings = frame(FRAME.SETTINGS, 0, 0, cat(setting(1, 0), setting(2, 0), setting(4, 0x7fffffff)))
  const window = frame(FRAME.WINDOW_UPDATE, 0, 0, u32(0x7fffffff - 65535))
  if (keyLen + 7 >= 127 || keyLen <= 0) fail('h2: key length does not fit the head')
  const before = cat(
    Uint8Array.from([0x82, 0x87, 0x01]), hstr(ascii(host)),
    Uint8Array.from([0x04]), hstr(ascii(probePath)),
    Uint8Array.from([0x57, 7 + keyLen]), ascii('Bearer '),
  )
  const block = cat(before, new Uint8Array(keyLen))
  const headers = frame(FRAME.HEADERS, FLAG.END_STREAM | FLAG.END_HEADERS, 1, block)
  const prefix = cat(PREFACE, settings, window)
  const base = prefix.length + 9 + before.length
  const template = cat(prefix, headers, frame(FRAME.RST_STREAM, 0, 1, u32(8)))
  return { template, offsets: Array.from({ length: keyLen }, (_, i) => base + i) }
}

/** The header block of every request (A.5); `authorization` is the index 62 (0xbe). */
export function requestBlock(host: string, path: string): Uint8Array {
  return cat(
    Uint8Array.from([0x83, 0x87, 0x01]), hstr(ascii(host)),
    Uint8Array.from([0x04]), hstr(ascii(path)),
    Uint8Array.from([0x0f, 0x10]), hstr(ascii('application/json')),
    Uint8Array.from([0xbe]),
  )
}

// ---------------------------------------------------------------------------
// HPACK decoding without a dynamic table
// ---------------------------------------------------------------------------

let huffmanMap: Map<number, number> | undefined

/** Decode a Huffman-coded string (RFC 7541 §5.2): padding under 8 bits, all ones. */
export function huffmanDecode(data: Uint8Array): Uint8Array {
  if (!huffmanMap) {
    huffmanMap = new Map()
    HPACK_HUFFMAN.forEach(([code, len], sym) => huffmanMap!.set(len * 2 ** 32 + code, sym))
  }
  const out: number[] = []
  let code = 0
  let len = 0
  for (const byte of data) {
    for (let bit = 7; bit >= 0; bit--) {
      code = code * 2 + ((byte >> bit) & 1)
      len++
      const sym = huffmanMap.get(len * 2 ** 32 + code)
      if (sym !== undefined) {
        if (sym === 256) fail('hpack: EOS inside a Huffman string')
        out.push(sym)
        code = 0
        len = 0
      } else if (len >= 30) fail('hpack: invalid Huffman code')
    }
  }
  if (len >= 8 || code !== 2 ** len - 1) fail('hpack: bad Huffman padding')
  return Uint8Array.from(out)
}

/**
 * Decode a header block with an empty dynamic table: indexed static fields,
 * literals (one "with incremental indexing" adds nothing to a table of size
 * 0), and a table size update to 0 before the first field. Anything that
 * needs a dynamic entry throws.
 */
export function decodeBlock(block: Uint8Array): [string, string][] {
  const out: [string, string][] = []
  let i = 0
  const integer = (n: number): number => {
    const mask = (1 << n) - 1
    if (i >= block.length) fail('hpack: truncated integer')
    let v = block[i++]! & mask
    if (v < mask) return v
    for (let shift = 0; shift <= 21; shift += 7) {
      if (i >= block.length) fail('hpack: truncated integer')
      const b = block[i++]!
      v += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return v
    }
    return fail('hpack: integer too long')
  }
  const string = (): string => {
    if (i >= block.length) fail('hpack: truncated string')
    const huffman = (block[i]! & 0x80) !== 0
    const len = integer(7)
    if (i + len > block.length) fail('hpack: string past the block')
    const raw = block.subarray(i, i + len)
    i += len
    return latin1(huffman ? huffmanDecode(raw) : raw)
  }
  const fixed = (index: number): readonly [string, string] => {
    const e = index >= 1 ? HPACK_STATIC[index - 1] : undefined
    if (!e) fail(`hpack: index ${index} refers to the dynamic table (its size is 0)`)
    return e!
  }
  while (i < block.length) {
    const b = block[i]!
    if (b & 0x80) {
      const [n, v] = fixed(integer(7))
      out.push([n, v])
      continue
    }
    let prefix = 4
    if (b & 0x40) prefix = 6
    else if (b & 0x20) {
      const size = integer(5)
      if (size !== 0 || out.length > 0) fail(`hpack: dynamic table size update to ${size}`)
      continue
    }
    const index = integer(prefix)
    const name = index === 0 ? string() : fixed(index)[0]
    out.push([name, string()])
  }
  return out
}

// ---------------------------------------------------------------------------
// Receiving: frames out of the decrypted record stream
// ---------------------------------------------------------------------------

export interface RxFrame {
  type: number
  flags: number
  stream: number
  payload: Uint8Array
  /** Offset of the frame header in the connection's received byte stream. */
  off: number
}

/** One received application-data record's content and where it sits in the stream. */
export interface RxRecord {
  /** Index among the server's application-data records since the connection began. */
  abs: number
  start: number
  content: Uint8Array
}

/** Reassembles HTTP/2 frames from record contents and remembers which record holds which byte. */
export class FrameReader {
  records: RxRecord[] = []
  /** Total content bytes received. */
  total = 0
  private pending: Uint8Array = new Uint8Array(0)
  private pendingOff = 0

  push(content: Uint8Array, abs: number): RxFrame[] {
    this.records.push({ abs, start: this.total, content })
    this.total += content.length
    this.pending = cat(this.pending, content)
    const out: RxFrame[] = []
    while (this.pending.length >= 9) {
      const p = this.pending
      const len = (p[0]! << 16) | (p[1]! << 8) | p[2]!
      if (p.length < 9 + len) break
      out.push({
        type: p[3]!,
        flags: p[4]!,
        stream: (((p[5]! & 0x7f) << 24) | (p[6]! << 16) | (p[7]! << 8) | p[8]!) >>> 0,
        payload: p.slice(9, 9 + len),
        off: this.pendingOff,
      })
      this.pending = p.subarray(9 + len)
      this.pendingOff += 9 + len
    }
    return out
  }

  /** True when the bytes received so far end at a frame boundary. */
  atBoundary(): boolean {
    return this.pending.length === 0
  }

  /** The record holding stream offset `off`. */
  recordAt(off: number): RxRecord {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!
      if (off >= r.start && off < r.start + r.content.length) return r
    }
    return fail(`h2: no record holds stream offset ${off}`)
  }

  /** Stream bytes `[from, to)`. */
  slice(from: number, to: number): Uint8Array {
    const parts: Uint8Array[] = []
    for (const r of this.records) {
      const a = Math.max(from, r.start)
      const b = Math.min(to, r.start + r.content.length)
      if (a < b) parts.push(r.content.subarray(a - r.start, b - r.start))
    }
    return cat(...parts)
  }

  /** Forget records before stream offset `off` (a settled request's). */
  dropBefore(off: number): void {
    this.records = this.records.filter((r) => r.start + r.content.length > off)
  }
}

/**
 * Split a request body into DATA payloads of at most `chunk` bytes, the last
 * one holding at least the pinned suffix (it must be the tail of one frame).
 */
export function splitBody(body: Uint8Array, suffixLen: number, chunk = MAX_DATA_IN_RECORD): Uint8Array[] {
  if (suffixLen > chunk || suffixLen > body.length) fail('h2: the suffix does not fit one DATA frame')
  const parts: Uint8Array[] = []
  let off = 0
  while (body.length - off > chunk) {
    // Leave at least the suffix for the last frame.
    const n = Math.min(chunk, body.length - off - suffixLen)
    parts.push(body.subarray(off, off + n))
    off += n
  }
  parts.push(body.subarray(off))
  return parts.filter((p) => p.length > 0)
}

// ---------------------------------------------------------------------------
// Offer and proof-parameter checks
// ---------------------------------------------------------------------------

const CANONICAL_PATH = /^(\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)+$/

/** The checked `h2` block of an offer. */
export interface H2OfferBlock {
  probe_path: string
  /** The sidecar's own idle limit (seconds). */
  idle_secs: number
  max_requests: number
  /** Reserved at the setup, released after the connection's first settled request (msat; 0: none). */
  connection_deposit_msat: number
  /** The node closes a connection with no request in flight for this long (seconds). */
  idle_timeout_s: number
}

/**
 * The signed offer's `h2` block, held to what the node's sidecar enforces at
 * startup: `http` lists "2", the probe is a canonical path that is a trusted
 * API base plus `/models`, and the limits are in range. Returns the block.
 */
export function checkH2Offer(offer: any, apiBases: string[]): H2OfferBlock {
  if (!Array.isArray(offer?.http) || !offer.http.includes('2')) fail('offer_no_http2: the offer does not list http 2')
  const b = offer.h2
  if (!b || typeof b !== 'object') fail('offer_malformed: no h2 block')
  if (typeof b.probe_path !== 'string' || b.probe_path.length >= 127 || !CANONICAL_PATH.test(b.probe_path)) {
    fail('offer_malformed: h2 probe_path is not a canonical path')
  }
  if (!apiBases.some((base) => b.probe_path === `${base}/models`)) fail('offer_malformed: h2 probe_path is not a trusted API base plus /models')
  const idle = b.idle_secs ?? 300
  const max = b.max_requests ?? 100
  if (!(Number.isSafeInteger(idle) && idle >= 10 && idle <= 3600)) fail('offer_malformed: h2 idle_secs')
  if (!(Number.isSafeInteger(max) && max >= 1 && max <= 1000)) fail('offer_malformed: h2 max_requests')
  const host = offer.upstream_host
  if (typeof host !== 'string' || host.length >= 127 || !/^[A-Za-z0-9.-]+$/.test(host)) fail('offer_malformed: upstream_host')
  // A node's two terms (absent from a sidecar's own offer): the deposit it
  // reserves when a connection is opened, and how long it keeps an idle one.
  const deposit = b.connection_deposit_msat === undefined ? 0 : b.connection_deposit_msat
  const idleTimeout = b.idle_timeout_s === undefined ? idle : b.idle_timeout_s
  if (!(Number.isSafeInteger(deposit) && deposit >= 0)) fail('offer_malformed: h2 connection_deposit_msat')
  if (!(Number.isSafeInteger(idleTimeout) && idleTimeout >= 10 && idleTimeout <= idle)) fail('offer_malformed: h2 idle_timeout_s')
  return { probe_path: b.probe_path, idle_secs: idle, max_requests: max, connection_deposit_msat: deposit, idle_timeout_s: idleTimeout }
}

/** The request path of an `http: 2` chat request: the route of the offer's (already checked) head template. */
export function chatPath(headTemplate: string): string {
  const m = /^POST (\/[\x21-\x7e]*) HTTP\/1\.1\r\n/.exec(headTemplate)
  if (!m || m[1]!.length >= 127 || !CANONICAL_PATH.test(m[1]!)) fail('offer_malformed: no usable request path')
  return m![1]!
}

/**
 * π_NK for an `http: 2` session (the client verifies): the statement is
 * rebuilt from the signed offer (host, probe path, key length) and the
 * anchor hk of our own 2PC output, so the node can only prove the connection
 * head of A.3: its SETTINGS (no dynamic table for responses, no push), its
 * one probe request, and the credential as the one table entry.
 */
export function checkPiNKParamsH2(
  params: unknown,
  own: { host: string; probePath: string; keyLength: number; keyAlphabet?: string; hk: Uint8Array },
): void {
  const p = (params as { PiNK?: Record<string, any> } | null)?.PiNK
  if (!p) fail('π_NK: params missing')
  const { template, offsets } = h2Head(own.host, own.probePath, own.keyLength)
  const alphabet = own.keyAlphabet ?? '[A-Za-z0-9_-]'
  if ((p!.key_alphabet ?? alphabet) !== alphabet) fail('π_NK: key alphabet differs from the signed offer')
  if (p!.key_len !== own.keyLength) fail('π_NK: key length mismatch')
  if (!eq(p!.template, template)) fail('π_NK: the head is not the HTTP/2 connection head of the offer')
  if (!eq(p!.key_offsets, offsets)) fail('π_NK: key offsets differ from the head')
  if (p!.head_len !== template.length) fail('π_NK: head_len mismatch')
  if (!eq(p!.hk, own.hk)) fail('π_NK: hk is not the anchor from our 2PC')
  const n = template.length + 1
  if (!eq(p!.header, [0x17, 0x03, 0x03, (n + 16) >> 8, (n + 16) & 0xff])) fail('π_NK: record header mismatch')
  if (!Array.isArray(p!.c_commit) || p!.c_commit.length !== 32) fail('π_NK: c_commit missing')
}

/** One of our own records, as a π_WIN window may refer to it. */
export interface WinSource {
  /** The record's ciphertext without the 16-byte tag. */
  ct: Uint8Array
  /** Its inner plaintext (content, the content-type byte, any padding). */
  plain: Uint8Array
  /** Byte ranges `[start, end)` of `plain` that are public. */
  pub: [number, number][]
}

/** The most windows and ciphertext bytes of one π_WIN (the statement's limits). */
export const MAX_WIN_WINDOWS = 2200
export const MAX_WIN_BYTES = 64 << 10

/**
 * π_WIN: every window names one of our records by sequence number, carries
 * exactly its ciphertext at a block-aligned offset, and compares bytes that
 * (a) are what the record really holds and (b) lie inside one public range.
 * `covered`, when given, must each be referred to by at least one window.
 */
export function checkPiWinParams(
  params: unknown,
  own: { anchor: Uint8Array; keyUpdates?: number; lookup: (seq: number) => WinSource | undefined; covered?: number[] },
): { windows: number; ctBytes: number } {
  const p = (params as { PiWin?: Record<string, any> } | null)?.PiWin
  const bad = (what: string): never => fail(`π_WIN: node-supplied parameters rejected (${what})`)
  if (!p) bad('missing')
  if (!eq(p!.anchor, own.anchor)) bad('anchor is not the one from our 2PC')
  if ((p!.key_updates ?? 0) !== (own.keyUpdates ?? 0)) bad('key epoch differs from ours')
  const ws = p!.windows
  if (!Array.isArray(ws) || ws.length === 0 || ws.length > MAX_WIN_WINDOWS) bad('window count')
  let ctBytes = 0
  const seen = new Set<number>()
  // Adjacent public ranges count as one.
  const merged = (pub: [number, number][]): [number, number][] => {
    const out: [number, number][] = []
    for (const [s, e] of [...pub].sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1]
      if (last && s <= last[1]) last[1] = Math.max(last[1], e)
      else out.push([s, e])
    }
    return out
  }
  for (const w of ws as Record<string, any>[]) {
    const seq = w.seq
    const off = w.off ?? 0
    const sel = w.sel_start ?? 0
    const src = Number.isSafeInteger(seq) ? own.lookup(seq) : undefined
    if (!src) bad(`window names record ${seq}, which is not one of ours in this proof`)
    const ct = w.ct as ArrayLike<number>
    const expected = w.expected as ArrayLike<number>
    if (!Number.isSafeInteger(off) || off < 0 || off % 16 !== 0) bad('offset not block-aligned')
    if (!ct || !(ct.length > 0) || off + ct.length > src!.ct.length) bad('ciphertext range outside our record')
    if (!eq(ct, src!.ct.subarray(off, off + ct.length))) bad('ciphertext is not ours')
    if (!Number.isSafeInteger(sel) || sel < 0 || !expected || !(expected.length > 0) || sel + expected.length > ct.length) {
      bad('compared range outside the window')
    }
    const a = off + sel
    const b = a + expected.length
    if (!merged(src!.pub).some(([s, e]) => a >= s && b <= e)) bad(`compared bytes [${a}, ${b}) of record ${seq} are not public`)
    if (!eq(expected, src!.plain.subarray(a, b))) bad('expected bytes are not what our record holds')
    ctBytes += ct.length
    seen.add(seq)
  }
  if (ctBytes > MAX_WIN_BYTES) bad('too much ciphertext')
  for (const seq of own.covered ?? []) if (!seen.has(seq)) bad(`no window covers record ${seq}`)
  return { windows: ws.length, ctBytes }
}
