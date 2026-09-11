/**
 * Regression tests for the persistent-store read in Nostr discovery.
 *
 * Kind 38421 is shared: an unrelated project can publish thousands of
 * addressable events on it (`lnproxy-v1` advertisements in production). Those
 * rows must not be stored, verified, or counted as discovery evidence, and the
 * relay query's `limit` must never truncate the store read — otherwise the
 * newest N rows are all foreign events and every routstr provider (and review)
 * silently disappears from discovery.
 *
 * The store double here keeps every version of an addressable event and
 * honours `limit`, which is what the SQLite-backed store does in production:
 * applesauce's `EventStore.remove` passes the event object to
 * `database.remove`, and `applesauce-sqlite` only honours a string id, so
 * inserting a newer version never deletes the older one. Discovery therefore
 * cannot rely on the store collapsing history.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventMemory, EventStore } from "applesauce-core";
import {
  finalizeEvent,
  getPublicKey,
  verifiedSymbol,
} from "applesauce-core/helpers";
import type { Filter, NostrEvent } from "applesauce-core/helpers";
import { of, throwError } from "rxjs";
import { ModelManager } from "../../discovery/ModelManager";
import { ProviderManager } from "../../client/ProviderManager";
import {
  createMemoryDriver,
  createSdkStore,
  createDiscoveryAdapterFromStore,
} from "../../storage";

const relay = vi.hoisted(() => ({
  events: [] as NostrEvent[],
  requests: [] as number[],
}));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_urls: string[], filter: { kinds: number[] }) {
      relay.requests.push(filter.kinds[0]);
      return relay.events.length === 0
        ? throwError(() => new Error("offline"))
        : of(...relay.events.filter((e) => filter.kinds.includes(e.kind)));
    }
  },
}));

const key = (n: number) =>
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const reviewer = key(1);
const quiet = {
  log() {},
  warn() {},
  error() {},
  debug() {},
  child: () => quiet,
};

const now = () => Math.floor(Date.now() / 1000);

const announcement = (url: string, sk: Uint8Array, createdAt = now()) =>
  finalizeEvent(
    {
      kind: 38421,
      created_at: createdAt,
      tags: [
        ["d", getPublicKey(sk).slice(0, 12)],
        ["u", url],
        ["version", "0.4.9"],
      ],
      content: JSON.stringify({ name: url }),
    },
    sk,
  );

/**
 * Addressable kind-38421 event from an unrelated publisher. The expiration tag
 * is in the future so the store admits it, matching a live advertisement that
 * was still valid when it was fetched (older versions then pile up, because a
 * SQLite-backed store never deletes them — see the file header).
 */
const foreignAd = (createdAt: number) =>
  finalizeEvent(
    {
      kind: 38421,
      created_at: createdAt,
      tags: [
        ["d", "lnproxy-v1"],
        ["n", "signet"],
        ["expiration", String(now() + 24 * 3600)],
        ["nonce", String(createdAt)],
      ],
      content: JSON.stringify({ base_fee_msat: 1000, fee_ppm: 1000 }),
    },
    key(9),
  );

const review = (nodePubkey: string, label: string, createdAt = now()) =>
  finalizeEvent(
    {
      kind: 38425,
      created_at: createdAt,
      tags: [
        ["d", nodePubkey],
        ["node", nodePubkey],
        ["t", label],
      ],
      content: "",
    },
    reviewer,
  );

/** Event claiming `pubkey` with an invalid signature. */
const forgeAs = (event: NostrEvent, pubkey: string): NostrEvent => {
  const forged = { ...event, pubkey, sig: "00".repeat(64) };
  delete (forged as Record<PropertyKey, unknown>)[verifiedSymbol];
  return forged;
};

/**
 * Mirrors the SQLite-backed event database discovery runs against:
 *
 * - `limit` truncates the result, because applesauce-sqlite renders it as a
 *   SQL `LIMIT`. EventMemory only applies a limit to time-bounded filters.
 * - Versions of an addressable event accumulate: `EventStore.add` deletes the
 *   superseded version through `database.remove(event)`, which
 *   applesauce-sqlite ignores (it only honours a string id).
 */
class SqliteLikeDatabase extends EventMemory {
  override getTimeline(filters: Filter | Filter[]): NostrEvent[] {
    const timeline = super.getTimeline(filters) as NostrEvent[];
    const limit = (Array.isArray(filters) ? filters[0] : filters)?.limit;
    return limit ? timeline.slice(0, limit) : timeline;
  }

  override remove(eventOrId: NostrEvent | string): boolean {
    return typeof eventOrId === "string" ? super.remove(eventOrId) : false;
  }

  // applesauce-sqlite deletes by SQL here, so its removeByFilters works even
  // though remove(event) does not; EventMemory delegates to remove(event).
  override removeByFilters(filters: Filter | Filter[]): number {
    let removed = 0;
    for (const event of this.getByFilters(filters) as NostrEvent[]) {
      if (super.remove(event.id)) removed += 1;
    }
    return removed;
  }
}

async function openManager() {
  const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);
  // Direct access lets a test write a row the way another writer could (and
  // the way the SQLite store does): bypassing the EventStore's own
  // add()-time signature check.
  const database = new SqliteLikeDatabase();
  const eventStore = new EventStore({ database: database as never });
  const manager = new ModelManager(adapter, {
    eventStore,
    routstrPubkey: getPublicKey(reviewer),
    logger: quiet,
  });
  return { adapter, database, manager, eventStore, store };
}

/** Append `count` foreign versions, each newest when it is added. */
function seedForeignAds(eventStore: EventStore, count: number): void {
  const base = now() - count * 60;
  for (let i = 0; i < count; i += 1) eventStore.add(foreignAd(base + i * 60));
}

describe("discovery store reads", () => {
  afterEach(() => {
    relay.events = [];
    relay.requests = [];
    vi.unstubAllGlobals();
  });

  it("keeps providers discoverable behind a wall of foreign kind-38421 events", async () => {
    const providerKeys = Array.from({ length: 30 }, (_, i) => key(i + 2));
    const urls = providerKeys.map((_, i) => `https://provider-${i}.example/`);
    const { manager, eventStore } = await openManager();

    // 300 foreign versions published after the announcements, so every one of
    // the newest 100 rows is foreign and no provider is inside that window.
    for (let i = 0; i < providerKeys.length; i += 1) {
      eventStore.add(announcement(urls[i]!, providerKeys[i]!, now() - 4 * 3600));
    }
    seedForeignAds(eventStore, 300);

    const bases = await manager.bootstrapProviders(false, true);
    expect(bases.sort()).toEqual([...urls].sort());
  });

  it("keeps reviews usable behind a wall of foreign kind-38421 events", async () => {
    const providerKey = key(2);
    const url = "https://provider.example/";
    const { adapter, manager, eventStore } = await openManager();
    eventStore.add(announcement(url, providerKey, now() - 4 * 3600));
    eventStore.add(review(getPublicKey(providerKey), "lgtm", now() - 4 * 3600));
    seedForeignAds(eventStore, 300);

    await manager.bootstrapProviders(false, true);
    expect(adapter.getDisabledProviders()).toEqual([]);
  });

  it("never stores, returns, or counts foreign events as discovery evidence", async () => {
    const providerKey = key(2);
    const url = "https://provider.example/";
    const { manager, eventStore } = await openManager();
    const foreign = foreignAd(now());
    relay.events = [
      announcement(url, providerKey),
      review(getPublicKey(providerKey), "lgtm"),
      foreign,
    ];

    const counts: number[] = [];
    const bases = await manager.bootstrapProviders(false, false, {
      onEventsFound: (count) => counts.push(count),
    });

    expect(bases).toEqual([url]);
    // Only the routstr announcement is announced; the advertisement is not.
    expect(counts).toEqual([1]);
    expect(eventStore.hasEvent(foreign.id)).toBe(false);
  });

  it("prunes superseded versions and foreign events without changing discovery", async () => {
    const providerKey = key(2);
    const url = "https://provider.example/";
    const { adapter, manager, eventStore } = await openManager();
    eventStore.add(announcement(url, providerKey, now() - 4 * 3600));
    eventStore.add(review(getPublicKey(providerKey), "lgtm"));
    seedForeignAds(eventStore, 50);

    expect(eventStore.getTimeline({ kinds: [38421] }).length).toBe(51);
    const removed = await manager.pruneSupersededDiscoveryEvents();

    // 50 foreign versions collapse to one (the newest) and that one is
    // rejected outright, so nothing but the announcement survives.
    expect(removed).toBe(50);
    expect(eventStore.getTimeline({ kinds: [38421] }).length).toBe(1);
    expect(await manager.bootstrapProviders(false, true)).toEqual([url]);
    expect(adapter.getDisabledProviders()).toEqual([]);

    // Idempotent: nothing left to prune on the next pass.
    expect(await manager.pruneSupersededDiscoveryEvents()).toBe(0);
  });

  it("prunes superseded replaceable versions but keeps the newest", async () => {
    const providerKey = key(2);
    const url = "https://provider.example/";
    const movedUrl = "https://provider-moved.example/";
    const { manager, eventStore } = await openManager();
    eventStore.add(announcement(url, providerKey, now() - 3600));
    eventStore.add(announcement(movedUrl, providerKey, now() - 60));

    expect(eventStore.getTimeline({ kinds: [38421] }).length).toBe(2);
    expect(await manager.pruneSupersededDiscoveryEvents()).toBe(1);
    expect(
      eventStore.getTimeline({ kinds: [38421] }).map((event) => event.tags),
    ).toEqual([expect.arrayContaining([["u", movedUrl]])]);
    // The pruned history does not resurrect the old endpoint.
    expect(await manager.bootstrapProviders(false, true)).toEqual([movedUrl]);
  });

  it("a forged newer version cannot evict a genuine announcement", async () => {
    const providerKey = key(2);
    const url = "https://provider.example/";
    const { database, manager, eventStore } = await openManager();
    const genuine = announcement(url, providerKey, now() - 3600);
    eventStore.add(genuine);
    // Same address (kind + pubkey + d tag), newer created_at, bogus signature,
    // written straight to the database the way a foreign writer would.
    const forged = forgeAs(
      announcement("https://attacker.example/", providerKey),
      genuine.pubkey,
    );
    database.add(forged);

    expect(eventStore.getTimeline({ kinds: [38421] }).length).toBe(2);
    expect(await manager.bootstrapProviders(false, true)).toEqual([url]);
    // Pruning keeps the genuine winner and drops the forgery.
    expect(await manager.pruneSupersededDiscoveryEvents()).toBe(1);
    expect(eventStore.getTimeline({ kinds: [38421] }).map((e) => e.id)).toEqual([
      genuine.id,
    ]);
  });

  it("pruning keeps the newest version when no version is trustworthy yet", async () => {
    const providerKey = key(2);
    const { manager, eventStore } = await openManager();
    // Far-future created_at: dropped by the trust gate until the clock
    // catches up, so pruning must not destroy the only evidence.
    const future = announcement(
      "https://provider.example/",
      providerKey,
      now() + 2 * 24 * 3600,
    );
    eventStore.add(future);

    expect(await manager.pruneSupersededDiscoveryEvents()).toBe(0);
    expect(eventStore.getTimeline({ kinds: [38421] }).map((e) => e.id)).toEqual([
      future.id,
    ]);
  });

  it("reports the provider ranking from restored evidence", async () => {
    const providerKeys = Array.from({ length: 30 }, (_, i) => key(i + 2));
    const urls = providerKeys.map((_, i) => `https://provider-${i}.example/`);
    const { adapter, manager, eventStore, store } = await openManager();
    for (let i = 0; i < providerKeys.length; i += 1) {
      eventStore.add(announcement(urls[i]!, providerKeys[i]!, now() - 4 * 3600));
      eventStore.add(
        review(getPublicKey(providerKeys[i]!), "lgtm", now() - 4 * 3600),
      );
    }
    seedForeignAds(eventStore, 300);

    const bases = await manager.bootstrapProviders(false, true);
    expect(bases).toHaveLength(urls.length);
    expect(adapter.getDisabledProviders()).toEqual([]);

    adapter.setCachedModels(
      Object.fromEntries(
        bases.map((base, i) => [
          base,
          [
            {
              id: "model",
              name: "model",
              sats_pricing: { prompt: 1, completion: 100 - i },
            },
          ],
        ]),
      ) as never,
    );

    const providers = new ProviderManager(adapter, store, quiet);
    const ranking = providers.getProviderPriceRankingForModel("model");
    // Sorted by price: the ranking is what routing uses.
    expect(ranking.map((entry) => entry.baseUrl).sort()).toEqual(
      [...bases].sort(),
    );
    expect(ranking[0]!.completionPerMillion).toBe(71 * 1_000_000);
  });
});
