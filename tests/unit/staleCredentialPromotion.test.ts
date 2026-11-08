import { describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { WalletAdapter } from "../../wallet/interfaces";
import { createMemoryDriver, createSdkStore } from "../../storage";
import { createStorageAdapterFromStore } from "../../storage/store";

const baseUrl = "https://provider.example.com/";
const token = "cashu-old";

async function fixture() {
  const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  storage.setApiKey(baseUrl, token);
  storage.updateApiKeyBalance(baseUrl, 7, 0);
  let resolve!: (value: any) => void;
  const read = new Promise((done) => { resolve = done; });
  const client: any = Object.create(RoutstrClient.prototype);
  client.mode = "apikeys";
  client._log = () => {};
  client.storageAdapter = storage;
  client.balanceManager = { getTokenBalance: vi.fn(() => read) };
  client._trackResponseUsage = vi.fn(async () => {});
  const pending = client._handlePostResponseBalanceUpdate({
    token, baseUrl, initialTokenBalance: 7,
    usage: { reportedSatsCost: 0.25 },
  });
  return { storage, client, pending, resolve: () => resolve({
    amount: 6000, reserved: 1000, unit: "msat", apiKey: "canonical-old", readSeq: 1,
  }) };
}

describe("post-response bootstrap credential promotion", () => {
  it.each(["cashu-new-funded", "canonical-new"])(
    "preserves a replacement %s and its balance while accounting settles",
    async (replacement) => {
      const f = await fixture();
      // Ordinary creation cannot overwrite an existing provider key. Model
      // removal followed by creation explicitly; do not bypass that guard.
      expect(() => f.storage.setApiKey(baseUrl, replacement)).toThrow("ApiKey already exists");
      f.storage.removeApiKey(baseUrl);
      f.storage.setApiKey(baseUrl, replacement);
      f.storage.updateApiKeyBalance(baseUrl, 29, 3);
      const before = f.storage.getApiKey(baseUrl);
      f.resolve();
      expect(await f.pending).toBe(0.25);
      expect(f.storage.getApiKey(baseUrl)).toEqual(before);
      expect(f.client._trackResponseUsage).toHaveBeenCalledWith(expect.objectContaining({ satsSpent: 0.25 }));
    },
  );

  it("preserves a key recreated after SDK refund cleanup while an old read waits", async () => {
    const f = await fixture();
    const logger: any = { log() {}, warn() {}, error() {}, child() { return this; } };
    const manager = new BalanceManager({} as WalletAdapter, f.storage, undefined, {} as any, logger);
    // Stub only the provider refund response. The SDK's real cleanup removes
    // the empty old credential, opening the slot for ordinary guarded creation.
    vi.spyOn(manager, "fetchRefundToken").mockResolvedValue({ success: false, noBalance: true });
    await expect(manager.refundApiKey({
      baseUrl, mintUrl: "https://mint.example.com/", apiKey: token, forceRefund: true,
    })).resolves.toMatchObject({ success: true });
    expect(f.storage.getApiKey(baseUrl)).toBeNull();
    f.storage.setApiKey(baseUrl, "cashu-new-funded");
    f.storage.updateApiKeyBalance(baseUrl, 29, 3);
    f.resolve();
    await f.pending;
    expect(f.storage.getApiKey(baseUrl)).toMatchObject({ key: "cashu-new-funded", balance: 29, reserved: 3 });
    expect(f.client._trackResponseUsage).toHaveBeenCalledOnce();
  });

  it("does not resurrect a removed key", async () => {
    const f = await fixture();
    f.storage.removeApiKey(baseUrl);
    f.resolve();
    await f.pending;
    expect(f.storage.getApiKey(baseUrl)).toBeNull();
    expect(f.client._trackResponseUsage).toHaveBeenCalledOnce();
  });

  it("still promotes the unchanged bootstrap key and saves its balance", async () => {
    const f = await fixture();
    f.resolve();
    await f.pending;
    expect(f.storage.getApiKey(baseUrl)).toMatchObject({ key: "canonical-old", balance: 6, reserved: 1 });
    expect(f.client._trackResponseUsage).toHaveBeenCalledOnce();
  });
});
