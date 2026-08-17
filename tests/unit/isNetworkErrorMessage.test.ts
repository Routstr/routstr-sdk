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
import { isNetworkErrorMessage } from "../../wallet/tokenUtils";

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
