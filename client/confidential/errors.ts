/**
 * Typed errors for the confidential-upstream client.
 *
 * Every rejection in this module is fail-closed: the caller (routstrd) decides
 * policy (`fail_closed` vs `fallback`) from the typed error, never by parsing a
 * message. All errors extend `ConfidentialError` and carry a stable `code`.
 */

/** Every `code` a confidential error carries (stable; callers match on it). */
export const CONFIDENTIAL_ERROR_CODES = [
  "offer_unavailable",
  "offer_malformed",
  "offer_bad_signature",
  "offer_unpinned",
  "offer_pin_mismatch",
  "offer_unsupported_version",
  "node_protocol_outdated",
  "upgrade_required",
  "twopc_version_mismatch",
  "request_refused",
  "trusted_host_rejected",
  "session_protocol",
  "session_rejected",
  "prover_failed",
  "prover_missing",
  "receipt_verification",
  "response_verification",
  "timeout",
  "not_configured",
  "unsupported_endpoint",
  "offer_no_images",
  "pinned_parameter",
  "reservation_above_ceiling",
] as const;

export type ConfidentialErrorCode = (typeof CONFIDENTIAL_ERROR_CODES)[number];

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

/**
 * The node's offer names a protocol version below this client's (PROTOCOL-V3
 * §11): the node is not used for confidential requests until it is updated.
 */
export class NodeProtocolOutdatedError extends ConfidentialError {
  /** The version the node offers. */
  readonly nodeVersion: number;
  constructor(message: string, nodeVersion: number) {
    super("node_protocol_outdated", message);
    this.name = "NodeProtocolOutdatedError";
    this.nodeVersion = nodeVersion;
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
  /** The `code` of the node's `error` frame (`h2_withdrawn`, `upstream_unreachable`, …), if any. */
  nodeCode?: string;
  /** The `fault` of the node's `error` frame (`upstream` or `node`), if any. */
  fault?: string;
  constructor(message: string, detail?: string, status?: number, nodeDetail?: unknown) {
    super("session_rejected", message, detail);
    this.name = "SessionRejectedError";
    this.status = status;
    this.nodeDetail = nodeDetail;
  }
}

/**
 * The node refused one `request` (`request_refused`, PROTOCOL-V3 §12.4):
 * nothing is held for it and the connection stays as it was. `reason` is the
 * node's (`offer_expired`, `offer_changed`, `session_fee_not_accepted`, or its
 * usual error text); `nodeDetail` its usual error body.
 */
export class RequestRefusedError extends SessionRejectedError {
  readonly reason: string;
  constructor(status: number, reason: string, nodeDetail?: unknown) {
    super(`node refused the request: ${reason.slice(0, 300)} (status ${status})`, undefined, status, nodeDetail);
    this.name = "RequestRefusedError";
    (this as { code: ConfidentialErrorCode }).code = "request_refused";
    this.reason = reason;
  }
}

/**
 * The node speaks a newer protocol than this client (`error` 426
 * `upgrade_required`, §11): update the client.
 */
export class UpgradeRequiredError extends SessionRejectedError {
  /** The lowest version the node accepts. */
  readonly minVersion?: number;
  constructor(message: string, minVersion?: number, nodeDetail?: unknown) {
    super(message, undefined, 426, nodeDetail);
    this.name = "UpgradeRequiredError";
    (this as { code: ConfidentialErrorCode }).code = "upgrade_required";
    this.minVersion = minVersion;
  }
}

/**
 * The two parties run different versions of the two-party key schedule
 * (`cu-2pc` exit status 3, or the node's `error` with this code; §4, §12.2):
 * the helper binary and the node's sidecar must be of the same release.
 */
export class TwoPcVersionMismatchError extends ConfidentialError {
  constructor(message: string) {
    super("twopc_version_mismatch", message);
    this.name = "TwoPcVersionMismatchError";
  }
}

/** The spawned `cu-prover` failed to run or exited non-zero. */
/**
 * A connection was not opened because of its deposit: the node's
 * deposit exceeds the client's maximum (nothing was sent), or the balance
 * does not cover it (the node refused the setup with 402 before any 2PC).
 */
export class ConnectionDepositError extends SessionRejectedError {
  /** The deposit the node asks for (msat). */
  readonly depositMsat: number;
  constructor(message: string, depositMsat: number, status?: number, nodeDetail?: unknown) {
    super(message, undefined, status, nodeDetail);
    this.name = "ConnectionDepositError";
    this.depositMsat = depositMsat;
  }
}

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
/**
 * The provider did not process the request (RFC 9113 §8.7): it refused the
 * stream (`RST_STREAM(REFUSED_STREAM)`) or went away with a last-stream-id
 * below it (`GOAWAY`). Nothing of the response came; the request may run
 * again on another connection, even after its body was released (the node may
 * still charge a released request's reservation: PROTOCOL-V3.md §12.10).
 */
export class StreamNotProcessedError extends SessionRejectedError {
  constructor(message: string) {
    super(message);
    this.name = "StreamNotProcessedError";
  }
}

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

/**
 * The node announced a reservation for the request (`request_ok`
 * `reserved_msats`) above the caller's ceiling (`maxReservationMsat`). The
 * client stopped before any record of the request was sent (framing "1.1":
 * before the ClientHello): nothing of it reached the provider, and the
 * connection is closed. Another node may serve the request.
 */
export class ReservationAboveCeilingError extends ConfidentialError {
  /** What the node announced (msat). */
  readonly reservedMsat: number;
  /** The caller's ceiling (msat). */
  readonly ceilingMsat: number;
  constructor(reservedMsat: number, ceilingMsat: number) {
    super(
      "reservation_above_ceiling",
      `the node reserves ${reservedMsat} msat for the request, above the client's ceiling of ${ceilingMsat} msat`,
    );
    this.name = "ReservationAboveCeilingError";
    this.reservedMsat = reservedMsat;
    this.ceilingMsat = ceilingMsat;
  }
}

/**
 * The property the confidential transport sets (true, not enumerable) on
 * every error it throws once the request's body was released towards the
 * provider: the request may have run there, so it must not be sent again,
 * to this node or another.
 */
export const MAY_HAVE_REACHED_PROVIDER = "mayHaveReachedProvider";

/**
 * True when `error` carries the transport's release marker. Read by shape:
 * the transport and the client may come from different bundles.
 */
export function mayHaveReachedProvider(error: unknown): boolean {
  return (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    (error as Record<string, unknown>)[MAY_HAVE_REACHED_PROVIDER] === true
  );
}

/** The `code` of a confidential error, read by shape (any bundle); undefined for anything else. */
export function confidentialErrorCode(error: unknown): ConfidentialErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (CONFIDENTIAL_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ConfidentialErrorCode)
    : undefined;
}

/**
 * Whether a confidential request that failed with `error` may run on another
 * node: only before its release (no `MAY_HAVE_REACHED_PROVIDER`), and only for
 * a failure of the node or its connection, decided by the error's type, never
 * by its message (which may carry the node's own text): the connection failed
 * or was closed without a status, the node broke the protocol, a step timed
 * out, its offer could not be fetched, the upstream's TLS could not be
 * verified, or its reservation was above the caller's ceiling. A refusal with
 * a status is a `Response`, not an error; local and caller faults
 * (configuration, binaries, versions, pinned parameters) stay where they are.
 */
export function confidentialFailoverError(error: unknown): boolean {
  if (mayHaveReachedProvider(error)) return false;
  const code = confidentialErrorCode(error);
  switch (code) {
    case "session_rejected": {
      const e = error as { status?: unknown; name?: unknown };
      return typeof e.status !== "number" && e.name !== "ConnectionDepositError";
    }
    case "session_protocol":
    case "timeout":
    case "offer_unavailable":
    case "response_verification":
    case "reservation_above_ceiling":
      return true;
    default:
      return false;
  }
}
