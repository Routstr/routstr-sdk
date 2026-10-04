/**
 * Unit tests: provider-mint cache wiring.
 *
 * Fetching a provider's `/v1/info` (used as the legacy-model-id fallback and
 * by MintDiscovery) advertises the mints the node accepts. That list must be
 * persisted into the mint cache so BalanceManager can refuse to spend a mint
 * the provider rejects — otherwise the SDK spends the wallet's largest mint
 * regardless of what the node accepts (finding #4).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, ProviderInfo, SdkLogger } from "../../core/types";

const PROVIDER = "https://provider.example.com/";

const silentLogger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

function makeAdapter(models: Record<string, Model[]> = {}): DiscoveryAdapter {
  let mints: Record<string, string[]> = {};
  let info: Record<string, ProviderInfo> = {};
  return {
    getCachedModels: () => models,
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

// A provider whose cached model list does not contain the requested id forces
// getModelForProvider down the `/v1/info` legacy fallback path.
const cachedModels = {
  [PROVIDER]: [{ id: "some-other-model", name: "Other" } as Model],
};

describe("provider mint cache wiring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists /v1/info mints into getCachedMints()", async () => {
    const adapter = makeAdapter(cachedModels);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          version: "0.1.0",
          mints: ["https://mint.example.com", "https://mint-two.example.com/"],
        })
      )
    );

    const manager = new ProviderManager(adapter, undefined, silentLogger);
    await manager.getModelForProvider(PROVIDER, "missing-model");

    expect(adapter.getCachedMints()[PROVIDER]).toEqual([
      "https://mint.example.com",
      "https://mint-two.example.com",
    ]);
  });

  it("does not clobber the mint cache when /v1/info has no mints", async () => {
    const adapter = makeAdapter(cachedModels);
    adapter.setCachedMints({ [PROVIDER]: ["https://existing.example.com"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ version: "0.1.0" }))
    );

    const manager = new ProviderManager(adapter, undefined, silentLogger);
    await manager.getModelForProvider(PROVIDER, "missing-model");

    expect(adapter.getCachedMints()[PROVIDER]).toEqual([
      "https://existing.example.com",
    ]);
  });

  it("providerAcceptsAnyMint fails open when the provider mint list is unknown", () => {
    const adapter = makeAdapter(cachedModels);
    const manager = new ProviderManager(adapter, undefined, silentLogger);
    expect(
      manager.providerAcceptsAnyMint(PROVIDER, ["https://mint.example.com"])
    ).toBe(true);

    adapter.setCachedMints({ [PROVIDER]: ["https://mint.example.com"] });
    expect(
      manager.providerAcceptsAnyMint(PROVIDER, ["https://other.example.com"])
    ).toBe(false);
    expect(
      manager.providerAcceptsAnyMint(PROVIDER, ["https://mint.example.com"])
    ).toBe(true);
  });
});

describe("ProviderManager mint-aware failover ranking", () => {
  const CHEAP = "https://cheap.example.com/";
  const RICH = "https://rich.example.com/";
  const MINT_A = "https://mint-a.example.com";
  const MINT_B = "https://mint-b.example.com";

  function pricedModel(cost: number): Model {
    return {
      id: "gpt-test",
      name: "GPT Test",
      sats_pricing: { prompt: cost, completion: cost, max_cost: 100 },
    } as Model;
  }

  function managerWithMints(mints: Record<string, string[]>) {
    const adapter = makeAdapter({
      [CHEAP]: [pricedModel(1)],
      [RICH]: [pricedModel(2)],
    });
    adapter.setCachedMints(mints);
    return new ProviderManager(adapter, undefined, silentLogger);
  }

  it("skips the cheapest provider that accepts none of the funded mints", () => {
    const manager = managerWithMints({
      [CHEAP]: [MINT_A],
      [RICH]: [MINT_B],
    });
    expect(
      manager.findNextBestProvider("gpt-test", "https://failed.example/", new Set(), {
        acceptableMintUrls: [MINT_B],
      })
    ).toBe(RICH);
  });

  it("keeps cheapest-first when no acceptable mints are known", () => {
    const manager = managerWithMints({
      [CHEAP]: [MINT_A],
      [RICH]: [MINT_B],
    });
    expect(
      manager.findNextBestProvider("gpt-test", "https://failed.example/", new Set())
    ).toBe(CHEAP);
  });

  it("fails open for a provider whose mint list is unknown", () => {
    const manager = managerWithMints({
      [CHEAP]: [],
      [RICH]: [MINT_B],
    });
    expect(
      manager.findNextBestProvider("gpt-test", "https://failed.example/", new Set(), {
        acceptableMintUrls: [MINT_B],
      })
    ).toBe(CHEAP);
  });
});
