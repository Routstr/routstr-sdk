/**
 * Tinfoil request preparation: reasoning-effort translation before EHBP sealing.
 *
 * Observed live: `reasoning_effort: "medium"` — a valid gateway literal, but
 * DeepSeek V4.1's chat template only accepts `low`/`high`/`xhigh`/`max` —
 * reached the enclave unchanged and 400'd. The node publishes
 * `reasoning.effort_map` on /v1/models; the client has to apply it before
 * sealing the body, since the proxy sees only ciphertext.
 *
 * The failover half of the original report (a retry carrying the routstr-only
 * `tinfoil-` prefix into the encrypted body) landed separately in #103 as
 * `_upstreamBodyModelId`; this suite only pins that the retry still re-maps the
 * caller's effort against the *next* node's map.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { applyTinfoilReasoningEffort } from "../../client/TinfoilReasoning";
import type { Model, ModelReasoning, SdkLogger } from "../../core/types";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const { fetchTinfoil, prepareTinfoil } = vi.hoisted(() => ({
  fetchTinfoil: vi.fn(),
  prepareTinfoil: vi.fn(),
}));

// Keep every other Tinfoil helper real (id math, cache secret paths); only the
// two that would attest against a live enclave are replaced.
vi.mock("../../client/TinfoilSecure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../client/TinfoilSecure")>();
  return {
    ...actual,
    fetchTinfoilPreservingPlaintextErrors: fetchTinfoil,
    prepareTinfoilClient: prepareTinfoil,
  };
});

const FIRST = "https://first.example/";
const NEXT = "https://next.example/";
const MINT = "https://mint.example/";
const KEY = "sk-test-key";
const CALLER_MODEL = "tinfoil-deepseek-v4-1-flash";
const WIRE_MODEL = "deepseek-v4-1-flash";

/** What routstr-core publishes for DeepSeek V4.1 after the metadata change. */
const DEEPSEEK_REASONING: ModelReasoning = {
  supported_efforts: ["xhigh", "high", "low"],
  effort_map: { low: "low", medium: "high", high: "xhigh" },
  mandatory: false,
};

const model = (id: string, reasoning?: ModelReasoning): Model =>
  ({
    id,
    name: id,
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
    ...(reasoning ? { reasoning } : {}),
  }) as Model;

const logger: SdkLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

function setup() {
  const wallet = {
    getBalances: async () => ({}),
    getMintUnits: () => ({}),
    getActiveMintUrl: () => MINT,
    sendToken: async () => KEY,
    receiveToken: async () => ({ success: false, message: "n/a" }),
  } as unknown as WalletAdapter;
  const storage = {
    getApiKey: () => ({
      key: KEY,
      baseUrl: FIRST,
      balance: 399,
      lastUsed: null,
    }),
    removeApiKey: vi.fn(),
    getApiKeyDistribution: () => [],
  } as unknown as StorageAdapter;
  const providerManager = {
    markFailed: vi.fn(),
    recordSuccess: vi.fn(),
    findNextBestProvider: vi.fn(() => NEXT),
    getModelForProvider: vi.fn(async () => model(CALLER_MODEL)),
    getRequiredSatsForModel: vi.fn(() => 100),
  };
  const client = new RoutstrClient(
    wallet,
    storage,
    {} as DiscoveryAdapter,
    "max",
    "apikeys",
    { providerManager: providerManager as any, logger },
  );
  const balanceManager = client.getBalanceManager();
  vi.spyOn(balanceManager, "getTokenBalance").mockResolvedValue({
    amount: 399_000,
    reserved: 0,
    unit: "msat",
    apiKey: KEY,
  });
  vi.spyOn(balanceManager, "refundApiKey").mockResolvedValue({
    success: true,
    message: "refunded",
    amount: 399,
  } as any);
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: "next-key",
    tokenBalance: 200,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  return { client, providerManager };
}

/** The string body the mocked EHBP transport was asked to seal. */
function sealedBody(callIndex = 0): Record<string, unknown> {
  const init = fetchTinfoil.mock.calls[callIndex][2] as RequestInit;
  return JSON.parse(String(init.body));
}

afterEach(() => {
  fetchTinfoil.mockReset();
  prepareTinfoil.mockReset();
  vi.restoreAllMocks();
});

describe("applyTinfoilReasoningEffort", () => {
  it("maps a caller level onto the model's native effort", () => {
    const body = { model: WIRE_MODEL, reasoning_effort: "medium" };

    expect(applyTinfoilReasoningEffort(body, DEEPSEEK_REASONING)).toEqual({
      model: WIRE_MODEL,
      reasoning_effort: "high",
    });
  });

  it("never mutates the caller's body (retries rebuild from it)", () => {
    const body = { model: WIRE_MODEL, reasoning_effort: "medium" };
    applyTinfoilReasoningEffort(body, DEEPSEEK_REASONING);
    expect(body.reasoning_effort).toBe("medium");
  });

  it("rewrites nested effort shapes in place", () => {
    expect(
      applyTinfoilReasoningEffort(
        { model: WIRE_MODEL, reasoning: { effort: "medium", exclude: true } },
        DEEPSEEK_REASONING,
      ),
    ).toEqual({
      model: WIRE_MODEL,
      reasoning: { effort: "high", exclude: true },
    });

    expect(
      applyTinfoilReasoningEffort(
        {
          model: WIRE_MODEL,
          chat_template_kwargs: { thinking: true, reasoning_effort: "medium" },
        },
        DEEPSEEK_REASONING,
      ),
    ).toEqual({
      model: WIRE_MODEL,
      chat_template_kwargs: { thinking: true, reasoning_effort: "high" },
    });
  });

  it("translates every shape a body carries, not just the first", () => {
    expect(
      applyTinfoilReasoningEffort(
        {
          model: WIRE_MODEL,
          reasoning_effort: "medium",
          chat_template_kwargs: { thinking: true, reasoning_effort: "medium" },
        },
        DEEPSEEK_REASONING,
      ),
    ).toEqual({
      model: WIRE_MODEL,
      reasoning_effort: "high",
      chat_template_kwargs: { thinking: true, reasoning_effort: "high" },
    });

    // All three at once, each mapping differently: `low` -> `low`,
    // `medium` -> `high`, `high` -> `xhigh`.
    expect(
      applyTinfoilReasoningEffort(
        {
          model: WIRE_MODEL,
          reasoning_effort: "low",
          reasoning: { effort: "medium", exclude: true },
          chat_template_kwargs: { reasoning_effort: "high" },
        },
        DEEPSEEK_REASONING,
      ),
    ).toEqual({
      model: WIRE_MODEL,
      reasoning_effort: "low",
      reasoning: { effort: "high", exclude: true },
      chat_template_kwargs: { reasoning_effort: "xhigh" },
    });
  });

  it("leaves the caller's nested containers untouched when rewriting them", () => {
    const reasoning = { effort: "medium", exclude: true };
    const chatTemplateKwargs = { thinking: true, reasoning_effort: "medium" };
    const body = {
      model: WIRE_MODEL,
      reasoning,
      chat_template_kwargs: chatTemplateKwargs,
    };

    applyTinfoilReasoningEffort(body, DEEPSEEK_REASONING);

    // Copy-on-write, not in-place mutation: a retry that rebuilds from the
    // caller's body still sees the values the caller sent.
    expect(reasoning.effort).toBe("medium");
    expect(chatTemplateKwargs.reasoning_effort).toBe("medium");
    expect(body.reasoning).toBe(reasoning);
    expect(body.chat_template_kwargs).toBe(chatTemplateKwargs);
  });

  it("leaves native and unmapped values alone", () => {
    const native = { model: WIRE_MODEL, reasoning_effort: "xhigh" };
    expect(applyTinfoilReasoningEffort(native, DEEPSEEK_REASONING)).toBe(
      native,
    );

    const unmapped = { model: WIRE_MODEL, reasoning_effort: "minimal" };
    expect(applyTinfoilReasoningEffort(unmapped, DEEPSEEK_REASONING)).toBe(
      unmapped,
    );
  });

  it("is a no-op without published metadata", () => {
    const body = { model: WIRE_MODEL, reasoning_effort: "medium" };
    expect(applyTinfoilReasoningEffort(body, undefined)).toBe(body);
    expect(applyTinfoilReasoningEffort(body, null)).toBe(body);
    expect(applyTinfoilReasoningEffort(body, {})).toBe(body);
  });

  it("ignores bodies that are not JSON objects and non-string efforts", () => {
    expect(applyTinfoilReasoningEffort("not json", DEEPSEEK_REASONING)).toBe(
      "not json",
    );
    const numeric = { model: WIRE_MODEL, reasoning_effort: 42 };
    expect(applyTinfoilReasoningEffort(numeric, DEEPSEEK_REASONING)).toBe(
      numeric,
    );
  });
});

describe("_makeRequest Tinfoil effort mapping", () => {
  const request = (reasoning?: ModelReasoning, body: unknown = {}) => ({
    path: "/v1/chat/completions",
    method: "POST",
    body: {
      model: WIRE_MODEL,
      messages: [{ role: "user", content: "hi" }],
      ...(body as Record<string, unknown>),
    },
    selectedModel: model(CALLER_MODEL, reasoning),
    baseUrl: FIRST,
    mintUrl: MINT,
    token: KEY,
    requiredSats: 10,
    headers: { "X-Routstr-Model": CALLER_MODEL },
    baseHeaders: {},
    tinfoilEnabled: true,
  });

  it("seals the native effort the node published", async () => {
    const { client } = setup();
    fetchTinfoil.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await (client as any)._makeRequest(
      request(DEEPSEEK_REASONING, { reasoning_effort: "medium" }),
    );

    expect(sealedBody().reasoning_effort).toBe("high");
  });

  it("forwards the body unchanged when the node publishes no effort map", async () => {
    const { client } = setup();
    fetchTinfoil.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await (client as any)._makeRequest(
      request(undefined, { reasoning_effort: "medium" }),
    );

    expect(sealedBody().reasoning_effort).toBe("medium");
  });
});

describe("_handleErrorResponse Tinfoil failover effort mapping", () => {
  const params = {
    path: "/v1/chat/completions",
    method: "POST",
    body: {
      model: WIRE_MODEL,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "medium",
    },
    selectedModel: model(CALLER_MODEL, DEEPSEEK_REASONING),
    baseUrl: FIRST,
    mintUrl: MINT,
    token: KEY,
    requiredSats: 100,
    headers: { "X-Routstr-Model": CALLER_MODEL },
    baseHeaders: {},
    tinfoilEnabled: true,
    requestedModelId: CALLER_MODEL,
  };

  // The enclave's 400 for the invalid effort, as routstr-core relays it.
  const upstreamBody = JSON.stringify({
    error: {
      type: "upstream_error",
      code: 400,
      message: "EHBP upstream tinfoil returned 400",
    },
  });

  it("re-maps the caller effort on the failover retry", async () => {
    const { client, providerManager } = setup();
    providerManager.getModelForProvider.mockResolvedValue(
      model(CALLER_MODEL, DEEPSEEK_REASONING),
    );
    fetchTinfoil.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await (client as any)._handleErrorResponse(
      params,
      KEY,
      400,
      "req-400",
      undefined,
      upstreamBody,
      0,
    );

    // Only the failover retry reaches the wire. The bare id is #103's
    // invariant (asserted here because the retry is the only path that
    // rebuilds it); the mapped effort is this PR's: node B's own effort map
    // has to be applied to the caller's original value.
    expect(fetchTinfoil).toHaveBeenCalledTimes(1);
    expect(sealedBody()).toMatchObject({
      model: WIRE_MODEL,
      reasoning_effort: "high",
    });
  });
});
