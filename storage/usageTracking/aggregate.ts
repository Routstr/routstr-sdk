import type {
  AggregateUsageOptions,
  UsageAggregateRow,
  UsageGroupBy,
} from "./interfaces";
import type { UsageTrackingEntry } from "./types";

// Shared, platform-agnostic aggregation helpers used by every usage tracking
// driver. SQL drivers (bunSqlite/sqlite) push the work down to SQLite via
// buildAggregateSql/mapAggregateRow; in-memory drivers (memory/indexedDB)
// reduce in JS via reduceAggregate. Both paths must produce identical group
// keys and ordering so callers get the same result regardless of backend.

const pad2 = (n: number): string => String(n).padStart(2, "0");

const aggregateColumns =
  "COUNT(*) AS requests, " +
  "COALESCE(SUM(prompt_tokens), 0) AS promptTokens, " +
  "COALESCE(SUM(completion_tokens), 0) AS completionTokens, " +
  "COALESCE(SUM(total_tokens), 0) AS totalTokens, " +
  "COALESCE(SUM(cost), 0) AS cost, " +
  "COALESCE(SUM(sats_cost), 0) AS satsCost";

/**
 * SQL expression producing the group key. `day`/`hour` shift the (millisecond)
 * timestamp by the timezone offset before bucketing so buckets land on the
 * caller's local-day/hour boundaries rather than UTC.
 */
const sqlGroupExpr = (
  groupBy: UsageGroupBy,
): { expr: string; usesTz: boolean } => {
  switch (groupBy) {
    case "modelId":
      return { expr: "model_id", usesTz: false };
    case "baseUrl":
      return { expr: "base_url", usesTz: false };
    case "client":
      return { expr: "client", usesTz: false };
    case "sessionId":
      return { expr: "session_id", usesTz: false };
    case "day":
      return {
        expr: "strftime('%Y-%m-%d', (timestamp - ? * 60000) / 1000, 'unixepoch')",
        usesTz: true,
      };
    case "hour":
      return {
        expr: "strftime('%H', (timestamp - ? * 60000) / 1000, 'unixepoch')",
        usesTz: true,
      };
  }
};

/**
 * Build an aggregation query from a driver-supplied WHERE clause. When
 * `groupBy` is omitted a single grand-total row is returned. Timezone params
 * (day/hour grouping) bind before the WHERE params because the group
 * expression appears earlier in the statement (the SELECT list).
 */
export const buildAggregateSql = (
  tableName: string,
  where: { sql: string; params: unknown[] },
  options: AggregateUsageOptions = {},
): { sql: string; params: unknown[] } => {
  if (!options.groupBy) {
    return {
      sql: `SELECT NULL AS grp, ${aggregateColumns} FROM ${tableName} ${where.sql}`,
      params: where.params,
    };
  }

  const { expr, usesTz } = sqlGroupExpr(options.groupBy);
  const tzParams = usesTz ? [options.tzOffsetMinutes ?? 0] : [];
  const orderBy =
    options.groupBy === "day" || options.groupBy === "hour"
      ? "ORDER BY grp ASC"
      : "ORDER BY satsCost DESC";

  return {
    sql: `SELECT ${expr} AS grp, ${aggregateColumns} FROM ${tableName} ${where.sql} GROUP BY grp ${orderBy}`,
    params: [...tzParams, ...where.params],
  };
};

/** Map a raw SQL aggregate row into a `UsageAggregateRow`. */
export const mapAggregateRow = (row: Record<string, unknown>): UsageAggregateRow => ({
  group: row.grp == null ? null : String(row.grp),
  requests: Number(row.requests ?? 0),
  promptTokens: Number(row.promptTokens ?? 0),
  completionTokens: Number(row.completionTokens ?? 0),
  totalTokens: Number(row.totalTokens ?? 0),
  cost: Number(row.cost ?? 0),
  satsCost: Number(row.satsCost ?? 0),
});

const jsGroupKey = (
  entry: UsageTrackingEntry,
  groupBy: UsageGroupBy,
  tzOffsetMinutes: number,
): string | null => {
  switch (groupBy) {
    case "modelId":
      return entry.modelId ?? null;
    case "baseUrl":
      return entry.baseUrl ?? null;
    case "client":
      return entry.client ?? null;
    case "sessionId":
      return entry.sessionId ?? null;
    case "day": {
      const d = new Date(entry.timestamp - tzOffsetMinutes * 60000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    case "hour": {
      const d = new Date(entry.timestamp - tzOffsetMinutes * 60000);
      return pad2(d.getUTCHours());
    }
  }
};

/**
 * Reduce already-filtered entries into aggregate rows, mirroring the SQL
 * drivers' grouping and ordering. With no `groupBy`, returns a single
 * grand-total row (even for an empty input).
 */
export const reduceAggregate = (
  entries: UsageTrackingEntry[],
  options: AggregateUsageOptions = {},
): UsageAggregateRow[] => {
  const emptyRow = (group: string | null): UsageAggregateRow => ({
    group,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    satsCost: 0,
  });

  const accumulate = (row: UsageAggregateRow, entry: UsageTrackingEntry): void => {
    row.requests += 1;
    row.promptTokens += entry.promptTokens;
    row.completionTokens += entry.completionTokens;
    row.totalTokens += entry.totalTokens;
    row.cost += entry.cost;
    row.satsCost += entry.satsCost;
  };

  if (!options.groupBy) {
    const total = emptyRow(null);
    for (const entry of entries) accumulate(total, entry);
    return [total];
  }

  const tz = options.tzOffsetMinutes ?? 0;
  const groups = new Map<string | null, UsageAggregateRow>();
  for (const entry of entries) {
    const key = jsGroupKey(entry, options.groupBy, tz);
    let row = groups.get(key);
    if (!row) {
      row = emptyRow(key);
      groups.set(key, row);
    }
    accumulate(row, entry);
  }

  const rows = [...groups.values()];
  if (options.groupBy === "day" || options.groupBy === "hour") {
    rows.sort((a, b) => (a.group ?? "").localeCompare(b.group ?? ""));
  } else {
    rows.sort((a, b) => b.satsCost - a.satsCost);
  }
  return rows;
};
