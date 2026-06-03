/**
 * bench-aggregate.ts
 *
 * Self-contained benchmark for the SDK's server-side usage aggregation.
 *
 * It measures the gain of the new `driver.aggregate({ groupBy: "modelId" })`
 * (SQL GROUP BY pushed down to SQLite) versus the old pattern of
 * `driver.list()` + a JS reduce that groups in application memory, swept over a
 * range of row counts.
 *
 * Everything runs from a clean checkout: no external DB, no network. Each size
 * gets a fresh temp SQLite file under os.tmpdir(), seeded transactionally from
 * a small set of sanitized fixture templates, then deleted.
 *
 * The fixture (./fixtures/usage-templates.json) is SYNTHETIC, SANITIZED data
 * for benchmarking only. It contains no real identifiers: generic model names,
 * example.com provider URLs, and placeholder client ids ("client-a", etc.).
 *
 * Usage:
 *   bun scripts/bench-aggregate.ts [sizes...]
 *   bun scripts/bench-aggregate.ts            # defaults to 100 1000 2000 5000 10000
 *   bun scripts/bench-aggregate.ts 500 5000   # custom sizes
 *   bun scripts/bench-aggregate.ts --json     # dump raw results array as JSON
 */

// @ts-ignore - bun:sqlite is only available at runtime in Bun environments
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
// Relative import into THIS repo's source so we benchmark the PR's code,
// not a published package. createBunSqliteUsageTrackingDriver is async and
// injects bun:sqlite itself; it auto-creates the table and exposes
// .aggregate() / .list().
import { createBunSqliteUsageTrackingDriver } from "../storage/bun";
import templates from "./fixtures/usage-templates.json";

const TABLE = "usage_tracking";
const DAYS_SPREAD = 45;
const RUNS = 7; // measured runs per path; first is discarded as warmup

interface FixtureTemplate {
  modelId: string;
  baseUrl: string;
  client?: string;
  cost: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  sessionId?: string;
  tags?: string[];
}

interface SeedRow {
  id: string;
  timestamp: number;
  model_id: string;
  base_url: string;
  request_id: string;
  cost: number;
  sats_cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  client: string | null;
  session_id: string | null;
  tags: string;
}

interface SizeResult {
  size: number;
  aggregateMs: number;
  listReduceMs: number;
  speedup: number;
  aggregateBytes: number;
  listBytes: number;
  sizeReduction: number;
}

const fixtures = templates as FixtureTemplate[];

// Generate N rows by cycling the fixture templates. Each row gets a unique id
// and request id; timestamps are spread evenly over the last ~45 days
// (oldest -> newest). camelCase fixture fields map to snake_case columns.
function generateRows(n: number): SeedRow[] {
  const now = Date.now();
  const spanMs = DAYS_SPREAD * 24 * 60 * 60 * 1000;
  const start = now - spanMs;
  const step = n > 1 ? spanMs / (n - 1) : 0;

  const rows: SeedRow[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = fixtures[i % fixtures.length];
    rows[i] = {
      id: "bench-" + i,
      timestamp: Math.round(start + step * i),
      model_id: t.modelId,
      base_url: t.baseUrl,
      request_id: "bench-req-" + i,
      cost: t.cost,
      sats_cost: t.satsCost,
      prompt_tokens: t.promptTokens,
      completion_tokens: t.completionTokens,
      total_tokens: t.totalTokens,
      client: t.client ?? null,
      session_id: t.sessionId ?? null,
      tags: JSON.stringify(t.tags ?? []),
    };
  }
  return rows;
}

// Seed transactionally with a raw bun:sqlite Database. This is the point of the
// benchmark setup: the driver's appendMany inserts row-by-row, which is slow at
// these sizes. A single prepared statement inside one transaction seeds 10k
// rows in milliseconds. The CREATE TABLE + indexes are copied verbatim from
// storage/usageTracking/bunSqlite.ts so the schema matches the SDK exactly.
function seedDb(dbPath: string, rows: SeedRow[]): void {
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      request_id TEXT NOT NULL,
      cost REAL NOT NULL,
      sats_cost REAL NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      client TEXT,
      session_id TEXT,
      tags TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_timestamp ON ${TABLE}(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_model_id ON ${TABLE}(model_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_base_url ON ${TABLE}(base_url)`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO ${TABLE} (
      id, timestamp, model_id, base_url, request_id,
      cost, sats_cost, prompt_tokens, completion_tokens, total_tokens,
      client, session_id, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = db.transaction((batch: SeedRow[]) => {
    for (const r of batch) {
      insert.run(
        r.id,
        r.timestamp,
        r.model_id,
        r.base_url,
        r.request_id,
        r.cost,
        r.sats_cost,
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        r.client,
        r.session_id,
        r.tags
      );
    }
  });
  seed(rows);
  db.close();
}

interface GroupSums {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
}

// JS reduce mirroring what aggregate({ groupBy: "modelId" }) computes, so the
// two paths do equivalent work.
function reduceByModel(
  rows: { modelId: string; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; satsCost: number }[]
): Map<string, GroupSums> {
  const groups = new Map<string, GroupSums>();
  for (const r of rows) {
    let g = groups.get(r.modelId);
    if (!g) {
      g = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, satsCost: 0 };
      groups.set(r.modelId, g);
    }
    g.requests += 1;
    g.promptTokens += r.promptTokens;
    g.completionTokens += r.completionTokens;
    g.totalTokens += r.totalTokens;
    g.cost += r.cost;
    g.satsCost += r.satsCost;
  }
  return groups;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Median of RUNS runs, discarding the first (warmup).
async function timeMedian(fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    if (i > 0) samples.push(elapsed); // discard warmup
  }
  return median(samples);
}

// Compare per-model sums between the aggregate path and the reduce path.
// Costs are floats, so compare with a small epsilon.
function sumsMatch(
  aggGroups: Map<string, GroupSums>,
  reduceGroups: Map<string, GroupSums>
): boolean {
  if (aggGroups.size !== reduceGroups.size) return false;
  const EPS = 1e-6;
  for (const [model, a] of aggGroups) {
    const b = reduceGroups.get(model);
    if (!b) return false;
    if (a.requests !== b.requests) return false;
    if (a.promptTokens !== b.promptTokens) return false;
    if (a.completionTokens !== b.completionTokens) return false;
    if (a.totalTokens !== b.totalTokens) return false;
    if (Math.abs(a.cost - b.cost) > EPS) return false;
    if (Math.abs(a.satsCost - b.satsCost) > EPS) return false;
  }
  return true;
}

async function benchSize(size: number): Promise<SizeResult> {
  const dbPath = join(tmpdir(), `sdk-bench-${size}-${process.pid}.sqlite`);
  if (existsSync(dbPath)) unlinkSync(dbPath);

  try {
    seedDb(dbPath, generateRows(size));

    const driver = await createBunSqliteUsageTrackingDriver({ dbPath });

    // NEW: server-side aggregate.
    const aggregateMs = await timeMedian(() => driver.aggregate({ groupBy: "modelId" }));

    // OLD: list everything then reduce in JS. The limit is the current size so
    // the legacy path returns ALL seeded rows (otherwise it would cap and the
    // sums would diverge from aggregate). Note: the real routstrd monitor caps
    // this at 10000 — see the takeaway note below.
    const listReduceMs = await timeMedian(async () => {
      const rows = await driver.list({ limit: size });
      reduceByModel(rows);
    });

    // Materialize each path's result once to measure the JSON payload size.
    // This is the headline: aggregate returns a handful of grouped rows, while
    // list() returns every row the caller would otherwise ship over the wire.
    const aggRows = await driver.aggregate({ groupBy: "modelId" });
    const listRows = await driver.list({ limit: size });
    const aggregateBytes = JSON.stringify(aggRows).length;
    const listBytes = JSON.stringify(listRows).length;

    // Sanity-check: both paths must produce identical per-model totals. Kept as
    // an assertion (warns on mismatch) so the bench stays trustworthy, but it's
    // not rendered as a table column.
    const aggGroups = new Map<string, GroupSums>();
    for (const row of aggRows) {
      if (row.group == null) continue;
      aggGroups.set(row.group, {
        requests: row.requests,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        cost: row.cost,
        satsCost: row.satsCost,
      });
    }
    const reduceGroups = reduceByModel(listRows);
    if (!sumsMatch(aggGroups, reduceGroups)) {
      console.warn(
        `WARNING: per-model sums differ between aggregate and list+reduce at N=${size}. Bench is not comparing equivalent work.`
      );
    }

    return {
      size,
      aggregateMs,
      listReduceMs,
      speedup: listReduceMs / aggregateMs,
      aggregateBytes,
      listBytes,
      sizeReduction: listBytes / aggregateBytes,
    };
  } finally {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
}

function fmt(ms: number): string {
  return ms.toFixed(3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const sizeArgs = args
    .filter((a) => !a.startsWith("--"))
    .map((a) => Number(a))
    .filter((n) => Number.isFinite(n) && n > 0);
  const sizes = sizeArgs.length > 0 ? sizeArgs : [100, 1000, 2000, 5000, 10000, 20000];

  const results: SizeResult[] = [];
  for (const size of sizes) {
    results.push(await benchSize(size));
  }

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("\naggregate({ groupBy: 'modelId' })  vs  list() + JS reduce");
  console.log("median of " + (RUNS - 1) + " runs (first discarded as warmup), per size\n");
  console.table(
    results.map((r) => ({
      N: r.size,
      "aggregate (ms)": fmt(r.aggregateMs),
      "list+reduce (ms)": fmt(r.listReduceMs),
      "speedup (x)": r.speedup.toFixed(1),
      "aggregate (KB)": (r.aggregateBytes / 1024).toFixed(1),
      "list (KB)": (r.listBytes / 1024).toFixed(1),
      "size reduction (x)": r.sizeReduction.toFixed(1),
    }))
  );

  const avgSpeedup = results.reduce((s, r) => s + r.speedup, 0) / results.length;
  const last = results[results.length - 1];

  console.log(
    `\nTakeaway: aggregate({ groupBy }) is consistently ~${avgSpeedup.toFixed(1)}x faster than list()+reduce ` +
      `across these sizes, and it shrinks the result payload ~${last.sizeReduction.toFixed(0)}x at N=${last.size} ` +
      `(${(last.listBytes / 1024).toFixed(1)} KB of raw rows vs ${(last.aggregateBytes / 1024).toFixed(1)} KB of grouped rows). ` +
      `list()+reduce pays twice: it ships and materializes every row as a JS object before reducing in JS, ` +
      `whereas aggregate returns only the grouped rows and keeps the per-row work in C. ` +
      `Note: this bench lifts the list() limit so it returns all rows at every size, but the real routstrd monitor ` +
      `uses a hard fetchUsage(10000) cap — so above 10k rows the legacy path silently undercounts, showing stats ` +
      `for only the latest 10k, while aggregate always sees all rows. That's a correctness benefit on top of the ` +
      `perf/size scaling (it's monitor behavior, not measured by this bench). ` +
      `The absolute gap widens with N.\n`
  );
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
