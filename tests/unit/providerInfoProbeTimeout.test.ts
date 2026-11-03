/**
 * Unit tests: the `/v1/info` probe is bounded.
 *
 * `getModelForProvider` falls back to `GET /v1/info` when the cached model list
 * has no match. That probe used to be a bare `fetch`: a node that accepted the
 * connection and then never answered held the call for the runtime default
 * (~300 s on Node, unbounded on Bun), and with it any request that was failing
 * over. These tests pin the absence of that failure mode, not the exact
 * milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, ProviderInfo, SdkLogger } from "../../core/types";

const PROVIDER = "https://provider.example.com/";
/** Mirrors INFO_FETCH_TIMEOUT_MS in client/ProviderManager.ts. */
const PROBE_DEADLINE_MS = 10_000;

const silentLogger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

function makeAdapter(): DiscoveryAdapter {
  let mints: Record<string, string[]> = {};
  let info: Record<string, ProviderInfo> = {};
  return {
    // The requested id is absent, so the cached-list match misses and the
    // `/v1/info` fallback runs.
    getCachedModels: () => ({
      [PROVIDER]: [{ id: "some-other-model", name: "Other" } as Model],
    }),
    setCachedModels: () => {},
    getCachedMints: () => mints,
    setCachedMints: (value) => {
      mints = value;
    },
    getCachedProviderInfo: () => info,
    setCachedProviderInfo: (value) => {
      info = value;
    },
    getProviderLastUpdate: () => null,
    setProviderLastUpdate: () => {},
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    getManuallyDisabledProviders: () => [],
    getBaseUrlsList: () => [],
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  };
}

describe("provider info probe deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("gives up on a probe that never answers", async () => {
    const adapter = makeAdapter();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const manager = new ProviderManager(adapter, undefined, silentLogger);

    let settled = false;
    const lookup = manager
      .getModelForProvider(PROVIDER, "missing-model")
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal to the probe so a runtime can cancel it", async () => {
    const adapter = makeAdapter();
    let seenSignal: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seenSignal = init?.signal;
        return Response.json({ version: "0.1.0" });
      }),
    );
    const manager = new ProviderManager(adapter, undefined, silentLogger);

    await manager.getModelForProvider(PROVIDER, "missing-model");

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("never publishes a response that arrives after the deadline", async () => {
    const adapter = makeAdapter();
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      ),
    );
    const manager = new ProviderManager(adapter, undefined, silentLogger);

    const lookup = manager.getModelForProvider(PROVIDER, "missing-model");
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    await expect(lookup).resolves.toBeNull();

    // The runtime ignored the abort and answered anyway: the late payload is
    // data only, so it must not land in either cache.
    release(
      Response.json({
        version: "0.1.0",
        mints: ["https://mint.example.com"],
      })
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.getCachedProviderInfo()).toEqual({});
    expect(adapter.getCachedMints()).toEqual({});
  });

  it("still caches a probe that answers inside the deadline", async () => {
    const adapter = makeAdapter();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          version: "0.1.0",
          mints: ["https://mint.example.com"],
        })
      )
    );
    const manager = new ProviderManager(adapter, undefined, silentLogger);

    await manager.getModelForProvider(PROVIDER, "missing-model");

    expect(adapter.getCachedProviderInfo()[PROVIDER]).toMatchObject({
      version: "0.1.0",
    });
    expect(adapter.getCachedMints()[PROVIDER]).toEqual([
      "https://mint.example.com",
    ]);
  });
});
