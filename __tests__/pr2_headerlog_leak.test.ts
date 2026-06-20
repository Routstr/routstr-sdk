import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../client/RoutstrClient";
import type {
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
  StreamingCallbacks,
} from "../wallet/interfaces";
import type { Model } from "../core/types";

// REGRESSION TEST for the header-value credential leak in the sdk#14 branch.
//
// Even after `_storeRequest` (the disk-dump leak) was removed, three more leak
// vectors remained. This test pins vector #1:
//
//   client/RoutstrClient.ts:_makeRequest used to do
//     if (this.mode === "xcashu") this._log("DEBUG", "HEADERS,", headers)
//   which, at DEBUG level, prints the FULL headers object — including the live
//   `X-Cashu` Cashu token — to stdout via console.log. One DEBUG run = the live
//   spendable token sitting in logs/CI output.
//
// The fix logs only `Object.keys(headers)` (and only response.status, never the
// whole Response). This test runs a real xcashu request at DEBUG level, spies on
// EVERY console sink, and asserts the live token value never appears in any
// console output across the whole request.

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

// NON-e2ee model to isolate the request path (no E2EE decrypt crash).
const plainModel: Model = {
  id: "openai/gpt-4o",
  name: "Plain GPT",
  sats_pricing: { max_cost: 50 },
} as unknown as Model;

const registry: ProviderRegistry = {
  getModelsForProvider: () => [plainModel],
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
};

const LIVE_TOKEN =
  "cashuBpGF0gaJhaUg_SECRET_LIVE_CASHU_TOKEN_DO_NOT_LEAK_abcdef123456";

function makeSSEStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

// Best-effort stringify of an arbitrary console arg so a token embedded in an
// object/headers/Response would still be caught.
function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

describe("sdk#14 header-value credential leak (FIXED)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never prints the live X-Cashu token to console across a DEBUG request", async () => {
    const realLog = console.log.bind(console);
    const captured: string[] = [];
    const sink = (...args: unknown[]) => {
      captured.push(args.map(stringifyArg).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(sink as any);
    vi.spyOn(console, "warn").mockImplementation(sink as any);
    vi.spyOn(console, "error").mockImplementation(sink as any);
    vi.spyOn(console, "debug").mockImplementation(sink as any);

    const client = new RoutstrClient(wallet, storage, registry, "max", "xcashu");
    // Force the noisiest path: DEBUG makes _log emit. Pre-fix this dumped the
    // full headers (with the live X-Cashu token).
    client.setDebugLevel("DEBUG");

    const spender = client.getCashuSpender();
    vi.spyOn(spender, "spend").mockImplementation(async () => {
      // The token returned here becomes the X-Cashu header value.
      return { token: LIVE_TOKEN, balance: 1000, unit: "sat" } as any;
    });

    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response(makeSSEStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as any;

    try {
      await client.fetchAIResponse(
        {
          messageHistory: [{ role: "user", content: "hi" } as any],
          selectedModel: plainModel,
          baseUrl: "https://provider.example",
          mintUrl: "https://mint",
          balance: 1000,
          transactionHistory: [],
        },
        callbacks
      );
    } catch {
      // streaming/decrypt may throw AFTER the request fires; irrelevant here.
    } finally {
      global.fetch = realFetch;
    }

    await new Promise((r) => setTimeout(r, 25));

    const all = captured.join("\n");

    // Sanity: the request path actually logged something at DEBUG (otherwise the
    // assertion below would be vacuously true).
    expect(captured.length).toBeGreaterThan(0);

    // The core invariant: the live token VALUE must never reach console output.
    const leaked = captured.filter((line) => line.includes(LIVE_TOKEN));

    realLog("\n===== sdk#14 HEADER-LOG LEAK FIX =====");
    realLog("console writes captured:", captured.length);
    realLog("lines containing live token:", leaked.length);
    realLog("======================================\n");

    expect(leaked).toEqual([]);
    expect(all.includes(LIVE_TOKEN)).toBe(false);
  });
});
