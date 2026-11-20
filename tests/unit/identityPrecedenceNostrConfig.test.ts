import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { finalizeEvent, getPublicKey } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { of } from "rxjs";
import { ModelManager } from "../../discovery/ModelManager";
import {
  createDiscoveryAdapterFromStore,
  createMemoryDriver,
  createSdkStore,
} from "../../storage";

/**
 * Identity precedence: an operator's own signed config events must outrank the
 * configured discovery author's, without becoming a way for an unknown author
 * to inject policy.
 */

const secret = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? n : 0);
const external = secret(1);
const identity = secret(2);
const stranger = secret(3);
const externalPubkey = getPublicKey(external);
const identityPubkey = getPublicKey(identity);
const now = () => Math.floor(Date.now() / 1000);

const relay = vi.hoisted(() => ({
  events: [] as NostrEvent[],
  filters: [] as any[],
  published: [] as NostrEvent[],
}));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_urls: unknown, filter: any) {
      relay.filters.push(filter);
      return of(...relay.events.filter(e => filter.kinds.includes(e.kind)));
    }
    publish(_urls: unknown, event: NostrEvent) {
      relay.published.push(event);
      return Promise.resolve();
    }
  },
}));

const quiet = { log() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

const policy = (url: string) => ({ routes: [{ url }] });
const whitelistEvent = (models: unknown, sk = external, created_at = now()) =>
  finalizeEvent({
    kind: 38427,
    created_at,
    tags: [["d", "model-path-whitelist"]],
    content: JSON.stringify({ version: 1, models }),
  }, sk);

async function open(options: {
  identityPubkey?: string;
  saved?: NostrEvent[];
  driver?: ReturnType<typeof createMemoryDriver>;
  identitySigner?: (template: { kind: number; created_at: number; tags: string[][]; content: string }) => NostrEvent;
} = {}) {
  const driver = options.driver ?? createMemoryDriver();
  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);
  const eventStore = new EventStore();
  for (const row of options.saved ?? []) eventStore.add(row);
  const manager = new ModelManager(adapter, {
    eventStore,
    routstrModelsPubkey: externalPubkey,
    identityPubkey: options.identityPubkey,
    identitySigner: options.identitySigner,
    logger: quiet,
  });
  return { adapter, driver, eventStore, manager };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Mirrors how routstrd wires the signer: finalizeEvent over the operator's key. */
const signer = (sk: Uint8Array) => (template: {
  kind: number; created_at: number; tags: string[][]; content: string;
}) => finalizeEvent(template as any, sk);

const externalPolicy = { "model-a": policy("https://external.example/v1") };
const identityPolicy = { "model-a": policy("https://mine.example/v1") };

describe("identity-preferred Nostr config", () => {
  beforeEach(() => { relay.events = []; relay.filters = []; relay.published = []; });
  afterEach(() => { relay.events = []; relay.filters = []; relay.published = []; vi.restoreAllMocks(); });

  it("prefers the configured identity over the external author", async () => {
    const { manager } = await open({ identityPubkey });
    relay.events = [
      whitelistEvent(externalPolicy, external, now() - 10),
      whitelistEvent(identityPolicy, identity, now() - 20),
    ];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(identityPolicy);
  });

  it("does not let an external publication newer than ours win", async () => {
    // The whole point of configuring an identity: our explicit choice is not
    // undone by the advertiser publishing afterwards.
    const { manager } = await open({ identityPubkey });
    relay.events = [
      whitelistEvent(identityPolicy, identity, now() - 100),
      whitelistEvent(externalPolicy, external, now() - 5),
    ];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(identityPolicy);
  });

  it("still reads the external author when no identity event exists", async () => {
    const { manager } = await open({ identityPubkey });
    relay.events = [whitelistEvent(externalPolicy, external, now() - 10)];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(externalPolicy);
  });

  it("rejects an unknown author even when newer", async () => {
    const { manager } = await open({ identityPubkey });
    relay.events = [
      whitelistEvent(externalPolicy, external, now() - 10),
      whitelistEvent({ "model-a": policy("https://evil.example/v1") }, stranger, now()),
    ];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(externalPolicy);
  });

  it("ignores identity events entirely when no identity is configured", async () => {
    const { manager } = await open();
    relay.events = [
      whitelistEvent(identityPolicy, identity, now()),
      whitelistEvent(externalPolicy, external, now() - 10),
    ];
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(externalPolicy);
  });

  it("never asks relays for the identity's author", async () => {
    // A local preference must not depend on relay availability, and asking for
    // our own pubkey would publish the operator's routing preferences.
    const { manager } = await open({ identityPubkey });
    relay.events = [whitelistEvent(identityPolicy, identity, now())];
    await manager.fetchModelPathWhitelist(true);
    const whitelistFilters = relay.filters.filter(f => f.kinds.includes(38427));
    expect(whitelistFilters.length).toBeGreaterThan(0);
    for (const filter of whitelistFilters) {
      expect(filter.authors).toEqual([externalPubkey]);
    }
  });

  it("restores the identity policy on boot from the persisted signed event", async () => {
    const mine = whitelistEvent(identityPolicy, identity, now() - 30);
    const first = await open({ identityPubkey });
    first.adapter.setModelPathWhitelistEvent(mine);
    await flush();
    // A fresh adapter over the same driver is the restart: the constructor must
    // accept a saved event that the configured author did not sign.
    const restarted = await open({ identityPubkey, driver: first.driver });
    expect(restarted.adapter.getModelPathWhitelist()).toEqual(identityPolicy);
  });

  it("keeps the identity policy across a restart whose relays only serve the external author", async () => {
    const mine = whitelistEvent(identityPolicy, identity, now() - 30);
    const first = await open({ identityPubkey });
    first.adapter.setModelPathWhitelistEvent(mine);
    await flush();
    const restarted = await open({ identityPubkey, driver: first.driver });
    relay.events = [whitelistEvent(externalPolicy, external, now() - 1)];
    expect(await restarted.manager.fetchModelPathWhitelist(true)).toEqual(identityPolicy);
  });
});

describe("writing the local policy through the identity", () => {
  beforeEach(() => { relay.events = []; relay.filters = []; });
  afterEach(() => { relay.events = []; relay.filters = []; vi.restoreAllMocks(); });

  it("stores a signed local document that wins over the external author", async () => {
    const { manager } = await open({ identityPubkey, identitySigner: signer(identity) });
    relay.events = [whitelistEvent(externalPolicy, external, now())];
    const applied = await manager.setModelPathWhitelistFromIdentity(identityPolicy);
    expect(applied).toEqual(identityPolicy);
    // ...and it survives a fetch that re-reads the external author's newer event.
    expect(await manager.fetchModelPathWhitelist(true)).toEqual(identityPolicy);
  });

  it("clears the local document so the external author applies again", async () => {
    const { manager } = await open({ identityPubkey, identitySigner: signer(identity) });
    relay.events = [whitelistEvent(externalPolicy, external, now())];
    await manager.setModelPathWhitelistFromIdentity(identityPolicy);
    expect(await manager.setModelPathWhitelistFromIdentity({})).toEqual(externalPolicy);
  });

  it("refuses to write when no signer is configured", async () => {
    const { manager } = await open({ identityPubkey });
    await expect(manager.setModelPathWhitelistFromIdentity(identityPolicy))
      .rejects.toThrow(/identityPubkey and identitySigner/);
  });

  it("refuses a signer that returns an event signed by someone else", async () => {
    // Otherwise the store would reject the event on read and the override would
    // look like it was applied but never take effect.
    const { manager } = await open({
      identityPubkey,
      identitySigner: signer(external),
    });
    await expect(manager.setModelPathWhitelistFromIdentity(identityPolicy))
      .rejects.toThrow(/signed by identityPubkey/);
  });

  it("rejects an invalid document before it reaches the store", async () => {
    const { manager } = await open({ identityPubkey, identitySigner: signer(identity) });
    await expect(manager.setModelPathWhitelistFromIdentity({
      "model-a": { routes: [] },
    } as any)).rejects.toThrow(/invalid routes/);
  });

  it("does not broadcast when only writing locally", async () => {
    const { manager } = await open({ identityPubkey, identitySigner: signer(identity) });
    await manager.setModelPathWhitelistFromIdentity(identityPolicy);
    // Writing is a local preference; publishing it is a separate decision.
    expect(relay.published).toEqual([]);
  });

  it("broadcasts only when publishing is requested explicitly", async () => {
    const { manager } = await open({ identityPubkey, identitySigner: signer(identity) });
    await manager.setModelPathWhitelistFromIdentity(identityPolicy);
    await manager.publishModelPathWhitelist();
    expect(relay.published).toHaveLength(1);
    expect(relay.published[0]?.pubkey).toBe(identityPubkey);
  });
});

describe("kind 38423 curated models", () => {
  beforeEach(() => { relay.events = []; relay.filters = []; relay.published = []; });
  afterEach(() => { relay.events = []; relay.filters = []; relay.published = []; vi.restoreAllMocks(); });

  const modelsEvent = (models: string[], sk = external, created_at = now()) =>
    finalizeEvent({
      kind: 38423,
      created_at,
      tags: [["d", "routstr-21-models"]],
      content: JSON.stringify({ models }),
    }, sk);

  /** Seed events straight into the store, the only way a local list can exist. */
  async function openWithStore(options: {
    identityPubkey?: string;
    routstrModelsPubkey?: string;
    stored?: NostrEvent[];
  } = {}) {
    const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
    await hydrate;
    const eventStore = new EventStore();
    for (const row of options.stored ?? []) eventStore.add(row);
    const manager = new ModelManager(createDiscoveryAdapterFromStore(store), {
      eventStore,
      routstrModelsPubkey: options.routstrModelsPubkey ?? externalPubkey,
      identityPubkey: options.identityPubkey,
      logger: quiet,
    });
    return manager;
  }

  it("keeps the advertised catalog when an identity is set but has no local list", async () => {
    // Regression: configuring identityPubkey alone returned [] because the
    // external tier was selected by rank, and rank 1 requires an absent local
    // event. No public API writes kind 38423, so this is not a transient state.
    relay.events = [modelsEvent(["ext-1", "ext-2"])];
    const manager = await openWithStore({ identityPubkey });
    expect(await manager.fetchRoutstr21Models(true)).toEqual(["ext-1", "ext-2"]);
  });

  it("leaves a default install unchanged", async () => {
    relay.events = [modelsEvent(["ext-1", "ext-2"])];
    const manager = await openWithStore();
    expect(await manager.fetchRoutstr21Models(true)).toEqual(["ext-1", "ext-2"]);
  });

  it("unions a local list ahead of the advertised catalog", async () => {
    relay.events = [modelsEvent(["ext-1", "ext-2"])];
    const manager = await openWithStore({
      identityPubkey,
      stored: [modelsEvent(["mine-1"], identity, now() - 100)],
    });
    expect(await manager.fetchRoutstr21Models(true)).toEqual(["mine-1", "ext-1", "ext-2"]);
  });

  it("does not lose the advertised tier when the identity is the advertiser", async () => {
    // Self-hosted advertiser: identityPubkey === routstrModelsPubkey. Ranking by
    // number collapsed both tiers into rank 0 and dropped the catalog.
    // The advertiser *is* the identity, so the event must be signed by it.
    relay.events = [modelsEvent(["ext-1"], identity)];
    const manager = await openWithStore({ identityPubkey, routstrModelsPubkey: identityPubkey });
    expect(await manager.fetchRoutstr21Models(true)).toEqual(["ext-1"]);
  });

  it("ignores a local list when no identity is configured", async () => {
    relay.events = [modelsEvent(["ext-1"])];
    const manager = await openWithStore({
      stored: [modelsEvent(["mine-1"], identity, now())],
    });
    expect(await manager.fetchRoutstr21Models(true)).toEqual(["ext-1"]);
  });

  it("keeps the advertised list when the local document is unparseable", async () => {
    relay.events = [modelsEvent(["ext-1"])];
    const manager = await openWithStore({
      identityPubkey,
      // Stored but invalid for the reader: it must not erase the other tier.
      stored: [finalizeEvent({
        kind: 38423,
        created_at: now() - 10,
        tags: [["d", "routstr-21-models"]],
        content: "{not json",
      }, identity)],
    });
    expect(await manager.fetchRoutstr21Models(true)).toEqual(["ext-1"]);
  });
});
