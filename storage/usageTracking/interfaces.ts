import type { UsageTrackingEntry } from "./types";

export interface ListUsageTrackingOptions {
  limit?: number;
  before?: number;
  after?: number;
  modelId?: string;
  baseUrl?: string;
  sessionId?: string;
  client?: string;
  /** Match any of these client ids (SQL `client IN (...)`). Complements `client`. */
  clients?: string[];
}

/** Dimension to group usage aggregates by. `day`/`hour` are timezone-aware. */
export type UsageGroupBy =
  | "modelId"
  | "baseUrl"
  | "client"
  | "sessionId"
  | "day"
  | "hour";

export interface AggregateUsageOptions
  extends Omit<ListUsageTrackingOptions, "limit"> {
  /** Group rows by this dimension. Omit for a single grand-total row. */
  groupBy?: UsageGroupBy;
  /**
   * Minutes to subtract from each timestamp before `day`/`hour` bucketing,
   * e.g. `new Date().getTimezoneOffset()`. Ignored for other groupings.
   * Defaults to 0 (UTC).
   */
  tzOffsetMinutes?: number;
}

export interface UsageAggregateRow {
  /**
   * The group key: the dimension value, "YYYY-MM-DD" (day) or "00".."23"
   * (hour). `null` when `groupBy` is omitted or the grouped column is null.
   */
  group: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
}

export interface UsageTrackingDriver {
  migrate(): Promise<void>;
  append(entry: UsageTrackingEntry): Promise<void>;
  appendMany(entries: UsageTrackingEntry[]): Promise<void>;
  list(options?: ListUsageTrackingOptions): Promise<UsageTrackingEntry[]>;
  count(options?: Omit<ListUsageTrackingOptions, "limit">): Promise<number>;
  aggregate(options?: AggregateUsageOptions): Promise<UsageAggregateRow[]>;
  deleteOlderThan(timestamp: number): Promise<number>;
  clear(): Promise<void>;
}
