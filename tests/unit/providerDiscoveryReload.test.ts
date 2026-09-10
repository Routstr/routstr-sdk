import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { finalizeEvent, getPublicKey } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { of, throwError } from "rxjs";
import { ModelManager } from "../../discovery/ModelManager";
import { ProviderManager } from "../../client/ProviderManager";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import {
  createMemoryDriver,
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createStorageAdapterFromStore,
} from "../../storage";

const relay = vi.hoisted(() => ({
  events: [] as NostrEvent[],
  offline: false,
  requests: [] as number[],
}));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_urls: string[], filter: { kinds: number[] }) {
      relay.requests.push(filter.kinds[0]);
      return relay.offline
        ? throwError(() => new Error("offline"))
        : of(...relay.events.filter((e) => filter.kinds.includes(e.kind)));
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
const announcement = (url = base, sk = provider) =>
  finalizeEvent(
    {
      kind: 38421,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", url]],
      content: "",
    },
    sk,
  );
const review = (label: string, secondsAgo = 0, sk = provider) =>
  finalizeEvent(
    {
      kind: 38425,
      created_at: Math.floor(Date.now() / 1000) - secondsAgo,
      tags: [
        ["d", getPublicKey(sk)],
        ["node", getPublicKey(sk)],
        ["t", label],
      ],
      content: "",
    },
    reviewer,
  );

async function scenario(persistEvents = true) {
  const driver = createMemoryDriver();
  let savedEvents: NostrEvent[] = [];
  async function open() {
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    const adapter = createDiscoveryAdapterFromStore(store);
    const eventStore = new EventStore();
    for (const event of savedEvents) eventStore.add(event);
    const manager = new ModelManager(adapter, {
      ...(persistEvents ? { eventStore } : {}),
      routstrPubkey: getPublicKey(reviewer),
      logger: quiet,
    });
    const providers = new ProviderManager(adapter, store, quiet);
    return {
      adapter,
      manager,
      providers,
      store,
      eventStore,
      save: () => {
        savedEvents = JSON.parse(
          JSON.stringify(
            eventStore.getTimeline({ kinds: [38421, 38425, 38423] }),
          ),
        );
      },
    };
  }
  return {
    open,
    forgetAnnouncements: () => {
      savedEvents = savedEvents.filter((e) => e.kind !== 38421);
    },
  };
}

describe("provider discovery across reloads", () => {
  afterEach(() => {
    relay.events = [];
    relay.offline = false;
    relay.requests = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restores evidence and eligible model routes without relays on a warm reload", async () => {
    relay.events = [announcement(), review("lgtm")];
    const s = await scenario();
    const first = await s.open();
    await first.manager.bootstrapProviders();
    first.adapter.setCachedModels({
      [base]: [
        {
          id: "model",
          name: "model",
          sats_pricing: { prompt: 1, completion: 1 },
        } as any,
      ],
    });
    expect(first.providers.getBestProviderForModel("model")).toBe(base);
    first.save();
    relay.offline = true;
    relay.requests = [];
    const reloaded = await s.open();
    await reloaded.manager.bootstrapProviders();
    expect(reloaded.providers.getBestProviderForModel("model")).toBe(base);
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
    expect(relay.requests).not.toContain(38421);
    expect(relay.requests).not.toContain(38425);
    const storage = createStorageAdapterFromStore(reloaded.store);
    for (const forcedProvider of [undefined, base]) {
      const route = await resolveRequestContext({
        modelId: "model",
        forcedProvider,
        modelManager: reloaded.manager,
        providerManager: reloaded.providers,
        discoveryAdapter: reloaded.adapter,
        storageAdapter: storage,
        sdkStore: reloaded.store,
        logger: quiet,
        walletAdapter: {
          getBalances: async () => ({}),
          getMintUnits: () => ({}),
          getActiveMintUrl: () => "https://mint.example",
          sendToken: async () => {
            throw new Error("must not spend");
          },
          receiveToken: async () => {
            throw new Error("must not receive");
          },
        },
      });
      expect(route.baseUrl).toBe(base);
      expect(route.selectedModel.id).toBe("model");
    }
  });

  it("repairs a legacy warm cache with 35 incorrectly disabled providers", async () => {
    const entries = Array.from({ length: 35 }, (_, i) => ({
      url: `https://provider-${i}.example/`,
      sk: key(i + 2),
    }));
    relay.events = entries.flatMap(({ url, sk }) => [
      announcement(url, sk), review("lgtm", 0, sk),
    ]);
    const { open } = await scenario();
    const s = await open();
    const urls = entries.map(({ url }) => url);
    s.adapter.setBaseUrlsList(urls);
    s.adapter.setBaseUrlsLastUpdate(Date.now());
    s.adapter.setDisabledProviders!(urls);
    await s.manager.bootstrapProviders();
    expect(relay.requests).toContain(38421);
    expect(s.adapter.getDisabledProviders()).toEqual([]);
  });

  it("fetches missing identities even when reviews were persisted", async () => {
    relay.events = [announcement(), review("lgtm")];
    const s = await scenario();
    const first = await s.open();
    await first.manager.bootstrapProviders();
    first.save();
    s.forgetAnnouncements();
    const reloaded = await s.open();
    reloaded.adapter.setDisabledProviders!([base]);
    await reloaded.manager.bootstrapProviders();
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
  });

  it("refreshes reviews after the TTL and applies a newer rejection", async () => {
    vi.useFakeTimers();
    relay.events = [announcement(), review("lgtm", 10)];
    const { open } = await scenario();
    const first = await open();
    await first.manager.bootstrapProviders();
    first.save();
    vi.setSystemTime(Date.now() + 22 * 60 * 1000);
    relay.events = [announcement(), review("avoid")];
    const reloaded = await open();
    await reloaded.manager.bootstrapProviders();
    expect(reloaded.adapter.getDisabledProviders()).toContain(base);
    expect(relay.requests.filter((k) => k === 38425)).toHaveLength(2);
  });

  it("recovers a missing node from a partial persistent announcement cache", async () => {
    const other = "https://other.example/";
    const providerEvent = announcement();
    relay.events = [
      providerEvent,
      announcement(other, key(3)),
      review("lgtm"),
      review("lgtm", 0, key(3)),
    ];
    const { open } = await scenario();
    const first = await open();
    await first.manager.bootstrapProviders();
    first.eventStore.remove(providerEvent.id);
    first.save();
    const reloaded = await open();
    reloaded.adapter.setDisabledProviders!([base]);
    relay.requests = [];
    await reloaded.manager.bootstrapProviders();
    expect(relay.requests).toContain(38421);
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
  });

  it("rebuilds an existing map when live refresh changes a URL's node identity", async () => {
    relay.events = [announcement(), review("lgtm", 10)];
    const { open } = await scenario();
    const s = await open();
    await s.manager.bootstrapProviders();
    relay.events = [announcement(base, key(3)), review("avoid", 0, key(3))];
    await s.manager.refreshNostrEvents();
    expect(s.adapter.getDisabledProviders()).toContain(base);
  });

  it("preserves saved evidence and manual choices during a failed forced refresh", async () => {
    const unknown = "https://unknown.example/";
    relay.events = [
      announcement(),
      announcement(unknown, key(3)),
      review("lgtm"),
    ];
    const { open } = await scenario();
    const s = await open();
    await s.manager.bootstrapProviders();
    s.adapter.setManuallyDisabledProviders!([base]);
    relay.offline = true;
    await s.manager.bootstrapProviders(false, true);
    expect(s.adapter.getDisabledProviders().sort()).toEqual(
      [base, unknown].sort(),
    );
    s.adapter.setManuallyDisabledProviders!([]);
    expect(s.adapter.getDisabledProviders()).toEqual([unknown]);
  });

  it.each(["relay error", "empty response"])("keeps saved approvals through an outage and retries after %s", async (failure) => {
    vi.useFakeTimers();
    const providerEvent = announcement();
    const positive = review("lgtm");
    relay.events = [providerEvent, positive];
    const { open } = await scenario();
    const s = await open();
    await s.manager.bootstrapProviders();
    vi.setSystemTime(Date.now() + 22 * 60 * 1000);
    relay.offline = failure === "relay error";
    relay.events = [];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await s.manager.bootstrapProviders();
    expect(s.adapter.getDisabledProviders()).toEqual([]);
    relay.offline = false;
    relay.events = [providerEvent, review("avoid")];
    await s.manager.bootstrapProviders();
    expect(s.adapter.getDisabledProviders()).toContain(base);
  });

  it("does not repeatedly query when relays stop returning one saved announcement", async () => {
    vi.useFakeTimers();
    const other = "https://other.example/";
    const otherEvent = announcement(other, key(3));
    const reviews = [review("lgtm"), review("lgtm", 0, key(3))];
    relay.events = [announcement(), otherEvent, ...reviews];
    const { open } = await scenario();
    const first = await open();
    await first.manager.bootstrapProviders();
    vi.setSystemTime(Date.now() + 22 * 60 * 1000);
    relay.events = [otherEvent, ...reviews];
    await first.manager.bootstrapProviders();
    first.save();

    relay.requests = [];
    const reloaded = await open();
    expect(await reloaded.manager.bootstrapProviders()).toContain(base);
    await reloaded.manager.bootstrapProviders();
    expect(relay.requests).not.toContain(38421);
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
  });

  it("keeps approvals received in different refreshes without repeated review queries", async () => {
    vi.useFakeTimers();
    const other = "https://other.example/";
    const announcements = [announcement(), announcement(other, key(3))];
    relay.events = [...announcements, review("lgtm")];
    const { open } = await scenario();
    const first = await open();
    await first.manager.bootstrapProviders();
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);
    relay.events = [...announcements, review("lgtm", 0, key(3))];
    await first.manager.bootstrapProviders(false, true);
    first.save();
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);

    relay.requests = [];
    const reloaded = await open();
    await reloaded.manager.bootstrapProviders();
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
    expect(relay.requests).not.toContain(38425);
  });

  it("does not persist new disables when discovery and its HTTP fallback both fail", async () => {
    const { open } = await scenario();
    const s = await open();
    s.adapter.setBaseUrlsList([base]);
    s.adapter.setBaseUrlsLastUpdate(Date.now() - 22 * 60 * 1000);
    relay.offline = true;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(s.manager.bootstrapProviders()).rejects.toThrow();
    expect(s.adapter.getDisabledProviders()).toEqual([]);
  });

  it("refetches missing events after a browser reload without an injected event store", async () => {
    relay.events = [announcement(), review("lgtm")];
    const { open } = await scenario(false);
    const first = await open();
    await first.manager.bootstrapProviders();
    first.adapter.setRoutstr21Models(["model"]);
    first.adapter.setRoutstr21ModelsLastUpdate(Date.now());
    first.save();

    relay.requests = [];
    const reloaded = await open();
    await reloaded.manager.bootstrapProviders();
    expect(relay.requests.sort()).toEqual([38421, 38425]);
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
  });

  it("keeps query times in memory for adapters without the optional cache methods", async () => {
    relay.events = [announcement(), review("lgtm")];
    const { open } = await scenario(false);
    const s = await open();
    delete s.adapter.getNostrQueryLastUpdate;
    delete s.adapter.setNostrQueryLastUpdate;
    await s.manager.bootstrapProviders();

    relay.requests = [];
    await s.manager.bootstrapProviders();
    expect(relay.requests).not.toContain(38421);
    expect(relay.requests).not.toContain(38425);
    expect(s.adapter.getDisabledProviders()).toEqual([]);
  });

  it("does not replace a saved rejection with an older positive relay response", async () => {
    const positive = review("lgtm", 20);
    relay.events = [announcement(), positive, review("avoid", 10)];
    const { open } = await scenario();
    const first = await open();
    await first.manager.bootstrapProviders();
    first.save();
    relay.events = [announcement(), positive];
    const reloaded = await open();
    await reloaded.manager.bootstrapProviders(false, true);
    expect(reloaded.adapter.getDisabledProviders()).toContain(base);
  });

  it("restores both clearnet and onion identities from directory-style announcements", async () => {
    const onion = "http://provider.onion/";
    relay.events = [
      finalizeEvent(
        {
          kind: 38421,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({
            providers: [{ endpoint_url: base, onion_url: onion }],
          }),
        },
        provider,
      ),
      review("lgtm"),
    ];
    const { open } = await scenario();
    const first = await open();
    expect(await first.manager.bootstrapProviders(true)).toEqual([onion]);
    expect(first.adapter.getDisabledProviders()).toEqual([]);
    first.save();
    relay.offline = true;
    const reloaded = await open();
    expect(await reloaded.manager.bootstrapProviders(true)).toEqual([onion]);
    expect(reloaded.adapter.getDisabledProviders()).toEqual([]);
  });
});
