import { describe, expect, it } from "vitest";

/**
 * Tests for the xcashu double-refund clamp in RoutstrClient._handlePostResponseBalanceUpdate.
 *
 * Bug: when a refund token is received (via x-cashu response header) and the
 * background refundXcashuTokens sweep also receives the same token (or its proofs),
 * the refund amount can exceed initialTokenBalance, producing a negative satsSpent
 * that gets written to usage_tracking.sats_cost.
 *
 * Real-world case: sats_cost = -8176 for a request that actually cost 56.8 sats.
 *
 * Fix: Math.max(0, initialTokenBalance - refundSats) + WARN log on anomaly.
 *
 * These tests exercise the exact arithmetic from the patched code path.
 */

// Reproduce the exact patched logic (isolated for unit testing)
function computeSatsSpent(
  initialTokenBalance: number,
  receiveAmount: number,
  unit: "sat" | "msat",
): { satsSpent: number; warned: boolean } {
  const refundSats = receiveAmount * (unit == "sat" ? 1 : 1000);
  let warned = false;
  if (refundSats > initialTokenBalance) {
    warned = true;
  }
  const satsSpent = Math.max(0, initialTokenBalance - refundSats);
  return { satsSpent, warned };
}

// Old (unpatched) logic for comparison
function oldComputeSatsSpent(
  initialTokenBalance: number,
  receiveAmount: number,
  unit: "sat" | "msat",
): number {
  return initialTokenBalance - receiveAmount * (unit == "sat" ? 1 : 1000);
}

describe("xcashu refund clamp (double-refund race guard)", () => {
  it("normal exact refund (sat) → 0 satsSpent, no warn", () => {
    const { satsSpent, warned } = computeSatsSpent(100, 100, "sat");
    expect(satsSpent).toBe(0);
    expect(warned).toBe(false);
  });

  it("normal partial refund (sat) → positive satsSpent, no warn", () => {
    const { satsSpent, warned } = computeSatsSpent(1000, 500, "sat");
    expect(satsSpent).toBe(500);
    expect(warned).toBe(false);
  });

  it("no refund → full balance as satsSpent, no warn", () => {
    const { satsSpent, warned } = computeSatsSpent(500, 0, "sat");
    expect(satsSpent).toBe(500);
    expect(warned).toBe(false);
  });

  it("RACE: refund > balance (sat) → clamped to 0, warned", () => {
    const { satsSpent, warned } = computeSatsSpent(100, 200, "sat");
    expect(satsSpent).toBe(0);
    expect(warned).toBe(true);
    // Old logic would produce -100
    expect(oldComputeSatsSpent(100, 200, "sat")).toBe(-100);
  });

  it("RACE: refund >> balance (sat) → clamped to 0, warned", () => {
    // Reproduces the -8176 bug: small balance, large double-refund
    const { satsSpent, warned } = computeSatsSpent(56, 8232, "sat");
    expect(satsSpent).toBe(0);
    expect(warned).toBe(true);
    expect(oldComputeSatsSpent(56, 8232, "sat")).toBe(-8176);
  });

  it("zero balance with any refund → clamped to 0, warned", () => {
    const { satsSpent, warned } = computeSatsSpent(0, 50, "sat");
    expect(satsSpent).toBe(0);
    expect(warned).toBe(true);
  });

  it("msat: normal partial refund → correct positive satsSpent", () => {
    const { satsSpent, warned } = computeSatsSpent(56806, 0.028, "msat");
    expect(satsSpent).toBe(56778);
    expect(warned).toBe(false);
  });

  it("msat: RACE refund > balance → clamped to 0, warned", () => {
    // Actual bug case from production: initialTokenBalance=8232 msats,
    // refund=16408 msats (double-received) → old: 8232-16408 = -8176
    const { satsSpent, warned } = computeSatsSpent(8232, 16.408, "msat");
    expect(satsSpent).toBe(0);
    expect(warned).toBe(true);
    expect(oldComputeSatsSpent(8232, 16.408, "msat")).toBe(-8176);
  });

  it("never produces negative satsSpent across all cases", () => {
    const cases: [number, number, "sat" | "msat"][] = [
      [100, 100, "sat"],
      [1000, 500, "sat"],
      [100, 200, "sat"],
      [56, 8232, "sat"],
      [0, 50, "sat"],
      [56806, 0.028, "msat"],
      [8232, 16.408, "msat"],
      [1, 999999, "sat"],
      [1, 0.001, "msat"],
    ];
    for (const [bal, amt, unit] of cases) {
      const { satsSpent } = computeSatsSpent(bal, amt, unit);
      expect(satsSpent).toBeGreaterThanOrEqual(0);
    }
  });
});
