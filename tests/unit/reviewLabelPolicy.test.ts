/**
 * Tests for the two-tier review-label policy.
 *
 * Default-enabled labels (lgtm/lgtm2/trusted/verified) turn a node on out of
 * the box. Opt-in labels (e.g. `sandbox`) never enable a node by themselves —
 * they only do so once the user adds them — so a sandbox-labelled node stays
 * disabled by default. Negative labels always disable.
 *
 * Uses real signed events (finalizeEvent) so the trust gate actually runs.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { of } from "rxjs";
import { finalizeEvent, getPublicKey } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { ModelManager, DEFAULT_ENABLED_REVIEW_LABELS } from "../../discovery/ModelManager";
import {
  createMemoryDriver,
  createSdkStore,
  createDiscoveryAdapterFromStore,
  createShardedDiscoveryAdapter,
} from "../../storage";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { SdkLogger } from "../../core/types";

// ─── Deterministic keys ─────────────────────────────────────────────────────

const secretKey = (n: number): Uint8Array => {
  const key = new Uint8Array(32);
  key[31] = n;
  return key;
};

const ANCHOR_SK = secretKey(1);
const PROVIDER_SK = secretKey(2);
const SANDBOX_SK = secretKey(4);

const ANCHOR_PK = getPublicKey(ANCHOR_SK);
const PROVIDER_PK = getPublicKey(PROVIDER_SK);
const SANDBOX_PK = getPublicKey(SANDBOX_SK);

const PROVIDER_URL = "https://provider.example.com/";
const SANDBOX_URL = "https://sandbox.example.com/";

const nowUnix = () => Math.floor(Date.now() / 1000);

// ─── Relay mock (kind-aware) ────────────────────────────────────────────────

const { relayEvents } = vi.hoisted(() => ({
  relayEvents: { current: [] as NostrEvent[] },
}));

vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_relays: unknown, filter: { kinds?: number[] }) {
      const kinds = filter?.kinds;
      const events = kinds
        ? relayEvents.current.filter((e) => kinds.includes(e.kind))
        : relayEvents.current;
      return of(...events);
    }
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const silentLogger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

const makeReview = (
  label: string,
  nodePubkeys: string[],
  created_at: number = nowUnix(),
): NostrEvent =>
  finalizeEvent(
    {
      kind: 38425,
      created_at,
      // Kind 38425 is addressable; reviews are keyed by `d` (here the reviewed
      // node), so different nodes coexist and a re-review replaces its node's.
      tags: [
        ["t", label],
        ["d", nodePubkeys[0] ?? ""],
        ...nodePubkeys.map((pk) => ["node", pk]),
      ],
      content: "",
    },
    ANCHOR_SK,
  );

const makeProviderEvent = (
  urls: string[],
): NostrEvent =>
  finalizeEvent(
    {
      kind: 38421,
      created_at: nowUnix(),
      tags: urls.map((url) => ["u", url]),
      content: "",
    },
    PROVIDER_SK,
  );

const nodeMap = (entries: Array<[string, string]>) => {
  const map = new Map<string, Set<string>>();
  for (const [url, pk] of entries) map.set(url, new Set([pk]));
  return map;
};

const sync = (
  manager: ModelManager,
  urls: string[],
  nodes: Map<string, Set<string>>,
) => manager.syncReviewedProvidersFromNostr(urls, nodes, true);

// ─── Storage layer ──────────────────────────────────────────────────────────

describe("review-label policy — storage layer", () => {
  it("defaults to the built-in enabled labels and no user opt-ins", async () => {
    const driver = createMemoryDriver();
    const { store } = createSdkStore({ driver });
    const adapter = createDiscoveryAdapterFromStore(store);
    const manager = new ModelManager(adapter, { logger: silentLogger });

    expect(manager.getEnabledReviewLabels()).toEqual(
      [...DEFAULT_ENABLED_REVIEW_LABELS],
    );
    expect(manager.getUserEnabledReviewLabels()).toEqual([]);
    expect(manager.getEnabledReviewLabels()).toContain("lgtm2");
    expect(manager.getEnabledReviewLabels()).not.toContain("sandbox");
  });

  it("adds, normalises and de-duplicates user-enabled labels", async () => {
    const driver = createMemoryDriver();
    const { store } = createSdkStore({ driver });
    const adapter = createDiscoveryAdapterFromStore(store);
    const manager = new ModelManager(adapter, { logger: silentLogger });

    manager.setUserEnabledReviewLabels(["  SandBox  ", "beta", "sandbox", ""]);

    expect(manager.getUserEnabledReviewLabels()).toEqual(["sandbox", "beta"]);
    expect(manager.getEnabledReviewLabels()).toEqual(
      expect.arrayContaining(["lgtm", "lgtm2", "sandbox", "beta"]),
    );
  });

  it("adds and removes a single label", async () => {
    const driver = createMemoryDriver();
    const { store } = createSdkStore({ driver });
    const adapter = createDiscoveryAdapterFromStore(store);
    const manager = new ModelManager(adapter, { logger: silentLogger });

    manager.addUserEnabledReviewLabel("sandbox");
    expect(manager.getUserEnabledReviewLabels()).toEqual(["sandbox"]);

    manager.removeUserEnabledReviewLabel("SANDBOX");
    expect(manager.getUserEnabledReviewLabels()).toEqual([]);
    // Defaults are never removable.
    expect(manager.getEnabledReviewLabels()).toContain("lgtm");
  });

  it("persists user-enabled labels across store re-creation", async () => {
    const driver = createMemoryDriver();

    const first = createSdkStore({ driver });
    await first.hydrate;
    createDiscoveryAdapterFromStore(first.store).setUserEnabledReviewLabels!([
      "sandbox",
    ]);
    // Writes are fire-and-forget; let the memory driver settle.
    await Promise.resolve();

    const second = createSdkStore({ driver });
    await second.hydrate;
    const adapter = createDiscoveryAdapterFromStore(second.store);
    expect(adapter.getUserEnabledReviewLabels!()).toEqual(["sandbox"]);
  });

  it("the sharded adapter persists and normalises the label set", async () => {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    adapter.setUserEnabledReviewLabels!([" Sandbox ", "sandbox", "beta"]);
    expect(adapter.getUserEnabledReviewLabels!()).toEqual(["sandbox", "beta"]);

    await Promise.resolve();
    const rehydrated = await createShardedDiscoveryAdapter({ driver });
    expect(rehydrated.getUserEnabledReviewLabels!()).toEqual([
      "sandbox",
      "beta",
    ]);
  });
});

// ─── Policy layer ───────────────────────────────────────────────────────────

describe("review-label policy — enable/disable verdict", () => {
  afterEach(() => {
    relayEvents.current = [];
  });

  async function makeManager(): Promise<{
    adapter: DiscoveryAdapter;
    manager: ModelManager;
  }> {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    const manager = new ModelManager(adapter, {
      routstrPubkey: ANCHOR_PK,
      logger: silentLogger,
    });
    return { adapter, manager };
  }

  it("a sandbox-labelled node stays disabled by default", async () => {
    relayEvents.current = [makeReview("sandbox", [SANDBOX_PK])];

    const { adapter, manager } = await makeManager();
    await sync(manager, [SANDBOX_URL], nodeMap([[SANDBOX_URL, SANDBOX_PK]]));

    expect(adapter.getDisabledProviders()).toContain(SANDBOX_URL);
  });

  it("a sandbox-labelled node is enabled once the user opts the label in", async () => {
    relayEvents.current = [makeReview("sandbox", [SANDBOX_PK])];

    const { adapter, manager } = await makeManager();
    manager.addUserEnabledReviewLabel("sandbox");
    await sync(manager, [SANDBOX_URL], nodeMap([[SANDBOX_URL, SANDBOX_PK]]));

    expect(adapter.getDisabledProviders()).not.toContain(SANDBOX_URL);
  });

  it("an lgtm-labelled node is enabled by default", async () => {
    relayEvents.current = [makeReview("lgtm", [PROVIDER_PK])];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], nodeMap([[PROVIDER_URL, PROVIDER_PK]]));

    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_URL);
  });

  it("an opted-in label still loses to a negative label", async () => {
    relayEvents.current = [makeReview("avoid", [SANDBOX_PK])];

    const { adapter, manager } = await makeManager();
    manager.setUserEnabledReviewLabels(["avoid"]);
    await sync(manager, [SANDBOX_URL], nodeMap([[SANDBOX_URL, SANDBOX_PK]]));

    expect(adapter.getDisabledProviders()).toContain(SANDBOX_URL);
  });

  it("the newest review wins when a node is relabelled", async () => {
    relayEvents.current = [
      makeReview("sandbox", [SANDBOX_PK], nowUnix() - 100),
      makeReview("lgtm", [SANDBOX_PK], nowUnix()),
    ];

    const { adapter, manager } = await makeManager();
    await sync(manager, [SANDBOX_URL], nodeMap([[SANDBOX_URL, SANDBOX_PK]]));

    // lgtm is newer than sandbox → enabled by default.
    expect(adapter.getDisabledProviders()).not.toContain(SANDBOX_URL);
  });
});

// ─── Resolver / index ───────────────────────────────────────────────────────

describe("review-label policy — matching and index", () => {
  afterEach(() => {
    relayEvents.current = [];
  });

  async function makeManager(): Promise<ModelManager> {
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    return new ModelManager(adapter, {
      routstrPubkey: ANCHOR_PK,
      logger: silentLogger,
    });
  }

  it("resolves labels to provider URLs and reports unmatched labels", async () => {
    relayEvents.current = [
      makeProviderEvent([SANDBOX_URL]),
      makeReview("sandbox", [PROVIDER_PK]),
    ];

    const manager = await makeManager();
    const result = await manager.matchProviderUrlsByLabels(
      ["sandbox", "nope"],
      [SANDBOX_URL],
      true,
    );

    expect(result.matchedUrls).toEqual([SANDBOX_URL]);
    expect(result.matchedLabels).toEqual(["sandbox"]);
    expect(result.unmatchedLabels).toEqual(["nope"]);
  });

  it("exposes the provider/review index with latest labels", async () => {
    relayEvents.current = [
      makeProviderEvent([SANDBOX_URL]),
      makeReview("sandbox", [SANDBOX_PK], nowUnix() - 50),
      makeReview("lgtm", [PROVIDER_PK], nowUnix()),
    ];

    const manager = await makeManager();
    const index = await manager.getProviderReviewIndex(true);

    expect(index.providerNodes.get(SANDBOX_URL)).toEqual(
      new Set([PROVIDER_PK]),
    );
    expect(index.latestLabelByNode.get(PROVIDER_PK)).toBe("lgtm");
    expect(index.latestLabelByNode.get(SANDBOX_PK)).toBe("sandbox");
    expect(index.reviewEvents.length).toBe(2);
    expect(index.latestLabelByNode.size).toBe(2);
  });
});
