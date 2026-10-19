/**
 * Ranking lab — compare provider-ranking metrics on live discovery data.
 *
 * Pulls exactly what `rout models -m <id>` pulls (Nostr provider discovery ->
 * GET /v1/models per node) and then scores every matching candidate under
 * several metrics at once, using the SDK's own cost function
 * (client/cacheAwareCost.ts) so the numbers here are the numbers production
 * would compute.
 *
 * Optional sections:
 *   --routes   per-upstream-route pricing from GET /v1/models/paths, which is
 *              finer-grained than the node's aggregate model price
 *   (ledger)   per-(model, route) measurements from the local usage ledger,
 *              plus a predicted-vs-delivered check and a calibrated ranking
 *
 * Usage:
 *   bun scripts/ranking-lab.ts kimi-k3
 *   bun scripts/ranking-lab.ts kimi-k3 --prompt 100000 --output 2000 --hit 0.9
 *   bun scripts/ranking-lab.ts kimi-k3 --routes
 *   bun scripts/ranking-lab.ts kimi-k3 --json
 */

import { ModelManager, ProviderManager } from "@routstr/sdk";
import { createDiscoveryAdapterFromStore } from "@routstr/sdk/storage";
import { existsSync } from "node:fs";
import {
  DEFAULT_CACHE_AWARE_BASKET,
  estimateCacheAwareCost,
  resolveCacheAwareRates,
  type CacheAwareBasket,
  type MissingCacheRatePolicy,
} from "../client/cacheAwareCost";

const isBun = typeof process !== "undefined" && !!(process.versions as any)?.bun;

type Args = {
  modelId: string;
  basket: CacheAwareBasket;
  routes: boolean;
  json: boolean;
  /** usage-ledger path; the measured sections are skipped when absent */
  ledgerPath: string;
};

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const modelId = argv[2]?.trim();
  if (!modelId || modelId.startsWith("--")) {
    console.error(
      "Usage: bun scripts/ranking-lab.ts <model-id> [--prompt N] [--output N] [--hit 0..1] [--routes] [--json] [--ledger path]"
    );
    process.exit(1);
  }
  return {
    modelId,
    basket: {
      promptTokens: Number(flag("--prompt") ?? DEFAULT_CACHE_AWARE_BASKET.promptTokens),
      outputTokens: Number(flag("--output") ?? DEFAULT_CACHE_AWARE_BASKET.outputTokens),
      cacheHitRate: Number(flag("--hit") ?? DEFAULT_CACHE_AWARE_BASKET.cacheHitRate),
    },
    routes: argv.includes("--routes"),
    json: argv.includes("--json"),
    ledgerPath: flag("--ledger") ?? `${process.env.HOME ?? "/root"}/.routstrd/routstr.db`,
  };
}

/** sats_pricing exactly as a node sends it — cache fields included. */
type RawPricing = {
  prompt?: number;
  completion?: number;
  request?: number;
  input_cache_read?: number;
  input_cache_write?: number;
  max_cost?: number;
};

type Candidate = {
  baseUrl: string;
  modelId: string;
  raw: RawPricing;
  disabled: boolean;
};

const f = (n: number, d = 2) => n.toFixed(d);
const perM = (n?: number) => (typeof n === "number" ? f(n * 1e6) : "—");

function rank(list: Candidate[], score: (c: Candidate) => number): Candidate[] {
  return [...list].sort((a, b) => {
    const d = score(a) - score(b);
    return d !== 0 ? d : a.baseUrl.localeCompare(b.baseUrl);
  });
}

function positionMap(list: Candidate[]): Map<string, number> {
  return new Map(list.map((c, i) => [c.baseUrl, i + 1]));
}

/** Production cost function, with the policy made explicit. */
function cost(
  c: Candidate,
  basket: CacheAwareBasket,
  policy: MissingCacheRatePolicy = "assume-miss"
): number {
  return estimateCacheAwareCost(c.raw, basket, policy).total;
}

async function loadCandidates(modelId: string) {
  // Silent logger: discovery and the SDK ranking both log tables at `log`.
  const silent = {
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silent,
  } as any;

  const { createSdkStore } = await import("@routstr/sdk/storage");
  const driver = isBun
    ? await (await import("@routstr/sdk/storage/bun")).createBunSqliteDriver("routstr.sqlite")
    : await (await import("@routstr/sdk/storage/node")).createSqliteDriver();

  const { store, hydrate } = createSdkStore({ driver });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);

  const modelManager = new ModelManager(adapter, { logger: silent });
  const providers = await modelManager.bootstrapProviders(false);
  try {
    await modelManager.fetchModels(providers);
  } catch (error) {
    console.error(`[warn] fetchModels failed, using cached catalog: ${error}`);
  }

  const providerManager = new ProviderManager(adapter, undefined, silent);
  const disabled = new Set(adapter.getDisabledProviders());

  // Enumerate through the SDK's own matcher (exact id, canonical, alias) so
  // the candidate set is exactly the one the SDK rankings use.
  const entries = providerManager.getProviderPriceRankingForModel(modelId, {
    includeDisabled: true,
  });
  const candidates: Candidate[] = entries.map((e) => ({
    baseUrl: e.baseUrl,
    modelId: e.model.id,
    raw: (e.model.sats_pricing ?? {}) as RawPricing,
    disabled: disabled.has(e.baseUrl),
  }));

  return { adapter, providerManager, candidates };
}

// ── Route-level data from GET /v1/models/paths ────────────────────────────
type RouteRow = {
  node: string;
  modelId: string;
  path: string;
  upstreamUrl: string;
  endpoint: string | null;
  rates: RawPricing;
};

async function loadRoutes(nodes: string[], modelId: string): Promise<RouteRow[]> {
  const out: RouteRow[] = [];
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const res = await fetch(new URL("v1/models/paths", node).toString(), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return;
        const payload: any = await res.json();
        for (const entry of payload?.data ?? []) {
          if (entry?.id !== modelId) continue;
          for (const p of entry.paths ?? []) {
            const sp = (p?.model?.sats_pricing ?? {}) as RawPricing;
            if (typeof sp.prompt !== "number" || typeof sp.completion !== "number") continue;
            const params = new URLSearchParams(p.path);
            out.push({
              node,
              modelId: entry.id,
              path: p.path,
              upstreamUrl: params.get("url") ?? p.path,
              endpoint: params.get("endpoint"),
              rates: sp,
            });
          }
        }
      } catch {
        /* node down / no paths endpoint */
      }
    })
  );
  // One row per distinct (upstream, endpoint): the same route reached through
  // several nodes is still one price.
  const seen = new Map<string, RouteRow>();
  for (const r of out) {
    const key = `${r.upstreamUrl}|${r.endpoint ?? ""}|${r.modelId}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

// ── Usage ledger ───────────────────────────────────────────────────────────
type LedgerStats = {
  n: number;
  promptTokens: number;
  cacheReadTokens: number;
  completionTokens: number;
  /** sats actually billed, summed over the window */
  sats: number;
};

async function loadLedger(
  dbPath: string,
  modelId: string
): Promise<Map<string, LedgerStats> | null> {
  if (!existsSync(dbPath)) return null;
  const sql = `SELECT base_url, COUNT(*) n,
                      COALESCE(SUM(prompt_tokens),0) p,
                      COALESCE(SUM(cache_read_input_tokens),0) cr,
                      COALESCE(SUM(completion_tokens),0) c,
                      COALESCE(SUM(sats_cost),0) s
                 FROM usage_tracking WHERE model_id = ? GROUP BY base_url`;
  let rows: Array<Record<string, unknown>> = [];
  try {
    if (isBun) {
      // @ts-ignore - bun:sqlite only exists at runtime in Bun
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      rows = db.query(sql).all(modelId) as any[];
      db.close();
    } else {
      const BetterSqlite3 = (await import("better-sqlite3")).default;
      const db = new BetterSqlite3(dbPath, { readonly: true });
      rows = db.prepare(sql).all(modelId) as any[];
      db.close();
    }
  } catch (error) {
    console.error(`[warn] ledger read failed (${dbPath}): ${error}`);
    return null;
  }

  const out = new Map<string, LedgerStats>();
  for (const r of rows) {
    const baseUrl = String(r.base_url ?? "");
    if (!baseUrl) continue;
    out.set(baseUrl, {
      n: Number(r.n ?? 0),
      promptTokens: Number(r.p ?? 0),
      cacheReadTokens: Number(r.cr ?? 0),
      completionTokens: Number(r.c ?? 0),
      sats: Number(r.s ?? 0),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const { candidates } = await loadCandidates(args.modelId);
  const live = candidates.filter((c) => !c.disabled);
  const { basket } = args;

  const metrics: Array<{
    name: string;
    note: string;
    score: (c: Candidate) => number;
  }> = [
    {
      name: "sdk",
      note: "(prompt+completion) sats/M — getProviderPriceRankingForModel",
      score: (c) => ((c.raw.prompt ?? 0) + (c.raw.completion ?? 0)) * 1e6,
    },
    {
      name: "basket:free",
      note: "cache-aware basket, unadvertised cache rate billed as free",
      score: (c) => cost(c, basket, "assume-free"),
    },
    {
      name: "basket:miss",
      note: "cache-aware basket, unadvertised cache rate billed at the prompt rate (production default)",
      score: (c) => cost(c, basket, "assume-miss"),
    },
    {
      name: "completion-only",
      note: "completion sats/M — findNextBestProvider's metric",
      score: (c) => (c.raw.completion ?? 0) * 1e6,
    },
  ];

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          modelId: args.modelId,
          basket,
          candidates,
          rankings: metrics.map((m) => ({
            metric: m.name,
            order: rank(live, m.score).map((c) => c.baseUrl),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  // ── 1. Raw rates ───────────────────────────────────────────────────────
  console.log(
    `\n${args.modelId}: ${candidates.length} candidate route(s), ${live.length} enabled` +
      `   [basket ${basket.promptTokens} in @ ${(basket.cacheHitRate * 100).toFixed(0)}% cache hit, ${basket.outputTokens} out]`
  );
  console.table(
    candidates.map((c) => {
      const rates = resolveCacheAwareRates(c.raw);
      return {
        route: c.baseUrl.replace(/^https?:\/\//, ""),
        model: c.modelId,
        "prompt /M": perM(c.raw.prompt),
        "cache-read /M": perM(c.raw.input_cache_read),
        "cache-write /M": perM(c.raw.input_cache_write),
        "completion /M": perM(c.raw.completion),
        "max_cost": f(c.raw.max_cost ?? 0),
        state: c.disabled ? "disabled" : "live",
        "cache-read src": rates.cacheReadSource,
      };
    })
  );

  // ── 2. Metric comparison ───────────────────────────────────────────────
  const orders = metrics.map((m) => ({ metric: m, order: rank(live, m.score) }));
  const positions = new Map(orders.map((o) => [o.metric.name, positionMap(o.order)]));
  const reference = orders.find((o) => o.metric.name === "basket:miss")!;

  console.log(`\nRank per metric (rows ordered by basket:miss):`);
  console.table(
    reference.order.map((c, i) => {
      const row: Record<string, string> = {
        "#": String(i + 1),
        route: c.baseUrl.replace(/^https?:\/\//, ""),
        "basket sats": f(cost(c, basket)),
      };
      for (const o of orders) row[o.metric.name] = `#${positions.get(o.metric.name)!.get(c.baseUrl)}`;
      return row;
    })
  );

  const sdkTop = orders.find((o) => o.metric.name === "sdk")!.order[0];
  const best = reference.order[0];
  if (sdkTop && best) {
    const sdkCost = cost(sdkTop, basket);
    const bestCost = cost(best, basket);
    console.log(
      `\nbasket:miss picks ${best.baseUrl} @ ${f(bestCost)} sats\n` +
        `sdk metric picks ${sdkTop.baseUrl} @ ${f(sdkCost)} sats ` +
        `-> ${f((sdkCost / Math.max(bestCost, 1e-9) - 1) * 100, 1)}% over the cheapest`
    );
  }

  console.log(`\nMetric notes:`);
  for (const m of metrics) console.log(`  ${m.name.padEnd(16)} ${m.note}`);

  // ── 3. Winner by cache-hit rate ────────────────────────────────────────
  const hits = [0, 0.5, 0.8, 0.88, 0.9, 0.95, 0.99, 1];
  console.log(
    `\nWinner by cache-hit rate (${basket.promptTokens} in / ${basket.outputTokens} out, zeroPolicy=assume-miss):`
  );
  console.table(
    hits.map((h) => {
      const b = { ...basket, cacheHitRate: h };
      const sorted = rank(live, (c) => cost(c, b));
      const [top, second] = sorted;
      return {
        hit: `${(h * 100).toFixed(0)}%`,
        winner: top?.baseUrl.replace(/^https?:\/\//, "") ?? "—",
        sats: top ? f(cost(top, b)) : "—",
        runnerUp: second?.baseUrl.replace(/^https?:\/\//, "") ?? "—",
        gap: top && second ? `${f(cost(second, b) / Math.max(cost(top, b), 1e-9))}x` : "—",
        "sdk pick cost": sdkTop ? f(cost(sdkTop, b)) : "—",
        "sdk regret": sdkTop && top
          ? `${f((cost(sdkTop, b) / Math.max(cost(top, b), 1e-9) - 1) * 100, 1)}%`
          : "—",
      };
    })
  );

  // ── 4. Measured profile from the local usage ledger ────────────────────
  const ledger = await loadLedger(args.ledgerPath, args.modelId);

  if (ledger && ledger.size > 0) {
    const measured = live
      .map((c) => ({ c, m: ledger.get(c.baseUrl) }))
      .filter((x): x is { c: Candidate; m: LedgerStats } => !!x.m && x.m.n > 0);

    console.log(`\n=== Measured per (model, route) — ledger ${args.ledgerPath} ===`);
    console.table(
      measured.map(({ c, m }) => ({
        route: c.baseUrl.replace(/^https?:\/\//, ""),
        requests: String(m.n),
        "hit rate": `${f((100 * m.cacheReadTokens) / Math.max(m.promptTokens, 1), 1)}%`,
        "avg prompt": String(Math.round(m.promptTokens / m.n)),
        "avg cache read": String(Math.round(m.cacheReadTokens / m.n)),
        "avg output": String(Math.round(m.completionTokens / m.n)),
        "avg sats paid": f(m.sats / m.n),
      }))
    );

    const unmeasured = live.filter((c) => !ledger.get(c.baseUrl)?.n);
    if (unmeasured.length) {
      console.log(
        `unmeasured (no ledger rows): ${unmeasured.map((c) => c.baseUrl).join(", ")}`
      );
    }

    // Predicted vs delivered on each route's *own* measured basket: does the
    // advertised price explain the bill?
    console.log(`\n=== Predicted vs delivered (route's own measured basket) ===`);
    console.table(
      measured.map(({ c, m }) => {
        const own: CacheAwareBasket = {
          promptTokens: m.promptTokens / m.n,
          outputTokens: m.completionTokens / m.n,
          cacheHitRate: m.cacheReadTokens / Math.max(m.promptTokens, 1),
        };
        const predicted = cost(c, own);
        const delivered = m.sats / m.n;
        return {
          route: c.baseUrl.replace(/^https?:\/\//, ""),
          "predicted sats": f(predicted),
          "delivered sats": f(delivered),
          "pred/deliv": `${f(predicted / Math.max(delivered, 1e-9))}x`,
        };
      })
    );

    // Calibrated basket: advertised rates give the shape of the bill, the
    // ledger gives its level: k = delivered/predicted on the route's own
    // measured basket, then applied to the reference basket.
    const MIN_SAMPLES = 20;
    const calibrated = live
      .map((c) => {
        const m = ledger.get(c.baseUrl);
        const assumed = cost(c, basket);
        if (!m || m.n < MIN_SAMPLES) {
          return {
            c,
            cost: assumed,
            k: 1,
            n: m?.n ?? 0,
            trusted: false,
            reason: m ? `n=${m.n} < ${MIN_SAMPLES}` : "no history",
          };
        }
        const own: CacheAwareBasket = {
          promptTokens: m.promptTokens / m.n,
          outputTokens: m.completionTokens / m.n,
          cacheHitRate: m.cacheReadTokens / Math.max(m.promptTokens, 1),
        };
        const predicted = cost(c, own);
        const k = predicted > 0 ? m.sats / m.n / predicted : 1;
        return { c, cost: assumed * k, k, n: m.n, trusted: true, reason: "" };
      })
      .sort((a, b) => a.cost - b.cost);

    console.log(`\n=== Calibrated basket (advertised shape x ledger level) ===`);
    console.table(
      calibrated.map((r, i) => ({
        "#": String(i + 1),
        route: r.c.baseUrl.replace(/^https?:\/\//, ""),
        "calibrated sats": f(r.cost),
        "calibration k": `${f(r.k, 2)}x`,
        samples: String(r.n),
        basis: r.trusted ? "calibrated" : r.reason,
        "sdk rank": `#${positions.get("sdk")!.get(r.c.baseUrl)}`,
      }))
    );

    // Decision table: what each metric picks, and what that pick is worth on
    // the calibrated basis.
    const truth = (c: Candidate) =>
      calibrated.find((r) => r.c.baseUrl === c.baseUrl)?.cost ?? Infinity;
    const bestCal = calibrated[0];
    const picks = [
      ...orders.map((o) => ({ metric: o.metric.name, pick: o.order[0] as Candidate | undefined })),
      { metric: "calibrated", pick: bestCal?.c as Candidate | undefined },
    ];
    console.log(`\n=== Decision table (cost of each metric's pick, calibrated basis) ===`);
    console.table(
      picks.map((p) => ({
        metric: p.metric,
        pick: p.pick?.baseUrl.replace(/^https?:\/\//, "") ?? "—",
        "sats @ calibrated": p.pick ? f(truth(p.pick)) : "—",
        "vs best":
          p.pick && bestCal
            ? `${f((truth(p.pick) / Math.max(bestCal.cost, 1e-9) - 1) * 100, 1)}%`
            : "—",
      }))
    );
  } else if (ledger === null) {
    console.log(`\n(no usage ledger at ${args.ledgerPath} — measured sections skipped)`);
  }

  // ── 5. Route-level view ────────────────────────────────────────────────
  if (args.routes) {
    const nodes = live.map((c) => c.baseUrl);
    console.log(`\nFetching /v1/models/paths from ${nodes.length} live node(s)...`);
    const routes = await loadRoutes(nodes, args.modelId);
    if (routes.length === 0) {
      console.log(`No advertised routes for ${args.modelId} (endpoint unsupported or model unfiled).`);
    } else {
      const scored = routes
        .map((r) => ({
          route: `${r.upstreamUrl.replace(/^https?:\/\//, "")}${r.endpoint ? ` [${r.endpoint}]` : ""}`,
          sats: estimateCacheAwareCost(r.rates, basket).total,
          prompt: r.rates.prompt,
          cacheRead: r.rates.input_cache_read,
          completion: r.rates.completion,
        }))
        .sort((a, b) => a.sats - b.sats);
      console.log(`\n=== ${scored.length} upstream route(s) for ${args.modelId}, cache-aware basket cost ===`);
      console.table(
        scored.slice(0, 25).map((r, i) => ({
          "#": String(i + 1),
          route: r.route,
          "basket sats": f(r.sats),
          "prompt /M": perM(r.prompt),
          "cache-read /M": perM(r.cacheRead),
          "completion /M": perM(r.completion),
        }))
      );
    }
  }
}

main().catch((error) => {
  console.error("ranking-lab failed:", error);
  process.exit(1);
});
