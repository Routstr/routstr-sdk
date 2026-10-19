/**
 * What the client accepts from the node about an image request and its
 * response: error charges by status, image error receipts bound to the
 * session's terms, an accepted response checked (and reported, not thrown),
 * interim HTTP heads, the provider headers handed on, and pins that may not
 * override what the caller set.
 */

import { describe, expect, it } from "vitest";

import { checkUpstreamErrorReceipt, errorStatusCharge } from "../../client/confidential/receipt";
import { exposedProviderHeader, parseHttpResponse } from "../../client/confidential/suffix";
import { checkImageResponse } from "../../client/confidential/session";
import { chooseImageVariant } from "../../client/confidential/imagePlan";
import { ConfidentialError, ReceiptVerificationError } from "../../client/confidential/errors";

const enc = (s: string) => new TextEncoder().encode(s);
const http = (head: string, body: string) => parseHttpResponse(enc(head + "\r\n\r\n" + body));

describe("provider error charges", () => {
  const err = (status: number, extra: Record<string, unknown> = {}) =>
    ({ sid: "s1", model: "m", usage: { error_status: status }, ...extra }) as never;

  it("bills a rejected request the abandon fee, a capacity refusal the session fee", () => {
    expect(errorStatusCharge(400)).toBe("abandon_fee");
    expect(errorStatusCharge(404)).toBe("abandon_fee");
    expect(errorStatusCharge(429)).toBe("session_fee");
    expect(errorStatusCharge(503)).toBe("session_fee");
    expect(errorStatusCharge(500)).toBe("reservation");
    // 400: up to max(session fee, abandon fee).
    expect(checkUpstreamErrorReceipt(err(400, { cost_msats: 2000 }), 400, 0, { abandonFeeMsat: 2000 })).toBe(true);
    expect(() => checkUpstreamErrorReceipt(err(400, { cost_msats: 2001 }), 400, 0, { abandonFeeMsat: 2000 })).toThrow(
      /abandon fee/,
    );
    // 429 / 503: only the session fee, whatever the abandon fee.
    expect(() => checkUpstreamErrorReceipt(err(429, { cost_msats: 2000 }), 429, 0, { abandonFeeMsat: 2000 })).toThrow(
      /session fee/,
    );
    expect(checkUpstreamErrorReceipt(err(503, { cost_msats: 0 }), 503, 0, { abandonFeeMsat: 2000 })).toBe(true);
  });

  it("holds an image error receipt to the session's terms", () => {
    const image = { model: "z", variant: "webp", count: 2, msatPerImage: 12000 };
    const ok = { kind: "images", model: "z", variant: "webp", count: 2 };
    expect(
      checkUpstreamErrorReceipt(err(400, { ...ok, cost_msats: 2000 }), 400, 0, { abandonFeeMsat: 2000, image }),
    ).toBe(true);
    // A 5xx is charged at most price × count + the larger fee, whatever reservation it names.
    expect(
      checkUpstreamErrorReceipt(err(500, { ...ok, cost_msats: 26000, reserved_msats: 26000 }), 500, 0, { abandonFeeMsat: 2000, image }),
    ).toBe(true);
    expect(() =>
      checkUpstreamErrorReceipt(err(500, { ...ok, cost_msats: 1e12, reserved_msats: 1e12 }), 500, 0, { abandonFeeMsat: 2000, image }),
    ).toThrow(/exceeds price × count/);
    for (const wrong of [{ kind: "chat" }, { model: "y" }, { variant: "1K-webp" }, { count: 1 }]) {
      expect(() =>
        checkUpstreamErrorReceipt(err(400, { ...ok, ...wrong, cost_msats: 0 }), 400, 0, { abandonFeeMsat: 2000, image }),
      ).toThrow(ReceiptVerificationError);
    }
  });
});

describe("an accepted image response", () => {
  const want = { model: "z", count: 2, countKey: "variants" };

  it("reports shortfalls instead of throwing", () => {
    const good = http("HTTP/1.1 200 OK\r\nContent-Type: application/json", JSON.stringify({ images: ["aa", "bb"], request: { model: "z", variants: 2 } }));
    expect(checkImageResponse(good, "venice", want).warnings).toEqual([]);
    const short = http("HTTP/1.1 200 OK", JSON.stringify({ images: ["aa"], request: { model: "other", variants: 1 } }));
    const r = checkImageResponse(short, "venice", want);
    expect(r.image.data).toHaveLength(1);
    expect(r.warnings.join("|")).toMatch(/1 of 2 images/);
    expect(r.warnings.join("|")).toMatch(/model other/);
    expect(r.warnings.join("|")).toMatch(/variants=1/);
    const cut = http("HTTP/1.1 200 OK\r\nContent-Length: 999999", JSON.stringify({ images: ["aa", "bb"] }));
    expect(checkImageResponse(cut, "venice", want).warnings.join("|")).toMatch(/incomplete/);
    const junk = http("HTTP/1.1 200 OK", "not json");
    expect(checkImageResponse(junk, "venice", want).warnings.join("|")).toMatch(/not JSON/);
    const openai = http("HTTP/1.1 200 OK", JSON.stringify({ created: 5, data: [{ b64_json: "aa" }, { b64_json: "bb" }] }));
    expect(checkImageResponse(openai, "openai", want)).toEqual({ image: { created: 5, data: [{ b64_json: "aa" }, { b64_json: "bb" }] }, warnings: [] });
  });
});

describe("HTTP framing", () => {
  it("skips interim 1xx heads", () => {
    const r = parseHttpResponse(enc("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: x\r\n\r\nHTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\nno"));
    expect(r.status).toBe(400);
    expect(r.bodyText).toBe("no");
    expect(r.complete).toBe(true);
  });

  it("knows whether the body is complete", () => {
    expect(http("HTTP/1.1 200 OK\r\nContent-Length: 3", "abc").complete).toBe(true);
    expect(http("HTTP/1.1 200 OK\r\nContent-Length: 4", "abc").complete).toBe(false);
    expect(http("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", "3\r\nabc\r\n0\r\n\r\n").complete).toBe(true);
    expect(http("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", "3\r\nabc\r\n").complete).toBe(false);
  });

  it("does not hand on the provider account's state", () => {
    expect(exposedProviderHeader("content-type")).toBe(true);
    expect(exposedProviderHeader("x-venice-balance-usd")).toBe(false);
    expect(exposedProviderHeader("X-Venice-Balance-Diem")).toBe(false);
    expect(exposedProviderHeader("x-ratelimit-remaining-requests")).toBe(false);
    expect(exposedProviderHeader("connection")).toBe(false);
  });
});

describe("pins never override the caller", () => {
  it("refuses a private key a variant pins", () => {
    // Shape checks keep such a pin out of a verified offer; the planner refuses it too.
    const images = {
      max_count: 4,
      count_key: "variants",
      fixed_pins: [] as [string, unknown][],
      price_list: { m: [{ id: "a", pins: [["aspect_ratio", "1:1"]] as [string, unknown][], msat_per_image: 1 }] },
    };
    expect(() => chooseImageVariant({ model: "m", prompt: "p", aspect_ratio: "16:9" }, images)).toThrow(ConfidentialError);
    expect(chooseImageVariant({ model: "m", prompt: "p" }, images).variant.id).toBe("a");
  });
});
