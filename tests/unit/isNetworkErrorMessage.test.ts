/**
 * Tests for isNetworkErrorMessage().
 *
 * Bug: Bun's native connection-failure messages ("Unable to connect. Is the
 * computer able to access the url?" and "Was there a typo in the url or
 * port?") were missing from the allowlist, so _makeRequest re-threw the error
 * instead of routing it through _handleErrorResponse → markFailed +
 * findNextBestProvider failover. Result: a request whose cheapest provider is
 * completely unreachable surfaced as a raw 500 instead of failing over.
 *
 * Fix: add the two Bun substrings to the allowlist in wallet/tokenUtils.ts.
 */

import { describe, expect, it } from "vitest";
import {
  isNetworkErrorCode,
  isNetworkErrorMessage,
  isTransientSocketErrorCode,
  isTransientSocketErrorMessage,
} from "../../wallet/tokenUtils";

describe("isNetworkErrorMessage", () => {
  it("treats Bun's 'Unable to connect' message as a network error", () => {
    expect(
      isNetworkErrorMessage("Unable to connect. Is the computer able to access the url?")
    ).toBe(true);
  });

  it("treats Bun's 'Was there a typo' message as a network error", () => {
    expect(
      isNetworkErrorMessage("Was there a typo in the url or port?")
    ).toBe(true);
  });

  it("treats Bun's socket-reset message as a network error", () => {
    // The message Bun's fetch throws when a provider kills the connection
    // mid-request. Missing from the allowlist, a request whose cheapest
    // provider reset the socket surfaced as a raw 500 instead of failing over.
    expect(
      isNetworkErrorMessage(
        "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
      )
    ).toBe(true);
    expect(
      isNetworkErrorMessage("The socket connection was closed unexpectedly.")
    ).toBe(true);
  });

  it("treats node/undici socket failures as network errors", () => {
    expect(isNetworkErrorMessage("fetch failed")).toBe(true);
    expect(isNetworkErrorMessage("socket hang up")).toBe(true);
    expect(isNetworkErrorMessage("read ECONNRESET")).toBe(true);
    expect(isNetworkErrorMessage("write EPIPE")).toBe(true);
    expect(isNetworkErrorMessage("other side closed (UND_ERR_SOCKET)")).toBe(true);
    expect(isNetworkErrorMessage("connection reset by peer")).toBe(true);
  });

  it("still recognizes existing browser/Node/TLS error strings", () => {
    expect(isNetworkErrorMessage("NetworkError when attempting to fetch resource")).toBe(true);
    expect(isNetworkErrorMessage("Failed to fetch")).toBe(true);
    expect(isNetworkErrorMessage("Load failed")).toBe(true);
    expect(isNetworkErrorMessage("ERR_TLS_CERT_ALTNAME_INVALID")).toBe(true);
    expect(isNetworkErrorMessage("ERR_TLS_CERT_NOT_YET_VALID")).toBe(true);
    expect(isNetworkErrorMessage("ERR_TLS_CERT_EXPIRED")).toBe(true);
    expect(isNetworkErrorMessage("UNABLE_TO_VERIFY_LEAF_SIGNATURE")).toBe(true);
    expect(isNetworkErrorMessage("SELF_SIGNED_CERT_IN_CHAIN")).toBe(true);
  });

  it("returns false for non-network error messages", () => {
    expect(isNetworkErrorMessage("")).toBe(false);
    expect(isNetworkErrorMessage("HTTP 500 Internal Server Error")).toBe(false);
    expect(isNetworkErrorMessage("Some random application error")).toBe(false);
  });
});

describe("isTransientSocketErrorMessage", () => {
  it("matches failures where an established socket died", () => {
    expect(
      isTransientSocketErrorMessage(
        "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
      )
    ).toBe(true);
    expect(isTransientSocketErrorMessage("socket hang up")).toBe(true);
    expect(isTransientSocketErrorMessage("EPIPE: broken pipe")).toBe(true);
  });

  it("does not match 'never connected' failures (not self-healing)", () => {
    expect(
      isTransientSocketErrorMessage(
        "Unable to connect. Is the computer able to access the url?"
      )
    ).toBe(false);
    expect(isTransientSocketErrorMessage("Was there a typo in the url or port?")).toBe(false);
    expect(isTransientSocketErrorMessage("getaddrinfo ENOTFOUND provider.test")).toBe(false);
    expect(isTransientSocketErrorMessage("ERR_TLS_CERT_EXPIRED")).toBe(false);
    expect(isTransientSocketErrorMessage("HTTP 500 Internal Server Error")).toBe(false);
    expect(isTransientSocketErrorMessage("")).toBe(false);
  });
});

describe("isNetworkErrorCode / isTransientSocketErrorCode", () => {
  it("classifies the structured code Bun attaches to a fetch rejection", () => {
    // Observed on Bun 1.4.4 for a provider that accepted then reset the socket:
    // TypeError { code: "ECONNRESET", message: "ECONNRESET: The socket …" }.
    expect(isNetworkErrorCode("ECONNRESET")).toBe(true);
    expect(isTransientSocketErrorCode("ECONNRESET")).toBe(true);
    expect(isNetworkErrorCode("ECONNREFUSED")).toBe(true);
    expect(isNetworkErrorCode("ENOTFOUND")).toBe(true);
    expect(isNetworkErrorCode("UND_ERR_SOCKET")).toBe(true);
  });

  it("does not treat 'never connected' codes as transient", () => {
    expect(isTransientSocketErrorCode("ECONNREFUSED")).toBe(false);
    expect(isTransientSocketErrorCode("ENOTFOUND")).toBe(false);
    expect(isTransientSocketErrorCode("ETIMEDOUT")).toBe(false);
  });

  it("is case-insensitive and ignores non-string codes", () => {
    expect(isNetworkErrorCode("econnreset")).toBe(true);
    expect(isNetworkErrorCode(undefined)).toBe(false);
    expect(isNetworkErrorCode(42)).toBe(false);
    expect(isNetworkErrorCode("")).toBe(false);
  });
});
