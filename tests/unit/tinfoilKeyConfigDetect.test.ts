/**
 * Tests for the broadened EHBP key-config mismatch detection.
 *
 * The proxy wraps upstream 422 problem+json responses into its own
 * application/json error envelope. The SDK must still detect the key-config
 * signature in the wrapped body to trigger re-attestation.
 */

import { describe, it, expect } from "vitest";

// We test the detection logic indirectly through the exported types and
// behavior.  Since isEhbpKeyConfigMismatchResponse is not exported, we
// replicate the test against the ehbp module's PROTOCOL constants and
// verify the detection contract.

const KEY_CONFIG_PROBLEM_TYPE = "urn:ietf:params:ehbp:error:key-config";

function isProblemJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/problem+json";
}

/**
 * Mirror of the updated isEhbpKeyConfigMismatchResponse logic.
 * Must stay in sync with client/TinfoilSecure.ts.
 */
async function isEhbpKeyConfigMismatchResponse(
  status: number,
  contentType: string | null,
  body: string,
  protocolKeyConfigType: string,
): Promise<boolean> {
  if (status !== 422) {
    return false;
  }

  // Primary: problem+json with the exact URN
  if (isProblemJsonContentType(contentType)) {
    try {
      const problem = JSON.parse(body);
      if (problem?.type === protocolKeyConfigType) {
        return true;
      }
    } catch {
      // Fall through
    }
  }

  // Secondary: any body containing the URN or canonical title
  return (
    body.includes(protocolKeyConfigType) ||
    body.includes("failed to read decrypted request body")
  );
}

describe("isEhbpKeyConfigMismatchResponse", () => {
  it("detects enclave-native problem+json key-config 422", async () => {
    const body = JSON.stringify({
      type: KEY_CONFIG_PROBLEM_TYPE,
      title: "failed to read decrypted request body",
    });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/problem+json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(true);
  });

  it("detects problem+json with charset suffix", async () => {
    const body = JSON.stringify({ type: KEY_CONFIG_PROBLEM_TYPE });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/problem+json; charset=utf-8",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(true);
  });

  it("detects proxy-wrapped application/json containing the URN", async () => {
    // This is what routstr-core's create_upstream_error_response produces
    const body = JSON.stringify({
      error: {
        message: `EHBP upstream tinfoil returned 422 for model glm-5-3-flash: {"type":"${KEY_CONFIG_PROBLEM_TYPE}","title":"failed to read decrypted request body"}`,
        type: "upstream_error",
        code: 422,
      },
      request_id: "abc-123",
    });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(true);
  });

  it("detects proxy-wrapped application/json with only the title", async () => {
    const body = JSON.stringify({
      error: {
        message:
          'EHBP upstream tinfoil returned 422: {"title":"failed to read decrypted request body"}',
        type: "upstream_error",
        code: 422,
      },
    });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(true);
  });

  it("does NOT match non-422 status", async () => {
    const body = JSON.stringify({
      type: KEY_CONFIG_PROBLEM_TYPE,
      title: "failed to read decrypted request body",
    });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        400,
        "application/problem+json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(false);
    expect(
      await isEhbpKeyConfigMismatchResponse(
        500,
        "application/problem+json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(false);
  });

  it("does NOT match 422 with different problem type", async () => {
    const body = JSON.stringify({
      type: "urn:ietf:params:ehbp:error:other",
      title: "some other error",
    });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/problem+json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(false);
  });

  it("does NOT match 422 application/json with unrelated error", async () => {
    const body = JSON.stringify({
      error: {
        message: "Insufficient balance",
        type: "payment_required",
        code: 402,
      },
    });
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/json",
        body,
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(false);
  });

  it("does NOT match empty body", async () => {
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/problem+json",
        "",
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(false);
  });

  it("does NOT match invalid JSON in problem+json", async () => {
    expect(
      await isEhbpKeyConfigMismatchResponse(
        422,
        "application/problem+json",
        "not json at all",
        KEY_CONFIG_PROBLEM_TYPE,
      ),
    ).toBe(false);
  });
});
