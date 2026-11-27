import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore } from "../../storage";
import { BalanceManager } from "../../wallet/BalanceManager";

const baseUrl = "https://provider.example/";
const mintUrl = "https://mint.example/";
const apiKey = "sk-example";
const receipt = { status: "paid", refund_id: "refund-1", recipient: "recipient@example.org" };

afterEach(() => vi.unstubAllGlobals());

async function attempt(body: unknown) {
  const sdk = createSdkStore({ driver: createMemoryDriver() });
  await sdk.hydrate;
  const storage = createStorageAdapterFromStore(sdk.store);
  storage.setApiKey(baseUrl, apiKey);
  storage.markApiKeyRefundPending!(baseUrl, apiKey);
  const receiveToken = vi.fn();
  const manager = new BalanceManager({
    getBalances: async () => ({}), getMintUnits: () => ({}),
    getActiveMintUrl: () => mintUrl, sendToken: vi.fn(), receiveToken,
  }, storage);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, {
    headers: { "x-routstr-request-id": "request-1" },
  })));
  const result = await manager.refundApiKey({ baseUrl, mintUrl, apiKey, forceRefund: true });
  expect(receiveToken).not.toHaveBeenCalled();
  expect(storage.getCachedReceiveTokens()).toEqual([]);
  return { result, storage };
}

describe("Lightning refund receipts", () => {
  it.each([{ sats: "17" }, { msats: "17000" }])("resolves a replayed paid receipt (%j)", async amount => {
    const { result, storage } = await attempt({ ...receipt, ...amount });
    expect(result).toMatchObject({ success: true, refundedAmount: 17000, requestId: "request-1" });
    expect(storage.getApiKey(baseUrl)).toBeNull();
  });

  it.each([{ ...receipt, status: "pending" }, { ...receipt, recipient: "" }, { ...receipt, refund_id: "" }])(
    "keeps an ambiguous tokenless response quarantined (%j)", async body => {
      const { result, storage } = await attempt(body);
      expect(result.success).toBe(false);
      expect(storage.getApiKey(baseUrl)?.refundPendingAt).toBeTypeOf("number");
    },
  );
});
