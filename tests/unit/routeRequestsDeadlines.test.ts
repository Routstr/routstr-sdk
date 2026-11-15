/**
 * L2: end-to-end through `routeRequests`, the entry point routstrd proxies to.
 *
 * The unit tests pin the deadline primitives and `_makeRequest`; this one
 * proves the behaviour a caller actually experiences: when the cheapest
 * provider accepts the connection and goes silent, the request must fail over
 * to the next provider promptly instead of waiting for the runtime's ~300 s
 * network timeout.
 *
 * The silent provider is a real socket server, so the deadline is exercised
 * through the actual fetch implementation rather than a mock that resolves on
 * command. Only the *follow-up* provider is stubbed.
 */

import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../../client/ProviderManager";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { Model, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import { resolveRequestContext } from "../../client/resolveRequestContext";
import { routeRequests } from "../../routeRequests";

vi.mock("../../client/resolveRequestContext", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../client/resolveRequestContext")>();
  return {
    ...original,
    resolveRequestContext: vi.fn(original.resolveRequestContext),
  };
});

const mintUrl = "https://mint.example/";
const credential = "sk-test-key";

const model = {
  id: "kimi-k3.1-pro",
  name: "Kimi",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

async function startSilentServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      // Handshake completes; no byte is ever written.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeClient() {
  const wallet = {
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl,
    sendToken: async () => credential,
    receiveToken: async () => ({ success: false, message: "no refund" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl: "https://x/", balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = new ProviderManager({} as DiscoveryAdapter, undefined, logger) as any;
  const client = new RoutstrClient(wallet, storage, {} as DiscoveryAdapter, "max", "apikeys", {
    providerManager,
    logger,
  });
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_topUpIfNeeded").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: credential,
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  vi.spyOn(client as any, "_handlePostResponseBalanceUpdate").mockResolvedValue(0);
  return { client, providerManager };
}

describe("routeRequests fails over from a silent provider", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await cleanup?.();
    cleanup = undefined;
  });

  it("answers from the next provider instead of waiting out the silent one", async () => {
    const silent = await startSilentServer();
    cleanup = () => silent.close();

    const healthyUrl = "https://healthy.example/";
    const healthyBody = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';

    // Capture the runtime's real fetch before replacing the global: the silent
    // provider must go through a real socket so the deadline is real.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        if (String(url).startsWith(silent.baseUrl)) return realFetch(url, init);
        return new Response(healthyBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      })
    );

    const { client, providerManager } = makeClient();
    (providerManager as any).findNextBestProvider = vi.fn(
      (_modelId: string, current: string, attempted: Set<string>) =>
        current === silent.baseUrl && !attempted?.has(healthyUrl) ? healthyUrl : null
    );
    (providerManager as any).getModelForProvider = vi.fn(async () => model);
    const markFailed = vi.spyOn(providerManager, "markFailed");

    vi.mocked(resolveRequestContext).mockResolvedValueOnce({
      client,
      baseUrl: silent.baseUrl,
      mintUrl,
      selectedModel: model,
      requestedModelId: model.id,
    } as never);

    const started = Date.now();
    const response = await routeRequests({
      modelId: model.id,
      path: "/v1/chat/completions",
      requestBody: { model: model.id, stream: true, messages: [] },
      walletAdapter: {} as never,
      storageAdapter: {} as never,
      discoveryAdapter: {} as never,
      deadlines: { ttfbMs: 300, idleMs: 300 },
    });
    const elapsed = Date.now() - started;

    // Prompt failover, not the runtime's own ~300 s network timeout.
    expect(elapsed).toBeLessThan(10_000);
    expect(response.status).toBe(200);
    // The silent node is recorded as failed. A cooldown needs a second
    // provider-wide strike under ProviderManager's existing policy, so assert
    // the strike rather than claiming the node is already excluded.
    expect(markFailed).toHaveBeenCalled();
    expect(String(markFailed.mock.calls[0]![0])).toContain(String(silent.baseUrl).replace(/\/$/, ""));
    await response.body?.cancel();
  }, 30_000);
});
