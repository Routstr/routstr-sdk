/**
 * Unit tests: provider failure reporting across fetch passes.
 *
 * The diffing logic lives in `discovery/providerOutageReport.ts` as pure
 * functions, so most of this file exercises them directly with no
 * `ModelManager` or `DiscoveryAdapter`. A refresh runs on a fixed cadence
 * against a mostly stable provider set, so the same unreachable nodes must not
 * re-print a raw warning every pass; only transitions are raw lines and the
 * steady state collapses into one bounded summary. A provider that was not
 * retried must never be called "recovered".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyProviderFailure,
  diffProviderOutage,
  type ProviderOutcome,
} from "../../discovery/providerOutageReport";
import { ModelManager } from "../../discovery/ModelManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { SdkLogger } from "../../core/types";

const A = "https://provider-a.example.com/";
const B = "https://provider-b.example.com/";

const connectError = () =>
  new TypeError("Unable to connect. Is the computer able to access the url?");

/** A failed outcome built from an error, routed through the real classifier. */
const failed = (base: string, error: Error): ProviderOutcome => ({
  base,
  failure: classifyProviderFailure(error),
});

const ok = (base: string): ProviderOutcome => ({ base });

/** Failure state a pass would carry forward, for seeding the next pass. */
const carried = (...outcomes: ProviderOutcome[]) =>
  diffProviderOutage(new Map(), outcomes, new Set(), outcomes.length, 0).failures;

const levels = (lines: Array<{ level: string }>) => lines.map((l) => l.level);

describe("diffProviderOutage", () => {
  it("warns once for a new failure, then only summarizes the repeat", () => {
    const previous = carried(failed(B, connectError()));
    const first = diffProviderOutage(new Map(), [ok(A), failed(B, connectError())], new Set([A]), 2, 9800);

    expect(levels(first.lines)).toEqual(["warn", "info"]);
    expect(first.lines[0].message).toContain(B);
    expect(first.lines[0].message).toContain("unreachable");
    expect(first.lines[1].message).toContain("1/2 providers ok");
    expect(first.lines[1].message).toContain("1 unavailable (1 new, 0 unchanged)");

    const second = diffProviderOutage(previous, [ok(A), failed(B, connectError())], new Set([A]), 2, 9800);

    // The unchanged outage is not repeated as a raw line, but the pass still
    // names the provider and ages the outage at debug.
    expect(levels(second.lines)).toEqual(["debug", "info"]);
    expect(second.lines[0].message).toContain("2 consecutive failed pass(es)");
    expect(second.lines[1].message).toContain("1 unavailable (0 new, 1 unchanged)");
    expect(second.lines[1].message).toContain("provider-b.example.com(connect)");
  });

  it("re-warns when a provider starts failing for a different reason", () => {
    const previous = carried(failed(B, connectError()));
    const { lines } = diffProviderOutage(
      previous,
      [failed(B, new Error("Failed to fetch models: 530"))],
      new Set(),
      1,
      0
    );

    expect(levels(lines)).toEqual(["warn", "info"]);
    expect(lines[0].message).toContain("Failed to fetch models: 530");
    expect(lines[1].message).toContain("provider-b.example.com(530)");
  });

  it("keeps reporting 'is down right now' for retryable-down providers", () => {
    const { lines } = diffProviderOutage(
      new Map(),
      [failed(B, new TypeError("fetch failed"))],
      new Set(),
      1,
      0
    );
    expect(lines[0].message).toContain("is down right now");
  });

  it("reports a recovery once and clears the outage", () => {
    const previous = carried(failed(B, connectError()));
    const { lines, failures } = diffProviderOutage(previous, [ok(B)], new Set([B]), 1, 500);

    expect(levels(lines)).toEqual(["info"]);
    expect(lines[0].message).toContain("1/1 providers ok");
    expect(lines[0].message).toContain("recovered: provider-b.example.com");
    expect(failures.size).toBe(0);

    // The outage is forgotten, so a later healthy pass says nothing at info.
    const later = diffProviderOutage(failures, [ok(B)], new Set([B]), 1, 500);
    expect(levels(later.lines)).toEqual(["debug"]);
  });

  it("does not call a provider recovered when it was never retried", () => {
    const previous = carried(failed(B, connectError()));
    // B is no longer in the provider set (its discovery event vanished), so it
    // is neither recovered nor re-reported.
    const { lines, failures } = diffProviderOutage(previous, [ok(A)], new Set([A]), 1, 0);

    expect(levels(lines)).toEqual(["debug"]);
    expect(failures.size).toBe(0);
  });

  it("bounds a wide outage to one line and names at most six hosts", () => {
    const providers = Array.from(
      { length: 12 },
      (_, i) => `https://down-${i}.example.com/`
    );
    const error = new Error("Failed to fetch models: 503");
    const { lines } = diffProviderOutage(
      new Map(),
      providers.map((p) => failed(p, error)),
      new Set(),
      12,
      0
    );

    expect(levels(lines)).toEqual([...Array(12).fill("warn"), "info"]);
    const info = lines[12].message;
    expect(info).toContain("0/12 providers ok");
    expect(info).toContain("12 unavailable (12 new, 0 unchanged)");
    expect(info).toContain("down-0.example.com(503)");
    expect(info).toContain("+6 more");
    expect(info).not.toContain("down-6.example.com");
  });
});

/** In-memory adapter: a Proxy stubs the ~45 unused interface methods. */
function makeAdapter(): DiscoveryAdapter {
  const cache: Record<string, import("../../core/types").Model[]> = {};
  const stamps = new Map<string, number>();
  const impl: Partial<DiscoveryAdapter> = {
    getCachedModels: () => cache,
    setCachedModels: (models) => {
      for (const key of Object.keys(cache)) delete cache[key];
      Object.assign(cache, models);
    },
    getProviderLastUpdate: (url) => stamps.get(url) ?? null,
    setProviderLastUpdate: (url, ts) => void stamps.set(url, ts),
    getDisabledProviders: () => [],
    getModelIdMappings: () => null,
  };
  return new Proxy(impl, {
    get: (target, prop) =>
      prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => undefined,
  }) as DiscoveryAdapter;
}

type Captured = { level: string; text: string };

function capturingLogger(): {
  logger: SdkLogger;
  lines: Captured[];
  at: (level: string) => string[];
} {
  const lines: Captured[] = [];
  const record = (level: string) => (...args: unknown[]) =>
    lines.push({ level, text: args.map(String).join(" ") });
  const logger: SdkLogger = {
    log: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    child: () => logger,
  };
  return {
    logger,
    lines,
    at: (level) => lines.filter((l) => l.level === level).map((l) => l.text),
  };
}

describe("fetchModels wiring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("diffs each pass and emits the lines the pure diff returns", async () => {
    const capture = capturingLogger();
    const manager = new ModelManager(makeAdapter(), { logger: capture.logger });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(A)
          ? Response.json({ data: [] })
          : Promise.reject(connectError())
      )
    );

    await manager.fetchModels([A, B], true);
    expect(capture.at("warn")).toHaveLength(1);
    expect(capture.at("warn")[0]).toContain(B);
    expect(capture.at("info")[0]).toContain("1 unavailable (1 new, 0 unchanged)");

    capture.lines.length = 0;
    await manager.fetchModels([A, B], true);
    expect(capture.at("warn")).toHaveLength(0);
    expect(capture.at("info")).toHaveLength(1);
    expect(capture.at("info")[0]).toContain("1 unavailable (0 new, 1 unchanged)");
  });
});
