/**
 * Receipt / attestation verification helpers.
 *
 * Kept separate from the session driver so the money checks are unit-testable
 * without a live TLS session: a receipt is only accepted when its Schnorr
 * signature verifies against the node key, its usage equals our own disclosed
 * usage event, and its cost does not exceed that usage at the signed rates.
 */

import { hex, sha256 } from "./advice";
import { verifySchnorrSignature } from "./canonical";
import { ReceiptVerificationError } from "./errors";
import type { ConfidentialReceipt } from "./session";
import type { UpstreamUsageEvent } from "./suffix";

export interface ReceiptVerificationInput {
  receipt: ConfidentialReceipt;
  /** Exact signed bytes when the node shipped them; else canonical/stringify. */
  receiptJson?: string;
  /** BIP-340 Schnorr signature hex. */
  sig?: string;
  /** Node notary pubkey hex. */
  pubkey?: string;
  /** Our own usage event parsed from the π_C3 disclosure. */
  ownUsage: UpstreamUsageEvent;
  /** The model's rates from the *signed* offer. */
  priceEntry?: { in: number; out: number; cached_in?: number };
  /** The signed offer's session fee (msats); 0 or absent when none. */
  sessionFeeMsat?: number;
  /** The signed offer's abandon fee (msats); a receipt may not name more. */
  abandonFeeMsat?: number;
}

export interface ReceiptVerificationResult {
  receiptSigOk: boolean;
  usageMatch: boolean;
  /**
   * cost_msats ≤ usage priced at the signed offer's rates + the signed session
   * fee (false if no rates were given: an unpriced model has no bound), and
   * any fee the receipt names is at most the signed one.
   */
  costWithinOffer: boolean;
}

/**
 * The most a node may charge for a usage at the signed offer's terms:
 * ceil((in·prompt + out·completion)/1000) + the session fee. The rates already
 * include any surcharge (the node signs the surcharged price list).
 *
 * Cached prompt tokens may be billed at `cached_in` (never above `in`), so
 * the honest charge is at most this bound. The node computes its charge as
 * ceil((in·(prompt−cached) + min(cached_in, in)·cached + out·completion)/1000)
 * in floating point, which can round one msat above the uncached formula when
 * the two are mathematically equal; the bound is the larger of both, so an
 * honest receipt is never refused for that rounding.
 */
export function maxChargeMsats(
  priceEntry: { in: number; out: number; cached_in?: number },
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: unknown;
    [k: string]: unknown;
  },
  sessionFeeMsat = 0,
): number {
  const inRate = Number(priceEntry.in);
  const outRate = Number(priceEntry.out);
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const uncached = Math.ceil((inRate * prompt + outRate * completion) / 1000);
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const cached = Math.min(tokenCount(details?.cached_tokens), prompt);
  const cachedRate = Math.min(Number(priceEntry.cached_in ?? inRate), inRate);
  const withCached =
    cached > 0 && Number.isFinite(cachedRate)
      ? Math.ceil((inRate * (prompt - cached) + cachedRate * cached + outRate * completion) / 1000)
      : uncached;
  return Math.max(uncached, withCached) + Math.max(0, sessionFeeMsat);
}

/** A receipt amount: a non-negative whole number of msats (never absent). */
function isMsatAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** A token count as the node reads one (non-negative integer, else 0). */
function tokenCount(v: unknown): number {
  if (typeof v === "boolean") return 0;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * A charge without usage: at most the given signed fee (the session fee for a
 * provider refusal, 4xx/503; the abandon fee for a session that ended without
 * a request reaching the provider).
 */
export function feeOnlyChargeOk(costMsats: number | undefined, sessionFeeMsat = 0): boolean {
  return (costMsats ?? 0) <= Math.max(0, sessionFeeMsat);
}

/**
 * A receipt for an upstream HTTP error (no usage event to price). It must name
 * the status we saw ourselves (returned as the usage match). A refusal the
 * provider answers before doing any work (4xx, 503) costs at most the signed
 * session fee; any other error at most the session's reservation, which is
 * what the node charges when it cannot attribute the provider's work. A charge
 * outside these bounds throws.
 */
export function checkUpstreamErrorReceipt(
  receipt: ConfidentialReceipt,
  status: number,
  sessionFeeMsat = 0,
): boolean {
  const ru = receipt.usage as unknown as { error_status?: unknown } | undefined;
  const usageMatch = ru?.error_status === status;
  const fee = Math.max(0, sessionFeeMsat);
  if (typeof receipt.session_fee_msat === "number" && receipt.session_fee_msat > fee) {
    throw new ReceiptVerificationError(
      `receipt names a session fee of ${receipt.session_fee_msat} msats, the signed offer ${fee} msats`,
    );
  }
  const cost = receipt.cost_msats;
  if (!isMsatAmount(cost)) {
    throw new ReceiptVerificationError(`receipt cost ${String(receipt.cost_msats)} is not a valid amount`);
  }
  const unbilled = status === 503 || (status >= 400 && status < 500);
  if (unbilled) {
    if (!feeOnlyChargeOk(cost, fee)) {
      throw new ReceiptVerificationError(
        `node charged ${cost} msats for an unbilled upstream error (session fee ${fee} msats)`,
      );
    }
  } else if (cost > fee) {
    const reserved = receipt.reserved_msats;
    if (typeof reserved !== "number" || !Number.isFinite(reserved)) {
      throw new ReceiptVerificationError(
        `node charged ${cost} msats for upstream error ${status} without naming its reservation`,
      );
    }
    if (cost > reserved) {
      throw new ReceiptVerificationError(
        `node charged ${cost} msats for upstream error ${status}, more than its reservation (${reserved} msats)`,
      );
    }
  }
  return usageMatch;
}

/**
 * A flat-priced (image) receipt: the charge is fixed at setup by the signed
 * offer, so everything is checked for equality: the model, variant and count
 * we pinned, the signed price per image, and the cost
 * `msat_per_image × count + session fee`. Throws on any mismatch.
 */
export function verifyFlatReceipt(
  receipt: ConfidentialReceipt,
  own: {
    model: string;
    variant: string;
    count: number;
    /** From the signed offer we verified. */
    msatPerImage: number;
    sessionFeeMsat?: number;
    abandonFeeMsat?: number;
  },
): void {
  const fee = Math.max(0, own.sessionFeeMsat ?? 0);
  const fail = (what: string): never => {
    throw new ReceiptVerificationError(`flat receipt: ${what}`);
  };
  if (receipt.kind !== "images") fail(`kind ${String(receipt.kind)} is not images`);
  if ((receipt.usage as unknown as { flat?: unknown } | undefined)?.flat !== true) fail("usage is not flat");
  if (receipt.model !== own.model) fail(`model ${String(receipt.model)} is not ${own.model}`);
  if (receipt.variant !== own.variant) fail(`variant ${String(receipt.variant)} is not ${own.variant}`);
  if (receipt.count !== own.count) fail(`count ${String(receipt.count)} is not ${own.count}`);
  if (receipt.msat_per_image !== own.msatPerImage) {
    fail(`price ${String(receipt.msat_per_image)} msats per image is not the signed ${own.msatPerImage}`);
  }
  if (typeof receipt.session_fee_msat === "number" && receipt.session_fee_msat > fee) {
    fail(`session fee ${receipt.session_fee_msat} msats exceeds the signed ${fee}`);
  }
  if (
    typeof receipt.abandon_fee_msat === "number" &&
    receipt.abandon_fee_msat > Math.max(fee, own.abandonFeeMsat ?? 0)
  ) {
    fail(`abandon fee ${receipt.abandon_fee_msat} msats exceeds the signed one`);
  }
  // The node charges the price × count plus the fee, rounded up to whole msats.
  const want = Math.ceil(own.msatPerImage * own.count + fee);
  if (!isMsatAmount(receipt.cost_msats) || receipt.cost_msats !== want) {
    fail(`cost ${String(receipt.cost_msats)} msats is not ${want} (price × count + session fee)`);
  }
}

export function verifyReceipt(input: ReceiptVerificationInput): ReceiptVerificationResult {
  const { receipt, ownUsage } = input;
  const receiptJson = input.receiptJson ?? JSON.stringify(receipt);
  const receiptSigOk = verifySchnorrSignature(receiptJson, input.sig, input.pubkey);

  const rUsage = receipt.usage as unknown as {
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: unknown };
  };
  const cachedTokens = (u: Record<string, unknown> | undefined) =>
    tokenCount((u?.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens);
  const usageMatch =
    rUsage?.usage?.prompt_tokens === ownUsage.usage.prompt_tokens &&
    rUsage?.usage?.completion_tokens === ownUsage.usage.completion_tokens &&
    cachedTokens(rUsage?.usage as Record<string, unknown> | undefined) === cachedTokens(ownUsage.usage) &&
    receipt.model === ownUsage.model;

  // The node may charge less than its signed terms (cached input), never more.
  // Without a signed rate for the model there is no bound to check against,
  // so the cost cannot be accepted.
  const fee = Math.max(0, input.sessionFeeMsat ?? 0);
  let costWithinOffer = false;
  if (input.priceEntry && isMsatAmount(receipt.cost_msats)) {
    const maxMsats = maxChargeMsats(input.priceEntry, ownUsage.usage, fee);
    costWithinOffer = receipt.cost_msats <= maxMsats;
  }
  if (typeof receipt.session_fee_msat === "number" && receipt.session_fee_msat > fee) {
    costWithinOffer = false;
  }
  if (
    typeof receipt.abandon_fee_msat === "number" &&
    receipt.abandon_fee_msat > Math.max(fee, input.abandonFeeMsat ?? 0)
  ) {
    costWithinOffer = false;
  }
  return { receiptSigOk, usageMatch, costWithinOffer };
}

/**
 * A node-signed receipt as the client accepts it: the signature must verify
 * over the exact signed bytes, those bytes (not any unsigned envelope) are the
 * receipt, and it must name this session and this session's attestation.
 */
export function parseSignedReceipt(input: {
  receiptJson: string;
  sig?: string;
  pubkey?: string;
  sid: string;
  /** The attestation bytes the node signed (`a_json`, or the attestation as
   * the client serialized and verified it). The receipt must hash them. */
  attestationJson: string;
}): ConfidentialReceipt {
  if (!verifySchnorrSignature(input.receiptJson, input.sig, input.pubkey)) {
    throw new ReceiptVerificationError("receipt signature invalid");
  }
  let receipt: ConfidentialReceipt;
  try {
    receipt = JSON.parse(input.receiptJson) as ConfidentialReceipt;
  } catch {
    throw new ReceiptVerificationError("receipt_json is not valid JSON");
  }
  if (receipt.sid !== input.sid) {
    throw new ReceiptVerificationError(`receipt is for session ${receipt.sid}, not ${input.sid}`);
  }
  if (
    typeof receipt.attestation_hash !== "string" ||
    receipt.attestation_hash !== hex(sha256(new TextEncoder().encode(input.attestationJson)))
  ) {
    throw new ReceiptVerificationError("receipt is not bound to this session's attestation");
  }
  return receipt;
}

/**
 * The attestation's own fields must name this session: its sid and the two
 * handshake transcript hashes we computed ourselves. A validly signed
 * attestation of another session is not evidence about this one.
 *
 * The head-record commitment (`c_commit`) must be the one π_NK proved to us.
 * The other fields we can recompute from our own records are checked as well,
 * each when we have it: the hash of the certificate list the provider sent,
 * and the count and hash of every upstream byte the node relayed to us. A node cannot then sign one
 * account of the session for us and another for anyone it shows the
 * attestation to.
 */
export function checkAttestationBinding(
  attestationJson: string,
  own: {
    sid: string;
    thSH?: Uint8Array;
    thSF?: Uint8Array;
    /** Hex `c_commit` of the π_NK statement we verified (required). */
    cCommit?: string;
    /** SHA-256 of the provider's certificate DERs, concatenated in order. */
    certChainHash?: Uint8Array;
    /** Complete TLS records received from upstream (all content types). */
    serverRecords?: number;
    /** SHA-256 of every upstream byte received. */
    recvSha256?: Uint8Array;
  },
): void {
  let a: {
    sid?: unknown;
    th_sh?: unknown;
    th_sf?: unknown;
    c_commit?: unknown;
    cert_chain_hash?: unknown;
    server_records?: unknown;
    sha256_recv?: unknown;
  };
  try {
    a = JSON.parse(attestationJson) as typeof a;
  } catch {
    throw new ReceiptVerificationError("attestation is not valid JSON");
  }
  if (a === null || typeof a !== "object") {
    throw new ReceiptVerificationError("attestation is not an object");
  }
  if (a.sid !== own.sid) {
    throw new ReceiptVerificationError(`attestation is for session ${String(a.sid)}, not ${own.sid}`);
  }
  if (!own.thSH || !own.thSF) {
    throw new ReceiptVerificationError("no handshake transcript to check the attestation against");
  }
  if (a.th_sh !== hex(own.thSH) || a.th_sf !== hex(own.thSF)) {
    throw new ReceiptVerificationError("attestation names a different TLS handshake");
  }
  if (!own.cCommit) {
    throw new ReceiptVerificationError("no head-record commitment to check the attestation against");
  }
  if (a.c_commit !== own.cCommit) {
    throw new ReceiptVerificationError("attestation names a different head-record commitment");
  }
  if (own.certChainHash && a.cert_chain_hash !== hex(own.certChainHash)) {
    throw new ReceiptVerificationError("attestation names a different certificate chain");
  }
  if (own.serverRecords !== undefined && a.server_records !== own.serverRecords) {
    throw new ReceiptVerificationError(
      `attestation counts ${String(a.server_records)} upstream records, we received ${own.serverRecords}`,
    );
  }
  if (own.recvSha256 && a.sha256_recv !== hex(own.recvSha256)) {
    throw new ReceiptVerificationError("attestation hashes different upstream bytes than we received");
  }
}
