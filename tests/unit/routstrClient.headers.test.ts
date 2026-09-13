import { describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";

const selector = "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&provider-id=2&model-id=glm-5.3-flash&endpoint=z-ai%2Ffp8";

// Run real request preparation up to the transport boundary, without wallet spend.
async function prepare(headers: Record<string, string>, mode = "xcashu") {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = mode;
  client._checkBalance = vi.fn().mockResolvedValue(undefined);
  client._log = vi.fn();
  client.providerManager = { getModelForProvider: vi.fn().mockResolvedValue(null) };
  client._spendToken = vi.fn().mockResolvedValue({
    token: "sdk-payment", tokenBalance: 1, tokenBalanceUnit: "sat",
  });
  const stop = new Error("transport boundary reached");
  client._makeRequest = vi.fn().mockRejectedValue(stop);
  await expect(client.routeRequest({
    path: "/v1/chat/completions", method: "POST",
    body: { model: "glm-5.3-flash", messages: [] },
    modelId: "glm-5.3-flash", baseUrl: "https://core.example/",
    mintUrl: "https://mint.example/", clientApiKey: "local-client",
    headers,
  })).rejects.toBe(stop);
  expect(client._makeRequest).toHaveBeenCalledOnce();
  return client._makeRequest.mock.calls[0][0];
}

describe("routed request header allowlist", () => {
  it.each(["x-routstr-model-path", "X-ROUTSTR-MODEL-PATH", "X-Routstr-Model-Path"])(
    "preserves %s unchanged in outgoing and retry base headers", async (name) => {
      const request = await prepare({ [name]: selector });
      expect(request.baseHeaders["x-routstr-model-path"]).toBe(selector);
      expect(new Headers(request.headers).get("x-routstr-model-path")).toBe(selector);
      expect(new Headers(request.headers).get("x-cashu")).toBe("sdk-payment");
    },
  );

  it.each(["xcashu", "apikeys"])("does not forward client credentials or arbitrary headers in %s mode", async (mode) => {
    const request = await prepare({
      "x-routstr-model-path": selector,
      Authorization: "Bearer client-secret", authorization: "Bearer another-secret",
      "X-Cashu": "client-token", cookie: "session=private", host: "localhost:8008",
      "x-routstr-provider": "https://other.example/", "x-custom": "private",
    }, mode);
    expect(request.baseHeaders).toEqual({ "Content-Type": "application/json", "x-routstr-model-path": selector });
    expect(new Headers(request.headers).get(mode === "xcashu" ? "x-cashu" : "authorization"))
      .toBe(mode === "xcashu" ? "sdk-payment" : "Bearer sdk-payment");
    expect(JSON.stringify(request.headers)).not.toMatch(/client-secret|another-secret|client-token|session=private|other\.example|x-custom/);
  });

  it("does not invent a selector when absent", async () => {
    const request = await prepare({});
    expect(new Headers(request.headers).has("x-routstr-model-path")).toBe(false);
  });
});
