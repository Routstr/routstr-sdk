import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { SdkLogger, Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://node.example/";
const mintUrl = "https://mint.example/";
const credential = "sk-test-key";
const model = {
  id: "test-model",
  name: "Test Model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

function setup(mode: "apikeys" | "xcashu" = "apikeys") {
  const logger: SdkLogger = {
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    },
  };
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl, balance: 399, lastUsed: null }),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    recordSuccess: vi.fn(),
    markFailed: vi.fn(),
    getFailedProviders: () => new Set(),
    findNextBestProvider: vi.fn(() => null),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(
    { getBalances: async () => ({}), getMintUnits: () => ({}), getActiveMintUrl: () => mintUrl } as unknown as WalletAdapter,
    storage,
    {} as DiscoveryAdapter,
    "max",
    mode,
    { providerManager: providerManager as any, logger }
  );
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: credential,
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  const balanceUpdate = vi
    .spyOn(client as any, "_handlePostResponseBalanceUpdate")
    .mockResolvedValue(0);
  return { client, balanceUpdate };
}

describe("streamed confidential response finalization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finalize() waits for settlement after the stream ends", async () => {
    const { client, balanceUpdate } = setup();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const upstream = new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    (upstream as any).confidentialSettled = settled;
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstream);

    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true },
      baseUrl,
      mintUrl,
      modelId: model.id,
      headers: {},
    });
    expect((response as any).confidentialSettled).toBe(settled);
    // EOF is delivered before accounting (the transport itself holds the
    // `[DONE]` line until the settlement checks pass), but neither the
    // accounting nor finalize() completes before the settlement.
    let finalized = false;
    const body = response.text();
    const done = (response as any).finalize().then(() => (finalized = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(finalized).toBe(false);
    expect(balanceUpdate).not.toHaveBeenCalled();
    settle();
    await body;
    await done;
    expect(balanceUpdate).toHaveBeenCalledTimes(1);
  });

  it("finalize() takes a one-off bearer's change from the settlement", async () => {
    for (const outcome of ["settled", "failed"] as const) {
      const { client, balanceUpdate } = setup("xcashu");
      const upstream = new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
      // The stream's wrapper copied the headers before the change existed.
      (upstream as any).confidentialSettled =
        outcome === "settled"
          ? Promise.resolve({ change: "cashuBchange" })
          : Promise.reject(Object.assign(new Error("bad receipt"), { cashuChange: "cashuBchange" }));
      vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstream);
      const response = await client.routeRequest({
        path: "/v1/chat/completions",
        method: "POST",
        body: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true },
        baseUrl,
        mintUrl,
        modelId: model.id,
        headers: {},
      });
      await response.text();
      await (response as any).finalize();
      expect(balanceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ refundToken: "cashuBchange" })
      );
      vi.restoreAllMocks();
    }
  });

  it("finalize() accounts the receipt's cost, which a chat response's headers do not carry", async () => {
    // The provider's usage event has no msat cost and a stream's headers left
    // before the receipt existed: without the settlement's cost a confidential
    // chat request is accounted at 0 sats in apikeys mode.
    const { client, balanceUpdate } = setup();
    const upstream = new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    (upstream as any).confidentialSettled = Promise.resolve({ change: undefined, costMsats: 1234 });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstream);
    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true },
      baseUrl,
      mintUrl,
      modelId: model.id,
      headers: {},
    });
    await response.text();
    await (response as any).finalize();
    const accounted = balanceUpdate.mock.calls[0]![0] as { response: Response };
    expect(accounted.response.headers.get("x-routstr-cost-msats")).toBe("1234");
  });

  it("finalize() returns the receipt's cost in sats (apikeys)", async () => {
    const { client, balanceUpdate } = setup();
    balanceUpdate.mockRestore();
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockRejectedValue(new Error("offline"));
    vi.spyOn(client as any, "_trackResponseUsage").mockResolvedValue(undefined);
    const upstream = new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    (upstream as any).confidentialSettled = Promise.resolve({ costMsats: 1234 });
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstream);
    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true },
      baseUrl,
      mintUrl,
      modelId: model.id,
      headers: {},
    });
    await response.text();
    expect(await (response as any).finalize()).toBe(1.234);
    expect((response as any).satsSpent).toBe(1.234);
  });

  /** An upstream error through a confidential session, as `_makeRequest` returns it (no failover). */
  function upstreamError(costMsats: number): Response {
    const r = new Response('{"error":"internal"}', {
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-routstr-confidential-sid": "ab".repeat(32),
        "x-routstr-cost-msats": String(costMsats),
      },
    });
    (r as any).passthrough = true;
    (r as any).confidentialSettled = Promise.resolve({ costMsats });
    return r;
  }
  const chat = { path: "/v1/chat/completions", method: "POST", baseUrl, mintUrl, modelId: model.id, headers: {} };

  it("an upstream error the node charged is accounted (apikeys, finding 20)", async () => {
    const { client, balanceUpdate } = setup();
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstreamError(2_687_000));
    const response = await client.routeRequest({ ...chat, body: { model: model.id, messages: [] } });
    expect(response.status).toBe(500);
    // The caller still reads the provider's error.
    expect(await response.text()).toBe('{"error":"internal"}');
    await (response as any).finalize();
    expect(balanceUpdate).toHaveBeenCalledTimes(1);
    const accounted = balanceUpdate.mock.calls[0]![0] as { response: Response; modelId: string };
    expect(accounted.response.headers.get("x-routstr-cost-msats")).toBe("2687000");
    expect(accounted.modelId).toBe(model.id);
  });

  it("an upstream error the node charged is accounted (xcashu: its change was taken already, finding 20)", async () => {
    const { client, balanceUpdate } = setup("xcashu");
    const track = vi.spyOn(client as any, "_trackResponseUsage").mockResolvedValue(undefined);
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstreamError(5_000));
    const response = await client.routeRequest({ ...chat, body: { model: model.id, messages: [] } });
    await (response as any).finalize();
    // No second attempt to receive the change.
    expect(balanceUpdate).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ satsSpent: 5, modelId: model.id }));
  });

  it("a failed settlement is logged without the change token it carries", async () => {
    const { client } = setup("xcashu");
    const logged: unknown[][] = [];
    for (const level of ["log", "warn", "error", "debug"] as const) {
      vi.spyOn((client as any).logger, level).mockImplementation((...args: unknown[]) => void logged.push(args));
    }
    const upstream = new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    // An older transport, or any caller-built error: the token as a plain property.
    const failed = Promise.reject(Object.assign(new Error("bad receipt"), { cashuChange: "cashuBchange" }));
    failed.catch(() => {});
    (upstream as any).confidentialSettled = failed;
    vi.spyOn(client as any, "_makeRequest").mockResolvedValue(upstream);
    const response = await client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true },
      baseUrl,
      mintUrl,
      modelId: model.id,
      headers: {},
    });
    await response.text();
    await (response as any).finalize();
    const { inspect } = await import("node:util");
    const text = logged.map((args) => args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")).join("\n");
    expect(text).toContain("confidential settlement check failed");
    expect(text).toContain("bad receipt");
    expect(text).not.toContain("cashuBchange");
  });
});
