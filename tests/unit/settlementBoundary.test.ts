import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { fetchAIResponse } from "../../client/fetchAIResponse";
import { inspectSSEWebStream } from "../../client/sse";
import { noopLogger as logger } from "../../core/types";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore, createDiscoveryAdapterFromStore } from "../../storage";

const base = "https://provider.example/";

describe("settlement boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("Stop returns to the caller only after the SDK balance update has settled", async () => {
    const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
    await hydrate;
    const storage = createStorageAdapterFromStore(store);
    storage.setApiKey(base, "fixture");
    storage.updateApiKeyBalance(base, 7);
    await storage.flush!();
    const client = new RoutstrClient({} as any, storage, createDiscoveryAdapterFromStore(store), "min", "apikeys", { logger });

    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const [visible, inspector] = new ReadableStream<Uint8Array>({ start(c) { upstream = c; } }).tee();
    const response = new Response(visible, { headers: { "content-type": "text/event-stream" } });
    vi.spyOn(client as any, "_prepareRoutedRequest").mockResolvedValue({
      response, usagePromise: inspectSSEWebStream(inspector, () => {}),
      tokenUsed: "fixture", baseUrlUsed: base, tokenBalanceInSats: 7, tokenBalanceUnknown: false,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockImplementation(async () => {
      await gate;
      return { amount: 6, unit: "sat", reserved: 0, apiKey: "fixture" };
    });

    const controller = new AbortController();
    const appended: unknown[] = [];
    let settled = false;
    const fetching = fetchAIResponse(
      { messageHistory: [], selectedModel: { id: "m", name: "m" } as any, baseUrl: base, mintUrl: "https://mint.example", abortSignal: controller.signal },
      { onStreamingUpdate: () => {}, onThinkingUpdate: () => {}, onMessageAppend: (m) => appended.push(m), onBalanceUpdate: () => {}, onTransactionUpdate: () => {} },
      { client, alertLevel: "min", logger }
    ).then(() => { settled = true; });

    await vi.waitFor(() => expect(visible.locked).toBe(true));
    controller.abort();
    upstream.error(new DOMException("stopped", "AbortError"));
    await vi.waitFor(() => expect(appended).toContainEqual({ role: "system", content: "Generation stopped." }));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(storage.getApiKey(base)?.balance).toBe(7);

    release();
    await fetching;
    await storage.flush!();
    expect(storage.getApiKey(base)?.balance).toBe(6);
  });
});
