import { afterEach, expect, it, vi } from "vitest";
import { fetchTinfoilPreservingPlaintextErrors, clearTinfoilClientCache } from "../../client/TinfoilSecure";
import { resolveTinfoilOutputCap, withTinfoilOutputCapHeader } from "../../client/TinfoilOutputTokens";

const { encrypt } = vi.hoisted(() => ({
  encrypt: vi.fn(async (request: Request) => ({ request, context: undefined })),
}));

// Keep the actual SDK transport wrapper; replace only attestation and crypto.
vi.mock("tinfoil", () => ({
  SecureClient: class {
    async ready() {}
    getVerificationDocument() { return { hpkePublicKey: "test-key" }; }
    getBaseURL() { return "https://proxy.example/"; }
    getEnclaveURL() { return "https://enclave.example/"; }
  },
}));
vi.mock("ehbp", () => ({
  Identity: { fromPublicKeyHex: async () => ({ encryptRequestWithContext: encrypt }) },
  PROTOCOL: {},
  decryptResponseWithToken: vi.fn(),
  extractSessionRecoveryToken: vi.fn(),
  KeyConfigMismatchError: class extends Error {},
}));

afterEach(() => {
  clearTinfoilClientCache();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps the prepared cap and count outside the sealed body through the real wrapper", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const body = { max_completion_tokens: 64, messages: [], n: 1 };
  const resolution = resolveTinfoilOutputCap({ path: "/v1/chat/completions", body });
  const headers = withTinfoilOutputCapHeader({ "Content-Type": "application/json" }, resolution);
  await fetchTinfoilPreservingPlaintextErrors(
    { baseUrl: "https://proxy.example/", userCacheSecret: "test-cache-secret" },
    "https://proxy.example/v1/chat/completions",
    { method: "POST", headers, body: JSON.stringify(body) }
  );
  expect(encrypt).toHaveBeenCalledOnce();
  const preSeal = encrypt.mock.calls[0][0];
  expect(preSeal.headers.get("X-Tinfoil-Max-Output-Tokens")).toBe("64");
  expect(preSeal.headers.get("X-Tinfoil-Completion-Count")).toBe("1");
  expect(JSON.parse(await preSeal.clone().text())).toMatchObject(body);
  const outbound = fetch.mock.calls[0][0] as Request;
  expect(outbound.headers.get("X-Tinfoil-Max-Output-Tokens")).toBe("64");
  expect(outbound.headers.get("X-Tinfoil-Completion-Count")).toBe("1");
});
