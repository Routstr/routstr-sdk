/**
 * Comparator: checks the disclosed (proven) TLS transcript against what the
 * SDK itself sent on channel A and received back.
 *
 * The disclosed transcript is raw HTTP/1.1 wire bytes; redacted ranges read
 * as zero bytes. Responses may be transfer-encoded (SSE usually is), so the
 * HTTP layer is parsed before comparison (see STATUS.md comparator note).
 */

export interface ParsedHttpRequest {
  method: string;
  path: string;
  headers: Map<string, string>;
  body: Uint8Array;
  /** Raw transcript bytes (redacted ranges are zero). */
  raw: Uint8Array;
  /** Byte ranges of header values, per lowercase header name. */
  headerValueRanges: Map<string, { start: number; end: number }[]>;
}

export interface ParsedHttpResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseHeaders(lines: string[]): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return headers;
}

/** Locate header value byte ranges in the raw head (case-insensitive). */
function locateHeaderValues(
  raw: Uint8Array,
  headLength: number
): Map<string, { start: number; end: number }[]> {
  const head = new TextDecoder("latin1").decode(raw.subarray(0, headLength));
  const lines = head.split("\r\n");
  const out = new Map<string, { start: number; end: number }[]>();
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 2; // + CRLF
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    let valueStart = idx + 1;
    while (valueStart < line.length && (line[valueStart] === " " || line[valueStart] === "\t")) {
      valueStart++;
    }
    const list = out.get(name) ?? [];
    list.push({ start: lineStart + valueStart, end: lineStart + line.length });
    out.set(name, list);
  }
  return out;
}

export function parseHttpRequest(raw: Uint8Array): ParsedHttpRequest {
  const headEnd = indexOf(raw, CRLFCRLF);
  if (headEnd < 0) throw new Error("disclosed request has no header terminator");
  const head = new TextDecoder("latin1").decode(raw.subarray(0, headEnd));
  const lines = head.split("\r\n");
  const [method, path] = lines[0].split(" ");
  return {
    method,
    path,
    headers: parseHeaders(lines.slice(1)),
    body: raw.subarray(headEnd + 4),
    raw,
    headerValueRanges: locateHeaderValues(raw, headEnd),
  };
}

function dechunk(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const text = new TextDecoder("latin1");
  for (;;) {
    const eol = indexOf(raw, new Uint8Array([13, 10]), i);
    if (eol < 0) throw new Error("truncated chunked body");
    const size = parseInt(text.decode(raw.subarray(i, eol)).split(";")[0], 16);
    i = eol + 2;
    if (Number.isNaN(size)) throw new Error("invalid chunk size");
    if (size === 0) break;
    for (let j = i; j < i + size; j++) out.push(raw[j]);
    i += size + 2; // data + trailing CRLF
  }
  return new Uint8Array(out);
}

export function parseHttpResponse(raw: Uint8Array): ParsedHttpResponse {
  const headEnd = indexOf(raw, CRLFCRLF);
  if (headEnd < 0) throw new Error("disclosed response has no header terminator");
  const head = new TextDecoder("latin1").decode(raw.subarray(0, headEnd));
  const lines = head.split("\r\n");
  const status = parseInt(lines[0].split(" ")[1] ?? "0", 10);
  const headers = parseHeaders(lines.slice(1));
  let body = raw.subarray(headEnd + 4);
  if ((headers.get("transfer-encoding") ?? "").includes("chunked")) {
    body = dechunk(body);
  }
  return { status, headers, body };
}

/** Extract the ordered `data:` payloads of an SSE byte stream. */
export function sseEventData(body: Uint8Array): string[] {
  const text = new TextDecoder().decode(body);
  const events: string[] = [];
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
  }
  return events;
}

export function sseSequencesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const ea = sseEventData(a);
  const eb = sseEventData(b);
  if (ea.length !== eb.length) return false;
  return ea.every((event, i) => event === eb[i]);
}

/** Deep equality for JSON values (order-insensitive on object keys). */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonDeepEqual(item, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) =>
      jsonDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

const REDACTED_HEADER_NAMES = ["authorization", "x-api-key", "api-key", "proxy-authorization"];

/**
 * Redaction check: for every credential header present in the disclosed
 * request, the header NAME must be visible but the VALUE bytes must all be
 * zero (redacted). A presentation that opens the credential is rejected.
 */
export function checkCredentialRedaction(request: ParsedHttpRequest): void {
  for (const name of REDACTED_HEADER_NAMES) {
    const ranges = request.headerValueRanges.get(name);
    if (!ranges) continue;
    for (const { start, end } of ranges) {
      if (end <= start) continue; // empty value: nothing to leak
      for (let i = start; i < end; i++) {
        if (request.raw[i] !== 0) {
          throw new Error(
            `credential leak: proof opened the ${name} header value — rejecting presentation`
          );
        }
      }
    }
  }
}
