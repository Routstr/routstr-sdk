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
  NodeProtocolOutdatedError,
  UpgradeRequiredError,
  TwoPcVersionMismatchError,
  RequestRefusedError,
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
  checkPiC3SParams,
  checkHeadTemplate,
  headTemplateProblem,
  headRouteProblem,
  type HeadTemplateKind,
} from "./params";

export {
  CONFIDENTIAL_VERSION,
  CONFIDENTIAL_VERSION_MIN,
  CONFIDENTIAL_VERSION_MAX,
  CONFIDENTIAL_TWOPC,
  CONFIDENTIAL_FRAMINGS,
  offerFramings,
  offerFramingsFor,
  offerConnectionDepositMsat,
  offerIdleTimeoutS,
  type ConfidentialFraming,
  type ConfidentialH2Offer,
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
  pinnedModelId,
  upstreamModelsProblem,
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

export { checkImageResponse, imageOutcome, type ConfidentialReceipt } from "./wire";

export {
  fetchConfidential,
  qualifyConfidentialNode,
  closeConfidentialConnections,
  confidentialConnectionsSnapshot,
  chooseFraming,
  http2OpenFailure,
  maxConnectionDepositMsat,
  buildPinnedBody,
  planImageRequest,
  isConfidentialImageEndpoint,
  aggregateChatCompletionSse,
  type ConfidentialFetchParams,
  type ConfidentialRequestOptions,
  type ConfidentialSettlement,
} from "./transport";

// The connection (both framings) and its pool.
export {
  ConfidentialConnection,
  DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT,
  connectionTerms,
  type ConfidentialConnectionOptions,
  type ConnectionPhase,
  type DepositOutcome,
  type ConnectionRequestOptions,
  type ConnectionRequestResult,
  type ConnectionRequestHandle,
  type ProofTiming,
  type ConnectionBytes,
} from "./connection";

export {
  ConnectionPool,
  HTTP2_DEFAULTS,
  PREWARM_DEFAULTS,
  FRAMING_BAD_MS,
  poolIdleMs,
  poolKey,
  type Http2Options,
  type PrewarmOptions,
  type ConfidentialRequestStats,
  type PoolKeyInfo,
  type PoolLease,
} from "./pool";
export { offerSupportsHttp2Images } from "./offer";

export {
  FrameReader,
  checkH2Offer,
  checkPiNKParamsH2,
  checkPiWinParams,
  checkPiWinFinalRecord,
  decodeBlock,
  h2Head,
  requestBlock,
  splitBody,
  type WinSource,
} from "./h2";
