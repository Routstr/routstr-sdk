import { describe, expect, it, vi } from "vitest";
import { RoutstrClient } from "../../client/RoutstrClient";

const selector = "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=glm-5.3-flash&endpoint=z-ai%2Ffp8";

// Run real request preparation up to the transport boundary, without wallet spend.
async function prepare(headers: Record<string, string>, mode = "xcashu") {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = mode;
  // Object.create skips the constructor, so instance fields are missing;
  // the proactive-topup path reads this map unconditionally.
  client._inflightTopups = new Map();
  client._checkBalance = vi.fn().mockResolvedValue(undefined);
  client._log = vi.fn();
  client.providerManager = { getModelForProvider: vi.fn().mockResolvedValue(null) };
  client._spendToken = vi.fn().mockResolvedValue({
    token: "sdk-payment", tokenBalance: 1, tokenBalanceUnit: "sat",
  });
  // The proactive API-key topup (apikeys mode) is a wallet-spend side effect
  // that is out of scope for header assertions — and this fake client has none
  // of the state a real topup needs. Neutralize it and assert headers only.
  client._topUpIfNeeded = vi.fn();
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

describe("forwarded inference header values", () => {
  // Caller input is untrusted: a non-Latin-1 or CR/LF value makes the runtime's
  // own `Headers` conversion throw a TypeError, which is not a network error,
  // so it would escape the failover path and fail a request that succeeded
  // before these headers were forwarded. Dropping the hint is the fix; the
  // assertions here are all "the request still reaches the transport".
  it.each([
    ["plain id", "session-abc-123"],
    ["latin-1", "caf\u00e9-\u00ff"],
    ["tab", "a\tb"],
    ["percent-encoded", "url=https%3A%2F%2Fopenrouter.ai"],
    ["max sensible length", "s".repeat(120)],
  ])("forwards a %s value unchanged", async (_case, value) => {
    const request = await prepare({ "x-session-id": value });
    expect(request.baseHeaders["x-session-id"]).toBe(value);
    // The real failure boundary: this is what threw for a CJK session id.
    expect(new Headers(request.headers).get("x-session-id")).toBe(value);
  });

  it.each([
    ["a CJK id", "\u30bb\u30c3\u30b7\u30e7\u30f3"],
    ["an astral emoji", "\ud83d\ude00"],
    ["a carriage return", "a\rb"],
    ["a newline", "a\nb"],
    ["a NUL", "a\u0000b"],
    ["an empty value", ""],
  ])("drops %s instead of failing the request", async (_case, value) => {
    // `prepare` rejects with its transport-boundary sentinel: reaching the
    // transport at all is the assertion, since the throw happened earlier.
    const request = await prepare({ "x-session-id": value });
    expect(request.baseHeaders).not.toHaveProperty("x-session-id");
    expect(new Headers(request.headers).has("x-session-id")).toBe(false);
    // An unusable hint must not take the other hints down with it.
    expect(new Headers(request.headers).get("content-type")).toBe(
      "application/json"
    );
  });

  it("drops only the unusable alias, keeping the rest", async () => {
    const request = await prepare({
      "x-session-id": "\u30bb\u30c3\u30b7\u30e7\u30f3",
      "session-id": "plain-alias",
      "x-client-request-id": "request-1",
    });
    expect(new Headers(request.headers).has("x-session-id")).toBe(false);
    expect(request.baseHeaders["session-id"]).toBe("plain-alias");
    expect(request.baseHeaders["x-client-request-id"]).toBe("request-1");
  });

  it("keeps distinct alias spellings as separate headers", async () => {
    // The caller picked the spelling and the node applies its own precedence;
    // collapsing here would silently overrule it.
    const request = await prepare({
      "x-session-id": "a", "session-id": "b", session_id: "c",
    });
    expect(request.baseHeaders["x-session-id"]).toBe("a");
    expect(request.baseHeaders["session-id"]).toBe("b");
    expect(request.baseHeaders["session_id"]).toBe("c");
  });

  it("names the dropped header in a warning", async () => {
    const client = Object.create(RoutstrClient.prototype) as any;
    client.mode = "xcashu";
    client._inflightTopups = new Map();
    client._checkBalance = vi.fn().mockResolvedValue(undefined);
    client.debugLevel = "WARN";
    client.logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    client.providerManager = { getModelForProvider: vi.fn().mockResolvedValue(null) };
    client._spendToken = vi.fn().mockResolvedValue({
      token: "sdk-payment", tokenBalance: 1, tokenBalanceUnit: "sat",
    });
    client._topUpIfNeeded = vi.fn();
    client._makeRequest = vi.fn().mockRejectedValue(new Error("stop"));

    await expect(client.routeRequest({
      path: "/v1/chat/completions", method: "POST",
      body: { model: "glm-5.3-flash", messages: [] },
      modelId: "glm-5.3-flash", baseUrl: "https://core.example/",
      mintUrl: "https://mint.example/",
      headers: { "x-session-id": "\u30bb\u30c3\u30b7\u30e7\u30f3" },
    })).rejects.toThrow("stop");

    expect(client.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("x-session-id")
    );
  });
});
