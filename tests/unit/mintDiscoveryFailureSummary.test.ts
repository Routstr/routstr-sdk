/**
 * Unit tests: compact mint-discovery failure reporting.
 *
 * Mint discovery runs on the same ~21-minute cadence as the model refresh
 * against a mostly stable provider set, so it must report the same way: a raw
 * warning only on a transition (newly failed, or failing differently), and one
 * bounded summary per pass. The previous code printed a full error object per
 * provider per pass, which flooded the daemon log with stack traces.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MintDiscovery } from "../../discovery/MintDiscovery";
import {
  classifyProviderFailure,
  diffProviderOutage,
  type ProviderOutcome,
} from "../../discovery/providerOutageReport";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { SdkLogger } from "../../core/types";

const A = "https://provider-a.example.com/";
const B = "https://provider-b.example.com/";

const connectError = () =>
  new TypeError("Unable to connect. Is the computer able to access the url?");

const infoResponse = (mints: string[] = ["https://mint.example.com"]) =>
  Response.json({ mints });

const failed = (base: string, error: Error): ProviderOutcome => ({
  base,
  failure: classifyProviderFailure(error),
});

/** In-memory adapter: a Proxy stubs the interface methods MintDiscovery ignores. */
function makeAdapter(): DiscoveryAdapter {
  let mints: Record<string, string[]> = {};
  let info: Record<string, import("../../discovery/interfaces").ProviderInfo> =
    {};
  const impl: Partial<DiscoveryAdapter> = {
    getCachedMints: () => mints,
    setCachedMints: (next) => {
      mints = next;
    },
    getCachedProviderInfo: () => info,
    setCachedProviderInfo: (next) => {
      info = next;
    },
  };
  return new Proxy(impl, {
    get: (target, prop) =>
      prop in target
        ? (target as Record<string | symbol, unknown>)[prop]
        : () => undefined,
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

describe("diffProviderOutage label", () => {
  it("names the pass in both the summary and the all-ok line", () => {
    const { lines } = diffProviderOutage(
      new Map(),
      [failed(B, connectError())],
      new Set(),
      1,
      9800,
      "Mint discovery"
    );
    expect(lines.at(-1)!.message).toContain(
      "Mint discovery: 0/1 providers ok"
    );

    const allOk = diffProviderOutage(
      new Map(),
      [{ base: A }],
      new Set([A]),
      1,
      500,
      "Mint discovery"
    );
    expect(allOk.lines[0].message).toBe(
      "Mint discovery: all 1 provider(s) ok in 0.5s"
    );
  });
});

describe("MintDiscovery failure summary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("warns once for a new outage, then only summarizes the repeat", async () => {
    const capture = capturingLogger();
    const discovery = new MintDiscovery(makeAdapter(), {
      logger: capture.logger,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(A) ? infoResponse() : Promise.reject(connectError())
      )
    );

    await discovery.discoverMints([A, B]);
    expect(capture.at("warn")).toHaveLength(1);
    expect(capture.at("warn")[0]).toContain(B);
    expect(capture.at("warn")[0]).toContain("unreachable");
    // No error object is passed through, so no stack is printed.
    expect(capture.at("warn")[0]).not.toContain("\n    at ");
    expect(capture.at("info")).toHaveLength(1);
    expect(capture.at("info")[0]).toContain("Mint discovery:");
    expect(capture.at("info")[0]).toContain("1/2 providers ok");
    expect(capture.at("info")[0]).toContain("1 unavailable (1 new, 0 unchanged)");

    capture.lines.length = 0;
    await discovery.discoverMints([A, B]);
    expect(capture.at("warn")).toHaveLength(0);
    expect(capture.at("info")).toHaveLength(1);
    expect(capture.at("info")[0]).toContain("1 unavailable (0 new, 1 unchanged)");
    expect(capture.at("info")[0]).toContain("provider-b.example.com(connect)");
  });

  it("classifies an HTTP rejection from /v1/info by status", async () => {
    const capture = capturingLogger();
    const discovery = new MintDiscovery(makeAdapter(), {
      logger: capture.logger,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 405 }))
    );

    await discovery.discoverMints([A]);
    expect(capture.at("warn")[0]).toContain("Failed to fetch info: 405");
    expect(capture.at("info")[0]).toContain("provider-a.example.com(405)");
  });

  it("reports a provider that starts answering again as recovered", async () => {
    const capture = capturingLogger();
    const discovery = new MintDiscovery(makeAdapter(), {
      logger: capture.logger,
    });
    let bAnswers = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(A) || bAnswers) return infoResponse();
        throw connectError();
      })
    );

    await discovery.discoverMints([A, B]);
    expect(capture.at("warn")).toHaveLength(1);

    capture.lines.length = 0;
    bAnswers = true;
    await discovery.discoverMints([A, B]);
    expect(capture.at("warn")).toHaveLength(0);
    expect(capture.at("info")[0]).toContain("recovered: provider-b.example.com");
  });
});
