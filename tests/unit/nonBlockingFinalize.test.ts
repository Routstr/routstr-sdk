/**
 * Accounting for a paid reply runs behind the response, not in front of it.
 *
 * A `/v1/wallet/info` read used to sit between the provider's answer and the
 * 200 the caller paid for: a node that answered the request and then stalled on
 * the balance read held (or, on abort, discarded) a completed answer. These
 * tests pin the new contract: `routeRequest` hands the answer over at once, the
 * body is intact for the caller, and `finalize()` settles the accounting.
 */

import { describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { StorageAdapter } from "../../wallet/interfaces";

const baseUrl = "https://provider.example.com/";
const mintUrl = "https://mint.example.com/";
const KEY = "sk-key-123";

const JSON_HEADERS = { "content-type": "application/json" };

/** A reply carrying usage, so accounting can derive a cost from the body. */
const answerBody = JSON.stringify({
  id: "gen-1",
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeClient(options: { balanceRead?: Deferred<any> } = {}) {
  const c: any = Object.create(RoutstrClient.prototype);
  c.mode = "apikeys";
  c.logger = { log() {}, warn() {}, error() {}, child() { return this; } };

  const rows: any[] = [];
  c.usageTrackingDriver = { append: async (entry: any) => { rows.push(entry); } };
  c.sdkStore = { getState: () => ({ clientIds: [] }) };

  const storage = {
    getApiKey: () => ({ baseUrl, key: KEY, balance: 0, reserved: 0, lastUsed: null }),
    updateApiKeyBalance: vi.fn(),
    touchApiKeyLastUsed: vi.fn(),
    removeApiKey: vi.fn(),
  } as unknown as StorageAdapter;
  c.storageAdapter = storage;

  // The provider's post-reply balance read. Left pending until the test
  // releases it, so "did the response wait for it?" is answerable.
  const read = options.balanceRead ?? deferred<any>();
  c.balanceManager = {
    getTokenBalance: vi.fn(() => read.promise),
  };

  c._prepareRoutedRequestWithMintFailover = vi.fn(async () => ({
    response: new Response(answerBody, { headers: JSON_HEADERS }),
    tokenUsed: KEY,
    baseUrlUsed: baseUrl,
    tokenBalanceInSats: 200,
    tokenBalanceUnknown: false,
    modelId: "some-model",
    clientApiKey: undefined,
    usagePromise: Promise.resolve({}),
  }));

  return { client: c, rows, storage, read };
}

const params = {
  path: "/v1/chat/completions",
  method: "POST",
  baseUrl,
  mintUrl,
  modelId: "some-model",
  body: { model: "some-model" },
  trackLifecycle: false,
};

describe("non-streaming accounting is not on the response path", () => {
  it("returns the answer while the provider balance read is still pending", async () => {
    const { client, read } = makeClient();

    // Would hang forever if the balance read were awaited inline.
    const response = await client.routeRequest(params);

    expect(response.status).toBe(200);
    expect(read.promise).toBeDefined();

    read.resolve({ amount: 150_000, reserved: 0, unit: "msat", apiKey: KEY, readSeq: 1 });
    expect(await response.finalize?.()).toBe(50);
    expect(response.satsSpent).toBe(50);
  });

  it("leaves the body untouched for the caller, and still accounts from it", async () => {
    const { client, rows, storage, read } = makeClient();

    const response = await client.routeRequest(params);
    // The caller reads the answer immediately, before accounting settles.
    expect(await response.json()).toMatchObject({ id: "gen-1" });

    read.resolve({ amount: 150_000, reserved: 0, unit: "msat", apiKey: KEY, readSeq: 1 });
    await response.finalize?.();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "gen-1",
      requestId: "gen-1",
      modelId: "some-model",
      baseUrl,
    });
    expect(storage.updateApiKeyBalance).toHaveBeenCalledWith(baseUrl, 150, 0);
  });

  it("accounts even when the caller never awaits finalize", async () => {
    const { client, rows, read } = makeClient();

    await client.routeRequest(params);
    read.resolve({ amount: 150_000, reserved: 0, unit: "msat", apiKey: KEY, readSeq: 1 });
    await vi.waitFor(() => expect(rows).toHaveLength(1));
  });

  it("still returns the answer when the balance read fails", async () => {
    const { client, rows } = makeClient({
      balanceRead: { promise: Promise.reject(new Error("read timed out")), resolve: () => {} },
    });

    const response = await client.routeRequest(params);
    expect(await response.text()).toBe(answerBody);
    // Unknown balance: cost falls back to the reply's own usage, answer intact.
    await expect(response.finalize?.()).resolves.toBeTypeOf("number");
    expect(rows).toHaveLength(1);
  });

  it("publishes the provider ID before the response leaves", async () => {
    const { client, read } = makeClient();

    const response = await client.routeRequest(params);
    expect((response as any).upstreamResponseId).toBe("gen-1");
    expect((response as any).requestId).toBe("gen-1");

    read.resolve({ amount: 200_000, reserved: 0, unit: "msat", apiKey: KEY, readSeq: 1 });
    await response.finalize?.();
  });
});
