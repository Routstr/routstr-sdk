import { describe, expect, it, vi } from "vitest";
import {
  OPENAI_JSON_BODY_PATHS,
  isOpenAiJsonBodyPath,
} from "../../utils/openAiEndpoints";
import { RoutstrClient } from "../../client/RoutstrClient";

/**
 * Run real request preparation up to the transport boundary and return the
 * body that would have gone upstream. Mirrors the harness in
 * routstrClient.headers.test.ts.
 */
async function prepare(path: string, body: unknown) {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = "xcashu";
  client._checkBalance = vi.fn().mockResolvedValue(undefined);
  client._log = vi.fn();
  client.providerManager = { getModelForProvider: vi.fn().mockResolvedValue(null) };
  client._spendToken = vi.fn().mockResolvedValue({
    token: "sdk-payment", tokenBalance: 1, tokenBalanceUnit: "sat",
  });
  client._spinOffTopupIfNeeded = vi.fn();
  const stop = new Error("transport boundary reached");
  client._makeRequest = vi.fn().mockRejectedValue(stop);

  await expect(client.routeRequest({
    path, method: "POST", body,
    modelId: "jev-latest", baseUrl: "https://node.example/",
    mintUrl: "https://mint.example/", headers: {},
  })).rejects.toBe(stop);

  return client._makeRequest.mock.calls[0][0].body as Record<string, unknown>;
}

const SYSTEMONE_BODY = {
  state: "Help! My payouts have been failing for 3 days.",
  model: "jev-latest",
  questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
};

describe("isOpenAiJsonBodyPath", () => {
  it("accepts OpenAI-compatible endpoints, with or without a prefix/query/slash", () => {
    for (const suffix of OPENAI_JSON_BODY_PATHS) {
      expect(isOpenAiJsonBodyPath(`/v1${suffix}`)).toBe(true);
      expect(isOpenAiJsonBodyPath(suffix)).toBe(true);
      expect(isOpenAiJsonBodyPath(`/proxy/openai/v1${suffix}?trace=1`)).toBe(true);
      expect(isOpenAiJsonBodyPath(`/v1${suffix}/`)).toBe(true);
    }
  });

  it("rejects endpoints that do not define the OpenAI request vocabulary", () => {
    for (const path of [
      "/v1/systemone",
      "/systemone",
      "/v1/embeddings",
      "/v1/audio/speech",
      "/v1/messages",
      "/v1/responsesXYZ",
    ]) {
      expect(isOpenAiJsonBodyPath(path)).toBe(false);
    }
  });
});

describe("no chat-completions fields on non-chat endpoints", () => {
  it("does not add stream to a TypeSafe System One body", async () => {
    const body = await prepare("/v1/systemone", { ...SYSTEMONE_BODY });
    expect(body).not.toHaveProperty("stream");
    expect(body).toEqual(SYSTEMONE_BODY);
  });

  it("still defaults stream to false on chat/completions", async () => {
    const body = await prepare("/v1/chat/completions", {
      model: "glm-5.3-flash", messages: [],
    });
    expect(body.stream).toBe(false);
  });

  it("preserves an explicit stream flag on chat/completions", async () => {
    const body = await prepare("/v1/chat/completions", {
      model: "glm-5.3-flash", messages: [], stream: true,
    });
    expect(body.stream).toBe(true);
  });
});
