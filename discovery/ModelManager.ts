/**
 * ModelManager class for discovering, fetching, and managing models from providers
 * Core responsibility: fetching models from providers, caching them, and selecting the best option
 * (lowest cost) across multiple providers
 */

import type { Model, SdkLogger } from "../core/types";
import { consoleLogger } from "../core/types";
import type { DiscoveryAdapter, ProviderInfo } from "./interfaces";
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

/** Kind 38425 review labels that mark a provider node as OK to route to. */
const POSITIVE_REVIEW_LABELS = new Set(["trusted", "verified", "lgtm"]);

/** Kind 38425 review labels that mark a provider node as unsafe to route to. */
const NEGATIVE_REVIEW_LABELS = new Set([
  "suspicious",
  "avoid",
  "blacklisted",
  "removed",
]);

// A hanging provider must not hold a fetch pass open indefinitely.
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

// Backstop for relays that never send EOSE; queries normally finish earlier.
const NOSTR_QUERY_TIMEOUT_MS = 5000;

// Drop events with a forged far-future created_at so they can't win "latest".
const MAX_EVENT_FUTURE_DRIFT_SECONDS = 15 * 60;

/** Kinds whose persisted events are discovery evidence. */
const DISCOVERY_KINDS = [38421, 38423, 38425];

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
  /** Nostr pubkey for the routstr-21 model list only (kind 38423). Falls back to routstrPubkey. */
  routstrModelsPubkey?: string;
  /** Nostr relay URLs for provider/model discovery.
   * When set, these relays are used for all Nostr queries (kinds 38421, 38423, 38425).
   * When unset, DEFAULT_NOSTR_RELAYS is used for all Nostr queries. */
  nostrRelays?: string[];
  /** Optional injectable logger */
  logger?: SdkLogger;
  /** Path to database for persistent Nostr event storage.
   * If provided, events fetched by ModelManager from relays (kinds 38421,
   * 38423, 38425) are persisted and survive process restarts. The underlying
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
   * (38421 providers, 38425 reviews, 38423 routstr21 models) and persist them
   * into the event store. Existing events are not replaced — new events are
   * merged in. Call this periodically (e.g. every 21 min) to discover new
   * providers, reviews, and model lists published since the last fetch.
   */
  async refreshNostrEvents(): Promise<void> {
    const eventStore = await this.ensureEventStore();
    if (!eventStore) {
      this.logger.warn("refreshNostrEvents: no event store configured, skipping");
      return;
    }

    // Kind 38421 — provider discovery
    await this.getNostrEvents(
      { kinds: [38421], limit: 100 },
      true,
      undefined,
      (event) => this.isProviderAnnouncement(event)
    );

    // Kind 38425 — provider review/audit events (lgtm, avoid, ...). Fetch all
    // labels so a provider that was later re-reviewed as `avoid` is discovered;
    // querying only `#t:["lgtm"]` here would silently keep stale approvals.
    await this.getNostrEvents(
      { kinds: [38425], limit: 500, authors: [this.routstrPubkey] },
      true
    );

    // Kind 38423 — routstr21 curated model list. Fetch every published
    // version so the latest one can be selected from the persistent store;
    // limiting to 1 here could persist a stale event.
    await this.getNostrEvents(
      { kinds: [38423], "#d": ["routstr-21-models"], authors: [this.routstrModelsPubkey] },
      true
    );

    this.logger.log("refreshNostrEvents: live fetch complete");

    const pruned = await this.pruneSupersededDiscoveryEvents();
    if (pruned > 0) {
      this.logger.log(
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
        await routstr21Prefetch;
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
   * - `t`: review label, where `lgtm`/`trusted`/`verified` mean the node looks
   *   good and `avoid`/`suspicious`/`blacklisted`/`removed` mean it is unsafe
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
    const latestByNode = new Map<string, NostrEvent>();

    const collectFromEvent = (event: NostrEvent) => {
      const label = event.tags
        .find((tag) => tag[0] === "t" && typeof tag[1] === "string" && tag[1])
        ?.[1]?.toLowerCase();

      if (!label) return;

      // Apply the label to every "node" tag, not just the first.
      for (const tag of event.tags) {
        if (tag[0] !== "node" || typeof tag[1] !== "string" || !tag[1])
          continue;
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
    };

    const events = await this.getNostrEvents(
      { kinds: [38425], limit: 500, authors: [this.routstrPubkey] },
      forceRefresh
    );
    for (const event of events) collectFromEvent(event);

    const labels = new Map<string, string>();
    for (const [node, event] of latestByNode) {
      const label = event.tags
        .find((tag) => tag[0] === "t" && typeof tag[1] === "string" && tag[1])
        ?.[1]?.toLowerCase();
      if (label) labels.set(node, label);
    }
    return labels;
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

    const isPositive = (label: string | undefined) =>
      !!label && POSITIVE_REVIEW_LABELS.has(label);
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

    const bestById = new Map<string, { model: Model; base: string }>();
    const modelsFromAllProviders: Record<string, Model[]> = {};
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

        modelsFromAllProviders[base] = list;

        // Update best-priced models if provider not disabled
        if (!disabledProviders.includes(base)) {
          for (const m of list) {
            const existing = bestById.get(m.id);

            // Skip models without sats pricing
            if (!m.sats_pricing) continue;

            if (!existing) {
              bestById.set(m.id, { model: m, base });
              continue;
            }

            // Replace if this provider has lower cost
            const currentCost = estimateMinCost(m);
            const existingCost = estimateMinCost(existing.model);
            if (currentCost < existingCost && m.sats_pricing) {
              bestById.set(m.id, { model: m, base });
            }
          }
        }

        emitProgress();

        return { success: true, base, list };
      } catch (error) {
        if (this.isProviderDownError(error)) {
          this.logger.warn(`Provider ${base} is down right now.`);
        } else {
          this.logger.warn(`Provider ${base} unreachable: ${(error as Error).message}`);
        }
        // No stamp on failure, or the provider is served as "offers
        // nothing" until the TTL expires; last known models keep serving.
        return { success: false, base };
      }
    });

    await Promise.allSettled(fetchPromises);

    // Cache all provider results, pruning stale entries for providers
    // that are no longer in the current baseUrls (e.g. their Nostr event
    // was lost).  Without this, stale models from vanished providers
    // accumulate in the cache forever.
    const existingCache = this.adapter.getCachedModels();
    const currentBaseUrls = new Set(baseUrls);
    const prunedExisting: Record<string, Model[]> = {};
    for (const url of Object.keys(existingCache)) {
      if (currentBaseUrls.has(url)) {
        prunedExisting[url] = existingCache[url];
      } else {
        // A pruned payload must take its freshness stamp with it, or the
        // provider reads as valid-but-empty until the TTL expires.
        this.adapter.setProviderLastUpdate(url, 0);
      }
    }
    this.adapter.setCachedModels({
      ...prunedExisting,
      ...modelsFromAllProviders,
    });
    // Stamp after the payload write so no reader ever sees a fresh stamp
    // with a missing payload.
    const stampTime = Date.now();
    for (const base of freshlyFetched) {
      this.adapter.setProviderLastUpdate(base, stampTime);
    }

    // Return combined models array
    return Array.from(bestById.values()).map((v) => v.model);
  }

  /**
   * Fetch models from a single provider
   * @param baseUrl Provider base URL
   * @returns Array of models from provider
   */
  private async fetchModelsFromProvider(baseUrl: string): Promise<Model[]> {
    const res = await fetch(`${baseUrl}v1/models`, {
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch models: ${res.status}`);
    }

    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];

    return list;
  }

  private isProviderDownError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    if (msg.includes("fetch failed")) return true;
    if (msg.includes("429")) return true;
    if (msg.includes("502")) return true;
    if (msg.includes("503")) return true;
    if (msg.includes("504")) return true;
    const cause = error.cause as { code?: string } | undefined;
    return cause?.code === "ENOTFOUND";
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
