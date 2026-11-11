/**
 * A one-off Cashu deposit (xcashu mode) around a confidential session: the
 * token minted for a session that never sent it comes back to the wallet,
 * and the change of an upstream error returned through a session is received
 * although such a response is passed through without accounting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient, setConfidentialTransport } from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const A = "https://a.example/";
const MINT = "https://mint.example";
const MODEL = "m-1";
const DEPOSIT = "cashuBdeposit";
const CHANGE = "cashuBchange";
const SID = "ab".repeat(32);

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

function setup(transport: (p: { baseUrl: string; returnChange?: boolean }) => Promise<Response>, receives = true) {
  const models: Record<string, Model[]> = {
    [A]: [
      {
        id: MODEL,
        name: MODEL,
        sats_pricing: { prompt: 1, completion: 1, max_cost: 100, max_prompt_cost: 60, max_completion_cost: 40 },
        confidential_upstream: { v: 2, offer_url: "/v1/confidential/offer" },
      } as Model,
    ],
  };
  const registry = {
    getCachedModels: () => models,
    getModelIdMappings: () => ({}),
    getDisabledProviders: () => [],
    getCachedMints: () => ({}),
    getCachedProviderInfo: () => ({}),
  } as unknown as DiscoveryAdapter;
  const stored = new Set<string>();
  const storage = {
    getApiKey: () => null,
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
    addXcashuToken: (_baseUrl: string, token: string) => void stored.add(token),
    removeXcashuToken: (_baseUrl: string, token: string) => void stored.delete(token),
    getXcashuTokens: () => ({}),
    getCachedReceiveTokens: () => [],
    setCachedReceiveTokens: () => {},
  } as unknown as StorageAdapter;
  const wallet = {
    getBalances: async () => ({ [MINT]: 1000 }),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT,
  } as unknown as WalletAdapter;
  const client = new RoutstrClient(wallet, storage, registry, "max", "xcashu", {
    providerManager: new ProviderManager(registry, undefined, logger),
    logger,
  });
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  // As _spendToken does in xcashu mode: mint the one-off token and store it.
  vi.spyOn(client as any, "_spendToken").mockImplementation(async () => {
    stored.add(DEPOSIT);
    return { token: DEPOSIT, tokenBalance: 200, tokenBalanceUnit: "sat", tokenBalanceUnknown: false };
  });
  const received: string[] = [];
  vi.spyOn(client.getCashuSpender(), "receiveToken").mockImplementation(async (token: string) => {
    received.push(token);
    return receives
      ? { success: true, amount: 100, unit: "sat" as const }
      : { success: false, amount: 0, unit: "sat" as const, message: "Token already spent" };
  });
  vi.spyOn(client.getCashuSpender(), "cacheReceiveToken").mockImplementation(() => {});
  const calls: { returnChange?: boolean }[] = [];
  setConfidentialTransport(
    async (p) => {
      calls.push({ returnChange: p.returnChange });
      return transport(p);
    },
    async () => undefined,
  );
  return { client, stored, received, calls };
}

const route = (client: RoutstrClient, stream = false) =>
  client.routeRequest({
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: MODEL, max_tokens: 10, stream, messages: [{ role: "user", content: "hi" }] },
    baseUrl: A,
    mintUrl: MINT,
    modelId: MODEL,
    confidential: {},
  });

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[TRANSPORT];
  delete (globalThis as Record<symbol, unknown>)[QUALIFIER];
});

describe("a one-off deposit for a session that never sent it", () => {
  it("is received back when the session fails with no change", async () => {
    // Thrown before the setup carried the token to the node: a local failure,
    // an abort, a request the session refuses.
    const { client, stored, received, calls } = setup(async () => {
      throw Object.assign(new Error("cu-prover not found or not executable"), { code: "prover_missing" });
    });
    await expect(route(client)).rejects.toThrow(/cu-prover not found/);
    expect(calls).toEqual([{ returnChange: true }]);
    expect(received).toEqual([DEPOSIT]);
    expect(stored.has(DEPOSIT)).toBe(false);
  });

  it("stays stored for the refund sweep when the node already redeemed it", async () => {
    const { client, stored, received } = setup(async () => {
      throw new Error("receipt verification failed");
    }, false);
    await expect(route(client)).rejects.toThrow(/receipt verification failed/);
    expect(received).toEqual([DEPOSIT]);
    expect(stored.has(DEPOSIT)).toBe(true);
  });

  it("is not touched when the failure carries the withdrawn change", async () => {
    const { client, stored, received } = setup(async () => {
      throw Object.assign(new Error("bad receipt"), { cashuChange: CHANGE });
    });
    await expect(route(client)).rejects.toThrow(/bad receipt/);
    // The change is received; the deposit itself is spent.
    expect(received).toEqual([CHANGE]);
    expect(stored.has(DEPOSIT)).toBe(false);
  });
});
