import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { finalizeEvent, getPublicKey, verifiedSymbol } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { of, throwError } from "rxjs";
import { MODEL_PATH_BOOTSTRAP } from "../../core/modelPathWhitelist";
import { ModelManager } from "../../discovery/ModelManager";
import {
  createMemoryDriver,
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createShardedDiscoveryAdapter,
} from "../../storage";

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
const event = (models: unknown, sk = author, created_at = now(), d = "model-path-whitelist") =>
  finalizeEvent({
    kind: 38427, created_at, tags: [["d", d]],
    content: JSON.stringify({ version: 1, models }),
  }, sk);
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


const policy = (url = "https://upstream.example/v1") => ({ routes: [{ url }] });
const snapshot = { test: policy() };

describe("kind 38427 model path policy", () => {
  afterEach(() => { relay.events = []; relay.filters = []; relay.offline = false; vi.restoreAllMocks(); });

  it("queries mappings before the exact whitelist filter and preserves bootstrap offline", async () => {
    const { manager } = await open();
    relay.offline = true;
    expect(await manager.fetchModelPathWhitelist()).toEqual(MODEL_PATH_BOOTSTRAP);
    relay.offline = false;
    relay.filters = [];
    relay.events = [event(snapshot)];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(snapshot);
    expect(relay.filters.map(f => f.kinds[0])).toEqual([38426, 38427]);
    expect(relay.filters[1]).toMatchObject({ kinds: [38427], authors: [pubkey], "#d": ["model-path-whitelist"] });
  });

  it("rejects wrong authors, tags, forged signatures and future events", async () => {
    const { manager, adapter } = await open();
    const good = event(snapshot, author, now() - 20);
    relay.events = [good];
    await manager.fetchModelPathWhitelist(true);
    const forged = { ...event({ evil: policy() }, other), pubkey, sig: "00".repeat(64) };
    delete (forged as Record<PropertyKey, unknown>)[verifiedSymbol];
    relay.events = [forged, event({ evil: policy() }, other),
      event({ evil: policy() }, author, now(), "wrong"), event({ evil: policy() }, author, now() + 86400)];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(snapshot);
    expect(adapter.getModelPathWhitelistEvent()?.id).toBe(good.id);
  });

  for (const sharded of [false, true]) {
    it(`persists empty kill switch and signed high-water mark (${sharded})`, async () => {
      const driver = createMemoryDriver();
      const create = async () => {
        if (sharded) return createShardedDiscoveryAdapter({ driver });
        const { store, hydrate } = createSdkStore({ driver }); await hydrate;
        return createDiscoveryAdapterFromStore(store);
      };
      const adapter = await create();
      const config = { routstrModelsPubkey: pubkey, logger: quiet };
      const manager = new ModelManager(adapter, config);
      const kill = event({}, author, now() - 5);
      relay.events = [kill]; await manager.fetchModelPathWhitelist(true); await flush();
      const reloaded = await create(); const restarted = new ModelManager(reloaded, config);
      expect(restarted.getModelPathWhitelist()).toEqual({});
      expect(reloaded.getModelPathWhitelistLastUpdate?.()).toBeTypeOf("number");
      relay.events = [event(snapshot, author, now() - 30)];
      expect(await restarted.fetchModelPathWhitelist(true)).toEqual({});
      expect(reloaded.getModelPathWhitelistEvent()?.id).toBe(kill.id);
    });
  }

  it("chooses lowest id at equal timestamps, independent of arrival order", async () => {
    const { manager, adapter } = await open();
    const rows = [event(snapshot), event({ second: policy() })].sort((a,b) => a.id.localeCompare(b.id));
    relay.events = [...rows].reverse(); await manager.fetchModelPathWhitelist(true);
    expect(adapter.getModelPathWhitelistEvent()?.id).toBe(rows[0].id);
    relay.events = rows; await manager.fetchModelPathWhitelist(true);
    expect(adapter.getModelPathWhitelistEvent()?.id).toBe(rows[0].id);
    await manager.pruneSupersededDiscoveryEvents();
    expect(manager.getModelPathWhitelist()).toEqual(JSON.parse(rows[0].content).models);
  });

  it("retains last-good projection across mapping collisions, TTL and restart without rollback", async () => {
    const { manager, adapter, driver } = await open();
    adapter.setModelIdMappings({});
    adapter.setModelIdMappingsLastUpdate?.(Date.now());
    const accepted = event({ a: policy(), b: policy("https://other.example") }, author, now() - 5);
    relay.events = [accepted]; await manager.fetchModelPathWhitelist();
    const good = adapter.getModelPathWhitelist();
    adapter.setModelIdMappings({ a: "b" });
    relay.events = [event({ older: policy() }, author, now() - 100)];
    expect(await manager.fetchModelPathWhitelist()).toEqual(good);
    expect(adapter.getModelPathWhitelistEvent()?.id).toBe(accepted.id);
    // Persist changed mappings as signed evidence, so constructor restores them first.
    const mapping = finalizeEvent({ kind: 38426, created_at: now(), tags: [["d", "model-id-mappings"]],
      content: JSON.stringify({ mappings: { a: "b" } }) }, author);
    adapter.setModelIdMappingsEvent(mapping); await flush();
    const restarted = await open(driver);
    expect(restarted.manager.getModelPathWhitelist()).toEqual(good);
    expect(await restarted.manager.fetchModelPathWhitelist(true)).toEqual(good);
    expect(restarted.adapter.getModelPathWhitelistEvent()?.id).toBe(accepted.id);
  });

  it("does not query whitelist until the mappings dependency finishes and uses its snapshot", async () => {
    const { manager, adapter } = await open();
    let release!: (mappings: Record<string, string>) => void;
    vi.spyOn(manager, "fetchModelIdMappings").mockImplementation(() =>
      new Promise(resolve => { release = resolve; }));
    const fetch = manager.fetchModelPathWhitelist(true);
    await Promise.resolve();
    expect(relay.filters).toEqual([]);
    relay.events = [event({ a: policy(), b: policy() })];
    // Adapter differs deliberately: validation must use the returned dependency.
    adapter.setModelIdMappings({});
    release({ a: "b" });
    expect(await fetch).toEqual(MODEL_PATH_BOOTSTRAP);
    expect(adapter.getModelPathWhitelistEvent()).toBeNull();
  });

  it("mapping failures use last-good mappings and malformed newer policies never replace evidence", async () => {
    const { manager, adapter } = await open();
    vi.spyOn(manager, "fetchModelIdMappings").mockRejectedValue(new Error("mapping offline"));
    adapter.setModelIdMappings({ alias: "test" });
    const good = event(snapshot, author, now() - 5);
    relay.events = [good]; await manager.fetchModelPathWhitelist(true);
    for (const models of [null, [], { test: { routes: [] } },
      { test: policy(), alias: policy() }, JSON.parse('{"__proto__":{}}')]) {
      relay.events = [event(models)];
      expect(await manager.fetchModelPathWhitelist(true)).toEqual(snapshot);
      expect(adapter.getModelPathWhitelistEvent()?.id).toBe(good.id);
    }
  });

  it("purges wrong-author projections and requires adapter support", async () => {
    const { manager, adapter } = await open(); relay.events = [event(snapshot)];
    await manager.fetchModelPathWhitelist(true);
    const changed = new ModelManager(adapter, { routstrModelsPubkey: getPublicKey(other), logger: quiet });
    expect(changed.getModelPathWhitelist()).toEqual(MODEL_PATH_BOOTSTRAP);
    expect(adapter.getModelPathWhitelistEvent()).toBeNull();
    delete (adapter as any).setModelPathWhitelist;
    expect(() => new ModelManager(adapter)).toThrow("DiscoveryAdapter must implement setModelPathWhitelist");
  });
});
