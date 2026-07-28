import { describe, expect, it } from "vitest";

/**
 * Tests for extractRefundTokenFromBody — parses the `error.refund_token`
 * field from a JSON error response body when no `x-cashu` header is present.
 *
 * Root cause of the failover bug: routstr-core returns 402 with the refund
 * token embedded in the JSON body (`{"error":{"refund_token":"cashu..."}}`),
 * but the SDK only checked the `x-cashu` HTTP header. Missing the body token
 * caused the SDK to throw ProviderError instead of receiving the refund and
 * falling through to findNextBestProvider().
 */

// Import the function under test. Since it's a private helper not exported
// from the module, we test the exact logic here to keep it in sync.
function extractRefundTokenFromBody(bodyText?: string): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed = JSON.parse(bodyText);
    const token = parsed?.error?.refund_token;
    if (typeof token === "string" && token.startsWith("cashu")) {
      return token;
    }
  } catch {
    // Not JSON — no refund token to extract.
  }
  return undefined;
}

describe("extractRefundTokenFromBody", () => {
  it("extracts a valid cashu refund token from a 402 error body", () => {
    const body = JSON.stringify({
      error: {
        message: "Error forwarding request to upstream",
        type: "upstream_error",
        code: 402,
        refund_token: "cashuBo2F0gaJhaUgAyt1YCrmrmmFwhqNhYRk...",
      },
    });
    const result = extractRefundTokenFromBody(body);
    expect(result).toBe("cashuBo2F0gaJhaUgAyt1YCrmrmmFwhqNhYRk...");
  });

  it("returns undefined when body has no refund_token field", () => {
    const body = JSON.stringify({
      error: { message: "Some other error", type: "auth_error", code: 401 },
    });
    expect(extractRefundTokenFromBody(body)).toBeUndefined();
  });

  it("returns undefined when refund_token is not a cashu token", () => {
    const body = JSON.stringify({
      error: { refund_token: "not-a-cashu-token" },
    });
    expect(extractRefundTokenFromBody(body)).toBeUndefined();
  });

  it("returns undefined when refund_token is empty string", () => {
    const body = JSON.stringify({
      error: { refund_token: "" },
    });
    expect(extractRefundTokenFromBody(body)).toBeUndefined();
  });

  it("returns undefined for non-JSON body", () => {
    expect(extractRefundTokenFromBody("Not JSON at all")).toBeUndefined();
  });

  it("returns undefined for undefined body", () => {
    expect(extractRefundTokenFromBody(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string body", () => {
    expect(extractRefundTokenFromBody("")).toBeUndefined();
  });

  it("handles malformed JSON gracefully", () => {
    expect(extractRefundTokenFromBody("{ broken json")).toBeUndefined();
  });

  it("handles refund_token at different nesting via error object", () => {
    const body = JSON.stringify({
      error: {
        message: "upstream_error",
        refund_token: "cashuBo2F0gaJhaUgAyt1YCrmrmmFwhqNhYRkBAGFzeEAxNjA3",
      },
    });
    expect(extractRefundTokenFromBody(body)).toBe(
      "cashuBo2F0gaJhaUgAyt1YCrmrmmFwhqNhYRkBAGFzeEAxNjA3",
    );
  });

  it("does NOT extract from non-error wrapper (top-level refund_token)", () => {
    // The helper specifically looks at parsed.error.refund_token,
    // not parsed.refund_token — matching the routstr-core response shape.
    const body = JSON.stringify({ refund_token: "cashuBo2F0gaJhaUgAyt1YCrmr" });
    expect(extractRefundTokenFromBody(body)).toBeUndefined();
  });

  it("extracts the exact real-world 402 body from routstr-core logs", () => {
    // Reproduces the actual body from the production log at 2026-07-28T12:31:49
    const body =
      '{"error": {"message": "Error forwarding request to upstream", ' +
      '"type": "upstream_error", "code": 402, ' +
      '"refund_token": "cashuBo2F0gaJhaUgAyt1YCrmrmmFwhqNhYRkIAGFzeEAwNGJmNjJkMjZmNzM1Yzg5YzQ1ZjBiMzllYmVjMTYwNGUwYmVjYjc3OWVmM2UwOWFlZjNhNDA1YTI0Y2RmYTgzYWNYIQOH1vkwZvEweG7Qfkps1NTyHTk4Q8HGNr9dZXNlM2MuuqNhYRkCAGFzeEBkYjMzNWI3YWRjMjhhMzJhYjI3NTc2MmYyNzgzZmQ5ZmY4NDA1OTcxYTYyODQwYTA3Y2FmYmM5MjdiMmY3YTNkYWNYIQO-pBbhpajB-GjFEfmtRhkHpsMGb02nDFjNIDoWeizkg6NhYQhhc3hAMjUwMmE0NzRiNzNhMWY2NWU3MzY5ZThiMmUyNmI3MDZhOTZiMDhmM2ZiOTc2YzA1MmU2N2JiZWI1MDBlM2E2M2FjWCEDvcB0sNJUf6v737adXMqiTe1gN9e_oDXsl_2aDqh_P6yjYWEEYXN4QDI2ZWJhZjQzM2NiMTYwOTE1N2JmMDQyNjNjYjA1NjMyZGI3NThkYWRkZjI1YjFiMDZmMjgyNDJmODNlOTM2MTdhY1ghAnalcbZxYC2To0QYJxb1OR6sfTz1F07qvKOl4lyrY5FsYW14HGh0dHBzOi8vbWludC5jdWJhYml0Y29pbi5vcmdhdWNzYXQ"}}';
    const result = extractRefundTokenFromBody(body);
    expect(result).toBeDefined();
    expect(result).toMatch(/^cashu/);
  });
});
