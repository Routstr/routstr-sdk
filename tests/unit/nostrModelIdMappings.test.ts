import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { finalizeEvent, getPublicKey, verifiedSymbol } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { of, throwError } from "rxjs";
import { ModelManager } from "../../discovery/ModelManager";
import { ProviderManager } from "../../client/ProviderManager";
import { canonicalIdForModel, MODEL_ID_MAPPINGS } from "../../core/modelMappings";
import {
  createMemoryDriver,
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createShardedDiscoveryAdapter,
} from "../../storage";
import type { Model } from "../../core/types";

const secret = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? n : 0);
const author = secret(1);
const other = secret(2);
const pubkey = getPublicKey(author);
const now = () => Math.floor(Date.now() / 1000);
const relay = vi.hoisted(() => ({ events: [] as NostrEvent[], offline: false, filters: [] as any[] }));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_urls: unknown, filter: any) {
      relay.filters.push(filter);
      return relay.offline ? throwError(() => new Error("offline")) :
        of(...relay.events.filter(e => filter.kinds.includes(e.kind)));
    }
  },
}));
const event = (mappings: unknown, sk = author, created_at = now(), d = "model-id-mappings") =>
  finalizeEvent({
    kind: 38426, created_at, tags: [["d", d]],
    content: JSON.stringify({ mappings }),
  }, sk);
const model = (id: string, completion = 1): Model => ({
  id, name: id, sats_pricing: { prompt: 1, completion },
} as Model);
const quiet = { log() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

async function open(driver = createMemoryDriver(), saved?: NostrEvent[]) {
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);
  const eventStore = new EventStore();
  for (const row of saved ?? []) eventStore.add(row);
  const manager = new ModelManager(adapter, {
    eventStore, routstrModelsPubkey: pubkey, logger: quiet,
  });
  return { driver, adapter, eventStore, manager };
}

// Wait for the fire-and-forget writes from either adapter before rehydrating.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("kind 38426 model ID mappings", () => {
  afterEach(() => {
    relay.events = [];
    relay.filters = [];
    relay.offline = false;
  });

  it("fetches only the configured author and d-tag, replacing the bootstrap fallback", async () => {
    relay.events = [event({ variant: "canonical" }), event({ ignored: "wrong" }, other),
      event({ ignored: "tag" }, author, now(), "different")];
    const { manager, adapter } = await open();
    expect(await manager.fetchModelIdMappings()).toEqual({ variant: "canonical" });
    expect(adapter.getModelIdMappings?.()).toEqual({ variant: "canonical" });
    expect(relay.filters[0]).toMatchObject({ kinds: [38426], "#d": ["model-id-mappings"], authors: [pubkey] });
    expect(canonicalIdForModel(model("z-ai-glm-5-3"), manager.getModelIdMappings())).toBe("z-ai-glm-5-3");
  });

  it("rejects forged and future-dated events without replacing the last good snapshot", async () => {
    const good = event({ variant: "canonical" }, author, now() - 20);
    const forged = { ...event({ variant: "evil" }, other, now() - 10), pubkey, sig: "00".repeat(64) };
    delete (forged as Record<PropertyKey, unknown>)[verifiedSymbol];
    relay.events = [good, forged, event({ variant: "future" }, author, now() + 86400)];
    const { manager } = await open();
    expect(await manager.fetchModelIdMappings(true)).toEqual({ variant: "canonical" });
  });

  it("does not partially apply invalid snapshots, and accepts an empty snapshot", async () => {
    const { manager, adapter } = await open();
    relay.events = [event({ variant: "canonical" }, author, now() - 3)];
    await manager.fetchModelIdMappings(true);
    const accepted = adapter.getModelIdMappingsEvent();
    for (const invalid of [[], { variant: 123 }, { a: "b", b: "c" },
      { a: "a" }, JSON.parse('{"__proto__":"evil"}'), null]) {
      relay.events = [event(invalid, author, now() + 1)];
      expect(await manager.fetchModelIdMappings(true)).toEqual({ variant: "canonical" });
      expect(adapter.getModelIdMappingsEvent()?.id).toBe(accepted?.id);
    }
    relay.events = [event({}, author, now() + 2)];
    expect(await manager.fetchModelIdMappings(true)).toEqual({});
    expect(adapter.getModelIdMappings?.()).toEqual({});
  });

  it("uses fallback offline on a fresh install and retains cached mappings offline", async () => {
    const { manager, driver, eventStore } = await open();
    relay.offline = true;
    expect(await manager.fetchModelIdMappings()).toEqual(MODEL_ID_MAPPINGS);
    relay.offline = false;
    relay.events = [event({ variant: "canonical" })];
    await manager.fetchModelIdMappings(true);
    await flush();
    relay.offline = true;
    const restarted = await open(driver, eventStore.getTimeline({ kinds: [38426] }));
    expect(restarted.manager.getModelIdMappings()).toEqual({ variant: "canonical" });
    expect(await restarted.manager.fetchModelIdMappings()).toEqual({ variant: "canonical" });
    expect(relay.filters).toHaveLength(2);
  });

  it("persists the snapshot in the sharded adapter as well", async () => {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    adapter.setModelIdMappings?.({ variant: "canonical" });
    adapter.setModelIdMappingsLastUpdate?.(123);
    await flush();
    const reloaded = await createShardedDiscoveryAdapter({ driver });
    expect(reloaded.getModelIdMappings?.()).toEqual({ variant: "canonical" });
    expect(reloaded.getModelIdMappingsLastUpdate?.()).toBe(123);
  });

  it("refreshes from Nostr and routes via native IDs without shared global mappings", async () => {
    const first = await open();
    const second = await open();
    first.adapter.setCachedModels({ "https://one.example/": [model("variant", 2)] });
    second.adapter.setCachedModels({ "https://two.example/": [model("variant", 2)] });
    relay.events = [event({ variant: "canonical" })];
    await first.manager.refreshNostrEvents();
    expect(new ProviderManager(first.adapter).getProviderPriceRankingForModel("canonical")[0].model.id).toBe("variant");
    expect(new ProviderManager(second.adapter).getProviderPriceRankingForModel("canonical")).toEqual([]);
    relay.events = [event({}, author, now() + 1)];
    await first.manager.refreshNostrEvents();
    expect(new ProviderManager(first.adapter).getProviderPriceRankingForModel("canonical")).toEqual([]);
  });
});

describe("mapping snapshot provenance and persistence", () => {
  afterEach(() => {
    relay.events = [];
    relay.filters = [];
    relay.offline = false;
  });

  it("rejects legacy adapters explicitly rather than silently ignoring mappings", async () => {
    const { adapter } = await open();
    delete (adapter as any).setModelIdMappings;
    expect(() => new ModelManager(adapter)).toThrow("DiscoveryAdapter must implement setModelIdMappings");
  });

  it("does not reuse a snapshot from a different configured author", async () => {
    const { adapter, manager } = await open();
    relay.events = [event({ variant: "first-author" })];
    await manager.fetchModelIdMappings(true);
    relay.filters = [];
    const changed = new ModelManager(adapter, {
      routstrModelsPubkey: getPublicKey(other), logger: quiet,
    });
    expect(changed.getModelIdMappings()).toEqual(MODEL_ID_MAPPINGS);
    relay.events = [event({ variant: "second-author" }, other)];
    expect(await changed.fetchModelIdMappings()).toEqual({ variant: "second-author" });
    expect(relay.filters[0].authors).toEqual([getPublicKey(other)]);
  });

  for (const sharded of [false, true]) {
    it(`prevents rollback after restart without a persistent event database (${sharded ? "sharded" : "store"})`, async () => {
      const driver = createMemoryDriver();
      const createAdapter = async () => {
        if (sharded) return createShardedDiscoveryAdapter({ driver });
        const { store, hydrate } = createSdkStore({ driver });
        await hydrate;
        return createDiscoveryAdapterFromStore(store);
      };
      const adapter = await createAdapter();
      const config = { routstrModelsPubkey: pubkey, logger: quiet };
      const manager = new ModelManager(adapter, config);
      const newest = event({ variant: "new-canonical" }, author, now() - 10);
      relay.events = [newest];
      await manager.fetchModelIdMappings(true);
      await flush();
      const reloaded = await createAdapter();
      const restarted = new ModelManager(reloaded, config);
      expect(reloaded.getModelIdMappingsEvent()?.id).toBe(newest.id);
      relay.events = [event({ variant: "old-canonical" }, author, now() - 1000)];
      expect(await restarted.fetchModelIdMappings(true)).toEqual({ variant: "new-canonical" });
      expect(reloaded.getModelIdMappingsEvent()?.id).toBe(newest.id);
    });
  }

  it("ignores malformed newer events before they replace valid stored evidence", async () => {
    const { manager, eventStore, driver } = await open();
    const good = event({ variant: "canonical" }, author, now() - 10);
    relay.events = [good, event({ a: "b", b: "c" })];
    expect(await manager.fetchModelIdMappings(true)).toEqual({ variant: "canonical" });
    await manager.pruneSupersededDiscoveryEvents();
    expect(eventStore.getTimeline({ kinds: [38426] }).map(e => e.id)).toEqual([good.id]);
    await flush();
    const restarted = await open(driver);
    relay.offline = true;
    expect(await restarted.manager.fetchModelIdMappings(true)).toEqual({ variant: "canonical" });
  });
});
