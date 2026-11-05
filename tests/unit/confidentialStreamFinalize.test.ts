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
    // The stream ends only after the accounting, so neither the body nor
    // finalize() completes before the settlement.
    let ended = false;
    let finalized = false;
    const body = response.text().then(() => (ended = true));
    const done = (response as any).finalize().then(() => (finalized = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(false);
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
});
