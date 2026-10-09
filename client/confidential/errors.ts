/**
 * Typed errors for the confidential-upstream client.
 *
 * Every rejection in this module is fail-closed: the caller (routstrd) decides
 * policy (`fail_closed` vs `fallback`) from the typed error, never by parsing a
 * message. All errors extend `ConfidentialError` and carry a stable `code`.
 */

export type ConfidentialErrorCode =
  | "offer_unavailable"
  | "offer_malformed"
  | "offer_bad_signature"
  | "offer_unpinned"
  | "offer_pin_mismatch"
  | "offer_unsupported_version"
  | "trusted_host_rejected"
  | "session_protocol"
  | "session_rejected"
  | "prover_failed"
  | "prover_missing"
  | "receipt_verification"
  | "response_verification"
  | "timeout"
  | "not_configured"
  | "unsupported_endpoint";

export class ConfidentialError extends Error {
  readonly code: ConfidentialErrorCode;
  /** Optional underlying detail (never a secret). */
  readonly detail?: string;

  constructor(code: ConfidentialErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "ConfidentialError";
    this.code = code;
    this.detail = detail;
  }
}

/** The node's `/v1/confidential/offer` could not be fetched. */
export class OfferUnavailableError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("offer_unavailable", message, detail);
    this.name = "OfferUnavailableError";
  }
}

/** The offer parsed but is structurally invalid. */
export class OfferMalformedError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("offer_malformed", message, detail);
    this.name = "OfferMalformedError";
  }
}

/** The BIP-340 Schnorr signature over the canonical payload did not verify. */
export class OfferBadSignatureError extends ConfidentialError {
  constructor(message = "offer signature invalid", detail?: string) {
    super("offer_bad_signature", message, detail);
    this.name = "OfferBadSignatureError";
  }
}

/** The offer is unsigned / unpinned and the caller did not opt into dev mode. */
export class OfferUnpinnedError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("offer_unpinned", message, detail);
    this.name = "OfferUnpinnedError";
  }
}

/** The offer's notary key does not equal the configured pin. */
export class OfferPinMismatchError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("offer_pin_mismatch", message, detail);
    this.name = "OfferPinMismatchError";
  }
}

/** The offer's protocol version is outside the client's supported range. */
export class OfferUnsupportedVersionError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("offer_unsupported_version", message, detail);
    this.name = "OfferUnsupportedVersionError";
  }
}

/** The offer's `upstream_host` matched no trusted hostname. */
export class TrustedHostError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("trusted_host_rejected", message, detail);
    this.name = "TrustedHostError";
  }
}


/** A protocol frame was missing/out of order/unexpected (fail-closed). */
export class SessionProtocolError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("session_protocol", message, detail);
    this.name = "SessionProtocolError";
  }
}

/** The node/sidecar rejected the session with an explicit `{type:"error"}`. */
export class SessionRejectedError extends ConfidentialError {
  /** HTTP status the node attached (e.g. 402 insufficient balance), if any. */
  readonly status?: number;
  /** The node's FastAPI-style error detail, if any. */
  readonly nodeDetail?: unknown;
  constructor(message: string, detail?: string, status?: number, nodeDetail?: unknown) {
    super("session_rejected", message, detail);
    this.name = "SessionRejectedError";
    this.status = status;
    this.nodeDetail = nodeDetail;
  }
}

/** The spawned `cu-prover` failed to run or exited non-zero. */
export class ProverError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("prover_failed", message, detail);
    this.name = "ProverError";
  }
}

/** No `cu-prover` binary could be resolved. */
export class ProverMissingError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("prover_missing", message, detail);
    this.name = "ProverMissingError";
  }
}

/** The receipt/attestation signature or its arithmetic did not check out. */
export class ReceiptVerificationError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("receipt_verification", message, detail);
    this.name = "ReceiptVerificationError";
  }
}

/** The response could not be verified against our own plaintext/statement. */
export class ResponseVerificationError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("response_verification", message, detail);
    this.name = "ResponseVerificationError";
  }
}

export class ConfidentialTimeoutError extends ConfidentialError {
  constructor(message: string, detail?: string) {
    super("timeout", message, detail);
    this.name = "ConfidentialTimeoutError";
  }
}
