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
import { headTemplateProblem } from "./params";
import {
  OfferBadSignatureError,
  OfferMalformedError,
  OfferPinMismatchError,
  OfferUnavailableError,
  OfferUnpinnedError,
  OfferUnsupportedVersionError,
  TrustedHostError,
} from "./errors";

/**
 * Protocol versions this client speaks: only v2 (the two-party handshake).
 * Protocol v1 is retired; a node that offers only v1 is refused.
 */
export const CONFIDENTIAL_VERSION_MIN = 2;
export const CONFIDENTIAL_VERSION_MAX = 2;

export interface ConfidentialPriceEntry {
  /** msats per 1k input tokens. */
  in: number;
  /** msats per 1k cached input tokens. */
  cached_in?: number;
  /** msats per 1k output tokens. */
  out: number;
}

/** One priced way to generate an image with a model (its pinned request keys). */
export interface ConfidentialImageVariant {
  id: string;
  /** Request keys and values the suffix pins for this variant, in order. */
  pins: [string, unknown][];
  /** Flat price per generated image (whole msats), surcharge included. */
  msat_per_image: number;
  /** Most images per request for this variant, when lower than the offer's `max_count`. */
  max_count?: number;
}

/**
 * The image-generation capability of a signed offer: a flat price per image,
 * fixed at setup from pinned request parameters (no usage disclosure).
 */
export interface ConfidentialImagesOffer {
  /** The request head the node writes for an image request ({KEY:n}, {LEN}). */
  head_template: string;
  /** `venice` (`{images: [b64]}`) or `openai` (`{data: [{b64_json}]}`). */
  response_shape: "venice" | "openai";
  /** Seconds the response may stay silent (image generation sends nothing until done). */
  response_idle_s?: number;
  /** Most images per request. */
  max_count: number;
  /** The request key that carries the image count (default `variants`). */
  count_key?: string;
  /** Key/value pairs pinned on every image request (paid extras off, …). */
  fixed_pins: [string, unknown][];
  /** The values each tier key may take (informational). */
  param_space?: Record<string, unknown[]>;
  price_list: Record<string, ConfidentialImageVariant[]>;
  max_response_bytes?: number;
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
  /**
   * Flat fee (msats) on top of the usage of a completed request, and the
   * charge for a request the provider refused (4xx/503). The client accepts it
   * by echoing it in setup.
   */
  session_fee_msat?: number;
  /**
   * Fee (msats, ≥ session_fee_msat) for a session that ends without a request
   * reaching the provider: armed and never used, aborted before the body, the
   * client gone. The node's anti-DoS deposit; it is reserved at setup and the
   * client accepts it by echoing it in setup.
   */
  abandon_fee_msat?: number;
  /**
   * Informational: the surcharge (percent) the node applies to its per-token
   * rates for confidential sessions. `price_list` already includes it.
   */
  rate_surcharge_pct?: number;
  /**
   * Completion tokens the node reserves beyond the pinned cap (a provider may
   * bill slightly past it); absent when none.
   */
  reserve_margin_tokens?: number;
  /** What the node serves confidentially (`chat`, `images`); absent: chat only. */
  capabilities?: string[];
  /** Image generation terms, present with the `images` capability. */
  images?: ConfidentialImagesOffer;
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
  /**
   * Why the offer's `images` block was refused (it is then dropped, chat is
   * unaffected); an image request names this reason.
   */
  imagesRefused?: string;
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
  if (typeof offer.v !== "number" || !Number.isSafeInteger(offer.v)) {
    throw new OfferMalformedError("offer.v is not an integer");
  }
  for (const key of ["min_v", "max_v"] as const) {
    const bound = offer[key];
    if (bound !== undefined && (typeof bound !== "number" || !Number.isSafeInteger(bound))) {
      throw new OfferMalformedError(`offer.${key} is not an integer`);
    }
  }
  // The offered range must contain the version the offer itself runs.
  const minV = (offer.min_v ?? offer.v) as number;
  const maxV = (offer.max_v ?? offer.v) as number;
  if (!(minV <= offer.v && offer.v <= maxV)) {
    throw new OfferMalformedError(
      `offer version v=${offer.v} lies outside its own range min_v=${minV} max_v=${maxV}`,
    );
  }
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
  for (const [model, entry] of Object.entries(offer.price_list)) {
    const rate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!isObject(entry) || !rate(entry.in) || !rate(entry.out) || (entry.cached_in !== undefined && !rate(entry.cached_in))) {
      throw new OfferMalformedError(`offer.price_list[${JSON.stringify(model)}] is not a set of non-negative rates`);
    }
  }
  if (
    typeof offer.max_tokens_cap !== "number" ||
    !Number.isSafeInteger(offer.max_tokens_cap) ||
    offer.max_tokens_cap <= 0
  ) {
    throw new OfferMalformedError("offer.max_tokens_cap is not a positive integer");
  }
  if (
    offer.session_fee_msat !== undefined &&
    (typeof offer.session_fee_msat !== "number" ||
      !Number.isSafeInteger(offer.session_fee_msat) ||
      offer.session_fee_msat < 0)
  ) {
    throw new OfferMalformedError("offer.session_fee_msat is not a non-negative integer");
  }
  if (
    offer.abandon_fee_msat !== undefined &&
    (typeof offer.abandon_fee_msat !== "number" ||
      !Number.isSafeInteger(offer.abandon_fee_msat) ||
      offer.abandon_fee_msat < 0)
  ) {
    throw new OfferMalformedError("offer.abandon_fee_msat is not a non-negative integer");
  }
  if (
    offer.rate_surcharge_pct !== undefined &&
    (typeof offer.rate_surcharge_pct !== "number" ||
      !Number.isFinite(offer.rate_surcharge_pct) ||
      offer.rate_surcharge_pct < 0)
  ) {
    throw new OfferMalformedError("offer.rate_surcharge_pct is not a non-negative number");
  }
  if (
    offer.capabilities !== undefined &&
    (!Array.isArray(offer.capabilities) || !offer.capabilities.every((c) => typeof c === "string"))
  ) {
    throw new OfferMalformedError("offer.capabilities is not a list of strings");
  }
  // The images block is checked in verifyConfidentialOffer: a malformed one
  // disables images only, never chat.
}

function isPinList(v: unknown): v is [string, unknown][] {
  return (
    Array.isArray(v) &&
    v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && p[0] !== "")
  );
}

/** The variant keys an image offer may pin: price axes and the output format. */
export const IMAGE_VARIANT_PIN_KEYS: ReadonlySet<string> = new Set(["resolution", "quality", "format"]);

/** Most images one confidential request may ask for. */
export const IMAGE_MAX_COUNT = 4;

/** A fixed pin may only switch a provider extra off: `false` or an empty list. */
function isOffValue(v: unknown): boolean {
  return v === false || (Array.isArray(v) && v.length === 0);
}

/**
 * Check a signed offer's `images` block. The node chooses every pinned value,
 * so the client holds it to a narrow shape: fixed pins only switch extras off,
 * variant pins only choose a price tier or the format among the published
 * values, the head is a plain request to the image endpoint, and the numbers
 * are bounded. Throws `OfferMalformedError`.
 */
export function validateImagesOffer(images: unknown, upstreamHost: string): asserts images is ConfidentialImagesOffer {
  const bad = (what: string): never => {
    throw new OfferMalformedError(`offer.images.${what}`);
  };
  if (!isObject(images)) bad("is not an object");
  const im = images as Record<string, unknown>;
  if (typeof im.head_template !== "string" || !im.head_template) bad("head_template is not a non-empty string");
  const tplProblem = headTemplateProblem(im.head_template as string, upstreamHost, "images");
  if (tplProblem) bad(`head_template: ${tplProblem}`);
  if (im.response_shape !== "venice" && im.response_shape !== "openai") bad("response_shape is not venice or openai");
  if (
    im.response_idle_s !== undefined &&
    !(Number.isSafeInteger(im.response_idle_s) && (im.response_idle_s as number) >= 30 && (im.response_idle_s as number) <= 600)
  ) {
    bad("response_idle_s is not an integer from 30 to 600");
  }
  if (!(Number.isSafeInteger(im.max_count) && (im.max_count as number) >= 1 && (im.max_count as number) <= IMAGE_MAX_COUNT)) {
    bad(`max_count is not an integer from 1 to ${IMAGE_MAX_COUNT}`);
  }
  if (im.count_key !== undefined && (typeof im.count_key !== "string" || !im.count_key)) {
    bad("count_key is not a non-empty string");
  }
  if (
    !isObject(im.param_space) ||
    !Object.values(im.param_space).every((vals) => Array.isArray(vals) && vals.every((x) => typeof x === "string"))
  ) {
    bad("param_space is not an object of string lists");
  }
  const space = im.param_space as Record<string, string[]>;
  if (!isPinList(im.fixed_pins)) bad("fixed_pins is not a list of [key, value] pairs");
  for (const [k, v] of im.fixed_pins as [string, unknown][]) {
    if (!isOffValue(v)) bad(`fixed_pins ${JSON.stringify(k)} is not switched off (only false or [] may be pinned)`);
  }
  if (!isObject(im.price_list)) bad("price_list is not an object");
  const fixed = new Set([...(im.fixed_pins as [string, unknown][]).map((p) => p[0]), "model", imageCountKey(im)]);
  if (fixed.size !== (im.fixed_pins as unknown[]).length + 2) bad("fixed_pins repeat a key or pin model/count");
  for (const [model, variants] of Object.entries(im.price_list as Record<string, unknown>)) {
    if (!Array.isArray(variants) || variants.length === 0) bad(`price_list[${JSON.stringify(model)}] has no variants`);
    const ids = new Set<string>();
    for (const v of variants as unknown[]) {
      const where = `price_list[${JSON.stringify(model)}]`;
      if (!isObject(v) || typeof v.id !== "string" || !v.id || ids.has(v.id)) bad(`${where} has a variant without a unique id`);
      ids.add((v as { id: string }).id);
      const vv = v as Record<string, unknown>;
      if (!isPinList(vv.pins) || vv.pins.some((p) => fixed.has(p[0]))) bad(`${where} pins a fixed key`);
      if (new Set((vv.pins as [string, unknown][]).map((p) => p[0])).size !== (vv.pins as unknown[]).length) {
        bad(`${where} repeats a pinned key`);
      }
      for (const [k, val] of vv.pins as [string, unknown][]) {
        if (!IMAGE_VARIANT_PIN_KEYS.has(k)) bad(`${where} pins ${JSON.stringify(k)}, which is not a price tier or the format`);
        if (typeof val !== "string" || !(space[k] ?? []).includes(val)) {
          bad(`${where} pins ${k}=${JSON.stringify(val)}, which is not in param_space`);
        }
      }
      const price = vv.msat_per_image;
      if (!(Number.isSafeInteger(price) && (price as number) > 0)) {
        bad(`${where} msat_per_image is not a positive whole number of msats`);
      }
      if (
        vv.max_count !== undefined &&
        !(Number.isSafeInteger(vv.max_count) && (vv.max_count as number) >= 1 && (vv.max_count as number) <= (im.max_count as number))
      ) {
        bad(`${where} max_count is not an integer from 1 to the offer's max_count`);
      }
    }
  }
}

/** Why a signed offer's `images` block is refused, or `undefined` when it is acceptable. */
export function imagesOfferProblem(images: unknown, upstreamHost: string): string | undefined {
  try {
    validateImagesOffer(images, upstreamHost);
    return undefined;
  } catch (error) {
    if (error instanceof OfferMalformedError) return error.message;
    throw error;
  }
}

/** The request key that carries the image count. */
export function imageCountKey(images: { count_key?: unknown }): string {
  return typeof images.count_key === "string" && images.count_key ? images.count_key : "variants";
}

/** True when the signed offer serves confidential image generation. */
export function offerSupportsImages(offer: ConfidentialOffer): boolean {
  return Array.isArray(offer.capabilities) && offer.capabilities.includes("images") && offer.images !== undefined;
}

/**
 * The pinned JSON suffix of an image request, byte for byte as the relay
 * renders it: model, count, the fixed pins, then the variant's pins, in
 * compact JSON, closing the request object.
 */
export function renderImageSuffix(
  model: string,
  count: number,
  countKey: string,
  fixedPins: readonly [string, unknown][],
  pins: readonly [string, unknown][],
): string {
  const parts = [`"model":${JSON.stringify(model)}`, `${JSON.stringify(countKey)}:${JSON.stringify(count)}`];
  for (const [k, v] of [...fixedPins, ...pins]) parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `,${parts.join(",")}}`;
}

function feeValue(fee: unknown): number {
  return typeof fee === "number" && Number.isSafeInteger(fee) && fee > 0 ? fee : 0;
}

/** The signed offer's completion-token margin on the reservation (0 when none). */
export function offerReserveMarginTokens(offer: Pick<ConfidentialOffer, "reserve_margin_tokens">): number {
  return feeValue(offer.reserve_margin_tokens);
}

/** The signed offer's session fee in msats (0 when the node charges none). */
export function offerSessionFeeMsat(offer: Pick<ConfidentialOffer, "session_fee_msat">): number {
  return feeValue(offer.session_fee_msat);
}

/**
 * The signed offer's abandon fee in msats: what a session that ends without a
 * request reaching the provider costs. Never below the session fee (the node
 * uses the session fee when it sets none).
 */
export function offerAbandonFeeMsat(
  offer: Pick<ConfidentialOffer, "session_fee_msat" | "abandon_fee_msat">,
): number {
  return Math.max(feeValue(offer.abandon_fee_msat), offerSessionFeeMsat(offer));
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
    min <= offer.v &&
    offer.v <= max &&
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
        `is not supported: this client speaks only protocol v${CONFIDENTIAL_VERSION_MIN}` +
        (offer.v < CONFIDENTIAL_VERSION_MIN ? " (protocol v1 is retired; the node must offer v2)" : ""),
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

  if (offer.images !== undefined) {
    const problem = imagesOfferProblem(offer.images, offer.upstream_host);
    if (problem) {
      // Images off for this offer; chat on the same signed terms still works.
      const { images: _refused, ...rest } = offer;
      return { ...rest, signedPayload: payload, imagesRefused: problem };
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
