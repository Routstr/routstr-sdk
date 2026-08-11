import { describe, expect, it } from "vitest";
import {
  parseCoreError,
  isCoreErrorType,
  shouldFailoverToAnotherMint,
  summarizeCoreError,
  CoreErrorType,
  CoreErrorCode,
} from "../../core/errorTypes";

describe("parseCoreError", () => {
  describe("X-Cashu envelope format (top-level error)", () => {
    it("parses token_already_spent from X-Cashu envelope", () => {
      const body = JSON.stringify({
        error: {
          type: "token_already_spent",
          message: "Cashu token already spent",
          code: "cashu_token_already_spent",
        },
        request_id: "req-abc123",
      });

      const parsed = parseCoreError(body, 400, "req-from-header");

      expect(parsed.type).toBe("token_already_spent");
      expect(parsed.code).toBe("cashu_token_already_spent");
      expect(parsed.message).toBe("Cashu token already spent");
      expect(parsed.status).toBe(400);
      expect(parsed.raw).toBe(false);
      // request_id from body is NOT preferred over header requestId
      // (header requestId is passed in and takes priority)
      expect(parsed.requestId).toBe("req-from-header");
    });

    it("uses request_id from body when no header requestId", () => {
      const body = JSON.stringify({
        error: {
          type: "mint_error",
          message: "Swap fees exceed amount",
          code: "cashu_token_swap_fees_exceed_amount",
        },
        request_id: "req-body-123",
      });

      const parsed = parseCoreError(body, 422);

      expect(parsed.requestId).toBe("req-body-123");
      expect(parsed.type).toBe("mint_error");
    });

    it("parses mint_unreachable with details", () => {
      const body = JSON.stringify({
        error: {
          type: "mint_unreachable",
          message: "Cashu mint is unreachable",
          code: "cashu_mint_unreachable",
          details: { mint_url: "https://mint.example.com" },
        },
      });

      const parsed = parseCoreError(body, 503);

      expect(parsed.type).toBe("mint_unreachable");
      expect(parsed.code).toBe("cashu_mint_unreachable");
      expect(parsed.details).toEqual({ mint_url: "https://mint.example.com" });
      expect(parsed.status).toBe(503);
    });
  });

  describe("Bearer envelope format (detail.error)", () => {
    it("parses token_already_spent from Bearer envelope", () => {
      const body = JSON.stringify({
        detail: {
          error: {
            type: "token_already_spent",
            message: "Cashu token already spent",
            code: "cashu_token_already_spent",
          },
        },
      });

      const parsed = parseCoreError(body, 400);

      expect(parsed.type).toBe("token_already_spent");
      expect(parsed.code).toBe("cashu_token_already_spent");
      expect(parsed.message).toBe("Cashu token already spent");
      expect(parsed.raw).toBe(false);
    });

    it("parses invalid_api_key from Bearer envelope", () => {
      const body = JSON.stringify({
        detail: {
          error: {
            type: "cashu_error",
            code: "invalid_api_key",
            message: "API key proofs already spent",
          },
        },
      });

      const parsed = parseCoreError(body, 401);

      expect(parsed.type).toBe("cashu_error");
      expect(parsed.code).toBe("invalid_api_key");
      expect(parsed.message).toBe("API key proofs already spent");
    });
  });

  describe("plain string detail format (POST /v1/wallet/topup)", () => {
    it("parses plain string detail as message", () => {
      const body = JSON.stringify({
        detail: "Cashu mint is unreachable",
      });

      const parsed = parseCoreError(body, 503);

      expect(parsed.message).toBe("Cashu mint is unreachable");
      expect(parsed.type).toBeUndefined();
      expect(parsed.code).toBeUndefined();
      expect(parsed.raw).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles undefined body", () => {
      const parsed = parseCoreError(undefined, 500);
      expect(parsed.status).toBe(500);
      expect(parsed.raw).toBe(true);
      expect(parsed.type).toBeUndefined();
    });

    it("handles null body", () => {
      const parsed = parseCoreError(null, 400);
      expect(parsed.status).toBe(400);
      expect(parsed.raw).toBe(true);
    });

    it("handles empty string body", () => {
      const parsed = parseCoreError("", 500);
      expect(parsed.status).toBe(500);
      expect(parsed.raw).toBe(true);
    });

    it("handles non-JSON body (plain text)", () => {
      const parsed = parseCoreError("Internal Server Error", 500);
      expect(parsed.message).toBe("Internal Server Error");
      expect(parsed.raw).toBe(true);
      expect(parsed.json).toBe(false);
    });

    it("handles JSON without error/detail fields", () => {
      const parsed = parseCoreError(JSON.stringify({ foo: "bar" }), 400);
      expect(parsed.raw).toBe(true);
      expect(parsed.type).toBeUndefined();
    });

    it("handles detail object with type/code/message directly", () => {
      const body = JSON.stringify({
        detail: {
          type: "mint_error",
          code: "cashu_foreign_mint_swap_failed",
          message: "Foreign mint swap failed",
        },
      });

      const parsed = parseCoreError(body, 422);

      expect(parsed.type).toBe("mint_error");
      expect(parsed.code).toBe("cashu_foreign_mint_swap_failed");
      expect(parsed.message).toBe("Foreign mint swap failed");
      expect(parsed.raw).toBe(false);
    });

    it("handles top-level type/code/message (no error/detail wrapper)", () => {
      const body = JSON.stringify({
        type: "internal_error",
        message: "Something went wrong",
      });

      const parsed = parseCoreError(body, 500);

      expect(parsed.type).toBe("internal_error");
      expect(parsed.message).toBe("Something went wrong");
      expect(parsed.raw).toBe(false);
      expect(parsed.json).toBe(true);
    });
  });
});

describe("isCoreErrorType", () => {
  it("matches when type is equal", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: { type: "token_already_spent", code: "cashu_token_already_spent" },
      }),
      400
    );
    expect(isCoreErrorType(parsed, CoreErrorType.TOKEN_ALREADY_SPENT)).toBe(true);
  });

  it("does not match when type differs", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: { type: "mint_error", code: "cashu_token_swap_fees_exceed_amount" },
      }),
      422
    );
    expect(isCoreErrorType(parsed, CoreErrorType.TOKEN_ALREADY_SPENT)).toBe(false);
  });
});

describe("shouldFailoverToAnotherMint", () => {
  it("returns true for mint_unreachable", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: {
          type: "mint_unreachable",
          code: "cashu_mint_unreachable",
          message: "Mint is down",
        },
      }),
      503
    );
    expect(shouldFailoverToAnotherMint(parsed)).toBe(true);
  });

  it("returns false for token_already_spent", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: {
          type: "token_already_spent",
          code: "cashu_token_already_spent",
        },
      }),
      400
    );
    expect(shouldFailoverToAnotherMint(parsed)).toBe(false);
  });

  it("returns false for mint_error with fee-exceeds-amount code", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: {
          type: "mint_error",
          code: "cashu_token_swap_fees_exceed_amount",
        },
      }),
      422
    );
    expect(shouldFailoverToAnotherMint(parsed)).toBe(false);
  });

  it("returns true for mint_error with foreign-mint-swap-failed code", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: {
          type: "mint_error",
          code: "cashu_foreign_mint_swap_failed",
        },
      }),
      422
    );
    expect(shouldFailoverToAnotherMint(parsed)).toBe(true);
  });

  it("returns false for mint_error without a known code", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: { type: "mint_error", message: "melt failed" },
      }),
      422
    );
    expect(shouldFailoverToAnotherMint(parsed)).toBe(false);
  });

  it("returns false for unknown/raw errors", () => {
    const parsed = parseCoreError("something broke", 500);
    expect(shouldFailoverToAnotherMint(parsed)).toBe(false);
  });
});

describe("summarizeCoreError", () => {
  it("combines type and message", () => {
    const parsed = parseCoreError(
      JSON.stringify({
        error: {
          type: "token_already_spent",
          message: "Cashu token already spent",
          code: "cashu_token_already_spent",
        },
      }),
      400
    );
    expect(summarizeCoreError(parsed)).toBe(
      "token_already_spent: Cashu token already spent"
    );
  });

  it("returns type when no message", () => {
    const parsed = parseCoreError(
      JSON.stringify({ error: { type: "mint_error" } }),
      422
    );
    expect(summarizeCoreError(parsed)).toBe("mint_error");
  });

  it("returns message when no type", () => {
    const parsed = parseCoreError(
      JSON.stringify({ detail: "Mint is unreachable" }),
      503
    );
    expect(summarizeCoreError(parsed)).toBe("Mint is unreachable");
  });

  it("returns HTTP status for raw errors with no fields", () => {
    const parsed = parseCoreError(undefined, 500);
    expect(summarizeCoreError(parsed)).toBe("HTTP 500");
  });

  it("returns 'Unknown error' for completely empty parsed error", () => {
    const parsed = parseCoreError("", undefined);
    expect(summarizeCoreError(parsed)).toBe("Unknown error");
  });
});

describe("CoreErrorCode constants", () => {
  it("has all expected codes", () => {
    expect(CoreErrorCode.TOKEN_ALREADY_SPENT).toBe("cashu_token_already_spent");
    expect(CoreErrorCode.INVALID_CASHU_TOKEN).toBe("invalid_cashu_token");
    expect(CoreErrorCode.CASHU_MINT_UNREACHABLE).toBe("cashu_mint_unreachable");
    expect(CoreErrorCode.INVALID_API_KEY).toBe("invalid_api_key");
  });
});
