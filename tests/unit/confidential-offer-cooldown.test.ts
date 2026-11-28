/**
 * A node whose offer could not be fetched cools down: it is tried after the
 * other confidential candidates, not instead of none. While every candidate
 * is cooling, the one whose cooldown ends first is tried again once its last
 * failure is a few seconds old, so a client whose own network was down (or a
 * client with one node) is served as soon as the network is back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient, setConfidentialTransport } from "../../client/RoutstrClient";
import { OfferUnavailableError, SessionRejectedError } from "../../client/confidential/errors";
import { closeConfidentialConnections, qualifyConfidentialNode } from "../../client/confidential/transport";
import * as twopc from "../../client/confidential/twopc";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import { BOTH, NODE_PUB, restoreFetch, signedV3Offer } from "./fixtures/v3";

const MINT = "https://mint.example";
const MODEL = "cheap";
const OPTIONS = { trustedHosts: ["*.venice.ai"], nodePubkeys: [NODE_PUB] };

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

let run = 0;
/** Fresh node URLs per test: the offer cooldown is process-wide. */
function nodes(n: number): string[] {
  run++;
  return Array.from({ length: n }, (_v, i) => `https://n${i}-cooldown-${run}.example/`);
}

const entry = (completion: number): Model =>
  ({
    id: MODEL,
    name: MODEL,
    sats_pricing: { prompt: 1, completion, max_cost: 100, max_prompt_cost: 60, max_completion_cost: 40 },
    confidential_upstream: { v: 3, offer_url: "/v1/confidential/offer" },
  }) as unknown as Model;

/** The network as the client sees it: hosts whose offer fetch fails. */
function network() {
  const down = new Set<string>();
  const offerFetches: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/v1/confidential/offer")) return new Response("{}", { status: 400 });
    offerFetches.push(url.origin + "/");
    if (down.has(url.origin + "/")) throw new TypeError("fetch failed: ENETUNREACH");
    return new Response(JSON.stringify(signedV3Offer(BOTH)), { status: 200 });
  }) as typeof fetch;
  return { down, offerFetches };
}

function setup(urls: string[]) {
  const models: Record<string, Model[]> = Object.fromEntries(urls.map((u, i) => [u, [entry(i + 1)]]));
  const registry = {
    getCachedModels: () => models,
    getModelIdMappings: () => ({}),
    getDisabledProviders: () => [],
    getCachedMints: () => ({}),
    getCachedProviderInfo: () => ({}),
  } as unknown as DiscoveryAdapter;
  const manager = new ProviderManager(registry, undefined, logger);
  const wallet = {
    getBalances: async () => ({ [MINT]: 100_000 }),
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
  const client = new RoutstrClient(wallet, storage, registry, "max", "apikeys", { providerManager: manager, logger });
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: "sk-1",
    tokenBalance: 100_000,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const bm = client.getBalanceManager();
  vi.spyOn(bm, "getTokenBalance").mockResolvedValue({ amount: 0, reserved: 0, unit: "msat", apiKey: "sk-1" });
  vi.spyOn(bm, "refundApiKey").mockResolvedValue({ success: true, message: "ok", amount: 0 } as any);
  vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
  vi.spyOn(twopc, "requireHelperBinaries").mockImplementation(() => {});
  const sessions: string[] = [];
  /** Nodes whose connection fails before anything is released. */
  const failing = new Set<string>();
  // The session itself is a stand-in; the qualifier is the transport's own.
  setConfidentialTransport(async ({ baseUrl }) => {
    sessions.push(baseUrl);
    if (failing.has(baseUrl)) throw new SessionRejectedError("connection closed");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }, qualifyConfidentialNode);
  const route = (baseUrl: string) =>
    client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      baseUrl,
      mintUrl: MINT,
      modelId: MODEL,
      confidential: OPTIONS,
    });
  return { route, sessions, failing };
}

const T0 = Date.parse("2026-11-17T12:00:00Z");
const at = (s: number) => vi.setSystemTime(T0 + s * 1000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreFetch();
  closeConfidentialConnections();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("@routstr/sdk/confidentialTransport")];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("@routstr/sdk/confidentialQualifier")];
});

describe("the offer cooldown orders nodes", () => {
  it("after the client's own outage, the next request is served though every node is cooling", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a, c] = nodes(2) as [string, string];
    const net = network();
    const { route, sessions } = setup([a, c]);
    net.down.add(a).add(c);
    // An agent retrying through the outage: both nodes' cooldowns grow.
    for (const s of [0, 40, 110]) {
      at(s);
      await expect(route(a)).rejects.toBeInstanceOf(OfferUnavailableError);
    }
    net.down.clear();
    // Back online at 120 s; both cooldowns run until 230 s.
    at(130);
    const res = await route(a);
    expect(res.status).toBe(200);
    expect(sessions).toHaveLength(1);
  });

  it("a single node is tried again a few seconds after its last failure, not after minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a] = nodes(1) as [string];
    const net = network();
    const { route, sessions } = setup([a]);
    net.down.add(a);
    for (const s of [0, 40, 110, 240]) {
      at(s);
      await expect(route(a)).rejects.toBeInstanceOf(OfferUnavailableError);
    }
    const fetches = net.offerFetches.length;
    // Right after a failure it fails fast: no fetch.
    at(243);
    await expect(route(a)).rejects.toThrow(/not asked again/);
    expect(net.offerFetches).toHaveLength(fetches);
    net.down.clear();
    at(252);
    expect((await route(a)).status).toBe(200);
    expect(sessions).toEqual([a]);
  });

  it("a failed probe reports its own error, not the cooldown that skipped the node", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a] = nodes(1) as [string];
    const net = network();
    const { route } = setup([a]);
    net.down.add(a);
    at(0);
    await expect(route(a)).rejects.toBeInstanceOf(OfferUnavailableError);
    const fetches = net.offerFetches.length;
    at(15);
    const err = await route(a).catch((e: unknown) => e);
    expect(net.offerFetches.length).toBeGreaterThan(fetches);
    expect(err).toBeInstanceOf(OfferUnavailableError);
    expect(String((err as Error).message)).not.toMatch(/not asked again/);
  });

  it("a failover after a failed connection probes a cooling node when no other is left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a, c] = nodes(2) as [string, string];
    const net = network();
    const { route, sessions, failing } = setup([a, c]);
    net.down.add(c);
    at(0);
    expect((await route(c)).status).toBe(200); // c fails (cools until 30 s), a serves
    net.down.clear();
    failing.add(a);
    at(15);
    expect((await route(a)).status).toBe(200);
    expect(sessions).toEqual([a, a, c]);
  });

  it("while another node serves, a cooling one is not asked; when all cool, the earliest to end goes first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [a, c] = nodes(2) as [string, string];
    const net = network();
    const { route, sessions } = setup([a, c]);
    net.down.add(a);
    at(0);
    expect((await route(a)).status).toBe(200); // a fails (cools until 30 s), c serves
    at(10);
    expect((await route(a)).status).toBe(200); // a is not asked
    expect(net.offerFetches.filter((u) => u === a)).toHaveLength(1);
    at(40);
    expect((await route(a)).status).toBe(200); // a fails again (until 100 s)
    expect(sessions).toEqual([c, c, c]);
    net.down.add(c);
    at(75);
    // c fails (until 105 s); a is the last candidate and is probed: it fails
    // again (until 195 s). One probe per request.
    const aFetches = net.offerFetches.filter((u) => u === a).length;
    await expect(route(c)).rejects.toBeInstanceOf(OfferUnavailableError);
    expect(net.offerFetches.filter((u) => u === a)).toHaveLength(aFetches + 1);
    net.down.clear();
    at(90);
    // Asked for a, both cooling: c's cooldown ends first, so c serves; a is not asked.
    expect((await route(a)).status).toBe(200);
    expect(sessions).toEqual([c, c, c, c]);
    expect(net.offerFetches.filter((u) => u === a)).toHaveLength(aFetches + 1);
  });
});
