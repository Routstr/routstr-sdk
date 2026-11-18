import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";

const baseUrl = "https://provider.example/";
const mintUrl = "https://mint.example/";
const refund = { baseUrl, mintUrl, apiKey: "key", forceRefund: true };
const topup = { baseUrl, mintUrl, token: "key", amount: 10 };
const deferred = () => {
  let resolve!: (value: { success: boolean; skipped?: boolean }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ success: boolean; skipped?: boolean }>((yes, no) => {
    resolve = yes; reject = no;
  });
  return { promise, resolve, reject };
};

// Isolate the public operation wrappers from network, mint and batching logic.
// Separate managers intentionally share the adapter, as request/refund clients do.
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const wallet = {} as WalletAdapter;
  const storage = {} as StorageAdapter;
  const managers = [0, 1, 2].map(() => new BalanceManager(wallet, storage));
  const gates = [deferred(), deferred()];
  managers.forEach((manager, i) => {
    vi.spyOn(manager as any, "_refundApiKeyImpl").mockImplementation(() =>
      i < 2 ? gates[i].promise : Promise.resolve({ success: true }));
    vi.spyOn(manager as any, "_queueTopUp").mockImplementation(() =>
      i < 2 ? gates[i].promise : Promise.resolve({ success: true }));
  });
  return { managers, gates };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

for (const type of ["refund", "topup"] as const) {
  describe(`${type} overlap`, () => {
    for (const first of [0, 1]) {
      for (const throws of [false, true]) {
        it(`keeps sibling locked when caller ${first} ${throws ? "throws" : "finishes"} first`, async () => {
          const { managers: m, gates } = setup();
          const start = (i: number) => type === "refund" ? m[i].refundApiKey(refund) : m[i].topUp(topup);
          const opposite = () => type === "refund" ? m[2].topUp(topup) : m[2].refundApiKey(refund);
          const pending = [start(0), start(1)];
          if (throws) {
            const assertion = expect(pending[first]).rejects.toThrow("unknown outcome");
            gates[first].reject(new Error("unknown outcome"));
            await assertion;
          } else {
            gates[first].resolve({ success: true });
            await pending[first];
          }
          await vi.advanceTimersByTimeAsync(10_001);
          expect(await opposite()).toMatchObject({ success: false, message: expect.stringContaining(`${type} in progress`) });
          gates[1 - first].resolve({ success: true });
          await pending[1 - first];
          expect(await opposite()).toMatchObject({ success: false, message: expect.stringContaining(`recent ${type} completed`) });
          await vi.advanceTimersByTimeAsync(9_999);
          expect((await opposite()).success).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect((await opposite()).success).toBe(true);
        });
      }
    }
  });
}

it("a skipped newest refund cannot discard an older live refund", async () => {
  const { managers: m, gates } = setup();
  const live = m[0].refundApiKey(refund);
  const skipped = m[1].refundApiKey(refund);
  gates[1].resolve({ success: false, skipped: true });
  await skipped;
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await m[2].topUp(topup)).toMatchObject({ success: false, message: expect.stringContaining("refund in progress") });
  gates[0].resolve({ success: true });
  await live;
  expect((await m[2].topUp(topup)).success).toBe(false);
});

it("a skip preserves, but does not extend, a completed sibling's cooldown", async () => {
  const { managers: m, gates } = setup();
  const real = m[0].refundApiKey(refund);
  const skipped = m[1].refundApiKey(refund);
  gates[0].resolve({ success: true });
  await real;
  await vi.advanceTimersByTimeAsync(5_000);
  gates[1].resolve({ success: false, skipped: true });
  await skipped;
  expect((await m[2].topUp(topup)).success).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await m[2].topUp(topup)).success).toBe(true);
});

it("a later skip preserves an existing real-refund cooldown", async () => {
  const { managers: m, gates } = setup();
  const real = m[0].refundApiKey(refund);
  gates[0].resolve({ success: true });
  await real;
  await vi.advanceTimersByTimeAsync(5_000);
  const skipped = m[1].refundApiKey(refund);
  gates[1].resolve({ success: false, skipped: true });
  await skipped;
  expect((await m[2].topUp(topup)).success).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await m[2].topUp(topup)).success).toBe(true);
});

it("all skipped overlapping refunds leave no cooldown", async () => {
  const { managers: m, gates } = setup();
  const pending = [m[0].refundApiKey(refund), m[1].refundApiKey(refund)];
  for (const gate of gates) gate.resolve({ success: false, skipped: true });
  await Promise.all(pending);
  expect((await m[2].topUp(topup)).success).toBe(true);
});

it("a final throwing refund starts a fresh cooldown", async () => {
  const { managers: m, gates } = setup();
  const first = m[0].refundApiKey(refund);
  const last = m[1].refundApiKey(refund);
  gates[0].resolve({ success: true });
  await first;
  await vi.advanceTimersByTimeAsync(10_001);
  const assertion = expect(last).rejects.toThrow("unknown outcome");
  gates[1].reject(new Error("unknown outcome"));
  await assertion;
  expect((await m[2].topUp(topup)).success).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await m[2].topUp(topup)).success).toBe(true);
});
