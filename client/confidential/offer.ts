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
import { checkH2Offer } from "./h2";
import { headRouteProblem, headTemplateProblem } from "./params";
import {
  NodeProtocolOutdatedError,
  OfferBadSignatureError,
  OfferMalformedError,
  OfferPinMismatchError,
  OfferUnavailableError,
  OfferUnpinnedError,
  OfferUnsupportedVersionError,
  TrustedHostError,
} from "./errors";
import { type ChatSuffixSpec, pinKeyProblem, validateChatSuffix } from "./suffix";

/** The one protocol version this client speaks (PROTOCOL-V3.md). */
export const CONFIDENTIAL_VERSION = 3;
export const CONFIDENTIAL_VERSION_MIN = CONFIDENTIAL_VERSION;
export const CONFIDENTIAL_VERSION_MAX = CONFIDENTIAL_VERSION;
/** The two-party key schedule this client implements (§4). */
export const CONFIDENTIAL_TWOPC = "split-public-1";
/** A connection's framing towards the provider. */
export type ConfidentialFraming = "2" | "1.1";
export const CONFIDENTIAL_FRAMINGS: readonly ConfidentialFraming[] = ["2", "1.1"];

export interface ConfidentialPriceEntry {
  /** msats per 1k input tokens. */
  in: number;
  /** msats per 1k cached input tokens. */
  cached_in?: number;
  /** msats per 1k prompt tokens written to the provider's prompt cache. */
  cache_write?: number;
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
  /** The keys the chat suffix pins, in order (derived from `chat`). */
  suffix_keys: string[];
  /** How the pinned chat suffix is built (`validateChatSuffix`). */
  chat: ChatSuffixSpec;
  price_list: Record<string, ConfidentialPriceEntry>;
  /**
   * Public id -> the provider's own id, for the models whose two ids differ
   * (an `org/` prefix): the chat suffix pins the provider's id, the request
   * and the price list name the public one (PROTOCOL-V3.md §12.1). Absent
   * when every id is the provider's own.
   */
  upstream_models?: Record<string, string>;
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
  /**
   * The framings the node serves towards the provider, in the operator's
   * order of preference (`"2"`: HTTP/2, many sequential requests per
   * connection; `"1.1"`: one request per connection). Absent: `["1.1"]`.
   */
  http?: string[];
  /** Terms of framing `"2"`, present when `http` lists it. */
  h2?: ConfidentialH2Offer;
  /** The two-party key schedule (`split-public-1`). */
  twopc?: string;
  /**
   * The deposit (msat) the node reserves at a connection's `setup`. It is
   * released when the connection's first request reaches a settlement and
   * charged when the connection ends without one (unless the node, its
   * sidecar or the provider failed first). 0: none.
   */
  connection_deposit_msat?: number;
  /** The node closes a connection that had no request in flight for this long (seconds). */
  idle_timeout_s?: number;
  /** BIP-340 Schnorr signature (hex) over `sig_payload`. */
  sig?: string;
  /** Exact bytes that were signed. */
  sig_payload?: string;
  [key: string]: unknown;
}

/** The `h2` block of an offer that lists `"2"` in `http` (§12.1). */
export interface ConfidentialH2Offer {
  /** Path of the node's one probe request in the connection head (API base + `/models`). */
  probe_path: string;
  /** The sidecar's own idle limit (seconds); the ceiling of the offer's `idle_timeout_s`. */
  idle_secs: number;
  /** Requests per connection. */
  max_requests: number;
  /** A connection is closed at the first settlement after this long since `head_written` (seconds). */
  max_lifetime_s: number;
  /**
   * The request kinds a connection serves: `["chat"]`, or `["chat", "images"]`
   * when image requests (the offer's `images` block) may run on it too.
   */
  kinds: string[];
}

/** The framings a verified offer serves, in the operator's order. */
export function offerFramings(offer: ConfidentialOffer): ConfidentialFraming[] {
  const list = Array.isArray(offer.http) ? offer.http : ["1.1"];
  return list.filter((f): f is ConfidentialFraming => f === "2" || f === "1.1");
}

/** The offer's connection deposit (msat; 0 when it names none). */
export function offerConnectionDepositMsat(offer: Pick<ConfidentialOffer, "connection_deposit_msat">): number {
  const d = offer.connection_deposit_msat;
  return typeof d === "number" && Number.isSafeInteger(d) && d > 0 ? d : 0;
}

/** How long the node keeps a connection with no request in flight (seconds). */
export function offerIdleTimeoutS(offer: Pick<ConfidentialOffer, "idle_timeout_s" | "h2">): number {
  const t = offer.idle_timeout_s;
  if (typeof t === "number" && Number.isSafeInteger(t) && t >= 10) return t;
  return Math.min(120, offer.h2?.idle_secs ?? 120);
}

/**
 * The framings of `offer` that serve a request of `kind`: `"1.1"` serves chat
 * always and images when the offer has an images block; `"2"` serves the
 * kinds its `h2` block lists.
 */
export function offerFramingsFor(offer: ConfidentialOffer, kind: "chat" | "images"): ConfidentialFraming[] {
  return offerFramings(offer).filter((f) => {
    if (kind === "chat") return f === "1.1" || offer.h2 !== undefined;
    if (!offerSupportsImages(offer)) return false;
    return f === "1.1" || offerSupportsHttp2Images(offer);
  });
}

/** True when the verified offer serves image requests on `http: 2` connections. */
export function offerSupportsHttp2Images(offer: ConfidentialOffer): boolean {
  return (
    offerSupportsHttp2(offer) &&
    offerSupportsImages(offer) &&
    Array.isArray(offer.h2?.kinds) &&
    offer.h2!.kinds.includes("images")
  );
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
  /**
   * Why the offer's framing-`"2"` terms were refused (`http` then no longer
   * lists `"2"` and `h2` is dropped; framing `"1.1"` is unaffected).
   */
  http2Refused?: string;
}

/** True when the verified offer serves framing `"2"`. */
export function offerSupportsHttp2(offer: ConfidentialOffer): boolean {
  return Array.isArray(offer.http) && offer.http.includes("2") && offer.h2 !== undefined;
}

/**
 * The id the chat suffix pins for `model` (a public id of `price_list`): the
 * offer's `upstream_models` entry where the provider's own id differs, else
 * the id itself.
 */
export function pinnedModelId(offer: { upstream_models?: Record<string, string> }, model: string): string {
  const m = offer.upstream_models;
  return m && Object.hasOwn(m, model) ? m[model]! : model;
}

/**
 * Why an offer's `upstream_models` is refused, or undefined (absent is fine).
 * Each value must be `<provider prefix>/<public id>`.
 */
export function upstreamModelsProblem(offer: { price_list: Record<string, unknown>; upstream_models?: unknown }): string | undefined {
  const m = offer.upstream_models;
  if (m === undefined) return undefined;
  if (m === null || typeof m !== "object" || Array.isArray(m)) return "upstream_models is not an object";
  for (const [pub, id] of Object.entries(m as Record<string, unknown>)) {
    if (!Object.hasOwn(offer.price_list, pub)) return `upstream_models names ${JSON.stringify(pub)}, which price_list does not`;
    // Rendered into the suffix as a JSON string: printable ASCII without a quote or backslash.
    if (typeof id !== "string" || !/^[\x21-\x7e]{1,256}$/.test(id) || /["\\]/.test(id) || id === pub) {
      return `upstream_models[${JSON.stringify(pub)}] is not a provider model id`;
    }
    // Only the provider's prefix may differ (`moonshotai/kimi-k3.1-pro` for
    // `kimi-k3.1-pro`): any other id would let the node pin another model than
    // the one the client asked and pays for, and the receipt would verify it.
    if (!id.endsWith(`/${pub}`)) {
      return `upstream_models[${JSON.stringify(pub)}] names another model (${JSON.stringify(id)})`;
    }
  }
  return undefined;
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
  // The node chooses every pinned value of the chat suffix: only a block
  // within the policy is accepted, and suffix_keys must list its keys. (An
  // offer for a version this client does not speak is refused as such.)
  if (supportedVersion(offer as ConfidentialOffer)) validateChatSuffix(offer.chat, offer.suffix_keys);
  if (!isObject(offer.price_list)) {
    throw new OfferMalformedError("offer.price_list is not an object");
  }
  for (const [model, entry] of Object.entries(offer.price_list)) {
    const rate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const optional = (v: unknown) => v === undefined || rate(v);
    if (!isObject(entry) || !rate(entry.in) || !rate(entry.out) || !optional(entry.cached_in) || !optional(entry.cache_write)) {
      throw new OfferMalformedError(`offer.price_list[${JSON.stringify(model)}] is not a set of non-negative rates`);
    }
  }
  const upstreamProblem = upstreamModelsProblem(offer as { price_list: Record<string, unknown>; upstream_models?: unknown });
  if (upstreamProblem) throw new OfferMalformedError(`offer.${upstreamProblem}`);
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
 * so the client holds it to a narrow shape: fixed pins only switch extras off
 * (under no key that negates a feature or names a protection), variant pins
 * only choose a price tier or the format among the published values, the
 * head is a plain request to the image endpoint, and the numbers are
 * bounded. Throws `OfferMalformedError`.
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
  // The count is pinned under this key and the charge is the price × count:
  // under a key the endpoint does not read, the provider would make its
  // default number of images while the client paid for `count`.
  const routeKey = imageCountKeyForRoute(im.head_template as string);
  if (routeKey === undefined) bad("head_template does not name an image endpoint with a known count key");
  if (imageCountKey(im) !== routeKey) {
    bad(`count_key ${JSON.stringify(imageCountKey(im))} is not the one the endpoint reads (${JSON.stringify(routeKey)})`);
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
    const keyProblem = pinKeyProblem(k, v);
    if (keyProblem) bad(`fixed_pins ${JSON.stringify(k)}: ${keyProblem}`);
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

/**
 * The request key an image endpoint reads the image count from, by the route
 * its head template names: `n` for the OpenAI-style `/images/generations`,
 * `variants` for `/image/generate`. Undefined for any other route (the head
 * template check allows only these two).
 */
export function imageCountKeyForRoute(headTemplate: string): string | undefined {
  const path = /^POST (\S+) HTTP\/1\.1\r\n/.exec(headTemplate)?.[1]?.split("?")[0] ?? "";
  if (path.endsWith("/images/generations")) return "n";
  if (path.endsWith("/image/generate")) return "variants";
  return undefined;
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

/** The version an offer names (in its signed bytes when it has them), when it is below this client's. */
function offeredVersionBelow(raw: unknown): number | undefined {
  if (!isObject(raw)) return undefined;
  let v: unknown = raw.v;
  if (typeof raw.sig_payload === "string" && raw.sig_payload.length > 0) {
    try {
      const signed: unknown = JSON.parse(raw.sig_payload);
      if (isObject(signed)) v = signed.v;
    } catch {
      return undefined;
    }
  }
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < CONFIDENTIAL_VERSION ? v : undefined;
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
  // §11, before anything else: an older node's offer need not have the shape
  // of ours, and the answer is the same whoever signed it (the node is not used).
  const olderVersion = offeredVersionBelow(raw);
  if (olderVersion !== undefined) {
    throw new NodeProtocolOutdatedError(
      `node_protocol_outdated: the node offers routstr-confidential v${olderVersion}, this client speaks v${CONFIDENTIAL_VERSION}; ` +
        "the node must be updated before it can serve confidential requests",
      olderVersion,
    );
  }
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
      `offer version v=${offer.v} is not supported: this client speaks only protocol v${CONFIDENTIAL_VERSION} (update the client)`,
    );
  }
  if (offer.twopc !== CONFIDENTIAL_TWOPC) {
    throw new OfferUnsupportedVersionError(
      `offer names the two-party key schedule ${JSON.stringify(offer.twopc ?? null).slice(0, 64)}, this client implements ${CONFIDENTIAL_TWOPC}`,
    );
  }
  const framings = offer.http === undefined ? ["1.1"] : offer.http;
  if (
    !Array.isArray(framings) ||
    framings.length === 0 ||
    framings.some((f) => f !== "2" && f !== "1.1") ||
    new Set(framings).size !== framings.length
  ) {
    throw new OfferMalformedError('offer.http is not a non-empty list of distinct framings ("2", "1.1")');
  }
  const deposit = offer.connection_deposit_msat === undefined ? 0 : offer.connection_deposit_msat;
  if (typeof deposit !== "number" || !Number.isSafeInteger(deposit) || deposit < 0) {
    throw new OfferMalformedError("offer.connection_deposit_msat is not a non-negative integer");
  }
  const idleS = offer.idle_timeout_s;
  if (idleS !== undefined && (typeof idleS !== "number" || !Number.isSafeInteger(idleS) || idleS < 10)) {
    throw new OfferMalformedError("offer.idle_timeout_s is not an integer of at least 10");
  }

  const pinsConfigured = Boolean(options.pinnedPubkey) || (options.pinnedPubkeys?.length ?? 0) > 0;
  if (!offer.sig) {
    if (!options.allowUnpinned) {
      throw new OfferUnpinnedError(
        "offer is unsigned and allowUnpinned is not set (self-consistency is not authenticity)",
      );
    }
    // A pin is a claim about who signed: an unsigned offer naming the pinned
    // key proves nothing, whatever allowUnpinned says.
    if (pinsConfigured) {
      throw new OfferUnpinnedError("offer is unsigned but node keys are pinned; a pinned offer must be signed");
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

  // The node writes the chat request head too: the same syntax as the image
  // head, checked before any setup (π_NK checks it again per session).
  const tplProblem = headTemplateProblem(offer.head_template, offer.upstream_host, "chat");
  if (tplProblem) throw new OfferMalformedError(`offer.head_template: ${tplProblem}`);

  // Fail closed at runtime too (plain-JS callers bypass the TS type): an
  // offer is only usable for an upstream host the caller trusts.
  if (options.trustedHosts === undefined) {
    throw new TrustedHostError("no trusted upstream hosts configured; refusing the offer");
  }
  let apiBases: string[] = [];
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
    // The node writes the request head: hold its route to the API base the
    // caller trusts for that host, so it cannot pick another route of the
    // same provider that merely ends in the endpoint.
    apiBases = matcher.apiBases(offer.upstream_host);
    const route = headRouteProblem(offer.head_template, apiBases, "chat");
    if (route) throw new TrustedHostError(`offer head_template: ${route}`);
  }

  // Framing "2": held to what the node's sidecar enforces. A refused block
  // switches it off for this offer when "1.1" is offered too; an offer of
  // nothing else is refused.
  let http2Refused: string | undefined;
  {
    const { h2: _block, ...rest } = offer;
    if (framings.includes("2")) {
      try {
        const h2 = checkH2Offer(offer, apiBases);
        if (idleS !== undefined && idleS > h2.idle_secs) {
          throw new OfferMalformedError("offer.idle_timeout_s exceeds h2.idle_secs");
        }
        offer = { ...rest, http: [...framings], h2 };
      } catch (error) {
        http2Refused = error instanceof Error ? error.message : String(error);
        if (!framings.includes("1.1")) throw new OfferMalformedError(`offer serves only framing "2" and its terms are refused: ${http2Refused}`);
        offer = { ...rest, http: ["1.1"] };
      }
    } else offer = { ...rest, http: [...framings] };
    offer.connection_deposit_msat = deposit;
  }

  if (offer.images !== undefined) {
    const images = offer.images as { head_template?: unknown };
    const problem =
      imagesOfferProblem(offer.images, offer.upstream_host) ??
      headRouteProblem(String(images.head_template), apiBases, "images");
    if (problem) {
      // Images off for this offer; chat on the same signed terms still works.
      const { images: _refused, ...rest } = offer;
      return { ...rest, signedPayload: payload, imagesRefused: problem, ...(http2Refused ? { http2Refused } : {}) };
    }
  }
  return { ...offer, signedPayload: payload, ...(http2Refused ? { http2Refused } : {}) };
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
  // The query tells an older node's access log that v3 clients are asking (§11).
  const url = `${base}/v1/confidential/offer?v=${CONFIDENTIAL_VERSION}`;
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
