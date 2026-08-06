/**
 * Unit tests: MintDiscovery freshness tracking
 *
 * Mint discovery keeps its own freshness clock. It must never read or write
 * the adapter's provider timestamp, which belongs to the model cache: mint
 * refreshes kept stamping failed model fetches as valid.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MintDiscovery } from "../../discovery/MintDiscovery";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { SdkLogger } from "../../core/types";

const PROVIDER_A = "https://provider-a.example.com/";
const PROVIDER_B = "https://provider-b.example.com/";

const silentLogger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

function makeAdapter(): DiscoveryAdapter {
  let cachedMints: Record<string, string[]> = {};
  let cachedInfo: Record<string, never> = {};
  return {
    getCachedModels: () => ({}),
    setCachedModels: () => {},
    getCachedMints: () => cachedMints,
    setCachedMints: (mints) => {
      cachedMints = mints;
    },
    getCachedProviderInfo: () => cachedInfo,
    setCachedProviderInfo: (info) => {
      cachedInfo = info as Record<string, never>;
    },
    getProviderLastUpdate: vi.fn(() => null),
    setProviderLastUpdate: vi.fn(),
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

const infoResponse = () => Response.json({ mints: ["https://mint.example.com"] });

describe("MintDiscovery freshness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never touches the model cache freshness stamp", async () => {
    const adapter = makeAdapter();
    const discovery = new MintDiscovery(adapter, { logger: silentLogger });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(PROVIDER_A)) return infoResponse();
        throw new TypeError("fetch failed");
      })
    );

    await discovery.discoverMints([PROVIDER_A, PROVIDER_B]);
    expect(adapter.setProviderLastUpdate).not.toHaveBeenCalled();
    expect(adapter.getProviderLastUpdate).not.toHaveBeenCalled();
  });

  it("passes an abort signal so a hanging provider cannot stall the pass", async () => {
    const adapter = makeAdapter();
    const discovery = new MintDiscovery(adapter, { logger: silentLogger });
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return infoResponse();
      })
    );

    await discovery.discoverMints([PROVIDER_A]);
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("serves cached info within the TTL and retries failed providers", async () => {
    const adapter = makeAdapter();
    const discovery = new MintDiscovery(adapter, { logger: silentLogger });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PROVIDER_A)) return infoResponse();
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await discovery.discoverMints([PROVIDER_A, PROVIDER_B]);
    const callsAfterFirst = fetchMock.mock.calls.length;

    await discovery.discoverMints([PROVIDER_A, PROVIDER_B]);
    const urls = fetchMock.mock.calls
      .slice(callsAfterFirst)
      .map(([url]) => url as string);
    // A is fresh in the in-memory clock; B failed and must be retried.
    expect(urls).toEqual([`${PROVIDER_B}v1/info`]);
  });
});
