import type {
  AggregateUsageOptions,
  ListUsageTrackingOptions,
  UsageAggregateRow,
  UsageTrackingDriver,
} from "./interfaces";
import type { UsageTrackingEntry } from "./types";
import { reduceAggregate } from "./aggregate";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const matchesFilters = (
  entry: UsageTrackingEntry,
  options: Omit<ListUsageTrackingOptions, "limit"> = {}
): boolean => {
  if (typeof options.before === "number" && entry.timestamp >= options.before) {
    return false;
  }
  if (typeof options.after === "number" && entry.timestamp <= options.after) {
    return false;
  }
  if (options.modelId && entry.modelId !== options.modelId) {
    return false;
  }
  if (options.baseUrl && normalizeBaseUrl(entry.baseUrl) !== normalizeBaseUrl(options.baseUrl)) {
    return false;
  }
  if (options.sessionId && entry.sessionId !== options.sessionId) {
    return false;
  }
  if (options.client && entry.client !== options.client) {
    return false;
  }
  if (
    options.clients &&
    options.clients.length > 0 &&
    (entry.client == null || !options.clients.includes(entry.client))
  ) {
    return false;
  }
  if (typeof options.minTotalTokens === "number" && entry.totalTokens < options.minTotalTokens) {
    return false;
  }
  if (typeof options.maxTotalTokens === "number" && entry.totalTokens >= options.maxTotalTokens) {
    return false;
  }
  return true;
};

export const createMemoryUsageTrackingDriver = (
  seed: UsageTrackingEntry[] = []
): UsageTrackingDriver => {
  const store = new Map<string, UsageTrackingEntry>();

  for (const entry of seed) {
    store.set(entry.id, { ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) });
  }

  return {
    async migrate(): Promise<void> {
      return;
    },

    async append(entry: UsageTrackingEntry): Promise<void> {
      store.set(entry.id, { ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) });
    },

    async appendMany(entries: UsageTrackingEntry[]): Promise<void> {
      for (const entry of entries) {
        store.set(entry.id, { ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) });
      }
    },

    async list(options: ListUsageTrackingOptions = {}): Promise<UsageTrackingEntry[]> {
      const entries = [...store.values()]
        .filter((entry) => matchesFilters(entry, options))
        .sort((a, b) => b.timestamp - a.timestamp);
      if (typeof options.limit === "number") {
        return entries.slice(0, options.limit);
      }
      return entries;
    },

    async count(options: Omit<ListUsageTrackingOptions, "limit"> = {}): Promise<number> {
      return (await this.list(options)).length;
    },

    async aggregate(options: AggregateUsageOptions = {}): Promise<UsageAggregateRow[]> {
      const entries = [...store.values()].filter((entry) => matchesFilters(entry, options));
      return reduceAggregate(entries, options);
    },

    async deleteOlderThan(timestamp: number): Promise<number> {
      let deleted = 0;
      for (const [id, entry] of store.entries()) {
        if (entry.timestamp < timestamp) {
          store.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },

    async clear(): Promise<void> {
      store.clear();
    },
  };
};
