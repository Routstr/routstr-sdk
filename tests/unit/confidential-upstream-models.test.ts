/**
 * Models whose public id is not the provider's own (an `org/` prefix): the
 * signed offer lists the pair in `upstream_models`, the request and the price
 * list name the public id, the chat suffix pins the provider's id, and the
 * receipt names both (PROTOCOL-V3.md §12.1, §12.8).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { closeConfidentialConnections, fetchConfidential } from "../../client/confidential/transport";
import { pinnedModelId, upstreamModelsProblem, validateOfferShape } from "../../client/confidential/offer";
import { ConfidentialConnection, type ConnectionRequestOptions } from "../../client/confidential/connection";
import { canonicalSuffix } from "../../client/confidential/suffix";
import { ReceiptVerificationError } from "../../client/confidential/errors";
import { BOTH, NODE_PUB, fakeConnections, mockNodeOffer, restoreFetch, v3OfferFields } from "./fixtures/v3";
import { VENICE_CHAT } from "./fixtures/chat";

const PUBLIC = "kimi-k3.1-pro";
const PROVIDER = "moonshotai/kimi-k3.1-pro";
const RATES = { in: 1000, cached_in: 1000, out: 1000 };
const MAPPED = {
  ...BOTH,
  price_list: { cheap: RATES, [PUBLIC]: RATES },
  upstream_models: { [PUBLIC]: PROVIDER },
};

let node = 0;
const quiet = { log: () => {} };
const base = { trustedHosts: ["*.venice.ai"], nodePubkeys: [NODE_PUB], http2: quiet };

afterEach(() => {
  vi.restoreAllMocks();
  restoreFetch();
  closeConfidentialConnections();
});

describe("upstream_models", () => {
  it("maps a public id to the provider's and leaves the others", () => {
    expect(pinnedModelId(MAPPED, PUBLIC)).toBe(PROVIDER);
    expect(pinnedModelId(MAPPED, "cheap")).toBe("cheap");
    expect(pinnedModelId({}, "x")).toBe("x");
  });

  it("is validated with the offer", () => {
    const fields = v3OfferFields(MAPPED);
    expect(() => validateOfferShape(fields)).not.toThrow();
    expect(() => validateOfferShape(v3OfferFields(BOTH))).not.toThrow();
    for (const bad of [[], "x", { other: "a/b" }, { cheap: "cheap" }, { cheap: 'a"b' }, { cheap: "a\\b" }, { cheap: "" }, { cheap: "a b" }, { cheap: 7 }]) {
      expect(upstreamModelsProblem({ price_list: MAPPED.price_list, upstream_models: bad })).toBeDefined();
      expect(() => validateOfferShape({ ...fields, upstream_models: bad })).toThrow(/upstream_models/);
    }
    for (const [pub, ok] of [
      ["meta/llama-3.2-1b-instruct", "@cf/meta/llama-3.2-1b-instruct"],
      ["llama-3.2-1b-instruct", "@cf/meta/llama-3.2-1b-instruct"],
      ["kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro"],
      ["lfm-2.5-2.6b:free", "liquid/lfm-2.5-2.6b:free"],
    ]) {
      expect(upstreamModelsProblem({ price_list: { [pub]: RATES }, upstream_models: { [pub]: ok } })).toBeUndefined();
    }
  });

  it("only the provider's prefix may differ: a node cannot pin another model (finding 17)", () => {
    const swap = (pub: string, id: string) =>
      upstreamModelsProblem({ price_list: { [pub]: RATES }, upstream_models: { [pub]: id } });
    // A model swap under the id the client asked (and pays) for.
    expect(swap("claude-opus-4.5", "qwen/qwen3.8-27b")).toMatch(/names another model/);
    // A suffix or a partial name is not a prefix.
    expect(swap("kimi-k3.1-pro", "moonshotai/kimi-k3.1-pro-lite")).toBeDefined();
    expect(swap("kimi-k3.1-pro", "moonshotai/xkimi-k3.1-pro")).toBeDefined();
    expect(swap("lfm-2.5-2.6b:free", "liquid/lfm-2.5-2.6b")).toBeDefined();
    expect(swap("meta/llama-3.2-1b-instruct", "@cf/meta/llama-3.2-3b-instruct")).toBeDefined();
    expect(() =>
      validateOfferShape(v3OfferFields({ ...MAPPED, upstream_models: { [PUBLIC]: "qwen/qwen3.8-27b" } })),
    ).toThrow(/names another model/);
  });

  it("the request names the public id; the body ends with the suffix pinning the provider's", async () => {
    mockNodeOffer(MAPPED);
    const seen: ConnectionRequestOptions[] = [];
    fakeConnections((_conn, _n, opts) => {
      seen.push(opts);
      return {};
    });
    const res = await fetchConfidential({
      baseUrl: `https://um-${++node}.example`,
      body: { model: PUBLIC, messages: [{ role: "user", content: "x" }], max_tokens: 20 },
      bearer: "sk-x",
      options: base,
    });
    expect(res.status).toBe(200);
    expect(seen[0]!.model).toBe(PUBLIC);
    const body = new TextDecoder().decode(seen[0]!.body);
    expect(body.endsWith(canonicalSuffix(VENICE_CHAT, PROVIDER, 20))).toBe(true);
    expect(body).not.toContain(`"model":"${PUBLIC}"`);
  });

  it("a receipt must name the public id and the pinned provider id", () => {
    const check = (ConfidentialConnection.prototype as any).checkPinnedModel as (cur: unknown, receipt: unknown) => void;
    const cur = { model: PUBLIC, offer: MAPPED };
    expect(() => check.call({}, cur, { model: PUBLIC, upstream_model: PROVIDER })).not.toThrow();
    expect(() => check.call({}, cur, { model: PUBLIC })).toThrow(ReceiptVerificationError);
    expect(() => check.call({}, cur, { model: PUBLIC, upstream_model: "moonshotai/other" })).toThrow(ReceiptVerificationError);
    expect(() => check.call({}, cur, { model: PROVIDER, upstream_model: PROVIDER })).toThrow(ReceiptVerificationError);
    // Ids that agree: no upstream_model.
    expect(() => check.call({}, { model: "cheap", offer: MAPPED }, { model: "cheap" })).not.toThrow();
    // Images are keyed by the provider's id already.
    expect(() => check.call({}, { model: PUBLIC, offer: MAPPED, image: {} }, { model: PUBLIC })).not.toThrow();
  });
});
