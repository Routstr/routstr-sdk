/**
 * Client-side checks of the proof parameters the node sends for π_C1, π_C2
 * and π_C3 (protocol v1), and π_NK, π_C2S and π_C3S (protocol v2).
 *
 * The client is the prover and the node chooses the public parameters, so the
 * client only proves statements about data it already agreed to disclose: its
 * own record material (π_C1), its own final body record carrying the pinned
 * suffix (π_C2), and the final server records covering its own disclosure
 * (π_C3). The circuits reveal only an equality bit; these checks make sure the
 * node cannot point even that bit at other plaintext.
 */

import { SessionProtocolError } from "./errors";

export interface SessionValues {
  clientHs: Uint8Array;
  serverHs: Uint8Array;
  thSH: Uint8Array;
  thSF: Uint8Array;
}

type Bytes = ArrayLike<number>;

interface SessionParams {
  client_hs: Bytes;
  server_hs: Bytes;
  th_sh: Bytes;
  th_sf: Bytes;
}

function eq(a: Bytes | undefined, b: Bytes): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fail(proof: string, what: string): never {
  throw new SessionProtocolError(`${proof}: node-supplied parameters rejected (${what})`);
}

function checkSession(proof: string, s: SessionParams | undefined, own: SessionValues): void {
  if (
    !s ||
    !eq(s.client_hs, own.clientHs) ||
    !eq(s.server_hs, own.serverHs) ||
    !eq(s.th_sh, own.thSH) ||
    !eq(s.th_sf, own.thSF)
  ) {
    fail(proof, "session values differ from our handshake");
  }
}

/** π_C1: exactly the record material we sent in `c1_material`. */
export function checkPiC1Params(
  params: unknown,
  own: { session: SessionValues; headLen: number; s: Uint8Array; h1: Uint8Array; t0: Uint8Array },
): void {
  const p = (params as { PiC1?: Record<string, any> } | null)?.PiC1;
  if (!p) fail("π_C1", "missing");
  checkSession("π_C1", p.session, own.session);
  if (p.head_len !== own.headLen || !eq(p.s, own.s) || !eq(p.h1, own.h1) || !eq(p.t0, own.t0)) {
    fail("π_C1", "material differs from ours");
  }
}

/**
 * π_C2: a window over *our* final body record (`record` = header + payload,
 * as we wrote it), ending at the inner content-type byte, equal to our suffix.
 */
export function checkPiC2Params(
  params: unknown,
  own: { session: SessionValues; seq: number; record: Uint8Array; suffix: Uint8Array },
): void {
  const p = (params as { PiC2?: Record<string, any> } | null)?.PiC2;
  if (!p) fail("π_C2", "missing");
  checkSession("π_C2", p.session, own.session);
  checkSuffixWindow("π_C2", p, own);
}

function checkSuffixWindow(
  proof: string,
  p: Record<string, any>,
  own: { seq: number; record: Uint8Array; suffix: Uint8Array },
): void {
  const payload = own.record.subarray(5);
  const ctLen = payload.length - 16; // inner plaintext length (content + type byte)
  const selLen = own.suffix.length;
  const w = Math.min(selLen + 1 + 13, ctLen);
  const off = ctLen - w;
  const selStart = w - 1 - selLen;
  if (selStart < 0) fail(proof, "suffix does not fit in our final record");
  if (p.seq !== own.seq) fail(proof, `seq ${p.seq} is not our final record ${own.seq}`);
  // v2 compares our suffix followed by the record's inner content type
  // (0x17, public too); v1's π_C2 compares the suffix alone.
  const want = proof === "π_C2S" ? Uint8Array.from([...own.suffix, 0x17]) : own.suffix;
  if (p.off !== off || p.w !== w || p.sel_start !== selStart || p.sel_len !== want.length) {
    fail(proof, "window is not the end of our final record");
  }
  if (!eq(p.ct_window, payload.subarray(off, off + w))) fail(proof, "ciphertext is not ours");
  if (!eq(p.expected, want)) fail(proof, "expected bytes are not our suffix");
}

/**
 * π_C3: the final server application records, exactly as we received them,
 * covering our disclosure `r` followed by `skip` undisclosed bytes.
 *
 * `serverRecords` are the payloads (ciphertext + tag) of every server
 * application-data record in arrival order. Records are matched from the end
 * of the transcript by content; a wrong `seq` would only make the in-circuit
 * decryption fail, never decrypt anything else.
 */
export function checkPiC3Params(
  params: unknown,
  own: { session: SessionValues; serverRecords: Uint8Array[]; r: Uint8Array; skip: number },
): void {
  const p = (params as { PiC3?: Record<string, any> } | null)?.PiC3;
  if (!p) fail("π_C3", "missing");
  checkSession("π_C3", p.session, own.session);
  checkTailRecords("π_C3", p, own);
}

function checkTailRecords(
  proof: string,
  p: Record<string, any>,
  own: {
    serverRecords: Uint8Array[];
    r: Uint8Array;
    skip: number;
    /** Server KeyUpdates we saw before the covered records (v2). */
    keyUpdates?: number;
    /**
     * Wire index (in `serverRecords`) of sequence 0 of the covered records'
     * key epoch; when given, every record's `seq` must be exactly its offset.
     */
    epochBase?: number;
  },
): void {
  if (!eq(p.expected, own.r)) fail(proof, "expected bytes are not our disclosure");
  if ((p.skip ?? 0) !== own.skip) fail(proof, "skip differs from ours");
  if ((p.key_updates ?? 0) !== (own.keyUpdates ?? 0)) fail(proof, "server key epoch differs from ours");
  const recs = p.records as { seq: number; ct: Bytes }[] | undefined;
  if (!Array.isArray(recs) || recs.length === 0) fail(proof, "no records");
  // One trailing close_notify-sized record (2 + 1 + 16 bytes) may follow.
  let end = own.serverRecords.length;
  const lastRec = own.serverRecords[end - 1];
  if (lastRec && lastRec.length === 19 && recs[recs.length - 1]!.ct?.length !== 3) end -= 1;
  const first = Math.max(0, end - recs.length);
  const mine = own.serverRecords.slice(first, end);
  if (mine.length !== recs.length) fail(proof, "more records than we received");
  // π_C3S decrypts the first record only from the last block boundary that
  // still covers the disclosure; the offset is determined by our own records.
  const contentOf = (m: Uint8Array) => m.length - 16 - 1;
  const total = mine.reduce((n, m) => n + contentOf(m), 0);
  const need = own.r.length + own.skip;
  const firstContent = contentOf(mine[0]!);
  const expectedOff =
    proof === "π_C3S" && total >= need
      ? Math.floor((firstContent - Math.max(0, need - (total - firstContent))) / 16) * 16
      : 0;
  if (own.epochBase !== undefined && recs[0]!.seq !== first - own.epochBase) {
    fail(proof, "record sequence numbers are not their position in our transcript");
  }
  let covered = 0;
  for (let i = 0; i < recs.length; i++) {
    const { seq, ct } = recs[i]!;
    const off = (recs[i] as { off?: number }).off ?? 0;
    if (!Number.isInteger(seq) || (i > 0 && seq !== recs[i - 1]!.seq + 1)) {
      fail(proof, "records are not contiguous");
    }
    if (off !== (i === 0 ? expectedOff : 0)) fail(proof, "record offset is not the one our disclosure needs");
    const m = mine[i]!;
    if (!eq(ct, m.subarray(off, m.length - 16))) {
      fail(proof, "records are not the end of the transcript we received");
    }
    covered += m.length - 16 - 1;
  }
  if (covered < own.r.length + own.skip) fail(proof, "records do not cover the disclosure");
}

// ---------------------------------------------------------------------------
// Protocol v2 (two-party handshake, docs/TWOPC-DESIGN.md). The proofs anchor
// on public hashes of the secrets our 2PC output gave us (h1 = SHA256(c_ap_1),
// h2 = SHA256(s_ap_0), hk = SHA256(K_0 ‖ IV_0)) instead of handshake values;
// the windows are checked exactly as in v1.
// ---------------------------------------------------------------------------

/** π_C2S: the end of our own final epoch-1 body record, anchored on our h1. */
export function checkPiC2SParams(
  params: unknown,
  own: { h1: Uint8Array; seq: number; record: Uint8Array; suffix: Uint8Array },
): void {
  const p = (params as { PiC2S?: Record<string, any> } | null)?.PiC2S;
  if (!p) fail("π_C2S", "missing");
  if (!eq(p.h1, own.h1)) fail("π_C2S", "anchor h1 is not the one from our 2PC");
  checkSuffixWindow("π_C2S", p, own);
}

/** π_C3S: the final server records as we received them, anchored on our h2. */
export function checkPiC3SParams(
  params: unknown,
  own: {
    h2: Uint8Array;
    serverRecords: Uint8Array[];
    r: Uint8Array;
    skip: number;
    keyUpdates?: number;
    epochBase?: number;
  },
): void {
  const p = (params as { PiC3S?: Record<string, any> } | null)?.PiC3S;
  if (!p) fail("π_C3S", "missing");
  if (!eq(p.h2, own.h2)) fail("π_C3S", "anchor h2 is not the one from our 2PC");
  checkTailRecords("π_C3S", p, own);
}

/**
 * π_NK (the client verifies): rebuild the statement from the *signed* offer,
 * our own body length and the anchor hk from our own 2PC output, so the node
 * cannot prove a different template, key placement, alphabet or key (K_0).
 */
export function checkPiNKParams(
  params: unknown,
  own: {
    offer: { head_template?: string; key_length?: number; key_alphabet?: string; upstream_host?: string };
    hk: Uint8Array;
    bodyLen: number;
  },
): void {
  const p = (params as { PiNK?: Record<string, any> } | null)?.PiNK;
  if (!p) fail("π_NK", "missing");
  const tpl = own.offer.head_template ?? "";
  checkHeadTemplate(tpl, own.offer.upstream_host ?? "");
  const keyLen = own.offer.key_length;
  if (typeof keyLen !== "number" || !Number.isInteger(keyLen) || keyLen <= 0) {
    fail("π_NK", "signed offer has no key length");
  }
  const alphabet = own.offer.key_alphabet ?? "[A-Za-z0-9_-]";
  const token = `{KEY:${keyLen}}`;
  if (!tpl.includes(token)) fail("π_NK", "published template lacks the {KEY:n} token");
  if ((p.key_alphabet ?? alphabet) !== alphabet) fail("π_NK", "key alphabet differs from the signed offer");
  const filled = new TextEncoder().encode(
    tpl.replace(token, "\u0000".repeat(keyLen)).replace("{LEN}", String(own.bodyLen)),
  );
  const offs: number[] = [];
  filled.forEach((b, i) => {
    if (b === 0) offs.push(i);
  });
  if (p.key_len !== keyLen || offs.length !== keyLen) fail("π_NK", "key length mismatch");
  if (!eq(p.template, filled)) fail("π_NK", "template differs from the published one");
  if (!eq(p.key_offsets, offs)) fail("π_NK", "key offsets differ from the template");
  if (p.head_len !== filled.length) fail("π_NK", "head_len mismatch");
  if (!eq(p.hk, own.hk)) fail("π_NK", "hk is not the anchor from our 2PC");
  const n = filled.length + 1;
  if (!eq(p.header, [0x17, 0x03, 0x03, (n + 16) >> 8, (n + 16) & 0xff])) {
    fail("π_NK", "record header mismatch");
  }
  if (!Array.isArray(p.c_commit) || p.c_commit.length !== 32) fail("π_NK", "c_commit missing");
}

/**
 * The published head template must be one HTTP/1.1 POST request head for the
 * offer's upstream host: `Host` names that host, the body length is the
 * `Content-Length`, and exactly one key token and one length token appear.
 * (The node writes the head, so this is what π_NK lets us hold it to.)
 */
export function checkHeadTemplate(tpl: string, upstreamHost: string): void {
  const count = (re: RegExp) => (tpl.match(re) ?? []).length;
  if (count(/\{KEY:\d+\}/g) !== 1) fail("π_NK", "template must carry exactly one {KEY:n} token");
  if (count(/\{LEN\}/g) !== 1) fail("π_NK", "template must carry exactly one {LEN} token");
  if (count(/[{}]/g) !== 4) fail("π_NK", "template carries other placeholders");
  if (!/^POST \/[\x21-\x7e]* HTTP\/1\.1\r\n/.test(tpl)) fail("π_NK", "template is not an HTTP/1.1 POST");
  if (!tpl.endsWith("\r\n\r\n") || tpl.indexOf("\r\n\r\n") !== tpl.length - 4) {
    fail("π_NK", "template is not exactly one request head");
  }
  const headers = tpl.slice(0, -4).split("\r\n").slice(1);
  const values = (name: string) =>
    headers
      .filter((h) => h.slice(0, h.indexOf(":")).trim().toLowerCase() === name)
      .map((h) => h.slice(h.indexOf(":") + 1).trim());
  const host = values("host");
  if (!upstreamHost || host.length !== 1 || host[0]!.toLowerCase() !== upstreamHost.toLowerCase()) {
    fail("π_NK", "template Host is not the offer's upstream host");
  }
  const len = values("content-length");
  if (len.length !== 1 || len[0] !== "{LEN}") fail("π_NK", "template Content-Length is not the body length");
  if (values("transfer-encoding").length > 0) fail("π_NK", "template sets Transfer-Encoding");
}
