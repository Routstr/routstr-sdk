import { describe, expect, it, vi, beforeEach } from "vitest";
import { RoutstrClient } from "../client/RoutstrClient";
import type {
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
  StreamingCallbacks,
} from "../wallet/interfaces";
import type { Model } from "../core/types";

// ---- Instrumentation: record every cashu spend with amount + order ----
type Event = { kind: "spend"; amount: number; seq: number } | {
  kind: "attestation-fetch";
  seq: number;
} | { kind: "attestation-verified"; seq: number } | {
  kind: "completion-fetch";
  seq: number;
};
const events: Event[] = [];
let seq = 0;

// fake-but-valid uncompressed secp256k1 pubkey (04 + 64 bytes) for attestation
const FAKE_MODEL_PUBKEY =
  "04" +
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

function makeSSEStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

const wallet: WalletAdapter = {
  getBalances: async () => ({ "https://mint": 1000 }),
  getMintUnits: () => ({}),
  getActiveMintUrl: () => "https://mint",
  sendToken: async () => "cashuTOKEN",
  receiveToken: async () => ({ success: true, amount: 0, unit: "sat" }),
};

const storage: StorageAdapter = {
  getToken: () => null,
  setToken: () => {},
  removeToken: () => {},
  updateTokenBalance: () => {},
  getCachedTokenDistribution: () => [],
  getApiKeyDistribution: () => [],
  removeApiKey: () => {},
  saveProviderInfo: () => {},
  getProviderInfo: () => null,
  getApiKey: () => null,
  setApiKey: () => {},
  updateApiKeyBalance: () => {},
  getAllApiKeys: () => [],
  getChildKey: () => null,
  setChildKey: () => {},
  getXcashuTokens: () => [],
  addXcashuToken: () => {},
  removeXcashuToken: () => {},
  clearXcashuTokens: () => {},
} as unknown as StorageAdapter;

const e2eeModel: Model = {
  id: "e2ee-llama-3.3-70b",
  name: "Venice: e2ee-llama",
  sats_pricing: { max_cost: 50 },
} as unknown as Model;

const registry: ProviderRegistry = {
  getModelsForProvider: () => [e2eeModel],
  getDisabledProviders: () => [],
  getProviderMints: () => ["https://mint"],
  getProviderInfo: async () => ({ version: "0.2.0" } as any),
  getAllProvidersModels: () => ({}),
};

const callbacks: StreamingCallbacks = {
  onStreamingUpdate: () => {},
  onThinkingUpdate: () => {},
  onMessageAppend: () => {},
  onBalanceUpdate: () => {},
  onTransactionUpdate: () => {},
  onTokenCreated: () => {},
  onPaymentProcessing: () => {},
};

// Runs one e2ee xcashu request with the real RoutstrClient, instrumenting
// every CashuSpender.spend and the attestation fetch/verify so we can assert on
// the spend amounts and their ORDER relative to attestation verification.
async function runE2EERequest() {
  const client = new RoutstrClient(wallet, storage, registry, "max", "xcashu");

  // Instrument the REAL CashuSpender.spend used inside the client.
  const spender = client.getCashuSpender();
  vi.spyOn(spender, "spend").mockImplementation(async (opts: any) => {
    events.push({ kind: "spend", amount: opts.amount, seq: seq++ });
    return {
      token: "cashuTOKEN_LIVE_" + opts.amount,
      balance: 1000,
      unit: "sat",
    } as any;
  });

  // Stub global fetch: attestation GET + completion POST.
  const realFetch = global.fetch;
  global.fetch = vi.fn(async (input: any, _init: any) => {
    const url = String(input);
    if (url.includes("/tee/attestation")) {
      events.push({ kind: "attestation-fetch", seq: seq++ });
      // The verifier checks attestation.verified===true and nonce.
      const nonceMatch = url.match(/nonce=([^&]+)/);
      const nonce = nonceMatch ? decodeURIComponent(nonceMatch[1]) : "";
      const modelMatch = url.match(/model=([^&]+)/);
      const model = modelMatch ? decodeURIComponent(modelMatch[1]) : "";
      events.push({ kind: "attestation-verified", seq: seq++ });
      return new Response(
        JSON.stringify({
          verified: true,
          nonce,
          model,
          signing_key: FAKE_MODEL_PUBKEY,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // completion POST
    events.push({ kind: "completion-fetch", seq: seq++ });
    return new Response(makeSSEStream(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as any;

  try {
    await client.fetchAIResponse(
      {
        messageHistory: [{ role: "user", content: "hi" } as any],
        selectedModel: e2eeModel,
        baseUrl: "https://provider.example",
        mintUrl: "https://mint",
        balance: 1000,
        transactionHistory: [],
      },
      callbacks
    );
  } catch (e) {
    // streaming/decrypt may throw AFTER spends; we only care about spend events.
    // eslint-disable-next-line no-console
    console.log(
      "[harness] post-spend error (expected, ignored):",
      (e as Error).message
    );
  } finally {
    global.fetch = realFetch;
  }

  const spends = events.filter((e) => e.kind === "spend") as Array<{
    kind: string;
    amount: number;
    seq: number;
  }>;
  const attVerified = events.find((e) => e.kind === "attestation-verified") as
    | { kind: string; seq: number }
    | undefined;

  return { spends, attVerified };
}

describe("PR#2 e2ee xcashu spend behavior", () => {
  beforeEach(() => {
    events.length = 0;
    seq = 0;
  });

  // (b) ORDERING FIX — the money-path invariant this rework locks in: the main
  // request-amount (requiredSats === 50) spend MUST NOT happen until the Venice
  // E2EE attestation has been fetched and verified. If anyone reorders the spend
  // before attestation, this fails.
  it("does NOT spend the request amount (requiredSats) before attestation is verified", async () => {
    const { spends, attVerified } = await runE2EERequest();

    expect(attVerified).toBeDefined();

    // The requiredSats main spend is 50. Find it and assert it comes AFTER
    // attestation verification.
    const mainSpend = spends.find((s) => s.amount === 50);
    expect(mainSpend, "expected a requiredSats (50) spend").toBeDefined();
    expect(mainSpend!.seq).toBeGreaterThan(attVerified!.seq);

    // Belt-and-suspenders: NO spend of the full request amount may precede
    // attestation verification.
    const requestAmountBeforeAttest = spends.filter(
      (s) => s.amount === 50 && s.seq < attVerified!.seq
    );
    expect(requestAmountBeforeAttest.length).toBe(0);
  });

  // (c) CHARACTERIZATION TEST (NOT a fix) — documents the still-open
  // double-spend. With the current code an e2ee xcashu request fires TWO
  // separate spends: a 1-sat attestation spend (in _getAttestationAuth) whose
  // returned token is NEVER consumed, followed by the full requiredSats (50)
  // spend. The 1-sat spend precedes attestation verification.
  //
  // This is DELIBERATELY left for the SDK author because resolving it (reuse the
  // attestation spend vs keep a separate paid attestation) depends on Venice's
  // attestation-endpoint payment model, which is not verifiable here. See PR body.
  // This test will START FAILING once the double-spend is resolved — that is the
  // signal the design decision was made; update it then.
  it("[characterization] currently double-spends: 1-sat attestation spend (unconsumed) + 50-sat request spend", async () => {
    const { spends, attVerified } = await runE2EERequest();

    // eslint-disable-next-line no-console
    console.log("\n========== PR#2 CHARACTERIZATION ==========");
    // eslint-disable-next-line no-console
    console.log("event order:", JSON.stringify(events, null, 0));
    // eslint-disable-next-line no-console
    console.log("spend amounts:", spends.map((s) => s.amount));
    // eslint-disable-next-line no-console
    console.log("===========================================\n");

    // Two distinct spends for one logical request.
    expect(spends.length).toBe(2);
    expect(spends.map((s) => s.amount).sort((a, b) => a - b)).toEqual([1, 50]);

    // The 1-sat attestation spend is the FIRST spend and precedes verification.
    const firstSpend = spends[0];
    expect(firstSpend.amount).toBe(1);
    expect(firstSpend.seq).toBeLessThan(attVerified!.seq);
  });
});
