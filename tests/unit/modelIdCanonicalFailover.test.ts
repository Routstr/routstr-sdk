/**
 * Regression: one requested model ("claude-opus-5.5") was spelled differently
 * in different places (requested id vs. the provider-native "claude-opus-5-5"),
 * so cooldowns were written under a key the ranking never checked and failover
 * looked up an id most nodes do not list.
 *
 * Fleet shape (mirrors the real model cache):
 * - cypherpunk: native "claude-opus-5-5", alias "claude-opus-5.5"
 * - ai.redsh1ft / otrta: BOTH "claude-opus-5-5" and "claude-opus-5.5" as
 *   separate entries (the -5-5 one pricier)
 * - ppq: only "claude-opus-5.5"
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient } from "../../client/RoutstrClient";
import { isUnknownPathError, parseCoreError } from "../../core/errorTypes";
import { MODEL_ID_MAPPINGS, canonicalizeModelId, modelIdVariants, findModelForId } from "../../core/modelMappings";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { SdkStore } from "../../storage/store";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const CYPHER = "https://cypherpunk.example/";
const REDSH1FT = "https://ai.redsh1ft.example/";
const OTRTA = "https://otrta.example/";
const PPQ = "https://ppq.example/";
const MINT = "https://mint.example/";
const KEY = "sk-test-key";

const REQUESTED = "claude-opus-5.5";
const NATIVE = "claude-opus-5-5";

const entry = (
  id: string,
  completion: number,
  extra: Partial<Model> = {}
): Model =>
  ({
    id,
    name: "Claude Opus 5.5",
    sats_pricing: {
      prompt: completion / 5,
      completion,
      max_cost: 100,
    },
    ...extra,
  }) as Model;

const catalog = (): Record<string, Model[]> => ({
  [CYPHER]: [entry(NATIVE, 1, { alias_ids: [REQUESTED] })],
  [REDSH1FT]: [entry(NATIVE, 9), entry(REQUESTED, 2)],
  [OTRTA]: [entry(NATIVE, 9), entry(REQUESTED, 3)],
  [PPQ]: [entry(REQUESTED, 4)],
});

const discovery = (models = catalog()): DiscoveryAdapter =>
  ({
    getCachedModels: () => models,
    getModelIdMappings: () => ({ [NATIVE]: REQUESTED }),
    getDisabledProviders: () => [],
    getCachedMints: () => ({}),
    getCachedProviderInfo: () => ({}),
  }) as unknown as DiscoveryAdapter;

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

function setup(models = catalog(), registry = discovery(models)) {
  const manager = new ProviderManager(registry, undefined, logger);
  const wallet = {
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT,
    sendToken: async () => KEY,
    receiveToken: async () => ({ success: false, message: "n/a" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => ({ key: KEY, baseUrl: CYPHER, balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const client = new RoutstrClient(wallet, storage, registry, "max", "apikeys", {
    providerManager: manager,
    logger,
  });
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: KEY,
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const bm = client.getBalanceManager();
  vi.spyOn(bm, "getTokenBalance").mockResolvedValue({
    amount: 399_000,
    reserved: 0,
    unit: "msat",
    apiKey: KEY,
  });
  vi.spyOn(bm, "refundApiKey").mockResolvedValue({
    success: true,
    message: "refunded",
    amount: 399,
  } as any);
  vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
  return { client, manager };
}

/** The request as resolveRequestContext hands it over: cypherpunk's native id in the body. */
const route = (client: RoutstrClient, baseUrl = CYPHER) =>
  client.routeRequest({
    path: "/v1/messages",
    method: "POST",
    body: { model: NATIVE, messages: [{ role: "user", content: "hi" }] },
    baseUrl,
    mintUrl: MINT,
    modelId: REQUESTED,
  });

const modelNotFound = () =>
  new Response(
    JSON.stringify({ error: { type: "model_not_found", message: "Model not found" } }),
    { status: 404, headers: { "content-type": "application/json" } }
  );

const pathNotFoundBody = JSON.stringify({
  error: { type: "not_found", message: "Path '/v1/v1/messages' not found" },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProviderManager canonicalizes model ids", () => {
  it("a cooldown struck under the native id hides the node from the requested-id ranking", () => {
    const { manager } = setup();
    expect(manager.getProviderPriceRankingForModel(REQUESTED)[0].baseUrl).toBe(CYPHER);

    manager.markFailed(CYPHER, "one", NATIVE);
    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(true); // first scoped strike immediately cools down
    manager.markFailed(CYPHER, "two", NATIVE);

    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(true);
    expect(manager.isOnCooldown(CYPHER, NATIVE)).toBe(true);
    const ranking = manager.getProviderPriceRankingForModel(REQUESTED);
    expect(ranking.map((r) => r.baseUrl)).not.toContain(CYPHER);
    expect(manager.getProvidersOnCooldown()).toEqual([
      expect.objectContaining({ baseUrl: CYPHER, modelId: REQUESTED }),
    ]);
  });

  it("strikes from the two spellings add up to one cooldown", () => {
    const { manager } = setup();
    manager.markFailed(CYPHER, "one", NATIVE);
    manager.markFailed(CYPHER, "two", REQUESTED);
    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(true);
  });

  it("removeFromCooldown clears the entry whichever spelling is used", () => {
    const { manager } = setup();
    manager.markFailed(CYPHER, "one", REQUESTED);
    manager.markFailed(CYPHER, "two", REQUESTED);
    manager.removeFromCooldown(CYPHER, NATIVE);
    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(false);
  });

  it("findNextBestProvider and getAllProvidersForModel accept either spelling", () => {
    const { manager } = setup();
    expect(manager.findNextBestProvider(NATIVE, CYPHER, new Set([REDSH1FT, OTRTA]))).toBe(PPQ);
    expect(manager.findNextBestProvider(REQUESTED, CYPHER, new Set([REDSH1FT, OTRTA]))).toBe(PPQ);
    const viaNative = manager.getAllProvidersForModel(NATIVE).map((p) => p.baseUrl);
    const viaRequested = manager.getAllProvidersForModel(REQUESTED).map((p) => p.baseUrl);
    expect(viaNative).toEqual(viaRequested);
    expect(viaNative).toContain(PPQ);
  });

  it("prefers the canonical entry when a node lists both spellings", async () => {
    const { manager } = setup();
    for (const id of [NATIVE, REQUESTED]) {
      const model = await manager.getModelForProvider(REDSH1FT, id);
      expect(model?.id).toBe(REQUESTED);
      expect(model?.sats_pricing?.completion).toBe(2);
    }
    // Failover ordering uses the cheaper canonical entry, not the -5-5 one.
    const ranked = manager
      .getAllProvidersForModel(NATIVE)
      .filter((p) => p.baseUrl !== CYPHER);
    expect(ranked.map((p) => [p.baseUrl, p.model.id])).toEqual([
      [REDSH1FT, REQUESTED],
      [OTRTA, REQUESTED],
      [PPQ, REQUESTED],
    ]);
    // A node serving only the native spelling is still found.
    const native = await manager.getModelForProvider(CYPHER, REQUESTED);
    expect(native?.id).toBe(NATIVE);
  });

  it("keeps persisted cooldown entries compatible (legacy spelling still blocks)", () => {
    const removeProviderFromCooldown = vi.fn();
    const state = {
      failedProviders: [],
      lastFailed: {},
      providersOnCooldown: [
        { baseUrl: CYPHER, modelId: NATIVE, timestamp: Date.now() },
        { baseUrl: PPQ, timestamp: Date.now() - 1_000_000 }, // expired
      ],
      removeProviderFromCooldown,
      addProviderOnCooldown: vi.fn(),
      addFailedProvider: vi.fn(),
      removeFailedProvider: vi.fn(),
    };
    const store = { getState: () => state } as unknown as SdkStore;
    const manager = new ProviderManager(discovery(), store, logger);
    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(true);
    expect(manager.isOnCooldown(CYPHER, NATIVE)).toBe(true);
    expect(manager.isOnCooldown(PPQ, REQUESTED)).toBe(false);

    // New cooldowns persist canonically; removal also purges the legacy spelling.
    manager.removeFromCooldown(CYPHER, REQUESTED);
    const removed = removeProviderFromCooldown.mock.calls.map((c) => c[1]);
    expect(removed).toEqual(expect.arrayContaining([REQUESTED, NATIVE]));
  });
});

describe("failover and cooldown across a mixed-spelling fleet", () => {
  it("fails over from the aliased node to a node listing only the requested id (ppq)", async () => {
    const { client, manager } = setup();
    const seen: Array<{ url: string; model: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, model: JSON.parse(init.body as string).model });
        return url.startsWith(PPQ)
          ? new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
          : modelNotFound();
      })
    );
    const markFailed = vi.spyOn(manager, "markFailed");

    const response = await route(client);

    expect(response.status).toBe(200);
    // cheapest-first walk; every hop forwards that node's NATIVE id
    expect(seen).toEqual([
      { url: `${CYPHER}v1/messages`, model: NATIVE },
      { url: `${REDSH1FT}v1/messages`, model: REQUESTED },
      { url: `${OTRTA}v1/messages`, model: REQUESTED },
      { url: `${PPQ}v1/messages`, model: REQUESTED },
    ]);
    // cooldown strikes are keyed by the requested/canonical id, not the native one
    expect(markFailed.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [CYPHER, REQUESTED],
      [REDSH1FT, REQUESTED],
      [OTRTA, REQUESTED],
    ]);
  });

  it("one failed request cools the aliased node down so the ranking skips it", async () => {
    const { client, manager } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(CYPHER)
          ? modelNotFound()
          : new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
      )
    );

    // A request starts on cypherpunk, fails, and fails over to a healthy node.
    expect((await route(client)).status).toBe(200);
    expect(manager.getProviderPriceRankingForModel(REQUESTED)[0].baseUrl).toBe(REDSH1FT);

    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(true);
    expect(manager.getProviderPriceRankingForModel(REQUESTED).map((r) => r.baseUrl)).toEqual([REDSH1FT, OTRTA, PPQ]);
  });
});

describe("unknown-path 404 is not a model failure", () => {
  it("classifies only the unknown-path envelope", () => {
    const parse = (body: string) => parseCoreError(body, 404);
    expect(isUnknownPathError(404, parse(pathNotFoundBody))).toBe(true);
    expect(isUnknownPathError(400, parse(pathNotFoundBody))).toBe(false);
    for (const body of [
      JSON.stringify({ error: { type: "model_not_found", message: "Model not found" } }),
      JSON.stringify({ error: { type: "invalid_model_path", message: "Model 'x' is not routable", code: 404 } }),
      JSON.stringify({ error: { type: "not_found", message: "Model 'claude-opus-5.5' not found" } }),
      "Not Found",
    ]) {
      expect(isUnknownPathError(404, parse(body))).toBe(false);
    }
  });

  it("gives no cooldown strike and forwards the last upstream 404 when every node rejects the path", async () => {
    const { client, manager } = setup();
    const fetchMock = vi.fn(
      async () =>
        new Response(pathNotFoundBody, {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.spyOn(manager, "markFailed");
    const refund = vi.mocked(client.getBalanceManager().refundApiKey);
    const removeApiKey = vi.spyOn((client as any).storageAdapter, "removeApiKey");

    for (let i = 0; i < 3; i++) {
      const response = await route(client);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(pathNotFoundBody);
    }

    expect(fetchMock).toHaveBeenCalledTimes(12); // every node, every request
    expect(markFailed).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled(); // the node never charged the key
    expect(removeApiKey).not.toHaveBeenCalled();
    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(false);
    expect(manager.getProvidersOnCooldown()).toEqual([]);
    expect(manager.getProviderPriceRankingForModel(REQUESTED)[0].baseUrl).toBe(CYPHER);
  });

  it("fails over when only some nodes allow the path (allowlist differs by version and config)", async () => {
    const { client, manager } = setup();
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith(CYPHER)
        ? new Response(
            JSON.stringify({ error: { type: "not_found", message: "Path '/v1/messages/count_tokens' not found" } }),
            { status: 404, headers: { "content-type": "application/json" } }
          )
        : new Response('{"input_tokens":3}', { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.spyOn(manager, "markFailed");

    const response = await client.routeRequest({
      path: "/v1/messages/count_tokens",
      method: "POST",
      body: { model: NATIVE, messages: [{ role: "user", content: "hi" }] },
      baseUrl: CYPHER,
      mintUrl: MINT,
      modelId: REQUESTED,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markFailed).not.toHaveBeenCalled();
    expect(manager.isOnCooldown(CYPHER, REQUESTED)).toBe(false);
  });

  it("still fails over on a 404 that means the model is missing on the node", async () => {
    const { client, manager } = setup();
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith(CYPHER)
        ? modelNotFound()
        : new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const markFailed = vi.spyOn(manager, "markFailed");

    const response = await route(client);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markFailed).toHaveBeenCalledTimes(1);
  });
});


describe("active Nostr mappings, not static fallback", () => {
  const native = "nostr-only-variant";
  const canonical = "nostr-only-model";
  const models = {
    [CYPHER]: [entry(native, 1)],
    [REDSH1FT]: [entry(native, 9), entry(canonical, 2)],
    [PPQ]: [entry(canonical, 3)],
  };

  it("uses a snapshot-only mapping for full failover, strikes and canonical-entry choice", async () => {
    expect(MODEL_ID_MAPPINGS[native]).toBeUndefined();
    const registry = discovery(models);
    registry.getModelIdMappings = () => ({ [native]: canonical });
    const { client, manager } = setup(models, registry);
    const lookup = vi.spyOn(manager, "getModelForProvider");
    const strikes = vi.spyOn(manager, "markFailed");
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).model);
      return url.startsWith(PPQ)
        ? Response.json({ ok: true }) : modelNotFound();
    }));
    const request = () => client.routeRequest({
      path: "/v1/messages", method: "POST", body: { model: native },
      modelId: native, baseUrl: CYPHER, mintUrl: MINT,
    });
    expect((await request()).status).toBe(200);
    expect(seen).toEqual([native, canonical, canonical]);
    expect(lookup).toHaveBeenCalledWith(REDSH1FT, canonical);
    expect(strikes.mock.calls.map((call) => call[2])).toEqual([canonical, canonical]);
    expect((await request()).status).toBe(200);
    expect(manager.isOnCooldown(CYPHER, canonical)).toBe(true);
    expect(manager.isOnCooldown(CYPHER, native)).toBe(true);
    expect(manager.getProviderPriceRankingForModel(native).map((p) => p.baseUrl)).toEqual([PPQ]);
    manager.removeFromCooldown(CYPHER, native);
    expect(manager.isOnCooldown(CYPHER, canonical)).toBe(false);
  });

  it("supports mappings through an alias when the native id itself is unmapped", async () => {
    const registry = discovery({
      [CYPHER]: [entry("unmapped-provider-native", 1, { alias_ids: [native] })],
      [PPQ]: [entry(canonical, 2)],
    });
    registry.getModelIdMappings = () => ({ [native]: canonical });
    const { client, manager } = setup(models, registry);
    const strike = vi.spyOn(manager, "markFailed");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith(CYPHER) ? modelNotFound() : Response.json({ ok: true })
    ));
    const request = () => client.routeRequest({
      path: "/v1/messages", method: "POST", body: { model: canonical },
      modelId: canonical, baseUrl: CYPHER, mintUrl: MINT,
    });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(strike.mock.calls.every((call) => call[2] === canonical)).toBe(true);
    expect(manager.getProviderPriceRankingForModel(canonical).map((p) => p.baseUrl)).toEqual([PPQ]);
  });

  it("an empty signed snapshot disables fallback; null or a missing getter enables it", () => {
    const fallbackNative = "z-ai-glm-5-3";
    const fallbackCanonical = "glm-5.3";
    const registry = discovery({ [CYPHER]: [entry(fallbackNative, 1)], [PPQ]: [entry(fallbackCanonical, 2)] });
    registry.getModelIdMappings = () => ({});
    const manager = new ProviderManager(registry, undefined, logger);
    expect(manager.canonicalizeModelId(fallbackNative)).toBe(fallbackNative);
    expect(manager.findNextBestProvider(fallbackNative, CYPHER)).toBeNull();
    manager.markFailed(CYPHER, "one", fallbackNative);
    manager.markFailed(CYPHER, "two", fallbackNative);
    expect(manager.isOnCooldown(CYPHER, fallbackCanonical)).toBe(false);
    registry.getModelIdMappings = () => null;
    expect(manager.canonicalizeModelId(fallbackNative)).toBe(fallbackCanonical);
    expect(manager.isOnCooldown(CYPHER, fallbackCanonical)).toBe(true);
    expect(manager.findNextBestProvider(fallbackNative, CYPHER)).toBe(PPQ);
    delete (registry as Partial<DiscoveryAdapter>).getModelIdMappings;
    expect(manager.canonicalizeModelId(fallbackNative)).toBe(fallbackCanonical);
  });

  it("rekeys strikes when a snapshot arrives after the first failure", () => {
    const registry = discovery(models);
    let snapshot: Record<string, string> | null = null;
    registry.getModelIdMappings = () => snapshot;
    const manager = new ProviderManager(registry, undefined, logger);
    manager.markFailed(CYPHER, "first", native);
    snapshot = { [native]: canonical };
    manager.markFailed(CYPHER, "second", canonical);
    expect(manager.isOnCooldown(CYPHER, native)).toBe(true);
    expect(manager.isOnCooldown(CYPHER, canonical)).toBe(true);
  });

  it("hydrates and removes legacy native-id persisted entries with snapshot-only mappings", () => {
    const registry = discovery(models);
    registry.getModelIdMappings = () => ({ [native]: canonical });
    const remove = vi.fn();
    const state = {
      failedProviders: [], lastFailed: {},
      providersOnCooldown: [{ baseUrl: CYPHER, modelId: native, timestamp: Date.now() }],
      removeProviderFromCooldown: remove,
    };
    const manager = new ProviderManager(registry, { getState: () => state } as unknown as SdkStore, logger);
    expect(manager.isOnCooldown(CYPHER, canonical)).toBe(true);
    manager.removeFromCooldown(CYPHER, canonical);
    expect(remove).toHaveBeenCalledWith(CYPHER, native, undefined);
    expect(manager.isOnCooldown(CYPHER, native)).toBe(false);
  });

  it("helpers consistently honor an explicit snapshot including an empty one", () => {
    const mappings = { [native]: canonical };
    expect(canonicalizeModelId(native, mappings)).toBe(canonical);
    expect(modelIdVariants(native, mappings)).toEqual([canonical, native]);
    expect(findModelForId([entry(canonical, 1)], native, mappings)?.id).toBe(canonical);
    expect(canonicalizeModelId("z-ai-glm-5-3", {})).toBe("z-ai-glm-5-3");
  });
});
