/**
 * A Tinfoil/EHBP request sends the bare model id inside the encrypted body
 * (`deepseek-v4-1-flash`) and the caller-facing routstr id in the plaintext
 * `X-Routstr-Model` header (`tinfoil-deepseek-v4-1-flash`).
 *
 * Cross-provider failover rebuilds `body.model` from the failover target's
 * model (`newModel.id`) or from the next node's model-path selector. Both
 * spellings are the prefixed routstr id, so without stripping again the
 * enclave is asked for a model it does not know and answers 404
 * `model_not_found` — replacing the error that triggered the failover
 * (typically a 429) and cooling down the healthy node.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import {
  modelPathCandidateKey,
} from "../../utils/modelPaths";
import type { DiscoveryAdapter } from "../../discovery/interfaces";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import type { Model } from "../../core/types";

// Attestation would hit the network. The model-id helpers stay real: they are
// what this suite is pinning.
const { prepareTinfoilClientMock } = vi.hoisted(() => ({
  prepareTinfoilClientMock: vi.fn(async () => ({
    verification: {
      enclaveHost: "enclave.tinfoil.test",
      codeFingerprint: "ab".repeat(32),
    },
    secureClient: {},
  })),
}));

vi.mock("../../client/TinfoilSecure", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../client/TinfoilSecure")>();
  return { ...actual, prepareTinfoilClient: prepareTinfoilClientMock };
});

const BASE_URL = "https://ai.redsh1ft.com/";
const NEXT_URL = "https://routstr.otrta.me/";
const MINT_URL = "https://mint.example.com";
const TOKEN = "cashu_token_123";
const MODEL_ID = "tinfoil-deepseek-v4-1-flash";
/** What the enclave expects in the body. */
const BARE_MODEL_ID = "deepseek-v4-1-flash";

const SELECTOR =
  "url=https%3A%2F%2Finference.tinfoil.sh&model-id=tinfoil-deepseek-v4-1-flash";
const NEXT_SELECTOR =
  "url=https%3A%2F%2Finference.tinfoil.sh&provider-id=4&model-id=tinfoil-deepseek-v4-1-flash";

const RATE_LIMITED_BODY = JSON.stringify({
  error: { message: "rate limited", type: "rate_limited", code: 429 },
});

const makeModel = (): Model =>
  ({
    id: MODEL_ID,
    name: "Tinfoil DeepSeek V4.1 Flash",
    sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
  }) as Model;

const createWallet = (): WalletAdapter => ({
  getBalances: async () => ({}),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => null,
  sendToken: async () => "token",
  receiveToken: async () => ({ success: true, amount: 100, unit: "sat" }),
});

const createStorage = (): StorageAdapter =>
  ({
    getXcashuTokens: () => ({}),
    getXcashuTokensForBaseUrl: () => [],
    addXcashuToken: () => {},
    removeXcashuToken: () => {},
    clearXcashuTokensForBaseUrl: () => {},
    updateXcashuTokenTryCount: () => {},
    getApiKeyDistribution: () => [],
    removeApiKey: () => {},
    saveProviderInfo: () => {},
    getProviderInfo: () => null,
    getApiKey: () => null,
    setApiKey: () => {},
    updateApiKeyBalance: () => {},
    touchApiKeyLastUsed: () => {},
    getAllApiKeys: () => [],
    getChildKey: () => null,
    setChildKey: () => {},
    updateChildKeyBalance: () => {},
    removeChildKey: () => {},
    getAllChildKeys: () => [],
    getCachedReceiveTokens: () => [],
    setCachedReceiveTokens: () => {},
  }) as StorageAdapter;

const createDiscovery = (): DiscoveryAdapter =>
  ({
    getModelIdMappings: () => null,
    setModelIdMappings: () => {},
    getModelIdMappingsEvent: () => null,
    setModelIdMappingsEvent: () => {},
    getCachedModels: () => ({
      [BASE_URL.slice(0, -1)]: [makeModel()],
      [NEXT_URL.slice(0, -1)]: [makeModel()],
    }),
    setCachedModels: () => {},
    getCachedMints: () => ({}),
    setCachedMints: () => {},
    getCachedProviderInfo: () => ({}),
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
  }) as DiscoveryAdapter;

function makeClient() {
  return new RoutstrClient(
    createWallet(),
    createStorage(),
    createDiscovery(),
    "ERROR",
    "xcashu"
  );
}

/**
 * Params as they reach `_handleErrorResponse` on the first attempt: the body
 * already carries the stripped model, and `requestedModelId` keeps the
 * caller-facing id for cooldown/failover keys.
 */
const errorParams = (baseHeaders: Record<string, string> = {}) => ({
  path: "/v1/chat/completions",
  method: "POST",
  body: { model: BARE_MODEL_ID, messages: [] },
  selectedModel: makeModel(),
  baseUrl: BASE_URL,
  mintUrl: MINT_URL,
  token: TOKEN,
  requiredSats: 100,
  headers: {},
  baseHeaders,
  tinfoilEnabled: true,
  requestedModelId: MODEL_ID,
});

function stubFailoverDeps(client: RoutstrClient) {
  vi.spyOn(client as any, "_spendToken").mockResolvedValue({
    token: "fresh_token",
    selectedMintUrl: MINT_URL,
    tokenBalance: 100,
    tokenBalanceUnit: "sat",
    tokenBalanceUnknown: false,
  });
  vi.spyOn(
    (client as any).providerManager,
    "getModelForProvider"
  ).mockResolvedValue(makeModel());
}

beforeEach(() => {
  // Unit tests must never reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      throw new Error(
        `unexpected network request in unit test: ${String(input)}`
      );
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  prepareTinfoilClientMock.mockClear();
});

describe("Tinfoil model id across provider failover", () => {
  it("retries a failover hop with the bare body model and the prefixed header", async () => {
    const client = makeClient();
    stubFailoverDeps(client);
    vi.spyOn(
      (client as any).providerManager,
      "findNextBestProvider"
    ).mockReturnValue(NEXT_URL);
    const makeRequest = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok"));

    await (client as any)._handleErrorResponse(
      errorParams(),
      TOKEN,
      429,
      "req-1",
      undefined,
      RATE_LIMITED_BODY
    );

    const retry = makeRequest.mock.calls[0][0];
    expect(retry.baseUrl).toBe(NEXT_URL);
    // The enclave only knows the bare id…
    expect(retry.body.model).toBe(BARE_MODEL_ID);
    // …while the plaintext header keeps the caller-facing id for proxy lookup.
    expect(retry.headers["X-Routstr-Model"]).toBe(MODEL_ID);
    expect(retry.tinfoilEnabled).toBe(true);
  });

  it("strips the next node's model-path selector spelling in the retry body", async () => {
    const client = makeClient();
    stubFailoverDeps(client);
    vi.spyOn(
      (client as any).providerManager,
      "getModelPathProviderRanking"
    ).mockResolvedValue([
      {
        baseUrl: NEXT_URL,
        selectors: [NEXT_SELECTOR],
        satsPricing: [null],
        model: makeModel(),
      },
    ]);
    const makeRequest = vi
      .spyOn(client as any, "_makeRequest")
      .mockResolvedValue(new Response("ok"));

    await (client as any)._handleErrorResponse(
      {
        ...errorParams({ "x-routstr-model-path": SELECTOR }),
        autoModelPath: { selector: SELECTOR },
      },
      TOKEN,
      429,
      "req-1",
      undefined,
      RATE_LIMITED_BODY
    );

    const retry = makeRequest.mock.calls[0][0];
    // The selector names the model `tinfoil-deepseek-v4-1-flash`; the body
    // must still name the enclave's bare id.
    expect(retry.baseHeaders["x-routstr-model-path"]).toBe(NEXT_SELECTOR);
    expect(retry.body.model).toBe(BARE_MODEL_ID);
    expect(retry.headers["X-Routstr-Model"]).toBe(MODEL_ID);
    // The failed hop's route is excluded from the chain it already burned.
    expect(retry.triedModelPaths).toEqual([
      modelPathCandidateKey(BASE_URL, SELECTOR),
    ]);
  });

  it("leaves non-Tinfoil model ids untouched", async () => {
    const client = makeClient();
    const upstreamBodyModelId = (client as any)._upstreamBodyModelId.bind(
      client
    );

    // Tinfoil request: the caller-facing id loses its prefix.
    expect(upstreamBodyModelId(MODEL_ID, true)).toBe(BARE_MODEL_ID);
    // Already bare (e.g. a route advertised under the enclave's own id): no
    // double slice, which would corrupt the id.
    expect(upstreamBodyModelId(BARE_MODEL_ID, true)).toBe(BARE_MODEL_ID);
    // Not a Tinfoil request: the prefix is part of the id.
    expect(upstreamBodyModelId(MODEL_ID, false)).toBe(MODEL_ID);
    expect(upstreamBodyModelId("z-ai-glm-5-3", false)).toBe("z-ai-glm-5-3");
  });
});
