import { afterEach, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const url = "https://provider.example/api";
const mintUrl = "https://mint.example/";
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const wallet = {} as WalletAdapter;
  const managers = [0, 1].map(() => new BalanceManager(wallet, {} as StorageAdapter));
  const refunds = managers.map(m => vi.spyOn(m as any, "_refundApiKeyImpl")
    .mockResolvedValue({ success: true }));
  const topups = managers.map(m => vi.spyOn(m as any, "_queueTopUp")
    .mockResolvedValue({ success: true }));
  const run = (i: number, type: "refund" | "topup", baseUrl: string) => type === "refund"
    ? managers[i].refundApiKey({ baseUrl, mintUrl, apiKey: "key", forceRefund: true })
    : managers[i].topUp({ baseUrl, mintUrl, token: "key", amount: 10 });
  return { run, refunds, topups };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

for (const type of ["refund", "topup"] as const) {
  for (const [first, second] of [[url, url + "/"], [url + "/", url], [url + "///", url]]) {
    it(`${type}: ${first} and ${second} share in-flight and cooldown tracking`, async () => {
      const { run, refunds, topups } = setup();
      const opposite = type === "refund" ? "topup" : "refund";
      let finish!: (result: { success: boolean }) => void;
      const impl = type === "refund" ? refunds : topups;
      impl[0].mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const pending = run(0, type, first);
      expect(impl[0]).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: first }));
      expect(await run(1, opposite, second)).toMatchObject({
        success: false, message: expect.stringContaining(`${type} in progress`),
      });
      finish({ success: true });
      await pending;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(await run(1, opposite, second)).toMatchObject({
        success: false, message: expect.stringContaining(`recent ${type} completed`),
      });
      await vi.advanceTimersByTimeAsync(1);
      expect((await run(1, opposite, second)).success).toBe(true);
      const oppositeImpl = type === "refund" ? topups : refunds;
      expect(oppositeImpl[1]).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: second }));
      // Completion and expiry must also use the normalized key in reverse.
      expect((await run(0, type, first)).success).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await run(0, type, first)).success).toBe(true);
    });
  }
}

it("a skipped refund removes its normalized tracking entry", async () => {
  const { run, refunds } = setup();
  refunds[0].mockResolvedValueOnce({ success: false, skipped: true });
  await run(0, "refund", url + "/");
  expect((await run(1, "topup", url)).success).toBe(true);
});

it("different provider paths and different wallets stay independent", async () => {
  const { run } = setup();
  await run(0, "refund", url);
  expect((await run(1, "topup", url + "-other/")).success).toBe(true);
  const other = setup();
  expect((await other.run(0, "topup", url + "/")).success).toBe(true);
});
