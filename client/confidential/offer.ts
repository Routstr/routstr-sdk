/**
 * The node's confidential-upstream offer: fetch, signature + pin verification,
 * version negotiation.
 *
 * Security model (review #16): a signature is only authenticity if the verifier
 * pins *who* may sign. `verifyConfidentialOffer` therefore requires either an
 * explicit `pinnedPubkey` (hex or npub, e.g. the node's Nostr key from its
 * NIP-91 announcement, which routstrd discovery already resolved) or the
 * explicit dev flag `allowUnpinned`. Without either, the offer is rejected —
 * self-consistency is not trust.
 */

import {
  canonicalJson,
  npubToHex,
  verifySchnorrSignature,
} from "./canonical";
import { TrustedHostMatcher } from "./hosts";
import {
  OfferBadSignatureError,
  OfferMalformedError,
  OfferPinMismatchError,
  OfferUnavailableError,
  OfferUnpinnedError,
  OfferUnsupportedVersionError,
  TrustedHostError,
} from "./errors";

/** Protocol versions this client speaks. */
export const CONFIDENTIAL_VERSION_MIN = 1;
export const CONFIDENTIAL_VERSION_MAX = 1;

export interface ConfidentialPriceEntry {
  /** msats per 1k input tokens. */
  in: number;
  /** msats per 1k cached input tokens. */
  cached_in?: number;
  /** msats per 1k output tokens. */
  out: number;
}

export interface ConfidentialOffer {
  v: number;
  min_v?: number;
  max_v?: number;
  upstream_host: string;
  ws?: string;
  notary_pubkey: string;
  notary_pubkey_curve?: string;
  max_tokens_cap: number;
  key_length: number;
  key_alphabet?: string;
  head_template: string;
  suffix_keys: string[];
  price_list: Record<string, ConfidentialPriceEntry>;
  mints?: string[];
  prewarm?: boolean;
  /** BIP-340 Schnorr signature (hex) over `sig_payload`. */
  sig?: string;
  /** Exact bytes that were signed. */
  sig_payload?: string;
  [key: string]: unknown;
}

export interface VerifyOfferOptions {
  /**
   * Expected notary pubkey (64-hex or npub). When set, a mismatch is fatal.
   * routstrd passes the node's Nostr announcement key here.
   */
  pinnedPubkey?: string;
  /**
   * A set of accepted notary pubkeys (hex or npub). The offer's notary must be
   * a member. Used when the operator pins several trusted nodes.
   */
  pinnedPubkeys?: readonly string[];
  /**
   * Dev-only escape hatch: accept an offer with no pin. NEVER set in
   * production; the review flagged self-signed offers as not authentic.
   */
  allowUnpinned?: boolean;
  /** Trusted upstream hostnames (exact or wildcard). Empty ⇒ reject. */
  trustedHosts?: readonly string[] | TrustedHostMatcher;
}

export interface VerifiedOffer extends ConfidentialOffer {
  /** The exact payload whose signature verified. */
  signedPayload: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural validation. Throws `OfferMalformedError`. */
export function validateOfferShape(offer: unknown): asserts offer is ConfidentialOffer {
  if (!isObject(offer)) throw new OfferMalformedError("offer is not an object");
  const required = [
    "v",
    "upstream_host",
    "notary_pubkey",
    "max_tokens_cap",
    "key_length",
    "head_template",
    "suffix_keys",
    "price_list",
  ] as const;
  for (const key of required) {
    if (!(key in offer)) {
      throw new OfferMalformedError(`offer is missing required field '${key}'`);
    }
  }
  if (typeof offer.v !== "number") throw new OfferMalformedError("offer.v is not a number");
  if (typeof offer.upstream_host !== "string" || !offer.upstream_host) {
    throw new OfferMalformedError("offer.upstream_host is not a non-empty string");
  }
  if (typeof offer.notary_pubkey !== "string" || !offer.notary_pubkey) {
    throw new OfferMalformedError("offer.notary_pubkey is not a non-empty string");
  }
  if (typeof offer.head_template !== "string" || !offer.head_template) {
    throw new OfferMalformedError("offer.head_template is not a non-empty string");
  }
  if (!Array.isArray(offer.suffix_keys)) {
    throw new OfferMalformedError("offer.suffix_keys is not an array");
  }
  if (!isObject(offer.price_list)) {
    throw new OfferMalformedError("offer.price_list is not an object");
  }
  if (typeof offer.max_tokens_cap !== "number" || offer.max_tokens_cap <= 0) {
    throw new OfferMalformedError("offer.max_tokens_cap is not a positive number");
  }
}

/** The exact bytes the node signed, or a canonical reconstruction. */
export function offerSignedPayload(offer: ConfidentialOffer): string {
  if (typeof offer.sig_payload === "string" && offer.sig_payload.length > 0) {
    return offer.sig_payload;
  }
  const { sig: _sig, sig_payload: _sp, ...unsigned } = offer;
  return canonicalJson(unsigned);
}

/** Verify only the BIP-340 signature; no pin check. */
export function verifyOfferSignature(offer: ConfidentialOffer): boolean {
  const payload = offerSignedPayload(offer);
  return verifySchnorrSignature(payload, offer.sig, offer.notary_pubkey);
}

/** Supported-version check against the offer's `min_v`/`max_v` and `v`. */
export function supportedVersion(offer: ConfidentialOffer): boolean {
  const min = offer.min_v ?? offer.v;
  const max = offer.max_v ?? offer.v;
  return (
    offer.v >= CONFIDENTIAL_VERSION_MIN &&
    offer.v <= CONFIDENTIAL_VERSION_MAX &&
    min <= CONFIDENTIAL_VERSION_MAX &&
    max >= CONFIDENTIAL_VERSION_MIN
  );
}

/**
 * Full verification: shape → version → signature → pin → trusted host.
 * Returns the offer with `signedPayload` filled in. Every failure is typed.
 */
export function verifyConfidentialOffer(
  raw: unknown,
  options: VerifyOfferOptions = {},
): VerifiedOffer {
  validateOfferShape(raw);
  // The signed bytes are authoritative: when the node ships `sig_payload`, the
  // fields the client uses MUST come from it, not from the outer (mutable)
  // envelope, or a tampered envelope would verify against an unchanged payload.
  let offer: ConfidentialOffer = raw;
  const payload = offerSignedPayload(raw);
  if (typeof raw.sig_payload === "string" && raw.sig_payload.length > 0) {
    let signed: unknown;
    try {
      signed = JSON.parse(raw.sig_payload);
    } catch (error) {
      throw new OfferMalformedError(
        "offer.sig_payload is not valid JSON",
        error instanceof Error ? error.message : String(error),
      );
    }
    validateOfferShape(signed);
    offer = { ...signed, sig: raw.sig, sig_payload: raw.sig_payload };
  }

  if (!supportedVersion(offer)) {
    throw new OfferUnsupportedVersionError(
      `offer version v=${offer.v} min_v=${offer.min_v ?? offer.v} max_v=${offer.max_v ?? offer.v} ` +
        `outside supported range ${CONFIDENTIAL_VERSION_MIN}-${CONFIDENTIAL_VERSION_MAX}`,
    );
  }

  if (!offer.sig) {
    if (!options.allowUnpinned) {
      throw new OfferUnpinnedError(
        "offer is unsigned and allowUnpinned is not set (self-consistency is not authenticity)",
      );
    }
  } else if (!verifySchnorrSignature(payload, offer.sig, offer.notary_pubkey)) {
    throw new OfferBadSignatureError();
  }

  if (options.pinnedPubkey) {
    const pin = npubToHex(options.pinnedPubkey);
    if (!pin) {
      throw new OfferPinMismatchError(
        `configured pinned pubkey is not a valid hex pubkey or npub: ${options.pinnedPubkey}`,
      );
    }
    const notary = npubToHex(offer.notary_pubkey);
    if (!notary || notary !== pin) {
      throw new OfferPinMismatchError(
        `offer notary ${offer.notary_pubkey} != pinned ${pin}`,
      );
    }
  } else if (options.pinnedPubkeys && options.pinnedPubkeys.length > 0) {
    const allowed = options.pinnedPubkeys
      .map((p) => npubToHex(p))
      .filter((p): p is string => p !== null);
    if (allowed.length === 0) {
      throw new OfferPinMismatchError("configured pinnedPubkeys contains no valid pubkey");
    }
    const notary = npubToHex(offer.notary_pubkey);
    if (!notary || !allowed.includes(notary)) {
      throw new OfferPinMismatchError(
        `offer notary ${offer.notary_pubkey} is not among the pinned node keys`,
      );
    }
  } else if (!options.allowUnpinned) {
    throw new OfferUnpinnedError(
      "no pinnedPubkey configured and allowUnpinned is not set",
    );
  }

  // Fail closed at runtime too (plain-JS callers bypass the TS type): an
  // offer is only usable for an upstream host the caller trusts.
  if (options.trustedHosts === undefined) {
    throw new TrustedHostError("no trusted upstream hosts configured; refusing the offer");
  }
  {
    const matcher =
      options.trustedHosts instanceof TrustedHostMatcher
        ? options.trustedHosts
        : new TrustedHostMatcher(options.trustedHosts as readonly string[]);
    if (!matcher.matches(offer.upstream_host)) {
      throw new TrustedHostError(
        `offer upstream_host not trusted: ${matcher.describe(offer.upstream_host)}`,
      );
    }
  }

  return { ...offer, signedPayload: payload };
}

/**
 * Fetch + verify the node's offer. `baseUrl` is the node HTTP(S) base (e.g.
 * `http://127.0.0.1:8000`) — the offer lives at `/v1/confidential/offer`.
 */
export async function fetchConfidentialOffer(
  baseUrl: string,
  options: VerifyOfferOptions & { fetchImpl?: typeof fetch } = {},
): Promise<VerifiedOffer> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/confidential/offer`;
  const doFetch = options.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(url);
  } catch (error) {
    throw new OfferUnavailableError(
      `could not reach ${url}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!resp.ok) {
    throw new OfferUnavailableError(`${url} returned HTTP ${resp.status}`);
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch (error) {
    throw new OfferMalformedError(
      "offer is not valid JSON",
      error instanceof Error ? error.message : String(error),
    );
  }
  return verifyConfidentialOffer(json, options);
}
