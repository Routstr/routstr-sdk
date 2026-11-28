/**
 * A confidential request that fails on one node may only fail over to a node
 * that advertises confidential sessions for the model, and no token is spent
 * on a node before its signed offer qualifies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient, setConfidentialTransport } from "../../client/RoutstrClient";
import { PoolBusyError } from "../../client/confidential/pool";
import { ConfidentialTimeoutError, confidentialFailoverError } from "../../client/confidential/errors";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const A = "https://a.example/";
const PLAIN = "https://plain.example/";
const C = "https://c.example/";
const MINT = "https://mint.example";
const MODEL = "m-1";

const cu = { v: 2, offer_url: "/v1/confidential/offer" };
const entry = (completion: number, extra: Partial<Model> = {}): Model =>
  ({
    id: MODEL,
    name: MODEL,
    sats_pricing: { prompt: 1, completion, max_cost: 100, max_prompt_cost: 60, max_completion_cost: 40 },
    ...extra,
  }) as Model;

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

const TRANSPORT = Symbol.for("@routstr/sdk/confidentialTransport");
const QUALIFIER = Symbol.for("@routstr/sdk/confidentialQualifier");

function setup(
  opts: {
    qualify?: (baseUrl: string, model: string, request: unknown) => void;
    /** Node A lists the model under its own id, mapped to the canonical one. */
    nativeIdOnA?: string;
    /** The verified offer the qualifier returns (sizes the deposit). */
    offer?: unknown;
    /** What the transport throws for node A (default: a fetch failure). */
    errorOnA?: () => unknown;
    /** No other confidential node: only the plaintext one is left after A. */
    withoutC?: boolean;
  } = {},
) {
  const models: Record<string, Model[]> = {
    [A]: [entry(1, { confidential_upstream: cu, ...(opts.nativeIdOnA ? { id: opts.nativeIdOnA } : {}) })],
    // Cheaper than C but serves the model in plaintext only.
    [PLAIN]: [entry(2)],
    ...(opts.withoutC ? {} : { [C]: [entry(3, { confidential_upstream: cu })] }),
  };
  const registry = {
    getCachedModels: () => models,
    getModelIdMappings: () => (opts.nativeIdOnA ? { [opts.nativeIdOnA]: MODEL } : {}),
    getDisabledProviders: () => [],
    getCachedMints: () => ({}),
    getCachedProviderInfo: () => ({}),
  } as unknown as DiscoveryAdapter;
  const manager = new ProviderManager(registry, undefined, logger);
  const wallet = {
    getBalances: async () => ({ [MINT]: 1000 }),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT,
    sendToken: async () => "cashu-test",
    receiveToken: async () => ({ success: false, message: "n/a" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => null,
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const client = new RoutstrClient(wallet, storage, registry, "max", "apikeys", {
    providerManager: manager,
    logger,
  });
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  const spent: { baseUrl: string; amount: number }[] = [];
  vi.spyOn(client as any, "_spendToken").mockImplementation(async (...args: unknown[]) => {
    const p = args[0] as { baseUrl: string; amount: number };
    spent.push({ baseUrl: p.baseUrl, amount: p.amount });
    return { token: `sk-${spent.length}`, tokenBalance: 200, tokenBalanceUnit: "sat", tokenBalanceUnknown: false };
  });
  const bm = client.getBalanceManager();
  vi.spyOn(bm, "getTokenBalance").mockResolvedValue({ amount: 0, reserved: 0, unit: "msat", apiKey: "sk-1" });
  vi.spyOn(bm, "refundApiKey").mockResolvedValue({ success: true, message: "ok", amount: 0 } as any);
  vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);

  const sessions: string[] = [];
  const qualified: string[] = [];
  const bodies: unknown[] = [];
  setConfidentialTransport(
    async ({ baseUrl, body }) => {
      sessions.push(baseUrl);
      bodies.push(body);
      if (baseUrl === A && !opts.nativeIdOnA) throw opts.errorOnA ? opts.errorOnA() : new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async (baseUrl, model, _options, _kind, request) => {
      qualified.push(baseUrl);
      opts.qualify?.(baseUrl, model, request);
      return opts.offer;
    },
  );
  return { client, spent, sessions, qualified, bodies };
}

const route = (client: RoutstrClient, extra: Record<string, unknown> = {}) =>
  client.routeRequest({
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    baseUrl: A,
    mintUrl: MINT,
    modelId: MODEL,
    confidential: {},
    ...extra,
  });

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[TRANSPORT];
  delete (globalThis as Record<symbol, unknown>)[QUALIFIER];
});

describe("confidential failover", () => {
  it("a busy pool (every connection of the key busy) is the caller's, not a node failure", async () => {
    expect(confidentialFailoverError(new PoolBusyError("busy"))).toBe(false);
    // By shape, from another bundle.
    const foreign = Object.assign(new Error("busy"), { code: "timeout", name: "PoolBusyError" });
    expect(confidentialFailoverError(foreign)).toBe(false);
    // A node's step timing out still fails over.
    expect(confidentialFailoverError(new ConfidentialTimeoutError("2PC timed out"))).toBe(true);

    const { client, spent, sessions } = setup({ errorOnA: () => new PoolBusyError("every connection is busy") });
    const markFailed = vi.spyOn(ProviderManager.prototype, "markFailed");
    await expect(route(client)).rejects.toBeInstanceOf(PoolBusyError);
    expect(sessions).toEqual([A]);
    expect(spent.map((s) => s.baseUrl)).toEqual([A]);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("never sends a confidential request in plaintext, also when only a plaintext node is left", async () => {
    const plainFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/\/(chat\/completions|images?\/gener)/.test(url)) throw new Error(`plaintext request to ${url}`);
      return new Response("{}", { status: 404 });
    });
    const { client, spent, sessions } = setup({ withoutC: true });
    // The request fails (an error or an error response), it is not answered by the plaintext node.
    const outcome = await route(client).catch((e: unknown) => e);
    if (outcome instanceof Response) expect(outcome.ok).toBe(false);
    expect(sessions).toEqual([A]);
    expect(spent.some((s) => s.baseUrl === PLAIN)).toBe(false);
    const inference = plainFetch.mock.calls
      .map(([input]) => String(input instanceof Request ? input.url : input))
      .filter((u) => /\/(chat\/completions|images?\/gener)/.test(u));
    expect(inference).toEqual([]);
  });

  it("skips nodes without confidential sessions and qualifies before spending", async () => {
    const { client, spent, sessions, qualified } = setup();
    const res = await route(client);
    expect(res.status).toBe(200);
    expect(sessions).toEqual([A, C]);
    expect(spent.map((s) => s.baseUrl)).toEqual([A, C]);
    expect(spent.some((s) => s.baseUrl === PLAIN)).toBe(false);
    // Each node qualified before its spend.
    expect(qualified).toEqual([A, C]);
    // The failover deposit covers the confidential reservation (full-context
    // prompt + max_tokens), not the plaintext estimate.
    expect(spent[1]!.amount).toBeGreaterThanOrEqual(60);
  });

  it("never spends on a failover node whose offer does not qualify", async () => {
    const { client, spent, sessions } = setup({
      qualify: (baseUrl) => {
        if (baseUrl === C) throw new Error("offer unavailable");
      },
    });
    // No qualifying node left: the failure comes back, nothing else is spent.
    const res = await route(client);
    expect(res.ok).toBe(false);
    expect(spent.map((s) => s.baseUrl)).toEqual([A]);
    expect(sessions).toEqual([A]);
  });

  it("does not spend on the first node when its offer does not qualify", async () => {
    const { client, spent, sessions } = setup({
      qualify: () => {
        throw new Error("offer unavailable");
      },
    });
    await expect(route(client)).rejects.toThrow(/offer unavailable/);
    expect(spent).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it("qualifies the id the body carries to the node (its own spelling), with the request", async () => {
    const seen: { model: string; request: unknown }[] = [];
    const { client, sessions, bodies } = setup({
      nativeIdOnA: "z-m-1",
      qualify: (_baseUrl, model, request) => {
        seen.push({ model, request });
        // The node's offer prices its own id only.
        if (model !== "z-m-1") throw new Error(`node does not serve ${model} confidentially`);
      },
    });
    const res = await route(client);
    expect(res.status).toBe(200);
    expect(seen.map((q) => q.model)).toEqual(["z-m-1"]);
    // The request is handed over, so the transport can refuse one it cannot pin.
    expect((seen[0]!.request as { messages?: unknown }).messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sessions).toEqual([A]);
    expect((bodies[0] as { model: string }).model).toBe("z-m-1");
  });

  it("moves on to the next confidential node when the first one does not qualify", async () => {
    // The cheapest node is down, signs with a key the caller does not pin, or
    // does not price the model: nothing was spent on it, another node can serve.
    const { client, spent, sessions, qualified } = setup({
      qualify: (baseUrl) => {
        if (baseUrl === A) throw new Error("offer unpinned: node key not in nodePubkeys");
      },
      // A would also fail the session: it must never be reached.
    });
    const res = await route(client);
    expect(res.status).toBe(200);
    expect(qualified).toEqual([A, C]);
    expect(spent.map((s) => s.baseUrl)).toEqual([C]);
    expect(sessions).toEqual([C]);
    // Never the plaintext-only node, although it is cheaper than C.
    expect(qualified.includes(PLAIN)).toBe(false);
  });

  it("reports the first node's error when no node qualifies", async () => {
    const { client, spent, qualified } = setup({
      qualify: (baseUrl) => {
        throw new Error(`offer unavailable at ${baseUrl}`);
      },
    });
    await expect(route(client)).rejects.toThrow(`offer unavailable at ${A}`);
    expect(qualified).toEqual([A, C]);
    expect(spent).toEqual([]);
  });

  it("does not try other nodes when the caller pinned the provider or a helper binary is missing", async () => {
    const pinned = setup({
      qualify: (baseUrl) => {
        if (baseUrl === A) throw new Error("offer unavailable");
      },
    });
    await expect(route(pinned.client, { pinnedProvider: true })).rejects.toThrow(/offer unavailable/);
    expect(pinned.qualified).toEqual([A]);
    expect(pinned.spent).toEqual([]);

    // A local failure is the same on every node.
    const local = setup({
      qualify: () => {
        throw Object.assign(new Error("cu-prover not found"), { code: "prover_missing" });
      },
    });
    await expect(route(local.client)).rejects.toThrow(/cu-prover not found/);
    expect(local.qualified).toEqual([A]);
  });

  it("sizes an image request's failover deposit by the signed image price", async () => {
    const offer = {
      price_list: {},
      session_fee_msat: 0,
      abandon_fee_msat: 2000,
      images: {
        max_count: 4,
        count_key: "n",
        fixed_pins: [],
        price_list: { [MODEL]: [{ id: "webp", pins: [["format", "webp"]], msat_per_image: 400_000 }] },
      },
    };
    const { client, spent, sessions } = setup({ offer });
    const res = await route(client, {
      path: "/v1/images/generations",
      body: { model: MODEL, prompt: "a cat", n: 2 },
    });
    expect(res.status).toBe(200);
    expect(sessions).toEqual([A, C]);
    // 2 × 400 sats + the larger fee, on the first node and on the failover node
    // alike (the chat formula would deposit the model's listed maximum).
    const want = Math.ceil((2 * 400_000 + 2000) / 1000);
    expect(spent).toEqual([
      { baseUrl: A, amount: want },
      { baseUrl: C, amount: want },
    ]);
  });

  it("a cancelled request does not fail over after its connection failed", async () => {
    const controller = new AbortController();
    const { client, spent, sessions } = setup({
      errorOnA: () => {
        // The caller gives up while node A's connection is failing.
        controller.abort();
        return new ConfidentialTimeoutError("2PC timed out");
      },
    });
    await expect(route(client, { signal: controller.signal })).rejects.toThrow();
    expect(sessions).toEqual([A]);
    expect(spent.map((s) => s.baseUrl)).toEqual([A]);
  });

  it("a request cancelled while a failover node qualifies spends nothing more", async () => {
    const controller = new AbortController();
    const { client, spent, sessions, qualified } = setup({
      errorOnA: () => new ConfidentialTimeoutError("2PC timed out"),
      qualify: (baseUrl) => {
        if (baseUrl === C) {
          controller.abort();
          throw new Error("offer unavailable");
        }
      },
    });
    await expect(route(client, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    // C is not probed again once the caller cancelled.
    expect(qualified).toEqual([A, C]);
    expect(sessions).toEqual([A]);
    expect(spent.map((s) => s.baseUrl)).toEqual([A]);
  });

  it("the local inference deadlines do not apply to a confidential attempt", async () => {
    const { client, spent } = setup();
    const sessions: string[] = [];
    // Slower than the caller's headers budget: a plaintext attempt would time
    // out and fail over; a confidential one keeps its own limits.
    setConfidentialTransport(async ({ baseUrl }) => {
      sessions.push(baseUrl);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const response = await route(client, {
      body: { model: MODEL, max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] },
      deadlines: { ttfbMs: 10, idleMs: 10 },
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await response.text()).toBe("data: [DONE]\n\n");
    expect(sessions).toEqual([A]);
    expect(spent.map((s) => s.baseUrl)).toEqual([A]);
  });
});
