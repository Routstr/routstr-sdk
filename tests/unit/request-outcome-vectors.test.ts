/**
 * The node's signed request outcome against what the client saw
 * (`requestOutcomeProblems`, PROTOCOL-V3.md §12.9, §12.10), on the vectors
 * shared with the reference client and the browser library:
 * `fixtures/request-outcome-vectors.json`, a byte-identical copy of
 * routstr-confidential `crypto/conformance/request-outcome-vectors.json`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUEST_OUTCOME_RULES, requestOutcomeProblems } from "../../client/confidential/receipt";

const doc = JSON.parse(readFileSync(new URL("./fixtures/request-outcome-vectors.json", import.meta.url), "utf8")) as {
  rules: Record<string, unknown>;
  cases: { name: string; outcome: unknown; signed: boolean; ctx: any; ok: boolean; match?: string }[];
};

describe("request outcome vectors", () => {
  it("the per-reason table is the node's", () => {
    expect(REQUEST_OUTCOME_RULES).toEqual(doc.rules);
  });
  for (const v of doc.cases) {
    it(v.name, () => {
      const p = requestOutcomeProblems(v.outcome, v.signed, v.ctx);
      if (v.ok) expect(p).toEqual([]);
      else expect(p.some((x) => x.includes(v.match!)), JSON.stringify(p)).toBe(true);
    });
  }
});
