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
import type { NostrEvent } from "applesauce-core/helpers";

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

/**
 * Configuration for ModelManager
 */
export interface ModelManagerConfig {
  /** URL to fetch provider directory from */
  providerDirectoryUrl?: string;
  /** Additional provider base URLs to include */
  includeProviderUrls?: string[];
  /** Provider base URLs to exclude */
  excludeProviderUrls?: string[];
  /** Cache TTL in milliseconds (default: 210 minutes) */
  cacheTTL?: number;
  /** Nostr pubkey for routstr review/model events (kind 38425/38423). Defaults to routstr's key. */
  routstrPubkey?: string;
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
  private readonly nostrRelays: string[] | undefined;
  private readonly logger: SdkLogger;
  private providerNodePubkeysByUrl = new Map<string, Set<string>>();
  /** One pool for all queries, so repeated bootstraps reuse relay sockets. */
  private relayPool: RelayPool | null = null;
  /** Persistent event store for relay-fetched events (null if not configured/initialized) */
  private eventStore: EventStore | null = null;
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
    this.cacheTTL = config.cacheTTL || 210 * 60 * 1000; // 21 minutes
    this.includeProviderUrls = config.includeProviderUrls || [];
    this.excludeProviderUrls = config.excludeProviderUrls || [];
    this.routstrPubkey =
      config.routstrPubkey ||
      "4ad6fa2d16e2a9b576c863b4cf7404a70d4dc320c0c447d10ad6ff58993eacc8";
    this.nostrRelays = config.nostrRelays;
    this.logger = (config.logger ?? consoleLogger).child("ModelManager");

    this.eventStoreDbPath = config.eventStoreDbPath;
    this.persistentEventDatabaseFactory = config.persistentEventDatabaseFactory;
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
   * Returns null if no eventStoreDbPath was provided.
   */
  private async ensureEventStore(): Promise<EventStore | null> {
    if (!this.eventStoreDbPath) return null;
    if (this.eventStore) return this.eventStore;

    if (!this.eventStoreInitPromise) {
      this.eventStoreInitPromise = (async () => {
        try {
          const db = await this.createPersistentEventDatabase();
          this.eventStoreDb = db;
          this.eventStore = new EventStore({ database: db });
          this.initializeEventStoreMetadata();
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
   * Returns null if no eventStoreDbPath was provided.
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

  private initializeEventStoreMetadata(): void {
    this.eventStoreDb?.db?.exec(
      `CREATE TABLE IF NOT EXISTS routstr_event_cache_metadata (
        event_id TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL
      )`
    );
  }

  private markEventFetched(event: NostrEvent, fetchedAt: number = Date.now()): void {
    const db = this.eventStoreDb?.db;
    if (!db) return;

    db.prepare(
      `INSERT INTO routstr_event_cache_metadata (event_id, fetched_at)
       VALUES (?, ?)
       ON CONFLICT(event_id) DO UPDATE SET fetched_at = excluded.fetched_at`
    ).run?.(event.id, fetchedAt);
  }

  private getEventFetchedAt(event: NostrEvent): number | undefined {
    const db = this.eventStoreDb?.db;
    if (!db) return undefined;

    const row = db
      .prepare(
        `SELECT fetched_at FROM routstr_event_cache_metadata WHERE event_id = ?`
      )
      .get?.(event.id);
    return typeof row?.fetched_at === "number" ? row.fetched_at : undefined;
  }

  /**
   * Return all matching events from the persistent event store.
   * The store accumulates events over time — it is the source of truth,
   * not a temporary cache. Old events remain valid.
   */
  private async getCachedNostrEvents(
    filter: { kinds?: number[]; authors?: string[]; "#t"?: string[]; "#d"?: string[] },
    forceRefresh: boolean = false
  ): Promise<NostrEvent[]> {
    const eventStore = await this.ensureEventStore();
    if (forceRefresh) return [];
    if (!eventStore) return [];

    return eventStore.getTimeline(filter);
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

    const relays = this.getNostrRelays();
    const timeoutMs = 5000;

    // Kind 38421 — provider discovery
    await this.fetchLiveIntoStore({ kinds: [38421], limit: 100 }, relays, timeoutMs);

    // Kind 38425 — provider review/audit events (lgtm, avoid, ...). Fetch all
    // labels so a provider that was later re-reviewed as `avoid` is discovered;
    // querying only `#t:["lgtm"]` here would silently keep stale approvals.
    await this.fetchLiveIntoStore(
      { kinds: [38425], limit: 500, authors: [this.routstrPubkey] },
      relays,
      timeoutMs
    );

    // Kind 38423 — routstr21 curated model list
    await this.fetchLiveIntoStore(
      { kinds: [38423], "#d": ["routstr-21-models"], limit: 1, authors: [this.routstrPubkey] },
      relays,
      timeoutMs
    );

    this.logger.log("refreshNostrEvents: live fetch complete");

    // Re-apply review-based provider disables against the freshly-updated
    // store. A newly published `avoid` review (or an lgtm→avoid reversal) must
    // take effect now, not on the next bootstrap/manual refresh.
    await this.syncReviewedProvidersFromNostr();
  }

  /**
   * Fetch events from live relays and persist them into the event store.
   */
  private async fetchLiveIntoStore(
    filter: { kinds?: number[]; authors?: string[]; "#t"?: string[]; "#d"?: string[]; limit?: number },
    relays: string[],
    timeoutMs: number
  ): Promise<void> {
    const eventStore = await this.ensureEventStore();
    if (!eventStore) return;

    await this.collectNostrEvents(filter, relays, timeoutMs, (event) => {
      eventStore.add(event);
      this.markEventFetched(event);
    });
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
            this.syncReviewedProvidersFromNostr(
              filteredCachedUrls,
              this.providerNodePubkeysByUrl,
              forceRefresh
            ),
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
    const relays = this.getNostrRelays();

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

    // Check persistent store first
    const cached = await this.getCachedNostrEvents(
      { kinds: [kind] },
      forceRefresh
    );

    if (cached.length > 0) {
      this.logger.log(`Using ${cached.length} cached kind ${kind} events from persistent store`);
      for (const event of cached) {
        collectFromEvent(event);
      }
    } else {
      await this.collectNostrEvents(
        { kinds: [kind], limit: 100 },
        relays,
        NOSTR_QUERY_TIMEOUT_MS,
        (event) => {
          // Persist to durable store if configured
          this.eventStore?.add(event);
          this.markEventFetched(event);
          collectFromEvent(event);
        }
      );
    }

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
   * @param baseUrls Current provider base URLs to evaluate
   * @returns Array of provider base URLs disabled by the review set
   */
  async syncReviewedProvidersFromNostr(
    baseUrls: string[] = this.adapter.getBaseUrlsList(),
    providerNodes: Map<string, Set<string>> = this.providerNodePubkeysByUrl,
    forceRefresh: boolean = false
  ): Promise<string[] | null> {
    if (baseUrls.length === 0) return null;

    if (!this.adapter.setDisabledProviders) {
      this.logger.warn(
        "NostrReviews: adapter does not support setDisabledProviders; skipping provider disable sync"
      );
      return null;
    }

    // On a warm bootstrap the base URL list is served from the adapter cache
    // and the Nostr discovery pass (which builds providerNodePubkeysByUrl) is
    // skipped, leaving the node map empty. Rebuild it from the persisted 38421
    // events so review-based disabling still works across restarts.
    if (providerNodes.size === 0) {
      providerNodes = await this.rebuildProviderNodesFromStore();
      this.providerNodePubkeysByUrl = providerNodes;
    }

    const reviewLabels = await this.fetchReviewLabels(forceRefresh);
    return this.applyReviewDisables(baseUrls, providerNodes, reviewLabels);
  }

  /**
   * Rebuild the url → node-pubkeys map from persisted kind 38421 events.
   * Used when a warm bootstrap skipped the live Nostr discovery pass.
   */
  private async rebuildProviderNodesFromStore(): Promise<
    Map<string, Set<string>>
  > {
    const map = new Map<string, Set<string>>();
    const eventStore = await this.ensureEventStore();
    if (!eventStore) return map;

    const addNode = (url: string, pubkey?: string) => {
      if (!pubkey) return;
      const normalized = this.normalizeUrl(url);
      const existing = map.get(normalized) || new Set<string>();
      existing.add(pubkey);
      map.set(normalized, existing);
    };

    const events = eventStore.getTimeline({ kinds: [38421] });
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
          const endpoints = this.getProviderEndpoints(p, false);
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
      const node = event.tags.find(
        (tag) => tag[0] === "node" && typeof tag[1] === "string" && tag[1]
      )?.[1];
      const label = event.tags.find(
        (tag) => tag[0] === "t" && typeof tag[1] === "string" && tag[1]
      )?.[1]?.toLowerCase();

      if (!node || !label) return;

      const previous = latestByNode.get(node);
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id > previous.id)
      ) {
        latestByNode.set(node, event);
      }
    };

    // Check persistent store first
    const cached = await this.getCachedNostrEvents(
      { kinds: [38425], authors: [this.routstrPubkey] },
      forceRefresh
    );

    if (cached.length > 0) {
      this.logger.log(
        `Using ${cached.length} cached kind 38425 review events from persistent store`
      );
      for (const event of cached) {
        collectFromEvent(event);
      }
    } else {
      await this.collectNostrEvents(
        {
          kinds: [38425],
          limit: 500,
          authors: [this.routstrPubkey],
        },
        this.getNostrRelays(),
        NOSTR_QUERY_TIMEOUT_MS,
        (event) => {
          this.eventStore?.add(event);
          this.markEventFetched(event);
          collectFromEvent(event);
        }
      );
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

    if (reviewLabels.size === 0) {
      this.logger.warn(
        "NostrReviews: no kind 38425 review events found; keeping disabled providers unchanged"
      );
      return null;
    }

    if (providerNodes.size === 0) {
      this.logger.warn(
        "NostrReviews: no kind 38421 provider node metadata found; keeping disabled providers unchanged"
      );
      return null;
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

    const relays = this.getNostrRelays();

    // Check persistent store first
    const cached = await this.getCachedNostrEvents(
      { kinds: [38423], "#d": ["routstr-21-models"], authors: [this.routstrPubkey] },
      forceRefresh
    );
    let event: NostrEvent | null = null;

    if (cached.length === 0) {
      await this.collectNostrEvents(
        {
          kinds: [38423],
          "#d": ["routstr-21-models"],
          limit: 1,
          authors: [this.routstrPubkey],
        },
        relays,
        NOSTR_QUERY_TIMEOUT_MS,
        (e) => {
          // Persist to durable store if configured
          this.eventStore?.add(e);
          this.markEventFetched(e);
          if (!event) event = e;
        }
      );
    } else {
      this.logger.log(`Using ${cached.length} cached kind 38423 events from persistent store`);
      event = cached[0];
    }

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
