import { describe, expect, it, vi } from "vitest";
import {
  TokenAlreadySpentError,
  parseCoreError,
  CoreErrorType,
  CoreErrorCode,
} from "../../core";

describe("TokenAlreadySpentError", () => {
  it("constructs with default message", () => {
    const err = new TokenAlreadySpentError({
      baseUrl: "https://provider.example.com",
    });

    expect(err.name).toBe("TokenAlreadySpentError");
    expect(err.message).toBe(
      "Cashu token already spent — do not retry with the same token"
    );
    expect(err.baseUrl).toBe("https://provider.example.com");
    expect(err.statusCode).toBe(400);
  });

  it("constructs with parsed error message", () => {
    const body = JSON.stringify({
      error: {
        type: "token_already_spent",
        message: "Cashu token already spent",
        code: "cashu_token_already_spent",
      },
      request_id: "req-123",
    });
    const parsed = parseCoreError(body, 400, "req-123");

    const err = new TokenAlreadySpentError({
      baseUrl: "https://provider.example.com",
      mintUrl: "https://mint.example.com",
      statusCode: 400,
      parsedError: parsed,
      requestId: "req-123",
    });

    expect(err.message).toBe("Cashu token already spent");
    expect(err.mintUrl).toBe("https://mint.example.com");
    expect(err.statusCode).toBe(400);
    expect(err.requestId).toBe("req-123");
    expect(err.parsedError?.type).toBe(CoreErrorType.TOKEN_ALREADY_SPENT);
  });

  it("constructs with custom message", () => {
    const err = new TokenAlreadySpentError({
      baseUrl: "https://provider.example.com",
      message: "Custom spent message",
    });

    expect(err.message).toBe("Custom spent message");
  });

  it("is an Error instance", () => {
    const err = new TokenAlreadySpentError({
      baseUrl: "https://provider.example.com",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TokenAlreadySpentError);
  });
});
