/**
 * Tinfoil visible output-token cap (`X-Tinfoil-Max-Output-Tokens`).
 *
 * EHBP keeps the body sealed from the node, so the only way a node can price a
 * Tinfoil request below the full `max_cost` envelope is a cap it can read
 * outside the body. tinfoilsh/confidential-model-router#518 added exactly that
 * header, and routstr-core prices sealed requests against it. These tests pin
 * the three halves that have to agree:
 *
 *  1. which value the SDK puts on the wire (endpoint-specific, engine
 *     precedence, never duplicated, never invented for an ignored field),
 *  2. that it survives the transport wrappers, retries and failover,
 *  3. that the reservation matches core's cap-aware sealed formula — and only
 *     on nodes that advertise it, so old nodes are never under-funded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { ProviderManager } from "../../client/ProviderManager";
import {
  bodyOutputCap,
  parseTinfoilOutputCapHeader,
  resolveTinfoilOutputCap,
  tinfoilMultiChoiceRequest,
  tinfoilOutputCapEndpoint,
  withTinfoilOutputCapHeader,
} from "../../client/TinfoilOutputTokens";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { Model, SdkLogger } from "../../core/types";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const { fetchTinfoilMock, prepareTinfoilMock } = vi.hoisted(() => ({
  fetchTinfoilMock: vi.fn(),
  prepareTinfoilMock: vi.fn(),
}));

// Only the two helpers that would attest against a live enclave are replaced;
// the header helpers stay real.
vi.mock("../../client/TinfoilSecure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../client/TinfoilSecure")>();
  return {
    ...actual,
    fetchTinfoilPreservingPlaintextErrors: fetchTinfoilMock,
    prepareTinfoilClient: prepareTinfoilMock,
  };
});

const HEADER = "X-Tinfoil-Max-Output-Tokens";
const FIRST = "https://first.example/";
const NEXT = "https://next.example/";
const MINT = "https://mint.example/";
const KEY = "sk-test-key";
const CALLER_MODEL = "tinfoil-deepseek-v4-1-flash";
const WIRE_MODEL = "deepseek-v4-1-flash";

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

/** Every value the request carries for the cap header (0, 1 or many). */
function headerValues(headers: unknown): string[] {
  const entries = Object.entries(
    (headers ?? {}) as Record<string, unknown>
  ).filter(([name]) => name.toLowerCase() === HEADER.toLowerCase());
  return entries.map(([, value]) => String(value));
}

function sealedInit(callIndex = 0): { headers: Record<string, string>; body: string } {
  const init = fetchTinfoilMock.mock.calls[callIndex][2] as RequestInit & {
    headers: Record<string, string>;
  };
  return { headers: init.headers, body: String(init.body) };
}

// ---------------------------------------------------------------------------
// 1. Header resolution: what the enclave will enforce for this request
// ---------------------------------------------------------------------------

describe("tinfoil output cap resolution", () => {
  it("maps only the generation endpoints the enclave acts on", () => {
    expect(tinfoilOutputCapEndpoint("/v1/chat/completions")).toBe("chat");
    expect(tinfoilOutputCapEndpoint("chat/completions")).toBe("chat");
    expect(tinfoilOutputCapEndpoint("/api/v1/chat/completions?v=2")).toBe(
      "chat"
    );
    expect(tinfoilOutputCapEndpoint("/v1/responses")).toBe("responses");
    expect(tinfoilOutputCapEndpoint("/v1/responses/")).toBe("responses");
    // Deployed enclaves 404 /v1/completions and ignore every other route, so
    // the SDK must not emit a cap there.
    expect(tinfoilOutputCapEndpoint("/v1/completions")).toBeNull();
    expect(tinfoilOutputCapEndpoint("/v1/messages")).toBeNull();
    expect(tinfoilOutputCapEndpoint("/v1/models")).toBeNull();
    expect(tinfoilOutputCapEndpoint("/v1/responses/foo")).toBeNull();
  });

  it("honours the engine's field precedence on chat", () => {
    // The engine prefers max_completion_tokens and ignores max_output_tokens.
    expect(
      bodyOutputCap("chat", {
        max_tokens: 4096,
        max_completion_tokens: 64,
      })
    ).toBe(64);
    expect(bodyOutputCap("chat", { max_tokens: 4096 })).toBe(4096);
    expect(bodyOutputCap("chat", { max_output_tokens: 32 })).toBeUndefined();
    expect(
      bodyOutputCap("chat", { max_output_tokens: 32, max_tokens: 8 })
    ).toBe(8);
  });

  it("reads only max_output_tokens on responses", () => {
    expect(bodyOutputCap("responses", { max_output_tokens: 32 })).toBe(32);
    expect(bodyOutputCap("responses", { max_tokens: 8 })).toBeUndefined();
  });

  it("does not reinterpret a body cap the engine would not honour", () => {
    // Present but unusable: falling through to the next field (or coercing
    // the value) would change what the caller asked for.
    expect(
      bodyOutputCap("chat", { max_completion_tokens: 0, max_tokens: 4096 })
    ).toBeUndefined();
    expect(
      bodyOutputCap("chat", { max_completion_tokens: 1.5, max_tokens: 4096 })
    ).toBeUndefined();
    expect(
      bodyOutputCap("chat", { max_completion_tokens: "64", max_tokens: 4096 })
    ).toBeUndefined();
    expect(bodyOutputCap("chat", { max_tokens: -1 })).toBeUndefined();
    expect(bodyOutputCap("chat", { max_tokens: null })).toBeUndefined();
    expect(bodyOutputCap("chat", undefined)).toBeUndefined();
  });

  it("accepts exactly the header grammar the enclave and core accept", () => {
    expect(parseTinfoilOutputCapHeader("64")).toBe(64);
    expect(parseTinfoilOutputCapHeader(" 16 ")).toBe(16);
    expect(parseTinfoilOutputCapHeader("\t32 ")).toBe(32);
    // Only space/tab are stripped (core's rule): a newline-padded value is
    // refused by the node, so the SDK must not quote it either.
    expect(parseTinfoilOutputCapHeader("\t32\n")).toBeUndefined();
    for (const rejected of [
      "",
      " ",
      "0",
      "-1",
      "+16",
      "12.5",
      "1e3",
      "64,128",
      "abc",
      "007",
    ]) {
      expect(parseTinfoilOutputCapHeader(rejected)).toBeUndefined();
    }
    // Above the bound core is willing to discount: emitting it would only
    // desynchronise the header from the reservation.
    expect(parseTinfoilOutputCapHeader("2147483648")).toBeUndefined();
    expect(parseTinfoilOutputCapHeader("2147483647")).toBe(2147483647);
  });

  it("prefers a caller-supplied header over the body cap", () => {
    const resolution = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { max_tokens: 500 },
      headers: { [HEADER]: "8" },
    });

    // The enclave replaces the body cap with the header, so 8 is the number
    // the reservation must be priced against.
    expect(resolution.cap).toBe(8);
    expect(resolution.source).toBe("caller-header");
    expect(resolution.injectValue).toBeUndefined();
  });

  it("forwards an unparseable caller header instead of replacing it", () => {
    const resolution = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { max_tokens: 500 },
      headers: { [HEADER]: "not-a-number" },
    });

    // The enclave answers its own 400; the SDK must not silently substitute a
    // different cap, and must not price against a value it cannot read.
    expect(resolution.cap).toBeUndefined();
    expect(resolution.callerHeaderInvalid).toBe(true);
    expect(resolution.injectValue).toBeUndefined();
  });

  it("treats a duplicated caller header as unusable, and adds nothing", () => {
    const resolution = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { max_tokens: 500 },
      headers: { "X-Tinfoil-Max-Output-Tokens": "8", "x-tinfoil-max-output-tokens": "300" },
    });

    expect(resolution.cap).toBeUndefined();
    expect(resolution.callerHeaderInvalid).toBe(true);
    // Adding a third value would only change the 400 into a different 400.
    expect(
      withTinfoilOutputCapHeader(
        { "X-Tinfoil-Max-Output-Tokens": "8", "x-tinfoil-max-output-tokens": "300" },
        resolution
      )
    ).toEqual({
      "X-Tinfoil-Max-Output-Tokens": "8",
      "x-tinfoil-max-output-tokens": "300",
    });
  });

  it("treats a multi-choice request as unpriceable through a per-choice cap", () => {
    // The cap applies per choice, and `n` is invisible to the node behind the
    // sealed body: quoting it would let the enclave bill n * cap.
    expect(tinfoilMultiChoiceRequest({ n: 5 })).toBe(true);
    expect(tinfoilMultiChoiceRequest({ n: "5" })).toBe(true);
    expect(tinfoilMultiChoiceRequest({ best_of: 2 })).toBe(true);
    expect(tinfoilMultiChoiceRequest({ n: 1 })).toBe(false);
    expect(tinfoilMultiChoiceRequest({ n: 0 })).toBe(false);
    expect(tinfoilMultiChoiceRequest({ n: "1" })).toBe(false);
    expect(tinfoilMultiChoiceRequest({})).toBe(false);
    expect(tinfoilMultiChoiceRequest(undefined)).toBe(false);

    // No derived header…
    const derived = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { max_completion_tokens: 64, n: 5 },
    });
    expect(derived.cap).toBeUndefined();
    expect(derived.injectValue).toBeUndefined();

    // …and no quote even behind the caller's own header (still forwarded).
    const callerHeader = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { n: 3 },
      headers: { [HEADER]: "64" },
    });
    expect(callerHeader.cap).toBeUndefined();
    expect(callerHeader.endpoint).toBe("chat");
    expect(callerHeader.callerHeaderInvalid).toBe(false);
  });

  it("does not quote a caller header on an endpoint the enclave ignores", () => {
    // The header is forwarded, but it bounds nothing there: core only quotes
    // chat/completions and responses, so the reserve must stay at the envelope.
    for (const path of ["/v1/completions", "/v1/messages", "/v1/models"]) {
      const resolution = resolveTinfoilOutputCap({
        path,
        body: { max_tokens: 10 },
        headers: { [HEADER]: "8" },
      });
      expect(resolution.endpoint).toBeNull();
      expect(resolution.cap).toBeUndefined();
      expect(resolution.callerHeaderInvalid).toBe(false);
    }
  });

  it("never adds a second value when the header is already present", () => {
    const headers = { [HEADER]: "8" };
    const resolution = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { max_tokens: 500 },
      headers,
    });
    expect(withTinfoilOutputCapHeader(headers, resolution)).toBe(headers);

    const lowered = { "x-tinfoil-max-output-tokens": "8" };
    const loweredResolution = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { max_tokens: 500 },
      headers: lowered,
    });
    expect(withTinfoilOutputCapHeader(lowered, loweredResolution)).toBe(lowered);
  });

  it("returns the input headers untouched when there is nothing to add", () => {
    const headers = { "Content-Type": "application/json" };
    const resolution = resolveTinfoilOutputCap({
      path: "/v1/chat/completions",
      body: { messages: [] },
      headers,
    });
    expect(resolution.cap).toBeUndefined();
    expect(withTinfoilOutputCapHeader(headers, resolution)).toBe(headers);
  });
});

// ---------------------------------------------------------------------------
// 2. Reservation: core's cap-aware sealed formula, mirrored
// ---------------------------------------------------------------------------

const createRegistry = (providerInfo: Record<string, unknown> = {}) =>
  ({
    getModelIdMappings: () => null,
    setModelIdMappings: () => {},
    getModelIdMappingsEvent: () => null,
    setModelIdMappingsEvent: () => {},
    getCachedModels: () => ({}),
    setCachedModels: () => {},
    getCachedMints: () => ({}),
    setCachedMints: () => {},
    getCachedProviderInfo: () => providerInfo,
    setCachedProviderInfo: () => {},
    getProviderLastUpdate: () => null,
    setProviderLastUpdate: () => {},
    getLastUsedModel: () => null,
    setLastUsedModel: () => {},
    getDisabledProviders: () => [],
    setDisabledProviders: () => {},
    getBaseUrlsList: () => [],
    getBaseUrlsLastUpdate: () => null,
    setBaseUrlsList: () => {},
    setBaseUrlsLastUpdate: () => {},
    getRoutstr21Models: () => [],
    setRoutstr21Models: () => {},
    getRoutstr21ModelsLastUpdate: () => null,
    setRoutstr21ModelsLastUpdate: () => {},
  }) as unknown as DiscoveryAdapter;

/**
 * Tinfoil-shaped model: no `top_provider`, so the node's base envelope is
 * `context_length * max(prompt, completion)`. Chosen so the full envelope is
 * 20 sats and the assertions below stay readable.
 */
const sealedModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: "tinfoil-kimi-k2-6",
    name: "tinfoil-kimi-k2-6",
    context_length: 1000,
    sats_pricing: {
      prompt: 0.01,
      completion: 0.02,
      max_prompt_cost: 10,
      max_completion_cost: 20,
      max_cost: 20,
    },
    ...overrides,
  }) as Model;

const MESSAGES = [{ role: "user", content: "Hi" }];

describe("sealed reservation mirrors core's cap-aware EHBP hold", () => {
  const manager = () => new ProviderManager(createRegistry());

  it("holds the full envelope when no visible cap exists", () => {
    // Old behaviour, unchanged: a sealed body with no header can be anything
    // up to the whole context window, so nothing may be discounted.
    expect(
      manager().getRequiredSatsForModel(sealedModel(), MESSAGES, undefined, {}, undefined, undefined)
    ).toBe(20);
  });

  it("discounts a visible cap to core's worst case over the context window", () => {
    // W = max((1000-100)*0.01 + 100*0.02, 1000*0.01) = 11 sats
    // hold = min(20 sats * 0.99, ceil(11 * 1000 * 0.99)) = 10.89 sats
    // reserve = hold * 1.05 (the SDK's tolerance margin) = 11.4345
    expect(
      manager().getRequiredSatsForModel(sealedModel(), MESSAGES, undefined, {}, undefined, 100)
    ).toBeCloseTo(11.4345, 4);
  });

  it("keeps the hidden-input reserve that a plaintext completion discount would drop", () => {
    // The same cap priced with the plaintext subtraction (subtract the whole
    // completion allowance) would reserve ~2.11 sats: it would have spent the
    // input allowance the node cannot see. Core keeps (context - cap) input
    // tokens in the hold, and so must the SDK.
    const capped = manager().getRequiredSatsForModel(
      sealedModel(),
      MESSAGES,
      undefined,
      {},
      undefined,
      100
    );
    expect(capped).toBeGreaterThan(10);
  });

  it("does not discount a cap that already covers the context window", () => {
    expect(
      manager().getRequiredSatsForModel(sealedModel(), MESSAGES, undefined, {}, undefined, 1000)
    ).toBe(20);
    expect(
      manager().getRequiredSatsForModel(sealedModel(), MESSAGES, undefined, {}, undefined, 5000)
    ).toBe(20);
  });

  it("keeps the full envelope when the model exposes no context window", () => {
    // Without a window core cannot bound the worst case and keeps the base.
    const noContext = sealedModel({ context_length: undefined, top_provider: undefined });
    expect(
      manager().getRequiredSatsForModel(noContext, MESSAGES, undefined, {}, undefined, 100)
    ).toBe(20);
  });

  it("bounds the window the way core does (top_provider, then context_length)", () => {
    // Core reads top_provider.context_length, then top_provider's
    // max_completion_tokens, then the bare context_length. A tinfoil-shaped
    // model that publishes only a completion cap is bounded by that cap, not
    // by a larger catalog context_length — using the wrong window would
    // reserve ~20 sats instead of ~11.43.
    const completionCapWindow = sealedModel({
      top_provider: { max_completion_tokens: 1000 } as any,
      context_length: 5000,
    });
    expect(
      manager().getRequiredSatsForModel(
        completionCapWindow,
        MESSAGES,
        undefined,
        {},
        undefined,
        100
      )
    ).toBeCloseTo(11.4345, 4);

    const providerWindow = sealedModel({
      top_provider: { context_length: 1000 } as any,
      context_length: 5000,
    });
    expect(
      manager().getRequiredSatsForModel(
        providerWindow,
        MESSAGES,
        undefined,
        {},
        undefined,
        100
      )
    ).toBeCloseTo(11.4345, 4);
  });

  it("keeps the full envelope when a rate is not a rate", () => {
    // A NaN/negative rate would poison the worst case into an under-reserve;
    // core refuses to price it, so the SDK holds the envelope.
    for (const pricing of [
      { prompt: -0.01, completion: 0.02 },
      { prompt: 0.01, completion: Number.NaN },
      { prompt: Number.POSITIVE_INFINITY, completion: 0.02 },
    ]) {
      const model = sealedModel({
        sats_pricing: {
          prompt: 0.01,
          completion: 0.02,
          max_prompt_cost: 10,
          max_completion_cost: 20,
          max_cost: 20,
          ...pricing,
        } as any,
      });
      expect(
        manager().getRequiredSatsForModel(model, MESSAGES, undefined, {}, undefined, 100)
      ).toBe(20);
    }
  });

  it("coerces numeric-string rates instead of collapsing the hold to the minimum", () => {
    // Catalog data occasionally carries rates as strings; core's `float()`
    // reads them, so the SDK must too. Treating them as zero would reserve a
    // single millisat.
    const stringRates = sealedModel({
      sats_pricing: {
        prompt: "0.01",
        completion: "0.02",
        max_prompt_cost: 10,
        max_completion_cost: 20,
        max_cost: 20,
      } as any,
    });
    expect(
      manager().getRequiredSatsForModel(stringRates, MESSAGES, undefined, {}, undefined, 100)
    ).toBeCloseTo(11.4345, 4);
  });

  it("still ignores a body cap on a sealed body", () => {
    // The node cannot read the sealed body, so a body-only cap must not move
    // the reservation even though the SDK passes it as `maxTokens`.
    const body = { max_tokens: 100 };
    expect(
      manager().getRequiredSatsForModel(sealedModel(), MESSAGES, 100, body)
    ).toBe(20);
  });

  it("leaves non-Tinfoil (plaintext) pricing untouched", () => {
    const plaintext = sealedModel({ id: "kimi-k2-6" });
    // A plaintext body cap still drives the completion term, and the extra
    // sealed-cap argument is deliberately ignored there.
    expect(
      manager().getRequiredSatsForModel(plaintext, MESSAGES, 100, { max_tokens: 100 })
    ).toBe(
      manager().getRequiredSatsForModel(
        plaintext,
        MESSAGES,
        100,
        { max_tokens: 100 },
        undefined,
        100
      )
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Lifecycle: on the wire, through retries and failover, and in the deposit
// ---------------------------------------------------------------------------

const makeModel = (id = CALLER_MODEL): Model =>
  ({
    id,
    name: id,
    sats_pricing: { prompt: 0.01, completion: 0.02, max_cost: 20 },
  }) as Model;

const createWallet = (): WalletAdapter =>
  ({
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT,
    sendToken: async () => KEY,
    receiveToken: async () => ({ success: false, message: "n/a" }),
  }) as unknown as WalletAdapter;

const createStorage = (): StorageAdapter =>
  ({
    getApiKey: () => ({ key: KEY, baseUrl: FIRST, balance: 399, lastUsed: null }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  }) as unknown as StorageAdapter;

const okResponse = () =>
  new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function setup(options?: {
  /** Whether /v1/info advertises the cap-aware reservation. */
  advertisesCap?: boolean;
}) {
  const providerManager = {
    markFailed: vi.fn(),
    recordSuccess: vi.fn(),
    findNextBestProvider: vi.fn(() => NEXT),
    getModelForProvider: vi.fn(async (_baseUrl: string, id: string) =>
      makeModel(id)
    ),
    getRequiredSatsForModel: vi.fn(() => 10),
    supportsSealedOutputTokenReservation: vi.fn(
      async () => options?.advertisesCap === true
    ),
  };
  const client = new RoutstrClient(
    createWallet(),
    createStorage(),
    createRegistry(),
    "max",
    "apikeys",
    { providerManager: providerManager as any, logger }
  );
  vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockResolvedValue({
    amount: 399_000,
    reserved: 0,
    unit: "msat",
    apiKey: KEY,
  });
  // A 429 refunds the key before failing over; without this the refund would
  // hit the network (and abort the failover).
  vi.spyOn(client.getBalanceManager(), "refundApiKey").mockResolvedValue({
    success: true,
    message: "refunded",
    amount: 399,
  } as any);
  vi.spyOn(client as any, "_checkBalance").mockResolvedValue(undefined);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: KEY,
    tokenBalance: 399,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  return { client, providerManager };
}

function routeRequest(
  client: RoutstrClient,
  options: {
    path?: string;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
    modelId?: string;
  }
) {
  return client.routeRequest({
    path: options.path ?? "/v1/chat/completions",
    method: "POST",
    body: options.body,
    headers: options.headers ?? {},
    baseUrl: FIRST,
    mintUrl: MINT,
    modelId: options.modelId ?? CALLER_MODEL,
  });
}

beforeEach(() => {
  fetchTinfoilMock.mockReset();
  prepareTinfoilMock.mockReset();
  prepareTinfoilMock.mockResolvedValue({
    verification: {
      enclaveHost: "enclave.tinfoil.test",
      codeFingerprint: "ab".repeat(32),
    },
    secureClient: {},
  });
  fetchTinfoilMock.mockResolvedValue(okResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("X-Tinfoil-Max-Output-Tokens on the wire", () => {
  it("sends the chat cap derived from max_completion_tokens", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64 },
    });
    expect(headerValues(sealedInit().headers)).toEqual(["64"]);
  });

  it("falls back to the legacy max_tokens field on chat", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_tokens: 4096 },
    });
    expect(headerValues(sealedInit().headers)).toEqual(["4096"]);
  });

  it("prefers max_completion_tokens when the body sets both", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: {
        model: WIRE_MODEL,
        messages: [],
        max_tokens: 4096,
        max_completion_tokens: 64,
      },
    });
    expect(headerValues(sealedInit().headers)).toEqual(["64"]);
  });

  it("does not send a chat header for max_output_tokens, which chat ignores", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_output_tokens: 32 },
    });
    expect(headerValues(sealedInit().headers)).toEqual([]);
    // The body is left exactly as the caller sent it: no invented cap, and no
    // field rewritten behind their back.
    expect(JSON.parse(sealedInit().body)).toMatchObject({
      max_output_tokens: 32,
    });
  });

  it("sends max_output_tokens on /v1/responses", async () => {
    const { client } = setup();
    await routeRequest(client, {
      path: "/v1/responses",
      body: { model: WIRE_MODEL, input: [], max_output_tokens: 32 },
    });
    expect(headerValues(sealedInit().headers)).toEqual(["32"]);
  });

  it("sends nothing on endpoints the enclave does not apply it to", async () => {
    const { client } = setup();
    await routeRequest(client, {
      path: "/v1/completions",
      body: { model: WIRE_MODEL, prompt: "hi", max_tokens: 10 },
    });
    expect(headerValues(sealedInit().headers)).toEqual([]);
  });

  it("sends nothing when the caller declared no cap", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [] },
    });
    expect(headerValues(sealedInit().headers)).toEqual([]);
  });

  it("sends nothing for an unusable cap, instead of turning it into a 400", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_tokens: 0 },
    });
    expect(headerValues(sealedInit().headers)).toEqual([]);
  });

  it("forwards a caller-supplied header and never duplicates it", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_tokens: 500 },
      headers: { [HEADER]: "8" },
    });
    expect(headerValues(sealedInit().headers)).toEqual(["8"]);
  });

  it("forwards an unparseable caller header verbatim, without adding one", async () => {
    const { client } = setup();
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_tokens: 500 },
      headers: { [HEADER]: "not-a-number" },
    });
    expect(headerValues(sealedInit().headers)).toEqual(["not-a-number"]);
  });

  it("leaves non-Tinfoil requests completely alone", async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { client } = setup();
      await routeRequest(client, {
        body: { model: "gpt-4o-mini", messages: [], max_tokens: 10 },
        modelId: "gpt-4o-mini",
      });
      // Plaintext transport, untouched headers: no cap header is invented for
      // a model the enclave is not serving.
      expect(fetchTinfoilMock).not.toHaveBeenCalled();
      const plainInit = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(headerValues(plainInit.headers)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("X-Tinfoil-Max-Output-Tokens across retries and failover", () => {
  it("re-asserts the cap in the transport wrapper when the headers lost it", async () => {
    // Belt-and-braces: a retry that rebuilt headers from scratch still ships
    // the cap the reservation was priced against.
    const { client } = setup();
    await (client as any)._makeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64 },
      selectedModel: makeModel(),
      baseUrl: FIRST,
      mintUrl: MINT,
      token: KEY,
      requiredSats: 10,
      headers: { "X-Routstr-Model": CALLER_MODEL },
      baseHeaders: {},
      tinfoilEnabled: true,
    });

    expect(headerValues(sealedInit().headers)).toEqual(["64"]);
  });

  it("carries the cap into a failover attempt and re-reserves with it", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });
    fetchTinfoilMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "rate limited", type: "rate_limited", code: 429 },
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValue(okResponse());

    // End-to-end: initial sealed attempt -> 429 -> failover -> sealed retry.
    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64 },
    });

    expect(fetchTinfoilMock.mock.calls.length).toBe(2);
    expect(String(fetchTinfoilMock.mock.calls[1][1])).toContain(NEXT);
    // The cap is the caller's, so the failover hop carries the same value…
    expect(headerValues(sealedInit(1).headers)).toEqual(["64"]);
    // …and the new node's deposit is priced against it (it advertises the
    // capability).
    const failoverReserve =
      providerManager.getRequiredSatsForModel.mock.calls.at(-1)!;
    expect(failoverReserve[5]).toBe(64);
  });

  it("keeps the full reserve on a node that does not advertise the capability", async () => {
    const { client, providerManager } = setup({ advertisesCap: false });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64 },
    });

    // The header still goes out — the enclave enforces it regardless — but an
    // old node holds the whole envelope, so the deposit must cover it.
    expect(headerValues(sealedInit().headers)).toEqual(["64"]);
    expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBeUndefined();
  });

  it("prices the cap when the node advertises support", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64 },
    });

    expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBe(64);
  });

  it("prices the caller's own header when they set one", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_tokens: 500 },
      headers: { [HEADER]: "8" },
    });

    // The enclave enforces 8 (the header overrides the body), so the
    // reservation must follow the header, not the ignored body cap.
    expect(providerManager.getRequiredSatsForModel.mock.calls[0][4 + 1]).toBe(8);
  });

  it("does not price an unparseable caller header", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_tokens: 500 },
      headers: { [HEADER]: "not-a-number" },
    });

    expect(
      providerManager.getRequiredSatsForModel.mock.calls[0][5]
    ).toBeUndefined();
  });

  it("forwards but does not price a caller header on an unsupported endpoint", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      path: "/v1/completions",
      body: { model: WIRE_MODEL, prompt: "hi", max_tokens: 10 },
      headers: { [HEADER]: "8" },
    });

    // Forwarded verbatim (the enclave owns the verdict)…
    expect(headerValues(sealedInit().headers)).toEqual(["8"]);
    // …but never quoted: an ignored header cannot bound a bill.
    expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBeUndefined();
  });

  it("sends no derived header and keeps the full reserve when n > 1", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64, n: 5 },
    });

    expect(headerValues(sealedInit().headers)).toEqual([]);
    expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBeUndefined();
  });

  it("still quotes a cap on a single-choice request", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], max_completion_tokens: 64, n: 1 },
    });

    expect(headerValues(sealedInit().headers)).toEqual(["64"]);
    expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBe(64);
  });

  it("forwards a caller header with n > 1 but quotes nothing", async () => {
    const { client, providerManager } = setup({ advertisesCap: true });

    await routeRequest(client, {
      body: { model: WIRE_MODEL, messages: [], n: 3 },
      headers: { [HEADER]: "64" },
    });

    expect(headerValues(sealedInit().headers)).toEqual(["64"]);
    expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBeUndefined();
  });

  it("never asks a non-Tinfoil request for the sealed capability", async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { client, providerManager } = setup({ advertisesCap: true });
      await routeRequest(client, {
        body: { model: "gpt-4o-mini", messages: [], max_tokens: 10 },
        modelId: "gpt-4o-mini",
      });
      expect(
        providerManager.supportsSealedOutputTokenReservation
      ).not.toHaveBeenCalled();
      expect(providerManager.getRequiredSatsForModel.mock.calls[0][5]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("node capability advertisement", () => {
  it("reads features.ehbp_output_token_reservation from /v1/info", async () => {
    const withFeature = new ProviderManager(
      createRegistry({
        [FIRST]: { features: { ehbp_output_token_reservation: true } },
      })
    );
    const withoutFeature = new ProviderManager(
      createRegistry({ [FIRST]: { features: {} } })
    );
    const oldNode = new ProviderManager(createRegistry({ [FIRST]: {} }));

    expect(await withFeature.supportsSealedOutputTokenReservation(FIRST)).toBe(
      true
    );
    expect(
      await withoutFeature.supportsSealedOutputTokenReservation(FIRST)
    ).toBe(false);
    expect(await oldNode.supportsSealedOutputTokenReservation(FIRST)).toBe(
      false
    );
  });
});
