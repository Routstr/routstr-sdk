/**
 * The prompt limit a node signs per model (`context_lengths`): the reservation
 * ceiling is sized only by it, the balance pre-check prefers it over the
 * listing's row (which may be another upstream's), and the offer check
 * refuses a malformed one.
 */

import { describe, expect, it } from "vitest";
import { contextLengthsProblem, validateOfferShape } from "../../client/confidential/offer";
import {
  confidentialRequiredSats,
  confidentialReservationCeilingMsats,
  confidentialReservationMsats,
} from "../../client/RoutstrClient";
import type { Model } from "../../core/types";
import { BOTH, v3OfferFields } from "./fixtures/v3";

const model = (extra: Record<string, unknown> = {}) =>
  ({ id: "m", context_length: 131072, sats_pricing: { prompt: 0.001, completion: 0.002, max_cost: 20 }, ...extra }) as unknown as Model;
const offer = (extra: Record<string, unknown> = {}) =>
  ({
    price_list: { m: { in: 1000, out: 2000 } },
    max_tokens_cap: 4096,
    session_fee_msat: 100,
    abandon_fee_msat: 300,
    reserve_margin_tokens: 16,
    connection_deposit_msat: 2000,
    ...extra,
  }) as never;
// What the node reserves for 100 completion tokens with a prompt limit of `limit`.
const nodeReserves = (limit: number) => Math.ceil((limit * 1000 + 116 * 2000) / 1000) + 300;

describe("the signed context length", () => {
  it("sizes the ceiling, not the listing's row (another upstream's, smaller)", () => {
    const signed = offer({ context_lengths: { m: 262144 } });
    const ceiling = confidentialReservationCeilingMsats(model(), 100, signed)!;
    expect(ceiling).toBe(nodeReserves(262144));
    // The honest node's reservation is within it.
    expect(ceiling).toBeGreaterThanOrEqual(nodeReserves(262144));
    // A listing with no context length at all: the signed number still bounds it.
    expect(confidentialReservationCeilingMsats(model({ context_length: undefined }), 100, signed)).toBe(nodeReserves(262144));
  });

  it("without it there is no ceiling, whatever the listing says", () => {
    expect(confidentialReservationCeilingMsats(model(), 100, offer())).toBeUndefined();
    expect(confidentialReservationCeilingMsats(model(), 100, offer({ context_lengths: { other: 8192 } }))).toBeUndefined();
  });

  it("is preferred by the balance pre-check; the listing's row is the fallback", () => {
    expect(confidentialReservationMsats(model(), 100, offer({ context_lengths: { m: 262144 } }))).toBe(nodeReserves(262144));
    expect(confidentialReservationMsats(model(), 100, offer())).toBe(nodeReserves(131072));
    expect(confidentialRequiredSats(model(), 100, offer({ context_lengths: { m: 262144 } }))).toBe(
      Math.ceil((nodeReserves(262144) + 2000) / 1000),
    );
  });

  it("is validated with the offer: optional, else positive safe integers for priced ids", () => {
    const priced = { ...BOTH, price_list: { cheap: { in: 1000, cached_in: 1000, out: 1000 } } };
    expect(() => validateOfferShape(v3OfferFields(priced))).not.toThrow();
    expect(() => validateOfferShape(v3OfferFields({ ...priced, context_lengths: { cheap: 131072 } }))).not.toThrow();
    expect(() => validateOfferShape(v3OfferFields({ ...priced, context_lengths: {} }))).not.toThrow();
    for (const bad of [
      [],
      "x",
      null,
      7,
      [131072],
      { cheap: 0 },
      { cheap: -1 },
      { cheap: 1.5 },
      { cheap: "131072" },
      { cheap: 2 ** 53 },
      { cheap: null },
      { other: 131072 },
    ]) {
      expect(contextLengthsProblem({ price_list: priced.price_list, context_lengths: bad })).toBeDefined();
      expect(() => validateOfferShape(v3OfferFields({ ...priced, context_lengths: bad }))).toThrow(/context_lengths/);
    }
  });
});
