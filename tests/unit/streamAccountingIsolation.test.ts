import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { createMemoryRequestLifecycleDriver } from "../../storage/requestLifecycle";

const baseUrl = "https://accounting.example/";
const key = "sk-existing";
const params = {
  path: "/v1/chat/completions", method: "POST", baseUrl,
  mintUrl: "https://mint.example/", modelId: "model",
  body: { model: "model", stream: true },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("response blocked by accounting")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Real prepare/fetch, tee/inspector, balance manager, accounting and lifecycle.
 * Only the network is mocked. Initial stored balance intentionally stays stale
 * until the gated wallet reads return, just as in an agent's back-to-back loop. */
function setup(options: { cost?: number; header?: string } = {}) {
  let balance = 100;
  const rows: any[] = [];
  const lifecycle = createMemoryRequestLifecycleDriver();
  const storage: any = {
    getApiKey: () => ({ baseUrl, key, balance, reserved: 0, lastUsed: null }),
    getApiKeyDistribution: () => [{ baseUrl, amount: balance, reserved: 0 }],
    updateApiKeyBalance: vi.fn((_: string, value: number) => { balance = value; }),
    touchApiKeyLastUsed: vi.fn(),
  };
  const logger: any = { log() {}, warn() {}, error() {}, child() { return this; } };
  const client = new RoutstrClient({} as any, storage, {} as any, "ERROR", "apikeys", {
    providerManager: { getModelForProvider: async () => null } as any,
    requestLifecycleDriver: lifecycle,
    usageTrackingDriver: { append: async (entry: any) => { rows.push(entry); } } as any,
    sdkStore: { getState: () => ({ clientIds: [] }) } as any,
    logger,
  });
  const reads: ReturnType<typeof deferred<Response>>[] = [];
  const endSecond = deferred<void>();
  let calls = 0;
  let cleaningUp = false;
  const fetch = vi.fn(async (url: any) => {
    if (String(url).endsWith("v1/wallet/info")) {
      if (cleaningUp) return new Response("{}", { status: 503 });
      const read = deferred<Response>(); reads.push(read); return read.promise;
    }
    expect(String(url)).toBe(`${baseUrl}v1/chat/completions`);
    const id = ++calls;
    const payload = {
      id: `gen-${id}`, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
        ...(options.cost !== undefined ? { cost_sats: options.cost } : {}) },
    };
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      // B retains a provider reservation while A's read resolves.
      if (id === 2) await endSecond.promise;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`));
      controller.close();
    } });
    return new Response(stream, { headers: {
      "content-type": "text/event-stream",
      ...(options.header !== undefined ? { "X-Routstr-Cost-Msats": options.header } : {}),
    } });
  });
  vi.stubGlobal("fetch", fetch);
  const settleRead = (index: number, amount: number, reserved: number, status = 200) => reads[index].resolve(
    new Response(JSON.stringify({ balance: amount * 1000, reserved: reserved * 1000, api_key: key }), { status }),
  );
  const cleanup = () => {
    cleaningUp = true;
    endSecond.resolve();
    reads.forEach(read => read.resolve(new Response("{}", { status: 503 })));
  };
  return { client, rows, lifecycle, storage, reads, endSecond, settleRead, cleanup, calls: () => calls };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("request cost is independent of shared-wallet reconciliation", () => {
  it.each([
    { cost: 10, expected: 10 },
    { cost: 0.125, expected: 0.125 },
    { cost: 0, expected: 0 },
    { cost: undefined, expected: 0 },
    { cost: 10, header: "0", expected: 0 },
    { cost: 10, header: "125", expected: 0.125 },
  ])("does not delay EOF or the next request, or charge their reservations: %j", async options => {
    const s = setup(options);
    const abort = new AbortController();
    const a: any = await s.client.routeRequest({ ...params, signal: abort.signal });
    let b: any;
    try {
      expect(await promptly(a.text())).toContain("[DONE]");
      await vi.waitFor(() => expect(s.reads).toHaveLength(1));
      abort.abort(); // A is fully delivered; this must not change its outcome.
      b = await promptly(s.client.routeRequest(params));
      expect(s.calls()).toBe(2); // B really reached upstream before A accounting.
      // A's read includes B's 50-sat reservation plus A's actual 10-sat charge.
      s.settleRead(0, 40, 50);
      expect(await a.finalize()).toBe(options.expected);
      expect(a.satsSpent).toBe(options.expected);
      expect(a.usage.satsCost).toBe(options.expected);
      expect(a.usage.reportedSatsCost).toBe(options.cost !== undefined || options.header !== undefined
        ? options.expected : undefined);
      s.endSecond.resolve();
      expect(await promptly(b.text())).toContain("[DONE]");
      await vi.waitFor(() => expect(s.reads).toHaveLength(2));
      s.settleRead(1, 80, 0);
      expect(await b.finalize()).toBe(options.expected);
      expect(await b.finalize()).toBe(options.expected);
      expect(b.usage.satsCost).toBe(options.expected);
      expect(s.rows).toHaveLength(2);
      expect(s.rows.map(row => row.satsCost)).toEqual([options.expected, options.expected]);
      expect(s.storage.updateApiKeyBalance).toHaveBeenLastCalledWith(baseUrl, 80, 0);
      for (const r of [a, b]) {
        const trace = await s.lifecycle.getTrace(r.requestId);
        expect(trace?.request.outcome).toBe("succeeded");
        expect(trace?.events.filter(e => e.type === "request_finished")).toHaveLength(1);
      }
    } finally {
      s.cleanup();
      await Promise.allSettled([a.finalize(), b?.finalize()]);
    }
  });

  it("retains the exact provider cost when wallet-info fails", async () => {
    const s = setup({ cost: 0.125 });
    const response: any = await s.client.routeRequest(params);
    await promptly(response.text());
    await vi.waitFor(() => expect(s.reads).toHaveLength(1));
    s.settleRead(0, 0, 0, 503);
    expect(await response.finalize()).toBe(0.125);
    expect(s.rows[0].satsCost).toBe(0.125);
    expect(s.storage.updateApiKeyBalance).not.toHaveBeenCalled();
  });
});
