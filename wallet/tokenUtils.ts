import type { MintSelection } from "../core/types";

/**
 * Transport failures that mean "this provider could not be reached at all",
 * i.e. candidates for marking the provider failed and failing over.
 *
 * This is a substring allowlist over whatever the runtime's fetch throws, so
 * every runtime's spelling has to be listed explicitly:
 * - browser: "NetworkError when attempting to fetch resource", "Load failed"
 * - undici/node: "fetch failed", "Failed to fetch"
 * - Bun: "Unable to connect. …", "Was there a typo in the url or port?",
 *   and — the one that used to slip through —
 *   "ECONNRESET: The socket connection was closed unexpectedly. …"
 *
 * A missing entry is not cosmetic: `RoutstrClient._makeRequest` only routes an
 * error through `_handleErrorResponse` (markFailed + findNextBestProvider)
 * when this returns true, so an unlisted string re-throws and the caller gets
 * a raw 500 for a provider that should simply have been skipped.
 */
export function isNetworkErrorMessage(message: string): boolean {
  return (
    message.includes("NetworkError when attempting to fetch resource") ||
    message.includes("Failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("Load failed") ||
    // Bun runtime connection failures (host down, refused, DNS, bad host/port)
    message.includes("Unable to connect") ||
    message.includes("Was there a typo in the url or port") ||
    // Socket-level failures: a live connection died mid-request. Bun's fetch
    // reports these as "ECONNRESET: The socket connection was closed
    // unexpectedly. …"; node/undici as "socket hang up" / UND_ERR_SOCKET and
    // plain "ECONNRESET" / "EPIPE" system-error text.
    message.includes("The socket connection was closed unexpectedly") ||
    message.includes("socket hang up") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("UND_ERR_SOCKET") ||
    message.includes("connection reset by peer") ||
    message.includes("ERR_TLS_CERT_ALTNAME_INVALID") ||
    message.includes("ERR_TLS_CERT_NOT_YET_VALID") ||
    message.includes("ERR_TLS_CERT_EXPIRED") ||
    message.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") ||
    message.includes("SELF_SIGNED_CERT_IN_CHAIN")
  );
}

/**
 * The subset of {@link isNetworkErrorMessage} where the connection was
 * established and then died, which is the signature of a *transient* failure:
 * the server reused-host race (it closed an idle keep-alive socket at the same
 * moment the client wrote to it), a provider restart, or a mesh/VPN path
 * hiccup. Repeating the exact same request over a fresh connection usually
 * succeeds within milliseconds, so `_makeRequest` retries the same provider
 * once before paying the cost of a cross-provider failover.
 *
 * Deliberately excludes "could not connect at all" errors ("Unable to
 * connect", DNS, TLS, refused): those are not self-healing, so they go
 * straight to failover.
 */
export function isTransientSocketErrorMessage(message: string): boolean {
  return (
    message.includes("The socket connection was closed unexpectedly") ||
    message.includes("socket hang up") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("UND_ERR_SOCKET") ||
    message.includes("connection reset by peer")
  );
}

/**
 * Structured counterpart of {@link isNetworkErrorMessage}.
 *
 * Bun's fetch rejects with a `TypeError` that also carries the system error
 * `code` (`ECONNRESET`, `ECONNREFUSED`, …); undici sets `cause.code`. Matching
 * the code as well as the text keeps the transport classification working if a
 * runtime rewords its message, which is exactly how the original bug (a reset
 * socket skipping failover) went unnoticed.
 */
export function isNetworkErrorCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  return NETWORK_ERROR_CODES.has(code.toUpperCase());
}

/** Structured counterpart of {@link isTransientSocketErrorMessage}. */
export function isTransientSocketErrorCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  return TRANSIENT_SOCKET_ERROR_CODES.has(code.toUpperCase());
}

/** "Could not reach it" codes: fail over, but retrying the same host is futile. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * "The connection existed and died" codes: one same-provider retry first.
 * `ECONNREFUSED`/`ENOTFOUND`/timeouts are deliberately absent — those do not
 * heal by re-sending.
 */
const TRANSIENT_SOCKET_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
]);

/**
 * The single msat→sat converter for balances. Keep the fraction: this value is
 * for arithmetic and comparisons. Use `persistApiKeyBalance` to *store* a
 * balance, since storage keeps whole sats.
 */
export function getBalanceInSats(
  balance: number,
  unit: "sat" | "msat" | string | undefined
): number {
  return unit === "msat" ? balance / 1000 : balance;
}

/**
 * Sats a provider will admit a new request against, from one balance read.
 *
 * routstr-core reports `/v1/wallet/info` as
 * `{"balance": total_balance, "reserved": reserved_balance}`, and
 * `total_balance` is defined as `balance - reserved_balance` (`routstr/core/db.py`).
 * So the `balance` field is already net of everything currently held by
 * in-flight requests: it is the same number `pay_for_request` compares
 * against the request price (`routstr/auth.py`), and it can even be negative
 * when a key is fully reserved. Subtracting `reserved` again would understate
 * the caller's funds by exactly `reserved`, which inflates topups by that
 * amount and makes an affordable request look short.
 *
 * Pinned by the node's own regression test
 * `test_balance_info_matches_chat_available_balance`, added when the field
 * switched from gross to net (core `v0.4.4`, 2026-05-20). Nodes older than
 * that are out of scope for this SDK.
 *
 * `reserved` is kept alongside for diagnostics and storage snapshots only.
 */
export function getAvailableBalanceInSats(
  amount: number,
  unit: "sat" | "msat" | string | undefined
): number {
  return getBalanceInSats(amount, unit);
}

export function getTotalMintBalanceInSats(
  balances: Record<string, number>,
  units: Record<string, "sat" | "msat">
): number {
  let total = 0;
  for (const mintUrl in balances) {
    total += getBalanceInSats(balances[mintUrl], units[mintUrl]);
  }
  return total;
}

export function selectMintWithBalance(
  balances: Record<string, number>,
  units: Record<string, string>,
  amount: number,
  excludeMints: string[] = []
): MintSelection {
  for (const mintUrl in balances) {
    if (excludeMints.includes(mintUrl)) {
      continue;
    }

    const balanceInSats = getBalanceInSats(balances[mintUrl], units[mintUrl]);
    if (balanceInSats >= amount) {
      return { selectedMintUrl: mintUrl, selectedMintBalance: balanceInSats };
    }
  }

  return { selectedMintUrl: null, selectedMintBalance: 0 };
}
