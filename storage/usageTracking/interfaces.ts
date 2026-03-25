import type { UsageTrackingEntry } from "./types";

export interface ListUsageTrackingOptions {
  limit?: number;
  before?: number;
  after?: number;
  modelId?: string;
  baseUrl?: string;
  sessionId?: string;
  client?: string;
}

export interface UsageTrackingDriver {
  migrate(): Promise<void>;
  append(entry: UsageTrackingEntry): Promise<void>;
  appendMany(entries: UsageTrackingEntry[]): Promise<void>;
  list(options?: ListUsageTrackingOptions): Promise<UsageTrackingEntry[]>;
  count(options?: Omit<ListUsageTrackingOptions, "limit">): Promise<number>;
  deleteOlderThan(timestamp: number): Promise<number>;
  clear(): Promise<void>;
}
