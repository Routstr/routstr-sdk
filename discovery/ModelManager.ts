/**
 * ModelManager class for discovering, fetching, and managing models from providers
 * Core responsibility: fetching models from providers, caching them, and selecting the best option
 * (lowest cost) across multiple providers
 */

import type { Model, SdkLogger } from "../core/types";
import { consoleLogger } from "../core/types";
import { canonicalIdForModel, MODEL_ID_MAPPINGS, type ModelIdMappings } from "../core/modelMappings";
import type { DiscoveryAdapter, ProviderInfo } from "./interfaces";
import { withProviderDeadline } from "./providerDeadline";
import {
  classifyProviderFailure,
  diffProviderOutage,
  type ProviderFailure,
  type ProviderOutcome,
} from "./providerOutageReport";
import {
  NoProvidersAvailableError,
  ProviderBootstrapError,
} from "../core/errors";
import { RelayPool } from "applesauce-relay";
import { EventStore } from "applesauce-core";
import type { IEventDatabase } from "applesauce-core";
import {
  getReplaceableIdentifier,
  isReplaceable,
  verifyEvent,
} from "applesauce-core/helpers";
import type { Filter, NostrEvent } from "applesauce-core/helpers";

type SqliteStatement = {
  run?: (...params: any[]) => unknown;
  get?: (...params: any[]) => any;
};

export type PersistentEventDatabase = IEventDatabase & {
  db?: {
    exec: (sql: string) => void;
    prepare: (sql: string) => SqliteStatement;
  };
  close?: () => void;
};

export type PersistentEventDatabaseFactory = (
  dbPath: string
) => Promise<PersistentEventDatabase> | PersistentEventDatabase;

export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.routstr.com",
];

/**
 * Kind 38425 review labels that enable a provider node by default.
 *
 * `sandbox` and other experimental labels are deliberately NOT in this list:
 * they are opt-in only (see `getUserEnabledReviewLabels`), so a
 * sandbox-labelled node stays disabled until the user explicitly enables that
 * label. Review labels are matched case-insensitively.
 */
export const DEFAULT_ENABLED_REVIEW_LABELS = [
  "trusted",
  "verified",
  "lgtm",
  "lgtm2",
] as const;

/** Kind 38425 review labels that mark a provider node as unsafe to route to. */
const NEGATIVE_REVIEW_LABELS = new Set([
  "suspicious",
  "avoid",
  "blacklisted",
  "removed",
]);

/** Review labels are compared case-insensitively and trimmed. */
const normalizeReviewLabel = (label: string): string =>
  label.trim().toLowerCase();

/** Normalise, drop empties, and de-duplicate a review label list. */
const normalizeReviewLabels = (labels: string[]): string[] => [
  ...new Set(labels.map(normalizeReviewLabel).filter(Boolean)),
];

/**
 * Latest label per reviewed node, mirroring the review sync: the newest
 * `created_at` wins, tie-broken by event id, and a label applies to every
 * `node` tag on its event. Several review events can cover one node (e.g. an
 * `lgtm` later reversed to `avoid`), so the newest is authoritative.
 */
function latestReviewLabelsByNode(
  events: NostrEvent[]
): Map<string, string> {
  const latestByNode = new Map<string, NostrEvent>();

  for (const event of events) {
    const label = event.tags
      .find((tag) => tag[0] === "t" && typeof tag[1] === "string" && tag[1])
      ?.[1]?.toLowerCase();
    if (!label) continue;

    for (const tag of event.tags) {
      if (tag[0] !== "node" || typeof tag[1] !== "string" || !tag[1]) continue;
      const node = tag[1];
      const previous = latestByNode.get(node);
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id > previous.id)
      ) {
        latestByNode.set(node, event);
      }
    }
  }

  const labels = new Map<string, string>();
  for (const [node, event] of latestByNode) {
    const label = event.tags
      .find((tag) => tag[0] === "t" && typeof tag[1] === "string" && tag[1])
      ?.[1]?.toLowerCase();
    if (label) labels.set(node, label);
  }
  return labels;
}

// A hanging provider must not hold a fetch pass open indefinitely.
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

// Backstop for relays that never send EOSE; queries normally finish earlier.
const NOSTR_QUERY_TIMEOUT_MS = 5000;

// Drop events with a forged far-future created_at so they can't win "latest".
const MAX_EVENT_FUTURE_DRIFT_SECONDS = 15 * 60;

/** Kinds whose persisted events are discovery evidence. */
const DISCOVERY_KINDS = [38421, 38423, 38425, 38426];

/** Address of the authoritative replaceable model mapping snapshot. */
const MODEL_ID_MAPPINGS_D_TAG = "model-id-mappings";

// Deletes are chunked so one pruning pass never builds an unbounded SQL
// statement; the store read itself is never limited.
const PRUNE_CHUNK_SIZE = 500;

/**
 * Configuration for ModelManager
 */
export interface ModelManagerConfig {
  /** Existing event store. Its database must be hydrated before discovery starts. */
  eventStore?: EventStore;
  /** URL to fetch provider directory from */
  providerDirectoryUrl?: string;
  /** Additional provider base URLs to include */
  includeProviderUrls?: string[];
  /** Provider base URLs to exclude */
  excludeProviderUrls?: string[];
  /** Cache TTL in milliseconds (default: 21 minutes) */
  cacheTTL?: number;
  /** Nostr pubkey for routstr review/audit events (kind 38425). Defaults to routstr's key. */
  routstrPubkey?: string;
  /** Nostr pubkey for routstr-21 models (38423) and model ID mappings (38426). Falls back to routstrPubkey. */
  routstrModelsPubkey?: string;
  /** Nostr relay URLs for provider/model discovery.
   * When set, these relays are used for all Nostr queries (kinds 38421, 38423, 38425, 38426).
   * When unset, DEFAULT_NOSTR_RELAYS is used for all Nostr queries. */
  nostrRelays?: string[];
  /** Optional injectable logger */
  logger?: SdkLogger;
  /** Path to database for persistent Nostr event storage.
   * If provided, events fetched by ModelManager from relays (kinds 38421,
   * 38423, 38425, 38426) are persisted and survive process restarts. The underlying
   * EventStore can also be accessed for advanced/manual event management.
   *
   * Runtime-specific SQLite implementations are intentionally not imported by
   * the browser-safe default SDK entrypoint. Use @routstr/sdk/node or
   * @routstr/sdk/bun to get a ModelManager preconfigured with a SQLite-backed
   * persistentEventDatabaseFactory, or inject your own factory here. */
  eventStoreDbPath?: string;
  /** Factory used with eventStoreDbPath to create the persistent event DB. */
  persistentEventDatabaseFactory?: PersistentEventDatabaseFactory;
}

/**
 * Progress callbacks for bootstrapProviders. Nostr discovery only: the
 * cached, HTTP-fallback, and includeProviderUrls paths do not report.
 */
export interface BootstrapOptions {
  /** Fires with the cumulative count of provider events as they arrive. */
  onEventsFound?: (count: number) => void;
  /** Fires as each new provider base URL is discovered. */
  onProvider?: (baseUrl: string) => void;
}

/**
 * Trusted provider/review index over the persisted discovery evidence:
 * which node pubkeys advertise each provider URL, the stored kind-38425
 * review events, and each node's latest review label.
 */
export interface ProviderReviewIndex {
  /** Provider base URL -> set of kind-38421 node pubkeys advertising it. */
  providerNodes: Map<string, Set<string>>;
  /** Trusted kind-38425 review events from the store (one per reviewed
   * address; kind 38425 is addressable and keyed by its `d` tag). */
  reviewEvents: NostrEvent[];
  /** Reviewed node pubkey -> latest review label (lowercased). */
  latestLabelByNode: Map<string, string>;
}

/** Result of resolving review labels to provider base URLs. */
export interface ReviewLabelMatch {
  /** Provider base URLs whose latest review label matched a request. */
  matchedUrls: string[];
  /** Requested labels that matched at least one provider. */
  matchedLabels: string[];
  /** Requested labels that matched no provider. */
  unmatchedLabels: string[];
}

/**
 * ModelManager handles all model discovery and caching logic
 * Abstracts away storage details via DiscoveryAdapter
 */
export class ModelManager {
  private readonly cacheTTL: number;
  private readonly providerDirectoryUrl: string;
  private readonly includeProviderUrls: string[];
  private readonly excludeProviderUrls: string[];
  private readonly routstrPubkey: string;
  private readonly routstrModelsPubkey: string;
  private readonly nostrRelays: string[] | undefined;
  private readonly logger: SdkLogger;
  private providerNodePubkeysByUrl = new Map<string, Set<string>>();
  /** One pool for all queries, so repeated bootstraps reuse relay sockets. */
  private relayPool: RelayPool | null = null;
  /** Persistent event store for relay-fetched events (null if not configured/initialized) */
  private eventStore: EventStore | null = null;
  private readonly memoryEventStore = new EventStore({ verifyEvent });
  private readonly queryLastUpdate = new Map<string, number>();
  private eventStoreDb: PersistentEventDatabase | null = null;
  private eventStoreInitPromise: Promise<EventStore | null> | null = null;
  private readonly eventStoreDbPath?: string;
  private readonly persistentEventDatabaseFactory?: PersistentEventDatabaseFactory;
  /**
   * Provider failures from the previous fetch pass, keyed by base URL.
   * A refresh runs on a fixed cadence against a provider set where the same
   * nodes are down for days at a time, so "still down" is not news: only a
   * transition (newly failed, reason changed, recovered) earns a raw line, and
   * the steady state collapses into one summary per pass.
   *
   * Best-effort under concurrency: two overlapping passes on one instance can
   * both read the pre-pass state, which re-reports the current outage set once
   * and reports no false recovery. Only log volume is affected, so this is not
   * worth locking for.
   */
  private providerFailures = new Map<string, ProviderFailure>();
  private providerModelRequests = new Map<string, Promise<Model[]>>();
  private modelPassSequence = 0;
  private activeModelPasses = new Map<number, Set<string>>();
  private latestModelPassUrls = new Set<string>();

  constructor(
    private adapter: DiscoveryAdapter,
    config: ModelManagerConfig = {}
  ) {
    this.providerDirectoryUrl =
      config.providerDirectoryUrl || "https://api.routstr.com/v1/providers/";
    this.cacheTTL = config.cacheTTL || 21 * 60 * 1000; // 21 minutes
    this.includeProviderUrls = config.includeProviderUrls || [];
    this.excludeProviderUrls = config.excludeProviderUrls || [];
    this.routstrPubkey =
      config.routstrPubkey ||
      "4ad6fa2d16e2a9b576c863b4cf7404a70d4dc320c0c447d10ad6ff58993eacc8";
    this.routstrModelsPubkey =
      config.routstrModelsPubkey ||
      config.routstrPubkey ||
      "4ad6fa2d16e2a9b576c863b4cf7404a70d4dc320c0c447d10ad6ff58993eacc8";
    this.nostrRelays = config.nostrRelays;
    this.logger = (config.logger ?? consoleLogger).child("ModelManager");

    this.eventStoreDbPath = config.eventStoreDbPath;
    this.persistentEventDatabaseFactory = config.persistentEventDatabaseFactory;
    this.eventStore = config.eventStore ?? null;

    for (const method of ["getModelIdMappings", "setModelIdMappings",
      "getModelIdMappingsEvent", "setModelIdMappingsEvent"] as const) {
      if (typeof adapter[method] !== "function") {
        throw new Error(`DiscoveryAdapter must implement ${method} for Nostr model mappings`);
      }
    }
    // The signed event is the source of truth. Discard legacy/unscoped
    // projections and rebuild only from evidence for the configured author.
    const saved = adapter.getModelIdMappingsEvent();
    adapter.setModelIdMappings(saved && this.isModelIdMappingEvent(saved)
      ? this.parseModelIdMappings(saved) : null);

  }

  /**
   * Get the list of bootstrapped provider base URLs
   * @returns Array of provider base URLs
   */
  getBaseUrls(): string[] {
    return this.adapter.getBaseUrlsList();
  }

  /**
   * Lazily initialize the persistent event store.
   * Returns null if neither eventStore nor eventStoreDbPath was provided.
   */
  private async ensureEventStore(): Promise<EventStore | null> {
    if (this.eventStore) return this.eventStore;
    if (!this.eventStoreDbPath) return null;

    if (!this.eventStoreInitPromise) {
      this.eventStoreInitPromise = (async () => {
        try {
          const db = await this.createPersistentEventDatabase();
          this.eventStoreDb = db;
          this.eventStore = new EventStore({ database: db });
          this.logger.log(
            `Persistent event store initialized at ${this.eventStoreDbPath}`
          );
          return this.eventStore;
        } catch (error) {
          this.eventStoreInitPromise = null;
          throw new Error(
            `Persistent Nostr event storage requires a runtime-specific database factory. Use @routstr/sdk/node, @routstr/sdk/bun, inject persistentEventDatabaseFactory, or omit eventStoreDbPath. (${error})`
          );
        }
      })();
    }

    return this.eventStoreInitPromise;
  }

  /**
   * Get the persistent event store, initializing it if configured.
   * Returns null if neither eventStore nor eventStoreDbPath was provided.
   */
  async getEventStore(): Promise<EventStore | null> {
    return this.ensureEventStore();
  }

  private async createPersistentEventDatabase(): Promise<PersistentEventDatabase> {
    if (!this.eventStoreDbPath) {
      throw new Error("eventStoreDbPath is required");
    }
    if (!this.persistentEventDatabaseFactory) {
      throw new Error(
        "persistentEventDatabaseFactory is required. Import ModelManager from @routstr/sdk/node or @routstr/sdk/bun for SQLite-backed persistent event storage."
      );
    }
    return this.persistentEventDatabaseFactory(this.eventStoreDbPath);
  }

  /** Close the persistent event store database handle, if configured. */
  closeEventStore(): void {
    this.eventStoreDb?.close?.();
    this.eventStore = null;
    this.eventStoreDb = null;
    this.eventStoreInitPromise = null;
  }

  /**
   * True when a kind-38421 event can yield routstr provider URLs, i.e. it
   * carries a `u` endpoint tag or directory-style JSON content.
   *
   * Kind 38421 is not exclusive to routstr — unrelated projects publish their
   * own addressable events on it (e.g. `lnproxy-v1` advertisement updates,
   * which have neither field). Without this gate those events are stored,
   * verified, and counted as discovery evidence.
   */
  private isProviderAnnouncement(event: NostrEvent): boolean {
    for (const tag of event.tags) {
      if (tag[0] === "u" && typeof tag[1] === "string" && tag[1]) return true;
    }
    // Directory-style announcements hold the URLs in JSON content instead.
    // Check the raw string first so rejected events are never JSON-parsed.
    const content = event.content;
    if (!content.includes("endpoint_url") && !content.includes("providers")) {
      return false;
    }
    try {
      const parsed = JSON.parse(content);
      const providers = Array.isArray(parsed)
        ? parsed
        : parsed?.providers ?? [];
      return Array.isArray(providers) && providers.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Read discovery evidence from the event store.
   *
   * `filter` belongs to the relay subscription and may carry a `limit`; that
   * limit must not reach the store read. The store is the accumulated history
   * and applying a row limit to it truncates the evidence to the newest N
   * rows — which a high-volume unrelated publisher on the same kind can
   * monopolize, silently evicting providers (and reviews) from discovery.
   * Superseded versions are collapsed instead, so the newest event per
   * address is what costs a signature verification.
   */
  private readStoredEvents(
    eventStore: EventStore,
    filter: Filter,
    accept?: (event: NostrEvent) => boolean
  ): NostrEvent[] {
    const { limit: _relayOnlyLimit, ...storeFilter } = filter;
    return this.newestTrustworthyPerAddress(
      this.groupByAddress(
        eventStore
          .getTimeline(storeFilter)
          .filter((event) => !accept || accept(event))
      )
    );
  }

  /**
   * Group stored rows by replaceable address, newest first.
   */
  private groupByAddress(rows: NostrEvent[]): NostrEvent[][] {
    const byAddress = new Map<string, NostrEvent[]>();

    for (const event of rows) {
      // Regular events have no history to collapse.
      const address = isReplaceable(event.kind)
        ? `${event.kind}:${event.pubkey}:${getReplaceableIdentifier(event)}`
        : `event:${event.id}`;
      const group = byAddress.get(address);
      if (group) group.push(event);
      else byAddress.set(address, [event]);
    }

    return Array.from(byAddress.values(), (group) =>
      group.sort(
        (a, b) =>
          b.created_at - a.created_at ||
          (a.id === b.id ? 0 : a.id < b.id ? 1 : -1)
      )
    );
  }

  /**
   * Collapse the persisted versions of every address to the newest
   * trustworthy one, verifying candidates newest-first so a forged newer
   * version cannot evict a genuine older one and honest addresses pay one
   * verification.
   */
  private newestTrustworthyPerAddress(groups: NostrEvent[][]): NostrEvent[] {
    const latest: NostrEvent[] = [];
    for (const group of groups) {
      const winner = group.find((candidate) =>
        this.isNostrEventTrustworthy(candidate)
      );
      if (winner) latest.push(winner);
    }
    return latest;
  }

  /**
   * Query Nostr events for a filter from the event store (persistent or
   * memory fallback), live-fetching from relays only when forced, the store is
   * empty for the filter, or the last successful fetch for the filter is
   * older than cacheTTL. Every returned event passes the trust gate exactly
   * once per call; `onEvent` fires once per returned event. `accept` scopes a
   * query to the events it can actually use, so unrelated publishers sharing
   * the kind are never stored, verified, or counted as evidence.
   */
  private async getNostrEvents(
    filter: Filter,
    forceRefresh: boolean = false,
    onEvent?: (event: NostrEvent) => void,
    accept?: (event: NostrEvent) => boolean
  ): Promise<NostrEvent[]> {
    const eventStore = (await this.ensureEventStore()) ?? this.memoryEventStore;
    const query = JSON.stringify(filter);
    const lastUpdate = this.queryLastUpdate.get(query) ??
      this.adapter.getNostrQueryLastUpdate?.()?.[query];
    const now = Date.now();
    const cacheValid = typeof lastUpdate === "number" &&
      lastUpdate <= now && now - lastUpdate <= this.cacheTTL;
    const received = new Set<string>();

    // forceRefresh decides the fetch branch on its own; the verified store
    // read would be discarded, so skip it entirely.
    const cached = forceRefresh
      ? []
      : this.readStoredEvents(eventStore, filter, accept);

    if (forceRefresh || cached.length === 0 || !cacheValid) {
      await this.collectNostrEvents(
        filter, this.getNostrRelays(), NOSTR_QUERY_TIMEOUT_MS,
        (event) => {
          // Relay noise that this query cannot use is not evidence, so it is
          // not persisted and does not renew the query cache.
          if (accept && !accept(event)) return;
          const stored = eventStore.add(event);
          if (!stored || stored.id !== event.id) return;
          received.add(event.id);
          onEvent?.(event);
        }
      );

      // Relay errors can complete an empty stream. Only returned evidence renews the query cache.
      if (received.size > 0) {
        this.queryLastUpdate.set(query, Date.now());
        this.adapter.setNostrQueryLastUpdate?.({
          ...this.adapter.getNostrQueryLastUpdate?.(),
          ...Object.fromEntries(this.queryLastUpdate),
        });
      }

      // Refresh timing does not expire saved announcements or reviews; the
      // re-read picks up both newly stored and previously saved events.
      const events = this.readStoredEvents(eventStore, filter, accept);
      for (const event of events) {
        if (!received.has(event.id)) onEvent?.(event);
      }
      return events;
    }

    // Cache hit: `cached` was verified moments ago and nothing has touched
    // the store since, so reuse it instead of re-reading the timeline. No
    // fetch ran, so `received` is empty and every event fires exactly once.
    for (const event of cached) {
      onEvent?.(event);
    }
    return cached;
  }

  /**
   * Drop persisted discovery events that can never win a read: superseded
   * versions of replaceable events, and kind-38421 events that are not
   * provider announcements. Discovery evidence is append-only, so without
   * this the store grows forever and a single unrelated publisher on the
   * same kind slows every read (and every bootstrap) down.
   *
   * In-memory query caches still point at events removed here only when they
   * were superseded, so reads are unaffected. Best effort: never throws.
   *
   * @returns Number of events removed
   */
  async pruneSupersededDiscoveryEvents(): Promise<number> {
    const eventStore = await this.ensureEventStore();
    if (!eventStore) return 0;

    let removed = 0;
    try {
      for (const kind of DISCOVERY_KINDS) {
        const accept = kind === 38421
          ? (event: NostrEvent) => this.isProviderAnnouncement(event)
          : undefined;
        const rows = eventStore.getTimeline({ kinds: [kind] });
        // Rows the read dropped are either superseded versions or events the
        // query rejects outright; neither can ever be returned again. An
        // address with no trustworthy version keeps its newest row, so a
        // future-dated event is not destroyed while the clock catches up.
        const keep = new Set<string>();
        for (const group of this.groupByAddress(
          rows.filter((event) => !accept || accept(event))
        )) {
          const winner = group.find((candidate) =>
            this.isNostrEventTrustworthy(candidate)
          );
          keep.add((winner ?? group[0]!).id);
        }
        const staleIds = rows
          .filter((event) => !keep.has(event.id))
          .map((event) => event.id);

        for (let i = 0; i < staleIds.length; i += PRUNE_CHUNK_SIZE) {
          removed += eventStore.removeByFilters({
            ids: staleIds.slice(i, i + PRUNE_CHUNK_SIZE),
          });
        }
      }
    } catch (error) {
      this.logger.warn("pruneSupersededDiscoveryEvents failed:", error);
    }

    return removed;
  }

  /**
   * Fetch current events from live Nostr relays for all tracked kinds
   * (38421 providers, 38425 reviews, 38423 routstr21 models, 38426 mappings) and persist them
   * into the event store. Existing events are not replaced — new events are
   * merged in. Call this periodically (e.g. every 21 min) to discover new
   * providers, reviews, model lists, and mappings published since the last fetch.
   */
  async refreshNostrEvents(): Promise<void> {
    const eventStore = await this.ensureEventStore();
    if (!eventStore) {
      this.logger.warn("refreshNostrEvents: no event store configured, skipping");
      return;
    }

    // Independent relay filters share one timeout window. Policy application
    // and pruning must wait for every query (including mappings) to finish.
    await Promise.all([
      this.getNostrEvents(
        { kinds: [38421], limit: 100 }, true, undefined,
        (event) => this.isProviderAnnouncement(event)
      ),
      // Fetch all review labels, including approval -> avoid reversals.
      this.getNostrEvents(
        { kinds: [38425], limit: 500, authors: [this.routstrPubkey] }, true
      ),
      this.getNostrEvents(
        { kinds: [38423], "#d": ["routstr-21-models"], authors: [this.routstrModelsPubkey] }, true
      ),
      this.fetchModelIdMappings(true),
    ]);

    // Per-scheduled-pass chatter: the caller reports the pass outcome, so the
    // phase markers stay at `debug` rather than re-printing every 21 minutes.
    this.logger.debug("refreshNostrEvents: live fetch complete");

    const pruned = await this.pruneSupersededDiscoveryEvents();
    if (pruned > 0) {
      this.logger.debug(
        `refreshNostrEvents: pruned ${pruned} superseded discovery event(s)`
      );
    }

    // Re-apply review-based provider disables against the freshly-updated
    // store. A newly published `avoid` review (or an lgtm→avoid reversal) must
    // take effect now, not on the next bootstrap/manual refresh.
    await this.syncReviewedProvidersFromNostr();
  }

  static async init(
    adapter: DiscoveryAdapter,
    config: ModelManagerConfig = {},
    options: { torMode?: boolean; forceRefresh?: boolean } = {}
  ): Promise<ModelManager> {
    const manager = new ModelManager(adapter, config);
    const torMode = options.torMode ?? false;
    const forceRefresh = options.forceRefresh ?? false;
    const providers = await manager.bootstrapProviders(torMode, forceRefresh);
    await manager.fetchModels(providers, forceRefresh);
    return manager;
  }

  /**
   * Bootstrap provider list from the provider directory
   * First tries to fetch from Nostr (kind 30421), falls back to HTTP
   * @param torMode Whether running in Tor context
   * @param forceRefresh Ignore provider cache and refresh provider sources
   * @returns Array of provider base URLs
   * @throws ProviderBootstrapError if all providers fail to fetch
   */
  async bootstrapProviders(
    torMode: boolean = false,
    forceRefresh: boolean = false,
    options: BootstrapOptions = {}
  ): Promise<string[]> {
    // First try cache
    if (!forceRefresh) {
      const cachedUrls = this.adapter.getBaseUrlsList();
      if (cachedUrls.length > 0) {
        const lastUpdate = this.adapter.getBaseUrlsLastUpdate();
        const cacheValid =
          lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;
        if (cacheValid) {
          const filteredCachedUrls = this.filterBaseUrlsForTor(
            cachedUrls,
            torMode
          );
          await Promise.all([
            this.fetchRoutstr21Models(forceRefresh),
            this.fetchModelIdMappings(forceRefresh),
            this.syncReviewedProvidersFromNostr(filteredCachedUrls),
          ]);
          return filteredCachedUrls;
        }
      }
    }

    // Try Nostr first (kind 38421)
    try {
      // The queries are independent: run them concurrently so a cold
      // bootstrap costs one relay round trip. Prefetch failures fall back
      // to empty; a broken event store still surfaces via the 38421 query.
      const routstr21Prefetch = this.fetchRoutstr21Models(forceRefresh).catch(
        () => [] as string[]
      );
      const mappingsPrefetch = this.fetchModelIdMappings(forceRefresh).catch(
        () => this.getModelIdMappings()
      );
      // Skip the review query when the adapter cannot store its result,
      // matching the wrapper's early return instead of waiting it out.
      const reviewPrefetch = this.adapter.setDisabledProviders
        ? this.fetchReviewLabels(forceRefresh).catch(
            () => new Map<string, string>()
          )
        : Promise.resolve(new Map<string, string>());
      const nostrProviders = await this.bootstrapFromNostr(
        38421,
        torMode,
        forceRefresh,
        options
      );
      if (nostrProviders.length > 0) {
        const filtered = this.filterBaseUrlsForTor(nostrProviders, torMode);
        this.adapter.setBaseUrlsList(filtered);
        this.adapter.setBaseUrlsLastUpdate(Date.now());
        await Promise.all([routstr21Prefetch, mappingsPrefetch]);
        this.applyReviewDisables(
          filtered,
          this.providerNodePubkeysByUrl,
          await reviewPrefetch
        );
        return filtered;
      }
    } catch (e) {
      this.logger.warn("Nostr bootstrap failed, falling back to HTTP:", e);
    }

    // Fall back to HTTP
    return this.bootstrapFromHttp(torMode, forceRefresh);
  }

  /**
   * Resolve Nostr relay URLs.
   * Returns user-configured relays if set, otherwise the shared defaults.
   */
  private getNostrRelays(): string[] {
    return this.nostrRelays && this.nostrRelays.length > 0
      ? this.nostrRelays
      : DEFAULT_NOSTR_RELAYS;
  }

  /** True when the event's created_at is beyond a sane future-drift window. */
  private isFutureDated(event: NostrEvent): boolean {
    const max = Math.floor(Date.now() / 1000) + MAX_EVENT_FUTURE_DRIFT_SECONDS;
    return event.created_at > max;
  }

  // getTimeline does not verify hydrated records; use the same trust gate for reads and relay events.
  private isNostrEventTrustworthy(event: NostrEvent): boolean {
    let valid = false;
    try {
      valid = verifyEvent(event);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.logger.warn(
        `Nostr: dropping kind ${event.kind} event ${event.id}: invalid signature`
      );
      return false;
    }
    if (this.isFutureDated(event)) {
      this.logger.warn(
        `Nostr: dropping kind ${event.kind} event ${event.id}: created_at ${event.created_at} is too far in the future`
      );
      return false;
    }
    return true;
  }

  /**
   * Collect events for a one-shot query. Resolves once every relay has sent
   * EOSE (connection failures count as EOSE) or after timeoutMs, whichever
   * comes first. Events are deduplicated by id across relays.
   */
  private async collectNostrEvents(
    filter: {
      kinds?: number[];
      authors?: string[];
      "#t"?: string[];
      "#d"?: string[];
      limit?: number;
    },
    relays: string[],
    timeoutMs: number,
    onEvent: (event: NostrEvent) => void
  ): Promise<void> {
    if (!this.relayPool) this.relayPool = new RelayPool();
    const pool = this.relayPool;
    const seen = new Set<string>();

    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let subscription: { unsubscribe(): void } | undefined;
      // The stream can complete synchronously (all relays cached/failed), so
      // finish must tolerate timer and subscription not being assigned yet.
      const finish = () => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        subscription?.unsubscribe();
        resolve();
      };

      subscription = pool.request(relays, filter).subscribe({
        next: (event) => {
          if (seen.has(event.id)) return;
          seen.add(event.id);
          if (!this.isNostrEventTrustworthy(event)) return;
          onEvent(event);
        },
        error: finish,
        complete: finish,
      });

      if (!done) timer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Bootstrap providers from Nostr network (kind 38421)
   * @param kind The Nostr kind to fetch
   * @param torMode Whether running in Tor context
   * @returns Array of provider base URLs
   */
  private async bootstrapFromNostr(
    kind: number,
    torMode: boolean,
    forceRefresh: boolean = false,
    options: BootstrapOptions = {}
  ): Promise<string[]> {
    const bases = new Set<string>();
    this.providerNodePubkeysByUrl = new Map();
    const excluded = new Set(
      this.excludeProviderUrls.map((url) => this.normalizeUrl(url))
    );
    let eventsFound = 0;

    const addBase = (url: string, pubkey?: string) => {
      const isNew = !bases.has(url);
      bases.add(url);
      this.addProviderNode(this.providerNodePubkeysByUrl, url, pubkey);
      // Announce only URLs that survive the caller's final Tor filter, so
      // the callback set matches the returned list by construction.
      if (
        isNew &&
        !excluded.has(url) &&
        this.filterBaseUrlsForTor([url], torMode).length > 0
      ) {
        options.onProvider?.(url);
      }
    };

    // Events are parsed as they arrive so callers can show live progress.
    const collectFromEvent = (event: NostrEvent) => {
      eventsFound += 1;
      options.onEventsFound?.(eventsFound);

      const eventUrls: string[] = [];

      for (const tag of event.tags) {
        if (tag[0] === "u" && typeof tag[1] === "string") {
          eventUrls.push(tag[1]);
        }
      }

      if (eventUrls.length > 0) {
        for (const url of eventUrls) {
          const normalized = this.normalizeUrl(url);
          if (!torMode || normalized.includes(".onion")) {
            addBase(normalized, event.pubkey);
          }
        }
        return;
      }

      try {
        const content = JSON.parse(event.content);
        const providers = Array.isArray(content)
          ? content
          : content.providers || [];

        for (const p of providers) {
          const endpoints = this.getProviderEndpoints(p, torMode);
          for (const endpoint of endpoints) {
            addBase(endpoint, p?.pubkey || event.pubkey);
          }
        }
      } catch {
        try {
          const providers = JSON.parse(event.content);
          if (Array.isArray(providers)) {
            for (const p of providers) {
              const endpoints = this.getProviderEndpoints(p, torMode);
              for (const endpoint of endpoints) {
                addBase(endpoint, p?.pubkey || event.pubkey);
              }
            }
          }
        } catch {
          this.logger.warn(
            "NostrBootstrap: failed to parse event content:",
            event.id
          );
        }
      }
    };

    await this.getNostrEvents(
      { kinds: [kind], limit: 100 },
      forceRefresh,
      collectFromEvent,
      kind === 38421
        ? (event) => this.isProviderAnnouncement(event)
        : undefined
    );

    // Add additional configured providers
    for (const url of this.includeProviderUrls) {
      const normalized = this.normalizeUrl(url);
      if (!torMode || normalized.includes(".onion")) {
        bases.add(normalized);
      }
    }

    const result = Array.from(bases).filter((base) => !excluded.has(base));

    return result;
  }

  /**
   * Bootstrap providers from HTTP endpoint
   * @param torMode Whether running in Tor context
   * @param forceRefresh Ignore routstr21 cache and fetch fresh data
   * @returns Array of provider base URLs
   */
  private async bootstrapFromHttp(
    torMode: boolean,
    forceRefresh: boolean = false
  ): Promise<string[]> {
    try {
      const res = await fetch(this.providerDirectoryUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch providers: ${res.status}`);
      }

      const data = await res.json();
      const providers = Array.isArray(data?.providers) ? data.providers : [];

      const bases = new Set<string>();
      this.providerNodePubkeysByUrl = new Map();
      for (const p of providers) {
        const endpoints = this.getProviderEndpoints(p, torMode);
        for (const endpoint of endpoints) {
          bases.add(endpoint);
          this.addProviderNode(this.providerNodePubkeysByUrl, endpoint, p?.pubkey);
        }
      }

      for (const url of this.includeProviderUrls) {
        const normalized = this.normalizeUrl(url);
        if (!torMode || normalized.includes(".onion")) {
          bases.add(normalized);
        }
      }

      const excluded = new Set(
        this.excludeProviderUrls.map((url) => this.normalizeUrl(url))
      );

      const list = Array.from(bases).filter((base) => !excluded.has(base));

      if (list.length > 0) {
        this.adapter.setBaseUrlsList(list);
        this.adapter.setBaseUrlsLastUpdate(Date.now());
        await Promise.all([
          this.fetchRoutstr21Models(forceRefresh),
          this.fetchModelIdMappings(forceRefresh),
          this.syncReviewedProvidersFromNostr(
            list,
            this.providerNodePubkeysByUrl,
            forceRefresh
          ),
        ]);
      }

      return list;
    } catch (e) {
      this.logger.error("Failed to bootstrap providers", e);
      throw new ProviderBootstrapError([], `Provider bootstrap failed: ${e}`);
    }
  }

  /**
   * Fetch Routstr review events from Nostr (kind 38425) and disable providers
   * whose 38421 node pubkey does not have a positive review (`lgtm` and friends)
   * or whose latest review is negative (`avoid` and friends).
   *
   * Review events are expected to have:
   * - `node`: the reviewed 38421 provider event pubkey
   * - `t`: review label, where `lgtm`/`lgtm2`/`trusted`/`verified` mean the node
   *   looks good and `avoid`/`suspicious`/`blacklisted`/`removed` mean it is unsafe
   *
   * Kind 38425 is not replaceable, so several review events can exist for one
   * node; the newest event (by `created_at`) is authoritative.
   *
   * Fails CLOSED: when reviews (or 38421 node metadata) are unavailable,
   * providers are treated as unreviewed and disabled, not left enabled.
   * Manually re-enabled providers are exempt.
   *
   * @param baseUrls Current provider base URLs to evaluate
   * @returns Array of provider base URLs disabled by the review set
   */
  async syncReviewedProvidersFromNostr(
    baseUrls: string[] = this.adapter.getBaseUrlsList(),
    providerNodes?: Map<string, Set<string>>,
    forceRefresh: boolean = false
  ): Promise<string[] | null> {
    if (baseUrls.length === 0) return null;

    if (!this.adapter.setDisabledProviders) {
      this.logger.warn(
        "NostrReviews: adapter does not support setDisabledProviders; skipping provider disable sync"
      );
      return null;
    }

    if (!providerNodes || providerNodes.size === 0) {
      providerNodes = await this.rebuildProviderNodesFromStore(forceRefresh);
      if (
        !forceRefresh && providerNodes.size > 0 &&
        baseUrls.some((url) => !providerNodes!.has(this.normalizeUrl(url)))
      ) {
        providerNodes = await this.rebuildProviderNodesFromStore(true);
      }
      this.providerNodePubkeysByUrl = providerNodes;
    }

    const reviewLabels = await this.fetchReviewLabels(forceRefresh);
    return this.applyReviewDisables(baseUrls, providerNodes, reviewLabels);
  }

  /**
   * Review labels that enable a node by default (`lgtm` and friends).
   * Exposed so callers never hardcode the default set.
   */
  getDefaultEnabledReviewLabels(): string[] {
    return [...DEFAULT_ENABLED_REVIEW_LABELS];
  }

  /**
   * Review labels the user opted into on top of the defaults (e.g. `sandbox`).
   * Empty until configured: these labels do NOT enable a node by themselves.
   */
  getUserEnabledReviewLabels(): string[] {
    return normalizeReviewLabels(
      this.adapter.getUserEnabledReviewLabels?.() ?? []
    );
  }

  /**
   * Effective enable labels: {@link getDefaultEnabledReviewLabels} ∪
   * {@link getUserEnabledReviewLabels}. A node is enabled by the review sync
   * only when its latest label is in this set (and it is not negatively
   * labelled).
   */
  getEnabledReviewLabels(): string[] {
    return [
      ...new Set([
        ...this.getDefaultEnabledReviewLabels(),
        ...this.getUserEnabledReviewLabels(),
      ]),
    ];
  }

  /**
   * Replace the user-enabled review label set. Persisted by the adapter, so an
   * opt-in such as `sandbox` survives restarts and applies to nodes discovered
   * later. Returns the normalised, stored list.
   */
  setUserEnabledReviewLabels(labels: string[]): string[] {
    if (!this.adapter.setUserEnabledReviewLabels) {
      this.logger.warn(
        "setUserEnabledReviewLabels: adapter does not support user-enabled review labels; ignoring"
      );
      return this.getUserEnabledReviewLabels();
    }
    const normalized = normalizeReviewLabels(labels);
    this.adapter.setUserEnabledReviewLabels(normalized);
    return normalized;
  }

  /**
   * Opt a single review label (e.g. `sandbox`) in. Returns the resulting set.
   */
  addUserEnabledReviewLabel(label: string): string[] {
    return this.setUserEnabledReviewLabels([
      ...this.getUserEnabledReviewLabels(),
      label,
    ]);
  }

  /**
   * Opt a single review label out. Returns the resulting set. Removing a
   * default label here has no effect (defaults are always enabled).
   */
  removeUserEnabledReviewLabel(label: string): string[] {
    const target = normalizeReviewLabel(label);
    return this.setUserEnabledReviewLabels(
      this.getUserEnabledReviewLabels().filter((entry) => entry !== target)
    );
  }

  /**
   * Provider/review index over the trusted store: provider URL -> advertising
   * node pubkeys, the stored kind-38425 review events, and each node's latest
   * label. Built from the same evidence (and trust gates) as the review sync,
   * so callers do not re-derive provider/review parsing.
   */
  async getProviderReviewIndex(
    forceRefresh: boolean = false
  ): Promise<ProviderReviewIndex> {
    const providerNodes = await this.rebuildProviderNodesFromStore(forceRefresh);
    this.providerNodePubkeysByUrl = providerNodes;
    const reviewEvents = await this.getNostrEvents(
      { kinds: [38425], limit: 500, authors: [this.routstrPubkey] },
      forceRefresh
    );
    return {
      providerNodes,
      reviewEvents,
      latestLabelByNode: latestReviewLabelsByNode(reviewEvents),
    };
  }

  /**
   * Resolve review labels (e.g. `sandbox`) to the provider base URLs whose
   * latest review carries them, using the same trusted index as the review
   * sync. Reports labels that matched nothing so a CLI can warn about typos.
   */
  async matchProviderUrlsByLabels(
    labels: string[],
    baseUrls: string[] = this.adapter.getBaseUrlsList(),
    forceRefresh: boolean = false
  ): Promise<ReviewLabelMatch> {
    const { providerNodes, latestLabelByNode } =
      await this.getProviderReviewIndex(forceRefresh);

    const matchedUrls: string[] = [];
    const matchedLabels: string[] = [];
    const unmatchedLabels: string[] = [];

    for (const rawLabel of labels) {
      const label = normalizeReviewLabel(rawLabel);
      if (!label) continue;

      let labelMatched = false;
      for (const baseUrl of baseUrls) {
        const nodePubkeys = providerNodes.get(this.normalizeUrl(baseUrl));
        if (!nodePubkeys) continue;
        const hit = Array.from(nodePubkeys).some(
          (pubkey) => latestLabelByNode.get(pubkey) === label
        );
        if (hit) {
          labelMatched = true;
          if (!matchedUrls.includes(baseUrl)) matchedUrls.push(baseUrl);
        }
      }

      if (labelMatched) {
        if (!matchedLabels.includes(label)) matchedLabels.push(label);
      } else if (!unmatchedLabels.includes(label)) {
        unmatchedLabels.push(label);
      }
    }

    return { matchedUrls, matchedLabels, unmatchedLabels };
  }

  // Restore provider identities even when a warm URL cache skipped discovery.
  private async rebuildProviderNodesFromStore(forceRefresh: boolean): Promise<
    Map<string, Set<string>>
  > {
    const map = new Map<string, Set<string>>();
    const addNode = (url: string, pubkey?: string) => {
      if (!pubkey) return;
      const normalized = this.normalizeUrl(url);
      const existing = map.get(normalized) || new Set<string>();
      existing.add(pubkey);
      map.set(normalized, existing);
    };

    const events = await this.getNostrEvents(
      { kinds: [38421], limit: 100 },
      forceRefresh,
      undefined,
      (event) => this.isProviderAnnouncement(event)
    );
    for (const event of events) {
      const eventUrls: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === "u" && typeof tag[1] === "string" && tag[1]) {
          eventUrls.push(tag[1]);
        }
      }

      if (eventUrls.length > 0) {
        for (const url of eventUrls) {
          addNode(url, event.pubkey);
        }
        continue;
      }

      try {
        const content = JSON.parse(event.content);
        const providers = Array.isArray(content)
          ? content
          : content.providers || [];
        for (const p of providers) {
          const endpoints = [
            ...this.getProviderEndpoints(p, false),
            ...this.getProviderEndpoints(p, true),
          ];
          for (const endpoint of endpoints) {
            addNode(endpoint, p?.pubkey || event.pubkey);
          }
        }
      } catch {
        /* unparseable content — ignore */
      }
    }

    return map;
  }

  /**
   * Fetch kind 38425 review/audit events (persistent store or live) authored
   * by the routstr pubkey and return the latest label per reviewed node pubkey.
   */
  private async fetchReviewLabels(
    forceRefresh: boolean = false
  ): Promise<Map<string, string>> {
    const events = await this.getNostrEvents(
      { kinds: [38425], limit: 500, authors: [this.routstrPubkey] },
      forceRefresh
    );
    return latestReviewLabelsByNode(events);
  }

  /**
   * Latest review label per reviewed node pubkey. Public read-only view of the
   * review evidence the enable/disable policy is computed from.
   */
  async getReviewLabels(forceRefresh: boolean = false): Promise<Map<string, string>> {
    return this.fetchReviewLabels(forceRefresh);
  }

  /**
   * Disable providers whose node pubkeys carry no positive review, or whose
   * latest review is negative. A provider stays enabled only when at least one
   * of its node pubkeys has a positive latest label and none of its node
   * pubkeys has a negative latest label.
   *
   * Compute-only counterpart of syncReviewedProvidersFromNostr.
   */
  private applyReviewDisables(
    baseUrls: string[],
    providerNodes: Map<string, Set<string>>,
    reviewLabels: Map<string, string>
  ): string[] | null {
    if (baseUrls.length === 0) return null;

    if (!this.adapter.setDisabledProviders) {
      this.logger.warn(
        "NostrReviews: adapter does not support setDisabledProviders; skipping provider disable sync"
      );
      return null;
    }

    // Fail closed: no evidence means unreviewed, and unreviewed is disabled.
    if (reviewLabels.size === 0) {
      this.logger.warn(
        "NostrReviews: no kind 38425 review events found; treating all providers as unreviewed (fail-closed)"
      );
    }

    if (providerNodes.size === 0) {
      this.logger.warn(
        "NostrReviews: no kind 38421 provider node metadata found; treating all providers as unreviewed (fail-closed)"
      );
    }

    // Providers the user explicitly re-enabled must not be re-disabled by
    // the review sync, even when their node has no positive review.
    const manuallyEnabled = new Set(
      (this.adapter.getManuallyEnabledProviders?.() ?? []).map((url) =>
        this.normalizeUrl(url)
      )
    );

    // Defaults (lgtm and friends) plus any labels the user opted into (e.g.
    // `sandbox`). A label outside this set — including `sandbox` by default —
    // is treated as unreviewed and leaves the node disabled.
    const enabledLabels = new Set(this.getEnabledReviewLabels());

    const isPositive = (label: string | undefined) =>
      !!label && enabledLabels.has(label);
    const isNegative = (label: string | undefined) =>
      !!label && NEGATIVE_REVIEW_LABELS.has(label);

    // Build the review-disabled set. A negative label always disables (even if
    // an older positive review exists); otherwise a node without a positive
    // review stays disabled by default. This only updates the auto/review-based
    // disabled list — manually disabled providers are tracked separately via
    // setManuallyDisabledProviders and the effective disabled set is the union
    // of both (returned by getDisabledProviders).
    const disabledByReview: string[] = [];
    for (const url of baseUrls) {
      const normalized = this.normalizeUrl(url);
      if (manuallyEnabled.has(normalized)) continue;
      const nodePubkeys = providerNodes.get(normalized) || new Set<string>();
      const labels = Array.from(nodePubkeys).map((pubkey) =>
        reviewLabels.get(pubkey)
      );
      const hasNegative = labels.some(isNegative);
      const hasPositive = labels.some(isPositive);
      if (hasNegative || !hasPositive) {
        disabledByReview.push(normalized);
      }
    }

    // Carry forward previously-disabled providers that are no longer
    // in the current bootstrap's baseUrls (e.g. their kind-38421 event
    // was lost from relays).  Without this, a re-bootstrap silently
    // re-enables providers whose Nostr event disappeared.
    const previousDisabled = this.adapter.getDisabledProviders();
    const currentBaseUrls = new Set(
      baseUrls.map((url) => this.normalizeUrl(url))
    );
    for (const url of previousDisabled) {
      if (!currentBaseUrls.has(url)) {
        disabledByReview.push(url);
      }
    }

    this.adapter.setDisabledProviders(Array.from(new Set(disabledByReview)));

    return disabledByReview;
  }

  private addProviderNode(
    map: Map<string, Set<string>>,
    url: string,
    pubkey?: string
  ): void {
    if (!pubkey) return;
    const normalized = this.normalizeUrl(url);
    const existing = map.get(normalized) || new Set<string>();
    existing.add(pubkey);
    map.set(normalized, existing);
  }


  /**
   * Fetch models from all providers and select best-priced options
   * Uses cache if available and not expired
   * @param baseUrls List of provider base URLs to fetch from
   * @param forceRefresh Ignore cache and fetch fresh data
   * @param onProgress Callback fired after each provider completes with current combined models
   * @returns Array of unique models with best prices selected
   */
  async fetchModels(
    baseUrls: string[],
    forceRefresh: boolean = false,
    onProgress?: (models: Model[]) => void
  ): Promise<Model[]> {
    if (baseUrls.length === 0) {
      throw new NoProvidersAvailableError();
    }

    const startedAt = Date.now();
    const passId = ++this.modelPassSequence;
    const normalizedUrls = new Set(baseUrls.map((url) =>
      url.endsWith("/") ? url : `${url}/`
    ));
    this.latestModelPassUrls = normalizedUrls;
    this.activeModelPasses.set(passId, normalizedUrls);
    try {
      // Bootstrap refreshes mappings before model grouping. Direct fetchModels
      // calls use the already-hydrated snapshot (or bundled offline fallback).
      const mappings = this.getModelIdMappings();
      const bestById = new Map<string, { model: Model; base: string }>();
      // Only network-fetched bases get a new stamp, so cache hits do not
      // slide the expiry window and failed fetches are retried next pass.
      const freshlyFetched = new Set<string>();
      const disabledProviders = this.adapter.getDisabledProviders();

      // Helper to estimate minimum cost for a model
      const estimateMinCost = (m: Model): number => {
        return m?.sats_pricing?.completion ?? 0;
      };

      // Helper to emit current progress
      const emitProgress = () => {
        if (onProgress) {
          const currentModels = Array.from(bestById.values()).map((v) => v.model);
          onProgress(currentModels);
        }
      };

      // Fetch from all providers in parallel with progressive updates
      const fetchPromises = baseUrls.map(async (url) => {
        const base = url.endsWith("/") ? url : `${url}/`;
        try {
          // Check cache if not forcing refresh
          let list: Model[];

          if (!forceRefresh) {
            const lastUpdate = this.adapter.getProviderLastUpdate(base);
            const cacheValid =
              lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;
            const cachedModels = this.adapter.getCachedModels();

            // Trust a stamp only when its payload actually exists: stamps
            // written without payloads (older SDK versions) must refetch.
            if (cacheValid && base in cachedModels) {
              list = cachedModels[base];
            } else {
              // Cache expired or doesn't exist, fetch fresh
              list = await this.fetchModelsFromProvider(base);
              freshlyFetched.add(base);
            }
          } else {
            // Force refresh
            list = await this.fetchModelsFromProvider(base);
            freshlyFetched.add(base);
          }

          // Update best-priced models if provider not disabled
          if (!disabledProviders.includes(base)) {
            for (const m of list) {
              // Group by canonical id so providers serving the same model
              // under a mapped variant id or alias fold into one entry.
              const canonicalId = canonicalIdForModel(m, mappings);
              const existing = bestById.get(canonicalId);

              // Skip models without sats pricing
              if (!m.sats_pricing) continue;

              if (!existing) {
                bestById.set(canonicalId, { model: m, base });
                continue;
              }

              // Replace if this provider has lower cost
              const currentCost = estimateMinCost(m);
              const existingCost = estimateMinCost(existing.model);
              if (currentCost < existingCost && m.sats_pricing) {
                bestById.set(canonicalId, { model: m, base });
              }
            }
          }

          emitProgress();

          return { base };
        } catch (error) {
          // No stamp on failure, or the provider is served as "offers
          // nothing" until the TTL expires; last known models keep serving.
          // The raw error text is kept, but reporting is deferred to the end of
          // the pass so a node that has been down for days cannot re-print its
          // error line on every refresh. See reportProviderFailures().
          return { base, failure: classifyProviderFailure(error) };
        }
      });

      const settled = await Promise.allSettled(fetchPromises);
      this.reportProviderFailures(
        settled.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : []
        ),
        freshlyFetched,
        baseUrls.length,
        Date.now() - startedAt
      );

      // Return this caller's subset, with its own policy snapshot/progress.
      return Array.from(bestById.values()).map((v) => v.model);
    } finally {
      this.activeModelPasses.delete(passId);
      // A finishing older/narrower pass must not erase a newer pass's results.
      // Keep active callers' subsets too; once they settle, the most recently
      // requested provider set is authoritative for pruning.
      const keep = new Set(this.latestModelPassUrls);
      for (const urls of this.activeModelPasses.values()) {
        for (const url of urls) keep.add(url);
      }
      const cache = this.adapter.getCachedModels();
      const retained: Record<string, Model[]> = {};
      for (const [url, models] of Object.entries(cache)) {
        if (keep.has(url)) retained[url] = models;
        else this.adapter.setProviderLastUpdate(url, 0);
      }
      this.adapter.setCachedModels(retained);
    }
  }

  /**
   * Fetch models from a single provider
   * @param baseUrl Provider base URL
   * @returns Array of models from provider
   */
  private fetchModelsFromProvider(baseUrl: string): Promise<Model[]> {
    const running = this.providerModelRequests.get(baseUrl);
    if (running) return running;

    const request = withProviderDeadline(async (signal) => {
      const res = await fetch(`${baseUrl}v1/models`, { signal });
      if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
      const json = await res.json();
      return (Array.isArray(json?.data) ? json.data : []) as Model[];
    }, PROVIDER_FETCH_TIMEOUT_MS).then((list) => {
      // Only the bounded result can publish, never a late underlying response.
      this.adapter.setCachedModels({ ...this.adapter.getCachedModels(), [baseUrl]: list });
      this.adapter.setProviderLastUpdate(baseUrl, Date.now());
      return list;
    }).finally(() => {
      this.providerModelRequests.delete(baseUrl);
    });
    this.providerModelRequests.set(baseUrl, request);
    return request;
  }

  /**
   * Report reachability for one fetch pass as state transitions plus a single
   * summary, instead of one line per provider per pass. The diff itself lives
   * in `providerOutageReport.ts`; this only emits the lines it returns.
   *
   * The per-provider detail is at `debug`, so suppression applies to consumers
   * that inject a level-filtering logger: `consoleLogger`, the default when no
   * logger is injected, prints `debug` like everything else.
   */
  private reportProviderFailures(
    outcomes: ProviderOutcome[],
    freshlyFetched: Set<string>,
    total: number,
    elapsedMs: number
  ): void {
    const report = diffProviderOutage(
      this.providerFailures,
      outcomes,
      freshlyFetched,
      total,
      elapsedMs
    );
    this.providerFailures = report.failures;

    for (const line of report.lines) {
      if (line.level === "warn") this.logger.warn(line.message);
      else if (line.level === "info") this.logger.log(line.message);
      else this.logger.debug(line.message);
    }
  }

  /**
   * Get all cached models from all providers
   * @returns Record mapping baseUrl -> models
   */
  getAllCachedModels(): Record<string, Model[]> {
    return this.adapter.getCachedModels();
  }

  /**
   * Clear cache for a specific provider
   * @param baseUrl Provider base URL
   */
  clearProviderCache(baseUrl: string): void {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    // Stamp first: a reader between the two writes must see stale, not
    // fresh-and-empty.
    this.adapter.setProviderLastUpdate(base, 0);
    const cached = this.adapter.getCachedModels();
    delete cached[base];
    this.adapter.setCachedModels(cached);
  }

  /**
   * Clear all model caches
   */
  clearAllCache(): void {
    // Stamps die with their payloads or the cleared providers read as
    // fresh-and-empty until the TTL expires.
    for (const base of Object.keys(this.adapter.getCachedModels())) {
      this.adapter.setProviderLastUpdate(base, 0);
    }
    this.adapter.setCachedModels({});
  }

  /**
   * Filter base URLs based on Tor context
   * @param baseUrls Provider URLs to filter
   * @param torMode Whether in Tor context
   * @returns Filtered URLs appropriate for Tor mode
   */
  filterBaseUrlsForTor(baseUrls: string[], torMode: boolean): string[] {
    if (!torMode) {
      // In normal mode, exclude onion URLs
      return baseUrls.filter((url) => !url.includes(".onion"));
    }
    // In Tor mode, only include onion URLs
    return baseUrls.filter((url) => url.includes(".onion"));
  }

  /**
   * Get provider endpoints from provider info
   * @param provider Provider object from directory
   * @param torMode Whether in Tor context
   * @returns Array of endpoint URLs
   */
  private getProviderEndpoints(provider: any, torMode: boolean): string[] {
    const endpoints: string[] = [];

    if (torMode && provider.onion_url) {
      endpoints.push(this.normalizeUrl(provider.onion_url));
    } else if (provider.endpoint_url) {
      endpoints.push(this.normalizeUrl(provider.endpoint_url));
    }

    return endpoints;
  }

  /**
   * Normalize provider URL with trailing slash
   * @param url URL to normalize
   * @returns Normalized URL
   */
  private normalizeUrl(url: string): string {
    if (!url.startsWith("http")) {
      url = `https://${url}`;
    }
    return url.endsWith("/") ? url : `${url}/`;
  }

  /** Current per-adapter mapping snapshot; offline first runs use the bundled fallback. */
  getModelIdMappings(): ModelIdMappings {
    return this.adapter.getModelIdMappings() ?? MODEL_ID_MAPPINGS;
  }

  /**
   * Fetch the complete kind 38426 variant -> canonical snapshot. The same
   * author and relays as kind 38423 are used. An empty object is a valid
   * replacement; an absent, invalid or unreachable event keeps the last good
   * snapshot (or the bundled fallback on a fresh install).
   */
  async fetchModelIdMappings(forceRefresh: boolean = false): Promise<ModelIdMappings> {
    const cached = this.adapter.getModelIdMappings() ?? null;
    const lastUpdate = this.adapter.getModelIdMappingsLastUpdate?.();
    if (!forceRefresh && cached !== null && lastUpdate != null &&
        lastUpdate <= Date.now() && Date.now() - lastUpdate <= this.cacheTTL) {
      return cached;
    }

    // Hydrate the local event store from driver-backed evidence as well.
    const saved = this.adapter.getModelIdMappingsEvent();
    if (saved && this.isModelIdMappingEvent(saved)) {
      const store = (await this.ensureEventStore()) ?? this.memoryEventStore;
      store.add(saved);
    }
    const events = await this.getNostrEvents(
      { kinds: [38426], "#d": [MODEL_ID_MAPPINGS_D_TAG], authors: [this.routstrModelsPubkey] },
      forceRefresh,
      undefined,
      event => this.isModelIdMappingEvent(event)
    );
    return this.applyModelIdMappingEvents(events);
  }

  private parseModelIdMappings(event: NostrEvent): ModelIdMappings {
    const content = JSON.parse(event.content);
    const mappings = content?.mappings;
    if (mappings === null || typeof mappings !== "object" || Array.isArray(mappings)) {
      throw new Error("mappings must be an object");
    }
    const entries = Object.entries(mappings);
    if (entries.length > 10_000) throw new Error("too many mappings");
    const snapshot = Object.fromEntries(entries) as ModelIdMappings;
    for (const [variant, canonical] of Object.entries(snapshot)) {
      if (variant === "__proto__" || variant === "constructor" || variant === "prototype" ||
          !variant.trim() || typeof canonical !== "string" || !canonical.trim() ||
          variant === canonical) {
        throw new Error(`invalid mapping for ${variant}`);
      }
    }
    for (const canonical of Object.values(snapshot)) {
      if (Object.hasOwn(snapshot, canonical)) throw new Error(`chained mapping at ${canonical}`);
    }
    return snapshot;
  }

  private isModelIdMappingEvent(event: NostrEvent): boolean {
    if (event.kind !== 38426 || event.pubkey !== this.routstrModelsPubkey ||
        getReplaceableIdentifier(event) !== MODEL_ID_MAPPINGS_D_TAG ||
        !this.isNostrEventTrustworthy(event)) return false;
    try {
      this.parseModelIdMappings(event);
      return true;
    } catch (error) {
      this.logger.warn("ModelIdMappings: invalid kind 38426 content:", event.id, error);
      return false;
    }
  }

  private applyModelIdMappingEvents(events: NostrEvent[]): ModelIdMappings {
    // Include the adapter's signed event: SQLite persistence is optional,
    // but a stale relay must never roll back the accepted snapshot on restart.
    const saved = this.adapter.getModelIdMappingsEvent();
    const candidates = saved ? [...events, saved] : events;
    const event = candidates.filter(e => this.isModelIdMappingEvent(e)).sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
    )[0];
    if (!event) return this.getModelIdMappings();
    const snapshot = this.parseModelIdMappings(event);
    this.adapter.setModelIdMappingsEvent(event);
    this.adapter.setModelIdMappings(snapshot);
    this.adapter.setModelIdMappingsLastUpdate?.(Date.now());
    return snapshot;
  }

  /**
   * Fetch routstr21 models from Nostr network (kind 38423)
   * Uses cache if available and not expired
   * @returns Array of model IDs or empty array if not found
   */
  async fetchRoutstr21Models(forceRefresh: boolean = false): Promise<string[]> {
    // Check cache first
    const cachedModels = this.adapter.getRoutstr21Models();
    if (!forceRefresh && cachedModels.length > 0) {
      const lastUpdate = this.adapter.getRoutstr21ModelsLastUpdate();
      const cacheValid = lastUpdate && Date.now() - lastUpdate <= this.cacheTTL;
      if (cacheValid) {
        return cachedModels;
      }
    }

    const events = await this.getNostrEvents(
      { kinds: [38423], "#d": ["routstr-21-models"], authors: [this.routstrModelsPubkey] },
      forceRefresh
    );
    const event = events.reduce<NostrEvent | null>(
      (latest, event) => !latest || event.created_at > latest.created_at ? event : latest,
      null
    );

    if (!event) {
      return cachedModels.length > 0 ? cachedModels : [];
    }

    try {
      const content = JSON.parse(event.content);
      const models = Array.isArray(content?.models) ? content.models : [];
      this.adapter.setRoutstr21Models(models);
      this.adapter.setRoutstr21ModelsLastUpdate(Date.now());
      return models;
    } catch {
      this.logger.warn(
        "Routstr21Models: failed to parse Nostr event content:",
        event.id
      );
      return cachedModels.length > 0 ? cachedModels : [];
    }
  }
}
