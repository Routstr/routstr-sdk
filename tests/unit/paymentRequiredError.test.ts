import { describe, expect, it } from "vitest";
import { isPaymentRequiredError, parseCoreError } from "../../core/errorTypes";
import { toInsufficientBalanceError } from "../../core/errors";

const details = {
  unit: "msat", required_msats: 28989, available_msats: 21000,
  shortfall_msats: 7989, reserved_msats: 4000, model: "gpt-test",
  pricing: { base_source: "model_sats_pricing", max_cost_formula: "context_only", required_msats: 28989 },
};
const error = {
  type: "insufficient_quota", code: "insufficient_balance",
  message: "Insufficient balance: 15.2208 sats required; 1 sats available.", details,
};
const parse = (body: unknown, status = 402) => parseCoreError(JSON.stringify(body), status);

describe("structured payment shortfalls", () => {
  it.each([
    { error, request_id: "body-id" },
    { detail: { error }, request_id: "body-id" },
    { error, detail: { error }, request_id: "body-id" },
  ])("reads structured msats, never conflicting English amounts", body => {
    const result = parse(body);
    expect(result).toMatchObject({ requiredMsats: 28989, availableMsats: 21000,
      shortfallMsats: 7989, reservedMsats: 4000, model: "gpt-test", unit: "msat",
      pricing: details.pricing, requestId: "body-id", raw: false });
    expect(isPaymentRequiredError(result)).toBe(true);
    const mapped = toInsufficientBalanceError(result)!;
    expect(mapped).toMatchObject({ required: 28.989, available: 21, parsedError: result });
  });

  it("prefers canonical error over a conflicting mirror and header ID over body ID", () => {
    const result = parseCoreError(JSON.stringify({ error, detail: { error: { ...error,
      details: { ...details, required_msats: 1 } } }, request_id: "body" }), 402, "header");
    expect(result.requiredMsats).toBe(28989);
    expect(result.requestId).toBe("header");
  });

  it("parses the old flat X-Cashu body without inventing available funds", () => {
    const result = parse({ detail: { type: "minimum_balance_required", reason: "Insufficient balance",
      amount_required_msat: 28989, model: "gpt-test" } });
    expect(result).toMatchObject({ code: "minimum_balance_required", requiredMsats: 28989,
      model: "gpt-test", message: "Insufficient balance", unit: "msat" });
    expect(isPaymentRequiredError(result)).toBe(false);
    expect(toInsufficientBalanceError(result)).toBeUndefined();
  });

  it("keeps the deprecated old-node English fallback", () => {
    const result = parse({ error: { ...error, details: undefined,
      message: "Insufficient balance: 28.989 sats (28989 msats) required for this model; 21 sats (21000 msats) available." } });
    expect(result).toMatchObject({ requiredMsats: 28989, availableMsats: 21000, shortfallMsats: 7989 });
    expect(result.pricing).toBeUndefined();
  });

  it.each(["28989", -1, 1.5, null, {}, [], Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid amount %j instead of falling back to prose", value => {
      const result = parse({ error: { ...error, details: { ...details, required_msats: value } } });
      expect(result.requiredMsats).toBeUndefined();
      expect(isPaymentRequiredError(result)).toBe(false);
      expect(toInsufficientBalanceError(result)).toBeUndefined();
    });

  it("rejects nonfinite JSON numbers", () => {
    const result = parseCoreError('{"error":{"type":"insufficient_quota","code":"insufficient_balance","details":{"required_msats":1e400}}}', 402);
    expect(result.requiredMsats).toBeUndefined();
  });

  it.each([null, [], "formula", 1])("ignores non-object pricing %j", pricing => {
    expect(parse({ error: { ...error, details: { ...details, pricing } } }).pricing).toBeUndefined();
  });

  it.each([[], null, "not details"])("never parses English when malformed details are present: %j", d => {
    expect(parse({ error: { ...error, details: d } }).requiredMsats).toBeUndefined();
  });

  it("accepts zero amounts", () => {
    expect(isPaymentRequiredError(parse({ error: { ...error, details: { ...details,
      required_msats: 0, available_msats: 0, shortfall_msats: 0 } } }))).toBe(true);
  });

  it.each([
    { status: 400 }, { status: undefined }, { unit: "sat" }, { type: "upstream_error" },
    { code: "balance_limit_exceeded" }, { availableMsats: undefined }, { shortfallMsats: NaN },
  ])("does not narrow an incompatible error %j", override => {
    expect(isPaymentRequiredError({ ...parse({ error }), ...override })).toBe(false);
  });

  it.each([{ error: [] }, { error: null }, { detail: { error: null } }, { request_id: {} }])(
    "handles malformed envelopes without throwing: %j", body => {
      expect(() => parse(body)).not.toThrow();
      expect(parse(body).requestId).toBeUndefined();
    });
});
