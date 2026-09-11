import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { finalizeEvent, getPublicKey } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { of } from "rxjs";
import { ModelManager } from "../../discovery/ModelManager";
import {
  createMemoryDriver,
  createSdkStore,
  createDiscoveryAdapterFromStore,
} from "../../storage";

// Count every trust-gate verification ModelManager performs, including the
// cheap symbol-cached repeats, so a redundant store re-read shows up as a
// doubled count.
const verify = vi.hoisted(() => ({ calls: 0 }));
vi.mock("applesauce-core/helpers", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    verifyEvent: (event: NostrEvent) => {
      verify.calls += 1;
      return actual.verifyEvent(event);
    },
  };
});

const relay = vi.hoisted(() => ({
  events: [] as NostrEvent[],
  requests: [] as number[],
}));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_urls: string[], filter: { kinds: number[] }) {
      relay.requests.push(filter.kinds[0]);
      return of(...relay.events.filter((e) => filter.kinds.includes(e.kind)));
    }
  },
}));

const key = (n: number) =>
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const reviewer = key(1);
const provider = key(2);
const base = "https://provider.example/";
const quiet = {
  log() {},
  warn() {},
  error() {},
  debug() {},
  child: () => quiet,
};

const announcement = () =>
  finalizeEvent(
    {
      kind: 38421,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", base]],
      content: "",
    },
    provider,
  );

const review = () =>
  finalizeEvent(
    {
      kind: 38425,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", getPublicKey(provider)],
        ["node", getPublicKey(provider)],
        ["t", "lgtm"],
      ],
      content: "",
    },
    reviewer,
  );

async function openManager() {
  const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);
  const eventStore = new EventStore();
  const manager = new ModelManager(adapter, {
    eventStore,
    routstrPubkey: getPublicKey(reviewer),
    logger: quiet,
  });
  return { adapter, manager };
}

describe("getNostrEvents verification cost", () => {
  afterEach(() => {
    relay.events = [];
    relay.requests = [];
    verify.calls = 0;
    vi.unstubAllGlobals();
  });

  it("verifies each stored event exactly once on a warm cache-hit bootstrap", async () => {
    relay.events = [announcement(), review()];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { adapter, manager } = await openManager();

    // Cold bootstrap: the live Nostr path populates the store and query cache.
    const eventsFound: number[] = [];
    const urls = await manager.bootstrapProviders(false, false, {
      onEventsFound: (count) => eventsFound.push(count),
    });
    expect(urls).toEqual([base]);
    // The fetch path must fire onEvent exactly once per received event —
    // received events fire immediately, the post-fetch re-read skips them.
    expect(eventsFound).toEqual([1]);
    expect(adapter.getDisabledProviders()).toEqual([]);

    // Warm bootstrap: the 38421 and 38425 queries must hit the verified cache.
    verify.calls = 0;
    relay.requests = [];
    await manager.bootstrapProviders();
    // One announcement + one review, each verified exactly once. A redundant
    // timeline re-read on the cache-hit path would double this to 4.
    expect(verify.calls).toBe(2);
    expect(relay.requests).not.toContain(38421);
    expect(relay.requests).not.toContain(38425);
    expect(adapter.getDisabledProviders()).toEqual([]);
  });

  it("does not read the store before a forced refresh", async () => {
    relay.events = [announcement(), review()];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { manager } = await openManager();
    await manager.bootstrapProviders();

    // Forced queries skip the verified pre-read: each stored event costs
    // one relay-gate verification plus one post-fetch re-read (2 events x 2
    // = 4). refreshNostrEvents then prunes superseded versions, whose one
    // read verifies both events again (+2), and re-applies the review sync,
    // whose two cache-hit queries re-verify both events once each (+2).
    verify.calls = 0;
    await manager.refreshNostrEvents();
    expect(verify.calls).toBe(8);
  });
});
