/**
 * Choosing the variant and count of a confidential image request.
 *
 * Kept free of the transport (no session, no prover) so the browser-safe
 * client can size a deposit with exactly the choice the request will make.
 */

import { ConfidentialError } from "./errors";
import type { ConfidentialImagesOffer, ConfidentialImageVariant } from "./offer";

/**
 * Keys that choose the variant and count: never sent in the private prefix
 * (the suffix pins what they select).
 */
export const IMAGE_SELECTOR_KEYS: ReadonlySet<string> = new Set([
  "model",
  "n",
  "variants",
  "count",
  "resolution",
  "quality",
  "format",
  "size",
  "response_format",
  "output_format",
]);

/** Keys that set the output size; on a model priced by resolution tier they would buy a tier privately. */
const IMAGE_SIZE_KEYS = ["width", "height"];

function refuseImage(message: string): never {
  throw new ConfidentialError("unsupported_endpoint", message);
}

function countKeyOf(images: { count_key?: unknown }): string {
  return typeof images.count_key === "string" && images.count_key ? images.count_key : "variants";
}

/**
 * The variant and count an image request asks for, in the offer's terms.
 * Throws when the offer has no variant matching the request, or when the
 * request names a price axis the variant cannot pin: no silent substitution
 * of a dearer or different tier, and no unpriced tier sent privately.
 */
export function chooseImageVariant(
  request: Record<string, unknown>,
  images: Pick<ConfidentialImagesOffer, "price_list" | "max_count" | "count_key" | "fixed_pins">,
): { model: string; variant: ConfidentialImageVariant; count: number; countKey: string } {
  const model = typeof request.model === "string" ? request.model : "";
  const variants = images.price_list[model];
  if (!variants || variants.length === 0) {
    throw new ConfidentialError("offer_malformed", `the node does not generate ${model} images confidentially`);
  }
  const countKey = countKeyOf(images);
  const rawCount = request[countKey] ?? request.n ?? request.variants ?? request.count ?? 1;
  const count = typeof rawCount === "number" ? rawCount : NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > images.max_count) {
    refuseImage(`confidential image requests take 1 to ${images.max_count} images, not ${String(rawCount)}`);
  }
  for (const fmt of [request.format, request.output_format]) {
    if (fmt !== undefined && fmt !== "webp") refuseImage(`confidential images are WebP only, not ${String(fmt)}`);
  }
  // The price axes this model's variants pin (format is always WebP).
  const axes = new Set(variants.flatMap((v) => v.pins.map((p) => p[0])));
  const asked: Record<string, unknown> = {};
  // A size is either absent, "auto" or WIDTHxHEIGHT; anything else is refused
  // rather than silently replaced by a default tier.
  if (request.size !== undefined && request.size !== "auto" && resolutionFromSize(request.size) === undefined) {
    refuseImage(`size ${JSON.stringify(request.size)} is not WIDTHxHEIGHT`);
  }
  if (typeof request.resolution === "string" && request.resolution) {
    asked.resolution = request.resolution.toUpperCase();
  } else if (request.resolution !== undefined) {
    refuseImage(`resolution must be a string, not ${JSON.stringify(request.resolution)}`);
  } else if (axes.has("resolution")) {
    // An OpenAI size only selects a tier where the model has tiers; for any
    // other model it is ignored (it mostly carries the caller's aspect).
    const fromSize = resolutionFromSize(request.size);
    if (fromSize) asked.resolution = fromSize;
  }
  if (request.quality !== undefined) asked.quality = request.quality;
  for (const k of Object.keys(asked)) {
    if (!axes.has(k)) refuseImage(`${model} has no ${k} tiers to choose from confidentially`);
  }
  if (axes.has("resolution")) {
    for (const k of IMAGE_SIZE_KEYS) {
      if (request[k] !== undefined) {
        refuseImage(`${model} is priced by resolution tier: choose a resolution, not ${k}`);
      }
    }
  }
  const fixed = new Set(images.fixed_pins.map((p) => p[0]));
  for (const k of Object.keys(request)) {
    if (fixed.has(k)) refuseImage(`${k} is fixed by the node's offer and cannot be set`);
  }
  const matches = variants.filter((v) =>
    Object.entries(asked).every(([k, want]) => {
      const pin = v.pins.find((p) => p[0] === k);
      return pin !== undefined && pin[1] === want;
    }),
  );
  if (matches.length === 0) {
    const ids = variants.map((v) => v.id).join(", ");
    refuseImage(`no confidential ${model} variant matches ${JSON.stringify(asked)} (offered: ${ids})`);
  }
  // Several match (the caller left a tier open): the cheapest, normally the default tier.
  const variant = matches.reduce((a, b) => (b.msat_per_image < a.msat_per_image ? b : a));
  return { model, variant, count, countKey };
}

/** The resolution class of an OpenAI `size` (by area, as the node bills it). */
export function resolutionFromSize(size: unknown): string | undefined {
  if (typeof size !== "string" || !/^\d+x\d+$/i.test(size)) return undefined;
  const [w, h] = size.toLowerCase().split("x").map(Number);
  const area = w! * h!;
  if (area < 2 * 1024 * 1024) return "1K";
  if (area < 2 * 2048 * 2048) return "2K";
  return "4K";
}
