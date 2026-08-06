/**
 * Unit tests: Nostr event collection in ModelManager
 *
 * Queries must finish as soon as every relay has sent EOSE (the stream
 * completes) instead of always waiting out the full timeout, keep the
 * timeout as a backstop for relays that never finish, unsubscribe when
 * done, dedupe events repeated across relays, and report live bootstrap
 * progress via BootstrapOptions.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Observable, of, merge, NEVER } from "rxjs";
import type { NostrEvent } from "applesauce-core/helpers";
import { ModelManager } from "../../discovery/ModelManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, SdkLogger } from "../../core/types";

const PROVIDER_A_URL = "https://provider-a.example.com";
const PROVIDER_B_URL = "https://provider-b.example.com";
const NORMALIZED_A = `${PROVIDER_A_URL}/`;
const NORMALIZED_B = `${PROVIDER_B_URL}/`;

const { relayStream } = vi.hoisted(() => ({
  relayStream: {
    current: null as null | ((filter?: unknown) => unknown),
  },
}));

vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_relays: unknown, filter: unknown) {
      return relayStream.current!(filter);
    }
  },
}));

const silentLogger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

const makeProviderEvent = (
  id: string,
  pubkey: string,
  urls: string[]
): NostrEvent => ({
  id,
  pubkey,
  created_at: Math.floor(Date.now() / 1000),
  kind: 38421,
  tags: urls.map((url) => ["u", url]),
  content: "",
  sig: "mock-sig",
});

function makeAdapter(): DiscoveryAdapter {
  let cachedModels: Record<string, Model[]> = {};
  const lastUpdate = new Map<string, number>();
  let baseUrls: string[] = [];
  return {
    getCachedModels: () => cachedModels,
    setCachedModels: (models) => {
      cachedModels = models;
    },
    getCachedMints: () => ({}),
    setCachedMints: () => {},
    getCachedProviderInfo: () => ({}),
    setCachedProviderInfo: () => {},
    getProviderLastUpdate: (baseUrl) => lastUpdate.get(baseUrl) ?? null,
    setProviderLastUpdate: (baseUrl, timestamp) => {
      lastUpdate.set(baseUrl, timestamp);
    },
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    setDisabledProviders: () => {},
    getManuallyDisabledProviders: () => [],
    setManuallyDisabledProviders: () => {},
    getBaseUrlsList: () => baseUrls,
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: (urls) => {
      baseUrls = urls;
    },
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  };
}

describe("ModelManager Nostr collection", () => {
  afterEach(() => {
    vi.useRealTimers();
    relayStream.current = null;
  });

  it("resolves as soon as every relay finishes, without waiting out the timeout", async () => {
    // Fake timers: if the code still needed its 5s timer the await would hang.
    vi.useFakeTimers();
    relayStream.current = () =>
      of(makeProviderEvent("evt-a", "pk-a", [PROVIDER_A_URL]));

    const manager = new ModelManager(makeAdapter(), { logger: silentLogger });
    const bases = await manager.bootstrapProviders(false, true);
    expect(bases).toEqual([NORMALIZED_A]);
  });

  it("falls back to the timeout and unsubscribes when a relay never finishes", async () => {
    vi.useFakeTimers();
    let teardowns = 0;
    relayStream.current = () =>
      new Observable((subscriber) => {
        merge(
          of(makeProviderEvent("evt-a", "pk-a", [PROVIDER_A_URL])),
          NEVER
        ).subscribe(subscriber);
        return () => {
          teardowns += 1;
        };
      });

    const manager = new ModelManager(makeAdapter(), { logger: silentLogger });
    const promise = manager.bootstrapProviders(false, true);
    // All three queries run concurrently, so one timeout window covers them.
    await vi.advanceTimersByTimeAsync(5000);
    const bases = await promise;
    expect(bases).toEqual([NORMALIZED_A]);
    expect(teardowns).toBe(3);
  });

  it("does not announce onion providers the clearnet result drops", async () => {
    const mixed = makeProviderEvent("evt-mixed", "pk-a", [
      PROVIDER_A_URL,
      "http://provider.onion",
    ]);
    relayStream.current = () => of(mixed);

    const discovered: string[] = [];
    const manager = new ModelManager(makeAdapter(), { logger: silentLogger });
    const bases = await manager.bootstrapProviders(false, true, {
      onProvider: (baseUrl) => discovered.push(baseUrl),
    });

    expect(discovered).toEqual([NORMALIZED_A]);
    expect(bases).toEqual([NORMALIZED_A]);
  });

  it("does not announce clearnet content providers the Tor result drops", async () => {
    // A content-based event whose provider has no onion_url: Tor mode falls
    // back to the clearnet endpoint, which the final filter then drops.
    const contentEvent: NostrEvent = {
      id: "evt-content",
      pubkey: "pk-a",
      created_at: Math.floor(Date.now() / 1000),
      kind: 38421,
      tags: [],
      content: JSON.stringify([{ endpoint_url: PROVIDER_A_URL }]),
      sig: "mock-sig",
    };
    relayStream.current = () => of(contentEvent);

    const discovered: string[] = [];
    const manager = new ModelManager(makeAdapter(), { logger: silentLogger });
    const bases = await manager.bootstrapProviders(true, true, {
      onProvider: (baseUrl) => discovered.push(baseUrl),
    });

    expect(discovered).toEqual([]);
    expect(bases).toEqual([]);
  });

  it("skips the review query when the adapter cannot store its result", async () => {
    vi.useFakeTimers();
    relayStream.current = (filter) => {
      const kinds = (filter as { kinds?: number[] })?.kinds ?? [];
      // The review query hangs; everything else completes immediately.
      if (kinds.includes(38425)) return merge(of(), NEVER);
      return of(makeProviderEvent("evt-a", "pk-a", [PROVIDER_A_URL]));
    };

    const adapter = makeAdapter();
    delete (adapter as { setDisabledProviders?: unknown }).setDisabledProviders;
    const manager = new ModelManager(adapter, { logger: silentLogger });
    // Resolves without advancing timers only if the review query is skipped.
    const bases = await manager.bootstrapProviders(false, true);
    expect(bases).toEqual([NORMALIZED_A]);
  });

  it("reports live progress and dedupes events repeated across relays", async () => {
    const eventA = makeProviderEvent("evt-a", "pk-a", [PROVIDER_A_URL]);
    const eventB = makeProviderEvent("evt-b", "pk-b", [PROVIDER_B_URL]);
    // The same event arriving from two relays must count once.
    relayStream.current = () => of(eventA, eventA, eventB);

    const counts: number[] = [];
    const discovered: string[] = [];
    const manager = new ModelManager(makeAdapter(), { logger: silentLogger });
    const bases = await manager.bootstrapProviders(false, true, {
      onEventsFound: (count) => counts.push(count),
      onProvider: (baseUrl) => discovered.push(baseUrl),
    });

    expect(counts).toEqual([1, 2]);
    expect(discovered).toEqual([NORMALIZED_A, NORMALIZED_B]);
    expect(bases.sort()).toEqual([NORMALIZED_A, NORMALIZED_B]);
  });
});
