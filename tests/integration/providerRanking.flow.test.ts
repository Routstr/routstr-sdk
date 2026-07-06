/**
 * Integration test: end-to-end provider ranking flow
 *
 * Covers:
 *  1. Bootstrap providers from Nostr (mocked kind 38421 events)
 *  2. Store provider URLs in the DiscoveryAdapter (persistent DB)
 *  3. Fetch models from each provider (mocked HTTP /v1/models)
 *  4. ProviderManager.getProviderPriceRankingForModel() checks ranking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NostrEvent } from "applesauce-core/helpers";
import { ModelManager } from "../../discovery/ModelManager";
import { ProviderManager } from "../../client/ProviderManager";
import {
  createMemoryDriver,
  createShardedDiscoveryAdapter,
} from "../../storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_A_URL = "https://expensive.example.com";
const PROVIDER_B_URL = "https://cheap.example.com";
const ROUTSTR_PUBKEY =
  "4ad6fa2d16e2a9b576c863b4cf7404a70d4dc320c0c447d10ad6ff58993eacc8";

// Nostr pubkeys for provider events (linked to lgtm reviews)
const PROVIDER_A_NODE_PUBKEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROVIDER_B_NODE_PUBKEY =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// Helpers - Nostr events
// ---------------------------------------------------------------------------

const nowUnix = () => Math.floor(Date.now() / 1000);

/** Create a kind 38421 provider bootstrap event with "u" tags */
const makeProviderEvent = (
  id: string,
  pubkey: string,
  urls: string[],
): NostrEvent => ({
  id,
  pubkey,
  created_at: nowUnix(),
  kind: 38421,
  tags: urls.map((url) => ["u", url]),
  content: "",
  sig: "mock-sig",
});

/** Create a kind 38425 lgtm review event */
const makeLgtmEvent = (
  id: string,
  pubkey: string,
  nodePubkeys: string[],
): NostrEvent => ({
  id,
  pubkey,
  created_at: nowUnix(),
  kind: 38425,
  tags: [
    ["t", "lgtm"],
    ...nodePubkeys.map((pk) => ["node", pk]),
  ],
  content: "",
  sig: "mock-sig",
});

/** Create a kind 38423 routstr21 models event (empty) */
const makeRoutstr21Event = (id: string, pubkey: string): NostrEvent => ({
  id,
  pubkey,
  created_at: nowUnix(),
  kind: 38423,
  tags: [["d", "routstr-21-models"]],
  content: JSON.stringify({ models: [] }),
  sig: "mock-sig",
});

// ---------------------------------------------------------------------------
// Helper - model fetch responses
// ---------------------------------------------------------------------------

const expensiveModels = [
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    sats_pricing: { prompt: 10, completion: 10, max_cost: 1000 },
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    sats_pricing: { prompt: 15, completion: 15, max_cost: 1500 },
  },
];

const cheapModels = [
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  },
  {
    id: "claude-3-haiku",
    name: "Claude 3 Haiku",
    sats_pricing: { prompt: 2, completion: 2, max_cost: 200 },
  },
];

// ---------------------------------------------------------------------------
// Mock applesauce-relay
// ---------------------------------------------------------------------------

const { mockNostrEvents } = vi.hoisted(() => ({
  mockNostrEvents: [] as NostrEvent[],
}));

vi.mock("applesauce-relay", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rxjs = require("rxjs") as typeof import("rxjs");
  return {
    RelayPool: class {
      req() {
        return rxjs.of(...mockNostrEvents);
      }
    },
    onlyEvents: () => (source: rxjs.Observable<any>) =>
      source.pipe(rxjs.filter((e: any) => e !== "EOSE")),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provider ranking integration flow", () => {
  beforeEach(() => {
    // Stub window for clearnet context
    vi.stubGlobal("window", { location: { hostname: "example.com" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Clear mock event queue between tests
    mockNostrEvents.length = 0;
  });

  it("bootstraps providers from Nostr, fetches models, and returns correct price ranking", async () => {
    // -- 1. Seed mock Nostr events --
    mockNostrEvents.push(
      // Provider bootstrap events (kind 38421)
      makeProviderEvent("evt-prov-a", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeProviderEvent("evt-prov-b", PROVIDER_B_NODE_PUBKEY, [
        PROVIDER_B_URL,
      ]),
      // Lgtm review (kind 38425) - approves both provider pubkeys
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        PROVIDER_B_NODE_PUBKEY,
      ]),
      // Routstr21 models (kind 38423) - empty
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    // -- 2. Mock HTTP model fetch for each provider --
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes(`${PROVIDER_A_URL}/v1/models`)) {
        return Response.json({ data: expensiveModels });
      }
      if (url.includes(`${PROVIDER_B_URL}/v1/models`)) {
        return Response.json({ data: cheapModels });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    // -- 3. Create in-memory DiscoveryAdapter (our persistent DB) --
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    // -- 4. Run the full bootstrap + model fetch flow --
    const manager = await ModelManager.init(adapter);

    // Verify ModelManager created correctly
    expect(manager).toBeInstanceOf(ModelManager);

    // -- 5. Verify providers were bootstrapped into the adapter --
    const baseUrls = adapter.getBaseUrlsList();
    expect(baseUrls).toContain(`${PROVIDER_A_URL}/`);
    expect(baseUrls).toContain(`${PROVIDER_B_URL}/`);

    // Verify models were cached in the adapter
    const cachedModels = adapter.getCachedModels();
    expect(cachedModels[`${PROVIDER_A_URL}/`]).toEqual(expensiveModels);
    expect(cachedModels[`${PROVIDER_B_URL}/`]).toEqual(cheapModels);

    // Verify fetch was called for both providers
    expect(fetchSpy).toHaveBeenCalledWith(
      `${PROVIDER_A_URL}/v1/models`,
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `${PROVIDER_B_URL}/v1/models`,
    );

    // -- 6. Create ProviderManager from the adapter --
    const providerManager = new ProviderManager(adapter);

    // -- 7. Verify provider ranking (cheapest first) --
    const ranking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
    );

    expect(ranking).toHaveLength(2);

    // Cheapest provider (1+1 = 2 sats/token) should be first
    expect(ranking[0].baseUrl).toBe(`${PROVIDER_B_URL}/`);
    expect(ranking[0].promptPerMillion).toBe(1_000_000);
    expect(ranking[0].completionPerMillion).toBe(1_000_000);
    expect(ranking[0].totalPerMillion).toBe(2_000_000);

    // Expensive provider (10+10 = 20 sats/token) should be second
    expect(ranking[1].baseUrl).toBe(`${PROVIDER_A_URL}/`);
    expect(ranking[1].promptPerMillion).toBe(10_000_000);
    expect(ranking[1].completionPerMillion).toBe(10_000_000);
    expect(ranking[1].totalPerMillion).toBe(20_000_000);

    // -- 8. Verify getBestProviderForModel returns cheapest --
    const best = providerManager.getBestProviderForModel("gpt-4o-mini");
    expect(best).toBe(`${PROVIDER_B_URL}/`);
  });

  it("provider that lacks lgtm review gets disabled and is excluded from ranking", async () => {
    // -- 1. Seed mock Nostr events --
    // Provider C is NOT included in the lgtm event
    const PROVIDER_C_URL = "https://unreviewed.example.com";
    const PROVIDER_C_NODE_PUBKEY =
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    mockNostrEvents.push(
      makeProviderEvent("evt-prov-a", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeProviderEvent("evt-prov-b", PROVIDER_B_NODE_PUBKEY, [
        PROVIDER_B_URL,
      ]),
      makeProviderEvent("evt-prov-c", PROVIDER_C_NODE_PUBKEY, [
        PROVIDER_C_URL,
      ]),
      // Lgtm only for A and B, NOT C
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        PROVIDER_B_NODE_PUBKEY,
      ]),
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    // -- 2. Mock HTTP model fetch --
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes(`${PROVIDER_A_URL}/v1/models`)) {
        return Response.json({ data: expensiveModels });
      }
      if (url.includes(`${PROVIDER_B_URL}/v1/models`)) {
        return Response.json({ data: cheapModels });
      }
      if (url.includes(`${PROVIDER_C_URL}/v1/models`)) {
        return Response.json({
          data: [
            {
              id: "gpt-4o-mini",
              name: "GPT-4o Mini",
              sats_pricing: { prompt: 5, completion: 5, max_cost: 500 },
            },
          ],
        });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    // -- 3. Run the flow --
    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    await ModelManager.init(adapter);

    // Provider C should be in the disabled list
    const disabled = adapter.getDisabledProviders();
    expect(disabled).toContain(`${PROVIDER_C_URL}/`);

    // Provider A and B should NOT be disabled
    expect(disabled).not.toContain(`${PROVIDER_A_URL}/`);
    expect(disabled).not.toContain(`${PROVIDER_B_URL}/`);

    // -- 4. Verify ranking: C is excluded, only A and B, sorted by price --
    const providerManager = new ProviderManager(adapter);
    const ranking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
    );

    expect(ranking).toHaveLength(2);
    expect(ranking[0].baseUrl).toBe(`${PROVIDER_B_URL}/`);
    expect(ranking[1].baseUrl).toBe(`${PROVIDER_A_URL}/`);
  });

  it("returns empty ranking when no provider has the requested model", async () => {
    mockNostrEvents.push(
      makeProviderEvent("evt-prov-a", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [PROVIDER_A_NODE_PUBKEY]),
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    // Provider only has gpt-4o, not gpt-4o-mini
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes(`${PROVIDER_A_URL}/v1/models`)) {
        return Response.json({
          data: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              sats_pricing: { prompt: 15, completion: 15, max_cost: 1500 },
            },
          ],
        });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    await ModelManager.init(adapter);

    const providerManager = new ProviderManager(adapter);
    const ranking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
    );

    expect(ranking).toHaveLength(0);
  });

  it("alphabetical tiebreak when totalPerMillion is equal", async () => {
    mockNostrEvents.push(
      makeProviderEvent("evt-prov-a", PROVIDER_A_NODE_PUBKEY, [
        "https://zulu.example.com",
      ]),
      makeProviderEvent("evt-prov-b", PROVIDER_B_NODE_PUBKEY, [
        "https://alpha.example.com",
      ]),
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        PROVIDER_B_NODE_PUBKEY,
      ]),
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    const equalPricing = {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
    };

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("zulu.example.com/v1/models") || url.includes("alpha.example.com/v1/models")) {
        return Response.json({ data: [equalPricing] });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    await ModelManager.init(adapter);

    const providerManager = new ProviderManager(adapter);
    const ranking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
    );

    expect(ranking).toHaveLength(2);
    expect(ranking.map((e) => e.baseUrl)).toEqual([
      "https://alpha.example.com/",
      "https://zulu.example.com/",
    ]);
  });

  it("torMode=true filters to only onion providers in ranking", async () => {
    const ONION_PROVIDER = "http://dark.onion";
    const ONION_NODE_PUBKEY =
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    mockNostrEvents.push(
      makeProviderEvent("evt-cleart", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeProviderEvent("evt-onion", ONION_NODE_PUBKEY, [ONION_PROVIDER]),
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        ONION_NODE_PUBKEY,
      ]),
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes(`${PROVIDER_A_URL}/v1/models`)) {
        return Response.json({ data: expensiveModels });
      }
      if (url.includes(`${ONION_PROVIDER}/v1/models`)) {
        return Response.json({
          data: [
            {
              id: "gpt-4o-mini",
              name: "GPT-4o Mini",
              sats_pricing: { prompt: 0.5, completion: 0.5, max_cost: 50 },
            },
          ],
        });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });

    // Run in clearnet mode. ModelManager filters onion URLs from baseUrls
    // at bootstrap time, so the onion provider won't be cached automatically.
    // Manually seed the adapter with onion provider models to test
    // ProviderManager's torMode ranking filter in isolation.
    await ModelManager.init(adapter);

    // Manually inject the onion provider into the cache (simulating a prior
    // tor-mode bootstrap)
    const existingModels = adapter.getCachedModels();
    adapter.setCachedModels({
      ...existingModels,
      [`${ONION_PROVIDER}/`]: [
        {
          id: "gpt-4o-mini",
          name: "GPT-4o Mini",
          sats_pricing: { prompt: 0.5, completion: 0.5, max_cost: 50 },
        },
      ],
    });

    const providerManager = new ProviderManager(adapter);

    // torMode=true should only show onion
    const torRanking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
      { torMode: true },
    );

    expect(torRanking).toHaveLength(1);
    expect(torRanking[0].baseUrl).toBe(`${ONION_PROVIDER}/`);

    // torMode=false (default) should only show clearnet
    const clearnetRanking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
    );

    expect(clearnetRanking).toHaveLength(1);
    expect(clearnetRanking[0].baseUrl).toBe(`${PROVIDER_A_URL}/`);
  });

  it("verifies data survives adapter re-creation (persistence)", async () => {
    mockNostrEvents.push(
      makeProviderEvent("evt-prov-a", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeProviderEvent("evt-prov-b", PROVIDER_B_NODE_PUBKEY, [
        PROVIDER_B_URL,
      ]),
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        PROVIDER_B_NODE_PUBKEY,
      ]),
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes(`${PROVIDER_A_URL}/v1/models`)) {
        return Response.json({ data: expensiveModels });
      }
      if (url.includes(`${PROVIDER_B_URL}/v1/models`)) {
        return Response.json({ data: cheapModels });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    // First run: bootstrap and fetch
    const driver = createMemoryDriver();
    const adapter1 = await createShardedDiscoveryAdapter({ driver });
    await ModelManager.init(adapter1);

    // Re-create adapter from the same driver (simulates app restart)
    const adapter2 = await createShardedDiscoveryAdapter({ driver });

    // Models and provider URLs should survive
    expect(adapter2.getBaseUrlsList()).toEqual(adapter1.getBaseUrlsList());
    expect(adapter2.getCachedModels()).toEqual({
      [`${PROVIDER_A_URL}/`]: expensiveModels,
      [`${PROVIDER_B_URL}/`]: cheapModels,
    });

    const providerManager = new ProviderManager(adapter2);
    const ranking = providerManager.getProviderPriceRankingForModel(
      "gpt-4o-mini",
    );

    expect(ranking).toHaveLength(2);
    expect(ranking[0].baseUrl).toBe(`${PROVIDER_B_URL}/`);
  });

  it("preserves disabled status and prunes stale models when a provider's Nostr event is lost on re-bootstrap", async () => {
    // ── Session 1: 3 providers ───────────────────────────────────────
    // Provider C has NO lgtm review → gets disabled.
    // A and B have lgtm → active.

    const PROVIDER_C_URL = "https://mid.example.com";
    const PROVIDER_C_NODE_PUBKEY =
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    const providerCModels = [
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        sats_pricing: { prompt: 5, completion: 5, max_cost: 500 },
      },
    ];

    // Session 1 events: all three providers + lgtm for A and B only
    mockNostrEvents.push(
      makeProviderEvent("evt-prov-a", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeProviderEvent("evt-prov-b", PROVIDER_B_NODE_PUBKEY, [
        PROVIDER_B_URL,
      ]),
      makeProviderEvent("evt-prov-c", PROVIDER_C_NODE_PUBKEY, [
        PROVIDER_C_URL,
      ]),
      // Lgtm reviews: only A and B, NOT C
      makeLgtmEvent("evt-lgtm", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        PROVIDER_B_NODE_PUBKEY,
      ]),
      makeRoutstr21Event("evt-r21", ROUTSTR_PUBKEY),
    );

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes(`${PROVIDER_A_URL}/v1/models`)) {
        return Response.json({ data: expensiveModels });
      }
      if (url.includes(`${PROVIDER_B_URL}/v1/models`)) {
        return Response.json({ data: cheapModels });
      }
      if (url.includes(`${PROVIDER_C_URL}/v1/models`)) {
        return Response.json({ data: providerCModels });
      }
      return Response.error();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const driver = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({ driver });
    await ModelManager.init(adapter);

    // ── Session 1 assertions ─────────────────────────────────────────

    // All three providers appear in the base URL list
    const baseUrls1 = adapter.getBaseUrlsList();
    expect(baseUrls1).toContain(`${PROVIDER_A_URL}/`);
    expect(baseUrls1).toContain(`${PROVIDER_B_URL}/`);
    expect(baseUrls1).toContain(`${PROVIDER_C_URL}/`);

    // C is disabled (no lgtm review)
    const disabled1 = adapter.getDisabledProviders();
    expect(disabled1).toContain(`${PROVIDER_C_URL}/`);
    expect(disabled1).not.toContain(`${PROVIDER_A_URL}/`);
    expect(disabled1).not.toContain(`${PROVIDER_B_URL}/`);

    // Models are cached for ALL three (fetchModels fetches all, disabled filter
    // only applies to best-model selection, not to caching)
    const models1 = adapter.getCachedModels();
    expect(models1).toHaveProperty(`${PROVIDER_A_URL}/`);
    expect(models1).toHaveProperty(`${PROVIDER_B_URL}/`);
    expect(models1).toHaveProperty(`${PROVIDER_C_URL}/`);
    expect(models1[`${PROVIDER_C_URL}/`]).toEqual(providerCModels);

    // Ranking excludes disabled provider C — only A and B
    {
      const providerManager = new ProviderManager(adapter);
      const pm = new ProviderManager(adapter);
      const ranking = pm.getProviderPriceRankingForModel("gpt-4o-mini");
      expect(ranking).toHaveLength(2);
      expect(ranking.map((e) => e.baseUrl)).toEqual([
        `${PROVIDER_B_URL}/`,
        `${PROVIDER_A_URL}/`,
      ]);
    }

    // ── Session 2: re-bootstrap, C's kind-38421 event is LOST ────────
    // Clear mock events and only push A, B (no C), same lgtm reviews

    mockNostrEvents.length = 0;
    mockNostrEvents.push(
      makeProviderEvent("evt-prov-a-v2", PROVIDER_A_NODE_PUBKEY, [
        PROVIDER_A_URL,
      ]),
      makeProviderEvent("evt-prov-b-v2", PROVIDER_B_NODE_PUBKEY, [
        PROVIDER_B_URL,
      ]),
      makeLgtmEvent("evt-lgtm-v2", ROUTSTR_PUBKEY, [
        PROVIDER_A_NODE_PUBKEY,
        PROVIDER_B_NODE_PUBKEY,
      ]),
      makeRoutstr21Event("evt-r21-v2", ROUTSTR_PUBKEY),
    );

    // Use the same adapter (persistent data) but force-refresh so we hit
    // Nostr again instead of using the cached base URLs.
    await ModelManager.init(adapter, {}, { forceRefresh: true });

    // ── Session 2 assertions: CORRECT BEHAVIOR ───────────────────────

    // C is MISSING from baseUrlsList because its Nostr event was lost.
    // This is expected — the new bootstrap only found A and B.
    const baseUrls2 = adapter.getBaseUrlsList();
    expect(baseUrls2).toContain(`${PROVIDER_A_URL}/`);
    expect(baseUrls2).toContain(`${PROVIDER_B_URL}/`);
    expect(baseUrls2).not.toContain(`${PROVIDER_C_URL}/`);

    // Fix A: C's disabled status is PRESERVED even though C's Nostr
    // event was lost.  syncReviewedProvidersFromNostr now carries
    // forward previously-disabled providers not in the current bootstrap.
    const disabled2 = adapter.getDisabledProviders();
    expect(disabled2).toContain(`${PROVIDER_C_URL}/`);
    expect(disabled2).not.toContain(`${PROVIDER_A_URL}/`);
    expect(disabled2).not.toContain(`${PROVIDER_B_URL}/`);

    // Fix B: C's stale models are PRUNED from the cache.
    // fetchModels now strips entries for providers not in the current
    // baseUrls before merging.
    const models2 = adapter.getCachedModels();
    expect(models2).toHaveProperty(`${PROVIDER_A_URL}/`);
    expect(models2).toHaveProperty(`${PROVIDER_B_URL}/`);
    expect(models2).not.toHaveProperty(`${PROVIDER_C_URL}/`);

    // Ranking only shows A and B — C is excluded (disabled + pruned).
    {
      const providerManager = new ProviderManager(adapter);
      const pm = new ProviderManager(adapter);
      const ranking = pm.getProviderPriceRankingForModel("gpt-4o-mini");

      expect(ranking).toHaveLength(2);
      expect(ranking[0].baseUrl).toBe(`${PROVIDER_B_URL}/`);
      expect(ranking[1].baseUrl).toBe(`${PROVIDER_A_URL}/`);
    }
  });
});
