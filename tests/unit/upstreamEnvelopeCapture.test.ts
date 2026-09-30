import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import type { SdkLogger, Model } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { UpstreamEnvelope } from "../../core/errors";

const baseUrl = "https://first.example/";
const mintUrl = "https://mint.example/";
const credential = "cashu-DO-NOT-LOG-THIS-SECRET";
const model = {
  id: "test-model",
  sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
} as Model;

/** The real litellm rejection body observed in production. */
const upstreamBody = JSON.stringify({
  error: {
    message:
      "Upstream error via litellm: litellm.BadRequestError: OpenAIException - Error code: 400 - {'details': {'_errors': [\"Unrecognized key(s) in object: 'web_search_options'\"]}, 'error': 'Invalid request parameters'}",
    type: "upstream_error",
    code: 400,
  },
  request_id: "04aee611-2e54-4151-8be4-4ef6c7e9523b",
});

function setup() {
  const messages: string[] = [];
  const logger: SdkLogger = {
    log: (...args) => { messages.push(args.map(String).join(" ")); },
    warn: (...args) => { messages.push(args.map(String).join(" ")); },
    error: (...args) => { messages.push(args.map(String).join(" ")); },
    debug: (...args) => { messages.push(args.map(String).join(" ")); },
    child() { return this; },
  };
  const wallet = {
    getBalances: async () => ({}), getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl, sendToken: async () => credential,
    receiveToken: async () => ({ success: false, message: "proofs already spent" }),
  } as WalletAdapter;
  const storage = {
    getApiKey: () => ({ key: credential, baseUrl, balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    markFailed: vi.fn(), getFailedProviders: () => new Set([baseUrl]),
    findNextBestProvider: vi.fn(() => undefined),
    getModelForProvider: vi.fn(async () => model),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(wallet, storage, {} as DiscoveryAdapter,
    "max", "apikeys", { providerManager: providerManager as any, logger });
  client.setDebugLevel("DEBUG");
  return { client, messages };
}

const params = {
  path: "/v1/messages", method: "POST",
  body: { model: model.id, messages: [], web_search_options: {} },
  selectedModel: model, baseUrl, mintUrl, token: credential, requiredSats: 100,
  headers: {}, baseHeaders: {}, tinfoilEnabled: false,
};

describe("upstream error envelope capture", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures status, statusText and forwardable headers before the body read", async () => {
    const { client } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(upstreamBody, {
      status: 400,
      statusText: "Bad Request",
      headers: {
        "content-type": "application/json",
        "x-routstr-request-id": "04aee611-2e54-4151-8be4-4ef6c7e9523b",
        "x-routstr-provider": "https://upstream.example/",
        "retry-after": "7",
        "transfer-encoding": "chunked",
      },
    })));

    const handled = vi
      .spyOn(client as any, "_handleErrorResponse")
      .mockResolvedValue(new Response("next", { status: 200 }));

    await (client as any)._makeRequest(params);

    expect(handled).toHaveBeenCalledTimes(1);
    const envelope: UpstreamEnvelope = handled.mock.calls[0][7];
    expect(envelope.status).toBe(400);
    expect(envelope.statusText).toBe("Bad Request");
    expect(envelope.headers["x-routstr-request-id"])
      .toBe("04aee611-2e54-4151-8be4-4ef6c7e9523b");
    expect(envelope.headers["content-type"]).toBe("application/json");
    expect(envelope.headers["x-routstr-provider"]).toBe("https://upstream.example/");
    expect(envelope.headers["retry-after"]).toBe("7");
    expect(envelope.headers).not.toHaveProperty("transfer-encoding");
    expect(envelope.headers).not.toHaveProperty("content-length");

    // The body still reaches the existing handler unchanged.
    expect(handled.mock.calls[0][5]).toBe(upstreamBody);
  });

  it("skips the envelope entirely on a 200 response", async () => {
    const { client } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    })));
    const handled = vi
      .spyOn(client as any, "_handleErrorResponse")
      .mockResolvedValue(new Response("next", { status: 200 }));

    const response = await (client as any)._makeRequest(params);

    expect(response.status).toBe(200);
    expect(handled).not.toHaveBeenCalled();
  });
});
