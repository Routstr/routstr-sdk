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
  priceEntry?: { in: number; out: number };
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
 */
export function maxChargeMsats(
  priceEntry: { in: number; out: number },
  usage: { prompt_tokens?: number; completion_tokens?: number },
  sessionFeeMsat = 0,
): number {
  return (
    Math.ceil(
      (Number(priceEntry.in) * (usage.prompt_tokens ?? 0) +
        Number(priceEntry.out) * (usage.completion_tokens ?? 0)) /
        1000,
    ) + Math.max(0, sessionFeeMsat)
  );
}

/**
 * A charge without usage: at most the given signed fee (the session fee for a
 * provider refusal, 4xx/503; the abandon fee for a session that ended without
 * a request reaching the provider).
 */
export function feeOnlyChargeOk(costMsats: number | undefined, sessionFeeMsat = 0): boolean {
  return (costMsats ?? 0) <= Math.max(0, sessionFeeMsat);
}

export function verifyReceipt(input: ReceiptVerificationInput): ReceiptVerificationResult {
  const { receipt, ownUsage } = input;
  const receiptJson = input.receiptJson ?? JSON.stringify(receipt);
  const receiptSigOk = verifySchnorrSignature(receiptJson, input.sig, input.pubkey);

  const rUsage = receipt.usage as unknown as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const usageMatch =
    rUsage?.usage?.prompt_tokens === ownUsage.usage.prompt_tokens &&
    rUsage?.usage?.completion_tokens === ownUsage.usage.completion_tokens &&
    receipt.model === ownUsage.model;

  // The node may charge less than its signed terms (cached input), never more.
  // Without a signed rate for the model there is no bound to check against,
  // so the cost cannot be accepted.
  const fee = Math.max(0, input.sessionFeeMsat ?? 0);
  let costWithinOffer = false;
  if (input.priceEntry) {
    const maxMsats = maxChargeMsats(input.priceEntry, ownUsage.usage, fee);
    costWithinOffer = (receipt.cost_msats ?? 0) <= maxMsats;
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
 */
export function checkAttestationBinding(
  attestationJson: string,
  own: { sid: string; thSH?: Uint8Array; thSF?: Uint8Array },
): void {
  let a: { sid?: unknown; th_sh?: unknown; th_sf?: unknown };
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
}
