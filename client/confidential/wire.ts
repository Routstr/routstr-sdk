/**
 * What a confidential connection shares with the code around it: the handle
 * of the TLS fork, the receipt's shape, limits, and small helpers for waits,
 * TLS records and an accepted image response.
 */

import { ConfidentialTimeoutError } from "./errors";
import type { ParsedHttpResponse, UpstreamUsageEvent } from "./suffix";
import { setCryptoImplementation } from "./tls-fork/lib/crypto/index.js";
import { webcryptoCrypto } from "./tls-fork/lib/crypto/webcrypto.js";

setCryptoImplementation(webcryptoCrypto);

export interface TlsHandle {
  startHandshake(): Promise<void>;
  handleReceivedBytes(data: Uint8Array): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** One record with exactly this inner plaintext (FORK PATCH v3). */
  writeInner(inner: Uint8Array): Promise<void>;
}

export interface ConfidentialReceipt {
  v?: number;
  sid: string;
  model: string;
  usage: UpstreamUsageEvent;
  /** Charged to the client's key from the verified usage. */
  cost_msats?: number;
  /** The node's reservation for this session (the model's maximum cost + fee). */
  reserved_msats?: number;
  /** The session fee of the frozen offer (msats), when the node charges one. */
  session_fee_msat?: number;
  /** The abandon fee of the frozen offer (msats), when the node charges one. */
  abandon_fee_msat?: number;
  /** The rate surcharge (percent) of the frozen offer, when set. */
  rate_surcharge_pct?: number;
  /** The key's balance after settlement (msats), when known. */
  balance_msats?: number | null;
  notary_pubkey?: string;
  attestation_hash?: string;
  time?: number;
  [k: string]: unknown;
}

/**
 * TLS bytes from the node queued for processing. Decryption keeps up with any
 * honest link, so a backlog this large means the node is flooding the session.
 */
export const MAX_PENDING_TLS_BYTES = 32 << 20;

/** A session id as the sidecar makes it (a SHA-256, hex). */
export const SID_RE = /^[0-9a-f]{64}$/;

/**
 * Rejects after `ms` without progress (`last()` = time of the last progress),
 * for waits that last as long as the provider streams.
 */
export function idleTimeout(ms: number, what: string, last: () => number, stop: Promise<unknown>): Promise<never> {
  return new Promise((_, rej) => {
    const timer = setInterval(() => {
      if (Date.now() - last() > ms) {
        clearInterval(timer);
        rej(new ConfidentialTimeoutError(`timeout waiting for ${what} (no response data for ${Math.round(ms / 1000)} s)`));
      }
    }, 1000);
    stop.finally(() => clearInterval(timer)).catch(() => {});
  });
}

/**
 * Rejects after `ms`. The timer is never cleared (the waits race it), so it
 * is unref'd: a wait that already ended must not keep the process alive for
 * the rest of its timeout. While a session runs, its sockets do.
 */
export function timeout(ms: number, what: string): Promise<never> {
  return new Promise((_, rej) => {
    const t = setTimeout(() => rej(new ConfidentialTimeoutError(`timeout waiting for ${what}`)), ms);
    (t as { unref?: () => void }).unref?.();
  });
}

export function cryptoRandom(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/**
 * What an image session does with the provider's status: accept a 2xx (the
 * flat price), disclose an error head (4xx/5xx), and refuse anything else
 * (a redirect, an unparsed status) without settling it as a success.
 */
export function imageOutcome(status: number): "accept" | "disclose" | "refuse" {
  if (status >= 200 && status < 300) return "accept";
  if (status >= 400) return "disclose";
  return "refuse";
}

/** The process opted into the insecure test hooks explicitly. */
export function insecureTestingEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.ROUTSTR_CONFIDENTIAL_INSECURE_TESTING === "1";
}

function indexOfCrlfCrlf(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

/** KeyUpdate messages (type 24) in a decrypted handshake record. */
export function countKeyUpdates(content: Uint8Array): number {
  let n = 0;
  let i = 0;
  while (i + 4 <= content.length) {
    if (content[i] === 24) n++;
    i += 4 + ((content[i + 1]! << 16) | (content[i + 2]! << 8) | content[i + 3]!);
  }
  return n;
}

/**
 * Server application records kept for π_C3S: it covers at most 64 records at
 * the end of the response, plus the ones that may trail them.
 */
export const KEPT_SERVER_RECORDS = 128;

/**
 * An accepted image response in the OpenAI shape, from the provider's own
 * shape, with every shortfall named: an incomplete body, fewer images than
 * pinned, or a provider echo (`request`) naming another model or count.
 * The charge was fixed at setup, so none of these throws.
 */
export function checkImageResponse(
  http: ParsedHttpResponse,
  shape: "venice" | "openai",
  want: { model: string; count: number; countKey: string },
): { image: { created: number; data: { b64_json: string }[] }; warnings: string[] } {
  const warnings: string[] = [];
  if (!http.complete) warnings.push("the image response body is incomplete");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(http.bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    else warnings.push("the image response is not a JSON object");
  } catch {
    warnings.push("the image response is not JSON");
  }
  const created = typeof body.created === "number" ? body.created : Math.floor(Date.now() / 1000);
  let data: { b64_json: string }[] = [];
  if (shape === "venice") {
    const images = Array.isArray(body.images) ? body.images : [];
    data = images.filter((i): i is string => typeof i === "string").map((b64_json) => ({ b64_json }));
  } else {
    const raw = Array.isArray(body.data) ? body.data : [];
    data = raw
      .filter((d): d is { b64_json: string } => !!d && typeof (d as { b64_json?: unknown }).b64_json === "string")
      .map((d) => ({ b64_json: d.b64_json }));
  }
  if (data.length !== want.count) warnings.push(`the provider returned ${data.length} of ${want.count} images`);
  const echo = body.request;
  if (echo && typeof echo === "object" && !Array.isArray(echo)) {
    const e = echo as Record<string, unknown>;
    if (e.model !== undefined && e.model !== want.model) {
      warnings.push(`the provider echoes model ${String(e.model)}, not ${want.model}`);
    }
    const n = e[want.countKey];
    if (n !== undefined && n !== want.count) warnings.push(`the provider echoes ${want.countKey}=${String(n)}, not ${want.count}`);
  }
  return { image: { created, data }, warnings };
}
