import { describe, expect, it } from "vitest";
import { redactCredentials } from "../../core/redact";

describe("redactCredentials", () => {
  it.each([
    ["cashuAabc_123-XYZ", "[REDACTED]"],
    ["cashuBabc_123-XYZ", "[REDACTED]"],
    ["CASHUbabc", "[REDACTED]"],
    ["Authorization: Bearer private-key", "Authorization: [REDACTED]"],
    ["bearer\tprivate-key", "[REDACTED]"],
    ["BEARER private-key", "[REDACTED]"],
    ["cashuAone; cashuBtwo; Bearer three", "[REDACTED]; [REDACTED]; [REDACTED]"],
  ])("redacts credential patterns in %s", (message, expected) => {
    expect(redactCredentials(message)).toBe(expected);
  });

  it("redacts known credentials literally, not as regular expressions", () => {
    expect(redactCredentials("key sk-[a].* and refund refund+token", ["sk-[a].*", "refund+token"]))
      .toBe("key [REDACTED] and refund [REDACTED]");
  });

  it("keeps known credential matching case-sensitive", () => {
    expect(redactCredentials("private PRIVATE", ["private"])).toBe("[REDACTED] PRIVATE");
  });

  it("ignores empty, absent and duplicate credentials", () => {
    expect(redactCredentials("key key", [undefined, "", "key", "key"]))
      .toBe("[REDACTED] [REDACTED]");
  });

  it.each(["cashu", "cashuB", "cashuBprivate", "Bearer", "Bearer private"])(
    "does not expose credential payload when a known value is a prefix: %s", (prefix) => {
      const message = prefix.startsWith("cashu") ? "cashuBprivateproof" : "Bearer privatekey";
      expect(redactCredentials(message, [prefix])).toBe("[REDACTED]");
    }
  );

  it("unions overlapping and adjacent matches on original text", () => {
    expect(redactCredentials("abcdefgh", ["abcd", "bcdef", "gh"]))
      .toBe("[REDACTED]");
  });

  it("finds overlapping occurrences of the same credential", () => {
    expect(redactCredentials("ababa", ["aba"])).toBe("[REDACTED]");
  });

  it("never rescans inserted redaction markers", () => {
    expect(redactCredentials("RED and secret", ["RED", "secret", "[REDACTED]"]))
      .toBe("[REDACTED] and [REDACTED]");
  });

  it.each([
    "max_tokens: value is not a valid integer",
    "a no ok y",
    "invalid_request_error invalid_type",
    "Invalid model. See https://docs.example.com/models",
    "See http://docs.example.com/?model=a&key=public",
    "private prompt that must remain visible to its caller",
    "cashu and Bearer",
    "",
  ])("preserves ordinary diagnostics: %s", (message) => {
    expect(redactCredentials(message)).toBe(message);
  });

  it("preserves large diagnostics instead of blanking the whole field", () => {
    const message = "context length exceeded; ".repeat(4000);
    expect(redactCredentials(message)).toBe(message);
    expect(redactCredentials(message + "cashuBsecret")).toBe(message + "[REDACTED]");
  });

  it("redacts many credentials without suppressing the surrounding diagnostic", () => {
    expect(redactCredentials("cashuBsecret; ".repeat(5000) + "context length exceeded"))
      .toBe("[REDACTED]; ".repeat(5000) + "context length exceeded");
  });
});
