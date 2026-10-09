/**
 * Client-side checks of the proof parameters the node sends for π_C1, π_C2
 * and π_C3.
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
  const payload = own.record.subarray(5);
  const ctLen = payload.length - 16; // inner plaintext length (content + type byte)
  const selLen = own.suffix.length;
  const w = Math.min(selLen + 1 + 13, ctLen);
  const off = ctLen - w;
  const selStart = w - 1 - selLen;
  if (selStart < 0) fail("π_C2", "suffix does not fit in our final record");
  if (p.seq !== own.seq) fail("π_C2", `seq ${p.seq} is not our final record ${own.seq}`);
  if (p.off !== off || p.w !== w || p.sel_start !== selStart || p.sel_len !== selLen) {
    fail("π_C2", "window is not the end of our final record");
  }
  if (!eq(p.ct_window, payload.subarray(off, off + w))) fail("π_C2", "ciphertext is not ours");
  if (!eq(p.expected, own.suffix)) fail("π_C2", "expected bytes are not our suffix");
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
  if (!eq(p.expected, own.r)) fail("π_C3", "expected bytes are not our disclosure");
  if ((p.skip ?? 0) !== own.skip) fail("π_C3", "skip differs from ours");
  const recs = p.records as { seq: number; ct: Bytes }[] | undefined;
  if (!Array.isArray(recs) || recs.length === 0) fail("π_C3", "no records");
  // One trailing close_notify-sized record (2 + 1 + 16 bytes) may follow.
  let end = own.serverRecords.length;
  const lastRec = own.serverRecords[end - 1];
  if (lastRec && lastRec.length === 19 && recs[recs.length - 1]!.ct.length !== 3) end -= 1;
  const mine = own.serverRecords.slice(end - recs.length, end);
  if (mine.length !== recs.length) fail("π_C3", "more records than we received");
  let covered = 0;
  for (let i = 0; i < recs.length; i++) {
    const { seq, ct } = recs[i]!;
    if (!Number.isInteger(seq) || (i > 0 && seq !== recs[i - 1]!.seq + 1)) {
      fail("π_C3", "records are not contiguous");
    }
    const m = mine[i]!;
    if (!eq(ct, m.subarray(0, m.length - 16))) {
      fail("π_C3", "records are not the end of the transcript we received");
    }
    covered += m.length - 16 - 1;
  }
  if (covered < own.r.length + own.skip) fail("π_C3", "records do not cover the disclosure");
}
