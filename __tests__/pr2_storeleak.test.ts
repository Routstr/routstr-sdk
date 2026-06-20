import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { RoutstrClient } from "../client/RoutstrClient";
import type {
  WalletAdapter,
  StorageAdapter,
  ProviderRegistry,
  StreamingCallbacks,
} from "../wallet/interfaces";
import type { Model } from "../core/types";

// REGRESSION TEST for the credential-to-disk leak in PR #2.
//
// PR #2 added a `_storeRequest()` debug dump that, on EVERY request, wrote the
// FULL request headers (live X-Cashu cashu tokens AND Authorization: Bearer api
// keys) to reqs/req-*.json via JSON.stringify. reqs/ was NOT gitignored.
//
// This rework REMOVED _storeRequest entirely. This test now asserts the FIX:
// after a request, NO reqs/*.json file is written and no live token lands on
// disk. It reproduced (file written + token matched) against the pre-fix source
// and now passes because the dump is gone.

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

describe("PR#2 _storeRequest credential leak (FIXED)", () => {
  it("does NOT write any reqs/*.json to disk and never persists a live token", async () => {
    const reqsDir = path.join(process.cwd(), "reqs");
    // clean slate
    await fs.rm(reqsDir, { recursive: true, force: true });

    const client = new RoutstrClient(
      wallet,
      storage,
      registry,
      "max",
      "xcashu"
    );

    const spender = client.getCashuSpender();
    vi.spyOn(spender, "spend").mockImplementation(async () => {
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
    } catch (e) {
      console.log("[harness] post err ignored:", (e as Error).message);
    } finally {
      global.fetch = realFetch;
    }

    // Give any fire-and-forget write a tick to (not) flush.
    await new Promise((r) => setTimeout(r, 50));

    // (1) reqs/ must not exist (or contain no req-*.json dumps).
    let reqFiles: string[] = [];
    try {
      const files = await fs.readdir(reqsDir);
      reqFiles = files.filter((f) => f.startsWith("req-"));
    } catch {
      // ENOENT: directory never created — the desired outcome.
    }
    console.log("\n===== _storeRequest LEAK FIX =====");
    console.log("reqs/ files written:", reqFiles);
    expect(reqFiles.length).toBe(0);

    // (2) Defense in depth: if any reqs/*.json somehow exists, it must not
    // contain the live token.
    for (const f of reqFiles) {
      const raw = await fs.readFile(path.join(reqsDir, f), "utf-8");
      expect(raw.includes(LIVE_TOKEN)).toBe(false);
    }
    console.log("no reqs/*.json written, no live token on disk");
    console.log("==================================\n");
  });
});
