import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { planImageRequest } from "../../client/confidential/transport";
import { ConfidentialError } from "../../client/confidential/errors";
import type { ConfidentialImagesOffer } from "../../client/confidential/offer";

/**
 * The shared request-splitting vectors. The web library runs the same table
 * (its copy of this file), so a request picks the same variant, count and
 * private keys whichever client sends it.
 */
const doc = JSON.parse(readFileSync(new URL("./fixtures/image-request-vectors.json", import.meta.url), "utf8")) as {
  images: Omit<ConfidentialImagesOffer, "head_template" | "response_shape" | "response_idle_s">;
  cases: {
    name: string;
    body: Record<string, unknown>;
    expect: { error: true } | { variant: string; count: number; private: string[] };
  }[];
};

const images: ConfidentialImagesOffer = {
  head_template: "POST /api/v1/image/generate HTTP/1.1\r\nContent-Length: {LEN}\r\n\r\n",
  response_shape: "venice",
  response_idle_s: 300,
  ...doc.images,
};

/** The keys the caller's private prefix carries (everything before the suffix). */
function privateKeys(body: Uint8Array, suffix: string): string[] {
  const text = new TextDecoder().decode(body);
  expect(text.endsWith(suffix)).toBe(true);
  const head = text.slice(0, text.length - suffix.length);
  return head === "{" ? [] : Object.keys(JSON.parse(head + "}")).sort();
}

describe("shared image request vectors", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      if ("error" in c.expect) {
        expect(() => planImageRequest(c.body, images)).toThrow(ConfidentialError);
        return;
      }
      const plan = planImageRequest(c.body, images);
      expect(plan.variant.id).toBe(c.expect.variant);
      expect(plan.count).toBe(c.expect.count);
      expect(privateKeys(plan.body, plan.suffix)).toEqual(c.expect.private);
    });
  }
});
