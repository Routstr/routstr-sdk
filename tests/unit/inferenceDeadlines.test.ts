/**
 * L1: the inference request needs its own local deadlines.
 *
 * Discovery and metadata fetches were already bounded, but `_makeRequest`
 * called `fetch` with only the caller's abort signal. A provider that accepted
 * the TCP connection and then went quiet held the request until the runtime's
 * own ~300 s network timeout, so nothing cooled the provider down or failed
 * over. Field evidence: a request to a node that took 187 s to answer 424, and
 * a follow-up failover attempt that sat until 300 s with no attempt data.
 *
 * These tests use a real socket server that accepts, reads, and never replies,
 * so the deadline has to work through the actual fetch implementation rather
 * than a mocked `fetch` that resolves on demand.
 */

import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { Model } from "../../core/types";
import type { SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://first.example/";
const mintUrl = "https://mint.example/";
const credential = "sk-test-key";

const model = {
  id: "test-model",
  name: "Test Model",
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

function makeClient() {
  const wallet = {
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl,
    sendToken: async () => credential,
    receiveToken: async () => ({ success: false, message: "no refund" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl, balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    markFailed: vi.fn(),
    recordSuccess: vi.fn(),
    getFailedProviders: () => new Set<string>(),
    findNextBestProvider: vi.fn(() => null),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(wallet, storage, {} as DiscoveryAdapter, "max", "apikeys", {
    providerManager: providerManager as any,
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
  return client;
}

/**
 * A server that completes the TCP handshake and then never writes a byte.
 * `respondOnce` lets a test answer exactly one request and stall the next, so a
 * failover target can be distinguished from the provider that hung.
 */
async function startSilentServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  requests: () => number;
}> {
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      count += 1;
      // Deliberately no write: the client must give up on its own.
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    requests: () => count,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Server that answers with headers + one SSE chunk, then stalls forever. */
async function startStallingStreamServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/event-stream\r\n" +
          "transfer-encoding: chunked\r\n\r\n"
      );
      const payload = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
      socket.write(payload.length.toString(16) + "\r\n" + payload + "\r\n");
      // Then silence — this is the "stream stalled mid-answer" case.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Server that emits a chunk, waits `gapMs`, emits another, then finishes. */
async function startSlowButHealthyServer(gapMs: number): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/event-stream\r\n" +
          "transfer-encoding: chunked\r\n\r\n"
      );
      const writeEvent = (text: string) => {
        const payload = `data: ${text}\n\n`;
        socket.write(payload.length.toString(16) + "\r\n" + payload + "\r\n");
      };
      writeEvent('{"choices":[{"delta":{"content":"a"}}]}');
      setTimeout(() => {
        writeEvent('{"choices":[{"delta":{"content":"b"}}]}');
        socket.write("0\r\n\r\n");
      }, gapMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Server that emits `chunks` events, `gapMs` apart, then closes.
 * Used to prove the idle budget is per-gap rather than an overall deadline: the
 * total duration exceeds the budget while every individual gap stays under it.
 */
async function startSteadyStreamServer(chunks: number, gapMs: number): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/event-stream\r\n" +
          "transfer-encoding: chunked\r\n\r\n"
      );
      const writeEvent = (text: string) => {
        const payload = `data: ${text}\n\n`;
        socket.write(payload.length.toString(16) + "\r\n" + payload + "\r\n");
      };
      let sent = 0;
      const tick = () => {
        // Every other event is an SSE comment: providers use these as
        // keep-alives, and they must count as progress like any other byte.
        writeEvent(sent % 2 === 0 ? `{"choices":[{"delta":{"content":"c${sent}"}}]}` : ": keep-alive");
        sent += 1;
        if (sent < chunks) setTimeout(tick, gapMs);
        else socket.write("0\r\n\r\n");
      };
      tick();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Server that waits `delayMs`, then answers one complete JSON body. */
async function startSlowJsonServer(delayMs: number): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      // No bytes until generation is "done" — exactly how a non-streaming
      // completion behaves at the HTTP level.
      setTimeout(() => {
        const body = JSON.stringify({ choices: [{ message: { content: "done" } }] });
        socket.write(
          "HTTP/1.1 200 OK\r\n" +
            "Content-Type: application/json\r\n" +
            `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body
        );
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("inference deadlines", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await cleanup?.();
    cleanup = undefined;
  });

  it("fails over when a provider never returns headers (ttfb)", async () => {
    const silent = await startSilentServer();
    const healthy = await startSlowButHealthyServer(0);
    cleanup = async () => {
      await silent.close();
      await healthy.close();
    };

    const client = makeClient();
    const nextProvider = `http://127.0.0.1:${healthy.port}/`;
    (client as any).providerManager.findNextBestProvider = vi.fn(() => nextProvider);
    (client as any).providerManager.markFailed = vi.fn();
    (client as any).providerManager.getModelForProvider = vi.fn(async () => model);

    const started = Date.now();
    const response = await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, stream: true },
      baseUrl: `http://127.0.0.1:${silent.port}/`,
      mintUrl,
      token: credential,
      requiredSats: 100,
      headers: { "content-type": "application/json" },
      baseHeaders: { "content-type": "application/json" },
      selectedModel: model,
      deadlines: { ttfbMs: 300, idleMs: 300 },
    });
    const elapsed = Date.now() - started;

    // The hung provider must be given up on quickly and recorded as failed.
    expect(elapsed).toBeLessThan(5_000);
    expect((client as any).providerManager.markFailed).toHaveBeenCalled();
    expect(response.status).toBe(200);
    // The answer came from the failover target, not the silent provider.
    expect((response as any).baseUrl).toBe(nextProvider);
  }, 20_000);

  it("does not cut off a stream whose TOTAL duration exceeds the idle budget", async () => {
    // The budget is per-gap, not an overall deadline: 8 events, 200 ms apart,
    // run for ~1.6 s against a 600 ms budget. An implementation that armed one
    // absolute deadline (or one reset to the start of the request) would abort
    // this healthy, steadily progressing answer.
    const steady = await startSteadyStreamServer(8, 200);
    cleanup = () => steady.close();

    const client = makeClient();
    const response = await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, stream: true },
      baseUrl: `http://127.0.0.1:${steady.port}/`,
      mintUrl,
      token: credential,
      requiredSats: 100,
      headers: { "content-type": "application/json" },
      baseHeaders: { "content-type": "application/json" },
      selectedModel: model,
      deadlines: { ttfbMs: 5_000, idleMs: 600 },
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    // All 8 events arrived: nothing was truncated mid-stream.
    expect(text).toContain("c0");
    expect(text).toContain("c6");
    // SSE keep-alive comments count as progress too.
    expect(text).toContain("keep-alive");
  }, 20_000);

  it("surfaces a stalled stream as a timeout and cools the provider down", async () => {
    const stalled = await startStallingStreamServer();
    cleanup = () => stalled.close();

    const client = makeClient();
    const markFailed = vi.fn();
    (client as any).providerManager.markFailed = markFailed;

    const response = await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, stream: true },
      baseUrl: `http://127.0.0.1:${stalled.port}/`,
      mintUrl,
      token: credential,
      requiredSats: 100,
      headers: { "content-type": "application/json" },
      baseHeaders: { "content-type": "application/json" },
      selectedModel: model,
      deadlines: { ttfbMs: 5_000, idleMs: 300 },
    });

    // Headers already reached the caller, so re-sending would duplicate the
    // answer: the stall must surface to the consumer instead of failing over.
    await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });

    // It is still recorded as a provider fault. Note the exact effect: one
    // provider-wide strike is recorded here, and ProviderManager's existing
    // two-strike policy means a single stall does NOT begin a cooldown. That is
    // deliberate — this change records the fault, it does not re-tune cooldown.
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed.mock.calls[0]![0]).toBe(`http://127.0.0.1:${stalled.port}/`);
  }, 20_000);

  it("does not apply the short headers budget to a non-streaming request", async () => {
    // `stream: false` sends nothing until generation finishes, so a 60 s
    // first-byte budget would kill a legitimately slow (but healthy) answer.
    const slowComplete = await startSlowJsonServer(600);
    cleanup = () => slowComplete.close();

    const client = makeClient();
    const response = await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, stream: false },
      baseUrl: `http://127.0.0.1:${slowComplete.port}/`,
      mintUrl,
      token: credential,
      requiredSats: 100,
      headers: { "content-type": "application/json" },
      baseHeaders: { "content-type": "application/json" },
      selectedModel: model,
      deadlines: { ttfbMs: 100, idleMs: 100 },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("done");
  }, 20_000);

  it("does not blame the provider when the CALLER's own timeout fires mid-stream", async () => {
    // A caller may pass `AbortSignal.timeout(n)`. Its rejection is named
    // "TimeoutError" too, so classification must use our own deadline flag —
    // otherwise a healthy provider gets a cooldown for the caller's choice.
    const stalled = await startStallingStreamServer();
    cleanup = () => stalled.close();

    const client = makeClient();
    const markFailed = vi.fn();
    (client as any).providerManager.markFailed = markFailed;

    const callerTimeout = AbortSignal.timeout(250);
    const response = await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, stream: true },
      baseUrl: `http://127.0.0.1:${stalled.port}/`,
      mintUrl,
      token: credential,
      requiredSats: 100,
      headers: { "content-type": "application/json" },
      baseHeaders: { "content-type": "application/json" },
      selectedModel: model,
      signal: callerTimeout,
      // Our own budgets are generous, so the caller's 250 ms fires first.
      deadlines: { ttfbMs: 10_000, idleMs: 10_000 },
    });

    await expect(response.text()).rejects.toBeTruthy();
    expect(markFailed).not.toHaveBeenCalled();
  }, 20_000);

  it("is disabled by a zero budget", async () => {
    // The server takes 400 ms to send headers and 400 ms between chunks. With a
    // 100 ms budget this would be aborted; with budgets zeroed it must complete,
    // which is the only way to show the opt-out is actually honoured.
    const slow = await startSlowButHealthyServer(400);
    cleanup = () => slow.close();

    const client = makeClient();
    const response = await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: model.id, stream: true },
      baseUrl: `http://127.0.0.1:${slow.port}/`,
      mintUrl,
      token: credential,
      requiredSats: 100,
      headers: { "content-type": "application/json" },
      baseHeaders: { "content-type": "application/json" },
      selectedModel: model,
      deadlines: { ttfbMs: 0, idleMs: 0 },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"b"');
  }, 20_000);
});
