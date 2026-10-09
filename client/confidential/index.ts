/**
 * Confidential-upstream client module (routstr-sdk).
 *
 * Exported from the `node` and `bun` entrypoints ONLY: it uses `node:crypto`,
 * `node:child_process` and the vendored `@reclaimprotocol/tls` fork, none of
 * which belong in the browser-safe default export.
 *
 * See `README.md` in this directory for the protocol and integration notes.
 */

export {
  ConfidentialError,
  OfferUnavailableError,
  OfferMalformedError,
  OfferBadSignatureError,
  OfferUnpinnedError,
  OfferPinMismatchError,
  OfferUnsupportedVersionError,
  TrustedHostError,
  SessionProtocolError,
  SessionRejectedError,
  ProverError,
  ProverMissingError,
  ReceiptVerificationError,
  ResponseVerificationError,
  ConfidentialTimeoutError,
  type ConfidentialErrorCode,
} from "./errors";

export {
  TrustedHostMatcher,
  InvalidHostPatternError,
  normalizeHostname,
  parseTrustedHostPattern,
  matchHostname,
  isTrustedHost,
} from "./hosts";

export {
  canonicalJson,
  verifySchnorrSignature,
  statementDigestHex,
  npubToHex,
} from "./canonical";

export {
  CONFIDENTIAL_VERSION_MIN,
  CONFIDENTIAL_VERSION_MAX,
  fetchConfidentialOffer,
  verifyConfidentialOffer,
  validateOfferShape,
  offerSignedPayload,
  verifyOfferSignature,
  supportedVersion,
  type ConfidentialOffer,
  type ConfidentialPriceEntry,
  type VerifyOfferOptions,
  type VerifiedOffer,
} from "./offer";

export {
  canonicalSuffix,
  buildConfidentialBody,
  checkPiNParams,
  parseHttpResponse,
  extractUsageDisclosure,
  usageEventFromDisclosure,
  disclosureTailLens,
  effectiveModelFromText,
  IncrementalHttpResponse,
  ChunkedDecoder,
  HOP_BY_HOP_HEADERS,
  type ParsedHttpResponse,
  type UpstreamUsageEvent,
  type PiNParams,
} from "./suffix";

export {
  epoch1Material,
  concat,
  hex,
  fromHex,
  sha256,
  type Epoch1Material,
} from "./advice";

export {
  CuProverBackend,
  resolveProverPath,
  CU_PROVER_ENV_VARS,
  type ProverBackendOptions,
  type ZkJob,
} from "./prover";

export {
  verifyReceipt,
  type ReceiptVerificationInput,
  type ReceiptVerificationResult,
} from "./receipt";

export {
  ConfidentialSession,
  type ConfidentialSessionOptions,
  type ConfidentialSessionResult,
  type ConfidentialSessionTimings,
  type ConfidentialReceipt,
} from "./session";


export {
  fetchConfidential,
  buildPinnedBody,
  aggregateChatCompletionSse,
  type ConfidentialFetchParams,
  type ConfidentialRequestOptions,
} from "./transport";
