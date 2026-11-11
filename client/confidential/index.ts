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
  ConnectionDepositError,
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
  parseTrustedHostEntry,
  DEFAULT_API_BASES,
  matchHostname,
  isTrustedHost,
  encryptedNodeTransport,
} from "./hosts";

export {
  canonicalJson,
  verifySchnorrSignature,
  statementDigestHex,
  npubToHex,
} from "./canonical";

export {
  checkPiNKParams,
  checkPiC2SParams,
  checkPiC3SParams,
  checkHeadTemplate,
  headTemplateProblem,
  headRouteProblem,
  type HeadTemplateKind,
} from "./params";

export {
  CONFIDENTIAL_VERSION_MIN,
  CONFIDENTIAL_VERSION_MAX,
  fetchConfidentialOffer,
  verifyConfidentialOffer,
  validateOfferShape,
  validateImagesOffer,
  imagesOfferProblem,
  IMAGE_VARIANT_PIN_KEYS,
  IMAGE_MAX_COUNT,
  offerSignedPayload,
  offerSessionFeeMsat,
  offerAbandonFeeMsat,
  verifyOfferSignature,
  supportedVersion,
  offerSupportsImages,
  offerSupportsHttp2,
  imageCountKey,
  imageCountKeyForRoute,
  renderImageSuffix,
  type ConfidentialImagesOffer,
  type ConfidentialImageVariant,
  type ConfidentialOffer,
  type ConfidentialPriceEntry,
  type VerifyOfferOptions,
  type VerifiedOffer,
} from "./offer";

export {
  canonicalSuffix,
  chatSuffixKeys,
  validateChatSuffix,
  CHAT_CAP_KEYS,
  CHAT_PROTOCOL_KEYS,
  type ChatSuffixSpec,
  buildConfidentialBody,
  parseHttpResponse,
  extractUsageDisclosure,
  usageEventFromDisclosure,
  disclosureTailLens,
  effectiveModelFromText,
  IncrementalHttpResponse,
  ChunkedDecoder,
  HOP_BY_HOP_HEADERS,
  exposedProviderHeader,
  type ParsedHttpResponse,
  type UpstreamUsageEvent,
} from "./suffix";

export { concat, hex, fromHex, sha256 } from "./advice";

export {
  CuProverBackend,
  resolveProverPath,
  CU_PROVER_ENV_VARS,
  type ProverBackendOptions,
  type ZkJob,
} from "./prover";

export {
  TwoPcSession,
  TwoPcFrameDecoder,
  encodeTwoPcFrame,
  requireHelperBinaries,
  resolveTwoPcPath,
  CU_2PC_ENV_VARS,
  type TwoPcOptions,
  type TwoPcFrame,
  type TwoPcHandshakeSecrets,
  type TwoPcApplicationSecrets,
  type TwoPcTiming,
} from "./twopc";

export {
  ProofChannel,
  type ProofChannelOptions,
  type ProofChannelResult,
} from "./zkchan";

export {
  verifyReceipt,
  maxChargeMsats,
  feeOnlyChargeOk,
  checkUpstreamErrorReceipt,
  errorStatusCharge,
  verifyFlatReceipt,
  type ReceiptVerificationInput,
  type ReceiptVerificationResult,
} from "./receipt";

export {
  ConfidentialSession,
  checkImageResponse,
  type ConfidentialSessionOptions,
  type ConfidentialSessionResult,
  type ConfidentialSessionTimings,
  type ConfidentialReceipt,
} from "./session";


export {
  PrewarmPool,
  PREWARM_DEFAULTS,
  chooseBucket,
  padPinnedBody,
  poolKey,
  type PrewarmOptions,
  type PrewarmDeps,
  type PoolKeyInfo,
  type ArmHandle,
  type ArmedSessionLike,
  type Lease,
  type RequestTicket,
} from "./prewarm";

export {
  fetchConfidential,
  qualifyConfidentialNode,
  closeConfidentialPrewarm,
  confidentialPrewarmSnapshot,
  closeConfidentialHttp2,
  confidentialHttp2Snapshot,
  buildPinnedBody,
  planImageRequest,
  isConfidentialImageEndpoint,
  aggregateChatCompletionSse,
  type ConfidentialFetchParams,
  type ConfidentialRequestOptions,
  type ConfidentialSettlement,
} from "./transport";

// Protocol v3, option A: `http: 2` sessions (one two-party handshake per
// HTTP/2 connection, sequential requests on it).
export {
  ConfidentialH2Connection,
  DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT,
  h2ConnectionTerms,
  type ConfidentialH2ConnectionOptions,
  type H2DepositOutcome,
  type H2RequestOptions,
  type H2RequestResult,
  type H2RequestHandle,
  type H2ProofTiming,
  type H2Bytes,
} from "./h2conn";

export {
  Http2Pool,
  HTTP2_DEFAULTS,
  http2IdleMs,
  http2PoolKey,
  type Http2Options,
  type Http2RequestStats,
  type Http2KeyInfo,
  type Http2Lease,
} from "./h2pool";
export { offerSupportsHttp2Images } from "./offer";

export {
  FrameReader,
  checkH2Offer,
  checkPiNKParamsH2,
  checkPiWinParams,
  decodeBlock,
  h2Head,
  requestBlock,
  splitBody,
  type WinSource,
} from "./h2";
