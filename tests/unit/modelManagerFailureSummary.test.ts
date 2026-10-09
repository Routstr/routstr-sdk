/**
 * Unit tests: provider failure reporting across fetch passes
 *
 * A refresh runs on a fixed cadence against a mostly stable provider set, so
 * the same unreachable nodes must not re-print a raw warning line every pass.
 * Only transitions (newly failed, failure reason changed, recovered) are raw
 * lines; the steady state collapses into one bounded summary. A provider that
 * was not retried must never be called "recovered".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ModelManager } from "../../discovery/ModelManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, SdkLogger } from "../../core/types";

const PROVIDER_A = "https://provider-a.example.com/";
const PROVIDER_B = "https://provider-b.example.com/";
const PROVIDER_C = "https://provider-c.example.com/";

type Captured = { level: string; text: string };

function capturingLogger(): {
  logger: SdkLogger;
  lines: Captured[];
  at: (level: string) => string[];
} {
  const lines: Captured[] = [];
  const record = (level: string) => (...args: unknown[]) => {
    lines.push({ level, text: args.map(String).join(" ") });
  };
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

const modelsFor = (id: string): Model[] => [
  {
    id,
    name: id,
    sats_pricing: {
      prompt: 1,
      completion: 1,
      max_completion_cost: 10,
      max_prompt_cost: 10,
      max_cost: 10,
    },
  } as Model,
];

function makeAdapter(): DiscoveryAdapter {
  let cachedModels: Record<string, Model[]> = {};
  const lastUpdate = new Map<string, number>();
  let mappings: import("../../core/modelMappings").ModelIdMappings | null = null;
  let mappingEvent: import("applesauce-core/helpers").NostrEvent | null = null;
  return {
    getModelIdMappings: () => mappings,
    setModelIdMappings: (value) => {
      mappings = value;
    },
    getModelIdMappingsEvent: () => mappingEvent,
    setModelIdMappingsEvent: (value) => {
      mappingEvent = value;
    },
    getCachedModels: () => cachedModels,
    setCachedModels: (models) => {
      cachedModels = models;
    },
    getCachedMints: () => ({}),
    setCachedMints: () => {},
    getCachedProviderInfo: () => ({}),
    setCachedProviderInfo: () => {},
    getProviderLastUpdate: (baseUrl) => lastUpdate.get(baseUrl) ?? null,
    setProviderLastUpdate: (baseUrl, timestamp) => {
      lastUpdate.set(baseUrl, timestamp);
    },
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    setDisabledProviders: () => {},
    getManuallyDisabledProviders: () => [],
    setManuallyDisabledProviders: () => {},
    getBaseUrlsList: () => [],
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getModelIdMappingsLastUpdate: () => Date.now(),
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  };
}

/** A provider that answers with one model, or fails with `error`. */
const answering = (id: string | Error) =>
  vi.fn(async () =>
    id instanceof Error ? Promise.reject(id) : Response.json({ data: modelsFor(id) })
  );

const connectError = () =>
  new TypeError("Unable to connect. Is the computer able to access the url?");

describe("fetchModels provider failure reporting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warns once for a new failure, then only summarizes the repeat", async () => {
    const adapter = makeAdapter();
    const capture = capturingLogger();
    const manager = new ModelManager(adapter, { logger: capture.logger });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(PROVIDER_A)
          ? Response.json({ data: modelsFor("model-a") })
          : Promise.reject(connectError())
      )
    );

    await manager.fetchModels([PROVIDER_A, PROVIDER_B], true);
    const firstWarns = capture.at("warn");
    expect(firstWarns).toHaveLength(1);
    expect(firstWarns[0]).toContain(PROVIDER_B);
    expect(firstWarns[0]).toContain("unreachable");
    expect(capture.at("info")[0]).toContain("1/2 providers ok");
    expect(capture.at("info")[0]).toContain("1 unavailable (1 new, 0 unchanged)");

    capture.lines.length = 0;
    await manager.fetchModels([PROVIDER_A, PROVIDER_B], true);

    // The unchanged outage is not repeated as a raw line, but the pass still
    // reports which provider is down and how long it has been down.
    expect(capture.at("warn")).toHaveLength(0);
    expect(capture.at("info")).toHaveLength(1);
    expect(capture.at("info")[0]).toContain("1 unavailable (0 new, 1 unchanged)");
    expect(capture.at("info")[0]).toContain("provider-b.example.com(connect)");
    // Full detail remains available to level-filtering loggers.
    expect(capture.at("debug").join("\n")).toContain("2 consecutive failed pass(es)");
  });

  it("re-warns when a provider starts failing for a different reason", async () => {
    const adapter = makeAdapter();
    const capture = capturingLogger();
    const manager = new ModelManager(adapter, { logger: capture.logger });

    vi.stubGlobal("fetch", answering(connectError()));
    await manager.fetchModels([PROVIDER_B], true);
    expect(capture.at("warn")[0]).toContain("unreachable");

    capture.lines.length = 0;
    vi.stubGlobal("fetch", answering(new Error("Failed to fetch models: 530")));
    await manager.fetchModels([PROVIDER_B], true);

    expect(capture.at("warn")).toHaveLength(1);
    expect(capture.at("warn")[0]).toContain("Failed to fetch models: 530");
    expect(capture.at("info")[0]).toContain("provider-b.example.com(530)");
  });

  it("keeps reporting 'is down right now' for retryable-down providers", async () => {
    const adapter = makeAdapter();
    const capture = capturingLogger();
    const manager = new ModelManager(adapter, { logger: capture.logger });
    vi.stubGlobal("fetch", answering(new TypeError("fetch failed")));

    await manager.fetchModels([PROVIDER_B], true);
    expect(capture.at("warn")[0]).toContain("is down right now");
  });

  it("reports a recovery once and clears the outage", async () => {
    const adapter = makeAdapter();
    const capture = capturingLogger();
    const manager = new ModelManager(adapter, { logger: capture.logger });

    vi.stubGlobal("fetch", answering(connectError()));
    await manager.fetchModels([PROVIDER_B], true);
    capture.lines.length = 0;

    vi.stubGlobal("fetch", answering("model-b"));
    await manager.fetchModels([PROVIDER_B], true);

    expect(capture.at("info")).toHaveLength(1);
    expect(capture.at("info")[0]).toContain("1/1 providers ok");
    expect(capture.at("info")[0]).toContain("recovered: provider-b.example.com");

    // The outage is forgotten, so a later healthy pass says nothing at info.
    capture.lines.length = 0;
    await manager.fetchModels([PROVIDER_B], true);
    expect(capture.at("info")).toHaveLength(0);
    expect(capture.at("warn")).toHaveLength(0);
  });

  it("does not call a provider recovered when it was never retried", async () => {
    const adapter = makeAdapter();
    const capture = capturingLogger();
    const manager = new ModelManager(adapter, { logger: capture.logger });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(PROVIDER_A)
          ? Response.json({ data: modelsFor("model-a") })
          : Promise.reject(connectError())
      )
    );
    await manager.fetchModels([PROVIDER_A, PROVIDER_B], true);
    capture.lines.length = 0;

    // B is no longer part of the provider set (its discovery event vanished),
    // so it is neither recovered nor re-reported.
    await manager.fetchModels([PROVIDER_A], true);
    expect(capture.at("info")).toHaveLength(0);
    expect(capture.at("warn")).toHaveLength(0);
  });

  it("bounds a wide outage to one line and names at most six hosts", async () => {
    const adapter = makeAdapter();
    const capture = capturingLogger();
    const manager = new ModelManager(adapter, { logger: capture.logger });
    const providers = Array.from(
      { length: 12 },
      (_, i) => `https://down-${i}.example.com/`
    );
    vi.stubGlobal("fetch", answering(new Error("Failed to fetch models: 503")));

    await manager.fetchModels(providers, true);

    const warns = capture.at("warn");
    expect(warns).toHaveLength(12);
    const info = capture.at("info");
    expect(info).toHaveLength(1);
    expect(info[0]).toContain("0/12 providers ok");
    expect(info[0]).toContain("12 unavailable (12 new, 0 unchanged)");
    expect(info[0]).toContain("down-0.example.com(503)");
    expect(info[0]).toContain("+6 more");
    expect(info[0]).not.toContain("down-6.example.com");
  });
});
