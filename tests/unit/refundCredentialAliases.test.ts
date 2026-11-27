import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore } from "../../storage";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://provider.example/";
const mintUrl = "https://mint.example/";
const bootstrap = "cashu-bootstrap";
const canonical = `sk-${createHash("sha256").update(bootstrap).digest("hex")}`;
const wallet = (): WalletAdapter => ({
  getActiveMintUrl: () => mintUrl,
  getBalances: async () => ({ [mintUrl]: 1000 }),
  getMintUnits: () => ({ [mintUrl]: "sat" }),
  sendToken: vi.fn(async () => "cashu-topup"),
  receiveToken: vi.fn(async () => ({ success: true, amount: 1, unit: "sat" as const })),
});

afterEach(() => vi.unstubAllGlobals());

it.each(["before refund", "after dispatch"])("quarantines both credentials when promoted %s", async order => {
  const driver = createMemoryDriver();
  const first = createSdkStore({ driver });
  await first.hydrate;
  const storage = createStorageAdapterFromStore(first.store);
  storage.setApiKey(baseUrl, bootstrap);
  const manager = new BalanceManager(wallet(), storage);
  if (order === "before refund") storage.replaceApiKey!(baseUrl, canonical);
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (order === "after dispatch") storage.replaceApiKey!(baseUrl, canonical);
    throw new Error("response lost");
  }));
  await manager.refundApiKey({ mintUrl, baseUrl, apiKey: bootstrap, forceRefund: true });
  await storage.flush!();

  const restarted = createSdkStore({ driver });
  await restarted.hydrate;
  const reloaded = createStorageAdapterFromStore(restarted.store);
  const freshWallet = wallet();
  const fresh = new BalanceManager(freshWallet, reloaded);
  for (const token of [bootstrap, canonical]) {
    expect(await fresh.topUp({ mintUrl, baseUrl, token, amount: 1 })).toMatchObject({ refundPending: true });
  }
  expect(freshWallet.sendToken).not.toHaveBeenCalled();
  expect(fresh.isApiKeyRefundPending(baseUrl, "cashu-unrelated")).toBe(false);

  // A definitive result from an operation pinned to the bootstrap credential
  // must clear the promoted key, but not any unrelated replacement.
  fresh.clearApiKeyRefundPending(baseUrl, "cashu-unrelated");
  expect(fresh.isApiKeyRefundPending(baseUrl, canonical)).toBe(true);
  fresh.clearApiKeyRefundPending(baseUrl, bootstrap);
  expect(reloaded.getApiKey(baseUrl)?.refundPendingAt).toBeUndefined();
});

it("uses the same identity with a legacy adapter that cannot persist markers", async () => {
  const sdk = createSdkStore({ driver: createMemoryDriver() });
  await sdk.hydrate;
  const storage = createStorageAdapterFromStore(sdk.store);
  storage.setApiKey(baseUrl, bootstrap);
  const manager = new BalanceManager(wallet(), {
    ...storage, markApiKeyRefundPending: undefined, clearApiKeyRefundPending: undefined,
  });
  manager.markApiKeyRefundPending(baseUrl, bootstrap);
  storage.replaceApiKey!(baseUrl, canonical);
  expect(manager.isApiKeyRefundPending(baseUrl, canonical)).toBe(true);
  manager.clearApiKeyRefundPending(baseUrl, canonical);
  expect(manager.isApiKeyRefundPending(baseUrl, bootstrap)).toBe(false);
});

it.each([canonical, "sk-unrelated"])("cleans up the resolved row but not an unrelated replacement: %s", async replacement => {
  const sdk = createSdkStore({ driver: createMemoryDriver() });
  await sdk.hydrate;
  const storage = createStorageAdapterFromStore(sdk.store);
  storage.setApiKey(baseUrl, bootstrap);
  const manager = new BalanceManager(wallet(), storage);
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (replacement === canonical) storage.replaceApiKey!(baseUrl, canonical);
    else {
      storage.removeApiKey(baseUrl);
      storage.setApiKey(baseUrl, replacement);
    }
    return Response.json({ detail: "No balance to refund" }, { status: 400 });
  }));
  expect((await manager.refundApiKey({ mintUrl, baseUrl, apiKey: bootstrap, forceRefund: true })).success).toBe(true);
  expect(storage.getApiKey(baseUrl)?.key).toBe(replacement === canonical ? undefined : replacement);
});
