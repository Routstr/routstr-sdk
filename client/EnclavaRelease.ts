import { verifyEvent, type NostrEvent } from "applesauce-core/helpers";

const HEX_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
export const ENCLAVA_RELEASE_KIND = 8428;

export interface EnclavaListingClaim {
  readonly coordinate: string;
  readonly announcementId: string;
  readonly origin: string;
  readonly releaseId: string;
}

// Don't reuse nostr-tools' signature verdict cached on a mutable input event.
function verifiedSnapshot(event: NostrEvent): NostrEvent {
  const { id, kind, pubkey, sig, created_at, content, tags } = event;
  if (!HEX_ID.test(id) || !HEX_ID.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig) ||
      !Number.isSafeInteger(created_at) || created_at < 0 || created_at > Date.now() / 1000 + 600 ||
      typeof content !== "string" || !Array.isArray(tags) ||
      tags.some(tag => !Array.isArray(tag) || tag.some(value => typeof value !== "string"))) {
    throw new Error("Malformed Nostr event");
  }
  const snapshot = { id, kind, pubkey, sig, created_at, content, tags: tags.map(tag => [...tag]) };
  if (!verifyEvent(snapshot)) throw new Error("Invalid Nostr event signature");
  return snapshot;
}

export function verifyEnclavaListing(
  announcement: NostrEvent,
  expectedCoordinate: string,
  origin: string,
): EnclavaListingClaim {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("Expected a canonical HTTPS origin");
  const event = verifiedSnapshot(announcement);
  const identifiers = event.tags.filter(tag => tag[0] === "d");
  if (event.kind !== 38421 || identifiers.length !== 1 || !identifiers[0][1] ||
      `38421:${event.pubkey}:${identifiers[0][1]}` !== expectedCoordinate ||
      !event.tags.some(tag => tag[0] === "u" && (tag[1] === origin || tag[1] === `${origin}/`))) {
    throw new Error("Announcement does not match the pinned provider coordinate and origin");
  }
  const claims = event.tags.filter(tag => tag[0] === "attestation" && tag[2] === origin);
  if (claims.length !== 1 || claims[0].length !== 4 || claims[0][1] !== "enclava-tee" || !HEX_ID.test(claims[0][3])) {
    throw new Error("Expected one Enclava release reference for the selected origin");
  }
  return { coordinate: expectedCoordinate, announcementId: event.id, origin, releaseId: claims[0][3] };
}

export function verifyEnclavaRelease(
  release: NostrEvent,
  expectedId: string,
  releasePubkey: string,
  imageRepository: string,
): { image: string; imageDigest: string } {
  const event = verifiedSnapshot(release);
  if (event.kind !== ENCLAVA_RELEASE_KIND || event.id !== expectedId || event.pubkey !== releasePubkey || event.tags.length !== 0) {
    throw new Error("Release does not match the referenced kind, ID and pinned signer");
  }
  const record = JSON.parse(event.content);
  if (!record || record.schema !== "routstr.enclava-image-release.v1" || record.scheme !== "enclava-tee" ||
      !REPOSITORY.test(imageRepository) || typeof record.image_digest !== "string" || !DIGEST.test(record.image_digest) ||
      record.image !== `${imageRepository}@${record.image_digest}`) {
    throw new Error("Invalid Enclava image release or unexpected repository");
  }
  return { image: record.image, imageDigest: record.image_digest };
}
