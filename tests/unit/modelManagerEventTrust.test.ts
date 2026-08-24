/**
 * Regression tests for the Nostr discovery trust gate: forged reviews must
 * not enable/disable providers, far-future created_at must not win "latest",
 * and the review gate must fail closed when reviews are unavailable.
 *
 * Uses real signed events (finalizeEvent) so verification actually runs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { of } from "rxjs";
import { finalizeEvent, getPublicKey, verifiedSymbol } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { ModelManager } from "../../discovery/ModelManager";
import {
  createMemoryDriver,
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
const ATTACKER_SK = secretKey(3);

const ANCHOR_PK = getPublicKey(ANCHOR_SK);
const PROVIDER_PK = getPublicKey(PROVIDER_SK);
const ATTACKER_PK = getPublicKey(ATTACKER_SK);

const PROVIDER_URL = "https://provider.example.com/";
const ATTACKER_URL = "https://attacker.example.com/";

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
  sk: Uint8Array,
  label: string,
  nodePubkeys: string[],
  created_at: number = nowUnix(),
): NostrEvent =>
  finalizeEvent(
    {
      kind: 38425,
      created_at,
      tags: [["t", label], ...nodePubkeys.map((pk) => ["node", pk])],
      content: "",
    },
    sk,
  );

/** Event claiming to be from `pubkey`, but with an invalid signature. */
const forgeAs = (event: NostrEvent, pubkey: string): NostrEvent => {
  const forged = { ...event, pubkey, sig: "00".repeat(64) };
  // Strip finalizeEvent's verified mark so this is really checked.
  delete (forged as Record<PropertyKey, unknown>)[verifiedSymbol];
  return forged;
};

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ModelManager Nostr event trust gating", () => {
  afterEach(() => {
    relayEvents.current = [];
  });

  it("accepts a genuine signed lgtm review — provider stays enabled", async () => {
    relayEvents.current = [makeReview(ANCHOR_SK, "lgtm", [PROVIDER_PK])];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], nodeMap([[PROVIDER_URL, PROVIDER_PK]]));

    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_URL);
  });

  it("ignores a forged negative review — honest provider stays enabled", async () => {
    const genuineLgtm = makeReview(ANCHOR_SK, "lgtm", [PROVIDER_PK]);
    // Forged NEWER avoid review as the anchor (invalid sig).
    const forgedAvoid = forgeAs(
      makeReview(ATTACKER_SK, "avoid", [PROVIDER_PK], nowUnix() + 100),
      ANCHOR_PK,
    );
    relayEvents.current = [genuineLgtm, forgedAvoid];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], nodeMap([[PROVIDER_URL, PROVIDER_PK]]));

    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_URL);
  });

  it("ignores a forged positive review — attacker provider stays disabled", async () => {
    // No genuine reviews at all; attacker forges an lgtm for its own node.
    const forgedLgtm = forgeAs(
      makeReview(ATTACKER_SK, "lgtm", [ATTACKER_PK]),
      ANCHOR_PK,
    );
    relayEvents.current = [forgedLgtm];

    const { adapter, manager } = await makeManager();
    await sync(manager, [ATTACKER_URL], nodeMap([[ATTACKER_URL, ATTACKER_PK]]));

    expect(adapter.getDisabledProviders()).toContain(ATTACKER_URL);
  });

  it("rejects genuine reviews with far-future created_at — cannot win latest", async () => {
    // Even a correctly-signed review two days in the future must be dropped
    // (created_at is attacker-friendly input for latest-wins selection).
    const futureLgtm = makeReview(
      ANCHOR_SK,
      "lgtm",
      [PROVIDER_PK],
      nowUnix() + 2 * 24 * 60 * 60,
    );
    relayEvents.current = [futureLgtm];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], nodeMap([[PROVIDER_URL, PROVIDER_PK]]));

    expect(adapter.getDisabledProviders()).toContain(PROVIDER_URL);
  });

  it("accepts reviews within the future-drift window", async () => {
    const nearFutureLgtm = makeReview(
      ANCHOR_SK,
      "lgtm",
      [PROVIDER_PK],
      nowUnix() + 10 * 60, // 10 min — inside the 15 min drift window
    );
    relayEvents.current = [nearFutureLgtm];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], nodeMap([[PROVIDER_URL, PROVIDER_PK]]));

    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_URL);
  });

  it("fails closed when no review events are retrievable", async () => {
    relayEvents.current = []; // review outage / fresh install / timeout

    const { adapter, manager } = await makeManager();
    const disabled = await sync(
      manager,
      [PROVIDER_URL, ATTACKER_URL],
      nodeMap([
        [PROVIDER_URL, PROVIDER_PK],
        [ATTACKER_URL, ATTACKER_PK],
      ]),
    );

    expect(adapter.getDisabledProviders()).toContain(PROVIDER_URL);
    expect(adapter.getDisabledProviders()).toContain(ATTACKER_URL);
    expect(disabled).toEqual(
      expect.arrayContaining([PROVIDER_URL, ATTACKER_URL]),
    );
  });

  it("fails closed when review events exist but node metadata is missing", async () => {
    relayEvents.current = [makeReview(ANCHOR_SK, "lgtm", [PROVIDER_PK])];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], new Map()); // no 38421 metadata

    expect(adapter.getDisabledProviders()).toContain(PROVIDER_URL);
  });

  it("keeps manually re-enabled providers enabled during a review outage", async () => {
    relayEvents.current = [];

    const { adapter, manager } = await makeManager();
    adapter.setManuallyEnabledProviders!([PROVIDER_URL]);

    await sync(
      manager,
      [PROVIDER_URL, ATTACKER_URL],
      nodeMap([
        [PROVIDER_URL, PROVIDER_PK],
        [ATTACKER_URL, ATTACKER_PK],
      ]),
    );

    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_URL);
    expect(adapter.getDisabledProviders()).toContain(ATTACKER_URL);
  });

  it("a later genuine negative review still disables a provider", async () => {
    const lgtm = makeReview(ANCHOR_SK, "lgtm", [PROVIDER_PK], nowUnix() - 100);
    const avoid = makeReview(ANCHOR_SK, "avoid", [PROVIDER_PK], nowUnix());
    relayEvents.current = [lgtm, avoid];

    const { adapter, manager } = await makeManager();
    await sync(manager, [PROVIDER_URL], nodeMap([[PROVIDER_URL, PROVIDER_PK]]));

    expect(adapter.getDisabledProviders()).toContain(PROVIDER_URL);
  });

  it("bootstrap accepts genuine signed 38421 announcements and enables reviewed providers", async () => {
    relayEvents.current = [
      finalizeEvent(
        {
          kind: 38421,
          created_at: nowUnix(),
          tags: [["u", PROVIDER_URL]],
          content: "",
        },
        PROVIDER_SK,
      ),
      makeReview(ANCHOR_SK, "lgtm", [PROVIDER_PK]),
      finalizeEvent(
        {
          kind: 38423,
          created_at: nowUnix(),
          tags: [["d", "routstr-21-models"]],
          content: JSON.stringify({ models: [] }),
        },
        ANCHOR_SK,
      ),
    ];

    const { adapter, manager } = await makeManager();
    const bases = await manager.bootstrapProviders(false, true);

    expect(bases).toContain(PROVIDER_URL);
    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_URL);
  });

  it("bootstrap drops forged 38421 announcements (no valid signature)", async () => {
    relayEvents.current = [
      forgeAs(
        finalizeEvent(
          {
            kind: 38421,
            created_at: nowUnix(),
            tags: [["u", ATTACKER_URL]],
            content: "",
          },
          ATTACKER_SK,
        ),
        ANCHOR_PK,
      ),
    ];
    // No HTTP fallback available either — bootstrap must fail rather than
    // admit the forged provider.
    vi.stubGlobal("fetch", async () => Response.error());

    const { adapter, manager } = await makeManager();
    await expect(manager.bootstrapProviders(false, true)).rejects.toThrow();

    expect(adapter.getBaseUrlsList()).not.toContain(ATTACKER_URL);

    vi.unstubAllGlobals();
  });
});
