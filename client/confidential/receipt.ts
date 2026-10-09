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
}

export interface ReceiptVerificationResult {
  receiptSigOk: boolean;
  usageMatch: boolean;
  /** cost_msats ≤ usage priced at the signed offer's rates (true if no rates given). */
  costWithinOffer: boolean;
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

  // The node may charge less than its signed rates (cached input), never more.
  let costWithinOffer = true;
  if (input.priceEntry) {
    const maxMsats = Math.ceil(
      (Number(input.priceEntry.in) * (ownUsage.usage.prompt_tokens ?? 0) +
        Number(input.priceEntry.out) * (ownUsage.usage.completion_tokens ?? 0)) /
        1000,
    );
    costWithinOffer = (receipt.cost_msats ?? 0) <= maxMsats;
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
  /** The attestation bytes the node signed (`a_json`), when it sent them. */
  attestationJson?: string;
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
    input.attestationJson !== undefined &&
    receipt.attestation_hash !== hex(sha256(new TextEncoder().encode(input.attestationJson)))
  ) {
    throw new ReceiptVerificationError("receipt is not bound to this session's attestation");
  }
  return receipt;
}
