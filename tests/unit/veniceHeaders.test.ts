import { describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";

async function prepared(headers: Record<string, string>) {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = "xcashu";
  client._checkBalance = vi.fn();
  client._log = vi.fn();
  client.providerManager = {
    getModelForProvider: vi.fn().mockResolvedValue(null),
    getRequiredSatsForModel: vi.fn(() => 1),
  };
  client._spendToken = vi
    .fn()
    .mockResolvedValue({
      token: "sdk-payment",
      tokenBalance: 1,
      tokenBalanceUnit: "sat",
    });
  client._topUpIfNeeded = vi.fn();
  const stop = new Error("transport boundary");
  client._makeRequest = vi.fn().mockRejectedValue(stop);
  const body = {
    model: "e2ee-test",
    stream: true,
    messages: [{ role: "user", content: "ciphertext" }],
  };
  await expect(
    client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body,
      modelId: "e2ee-test",
      baseUrl: "https://core.example/",
      mintUrl: "https://mint.example/",
      headers,
    }),
  ).rejects.toBe(stop);
  return client._makeRequest.mock.calls[0][0];
}

describe("Venice encrypted request headers", () => {
  it("preserves the three protocol headers case-insensitively, including retries", async () => {
    const request = await prepared({
      "X-Venice-TEE-Client-Pub-Key": "client-public",
      "x-venice-tee-model-pub-key": "model-public",
      "X-VENICE-TEE-SIGNING-ALGO": "ecdsa",
      authorization: "Bearer LOCAL-SECRET",
      "x-api-key": "LOCAL-SECRET",
      "x-venice-unrecognized": "untrusted",
      host: "localhost",
    });
    for (const headers of [request.headers, request.baseHeaders]) {
      expect(headers["x-venice-tee-client-pub-key"]).toBe("client-public");
      expect(headers["x-venice-tee-model-pub-key"]).toBe("model-public");
      expect(headers["x-venice-tee-signing-algo"]).toBe("ecdsa");
      expect(JSON.stringify(headers)).not.toContain("LOCAL-SECRET");
      expect(headers["x-venice-unrecognized"]).toBeUndefined();
      expect(headers.host).toBeUndefined();
    }
    expect(request.body.messages[0].content).toBe("ciphertext");
  });
  it("does not add encryption headers for ordinary inference", async () => {
    const request = await prepared({});
    expect(
      Object.keys(request.headers).some((k) => k.startsWith("x-venice-")),
    ).toBe(false);
  });
});
