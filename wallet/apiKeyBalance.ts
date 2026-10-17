/**
 * Single writer for API-key balances: a provider read may be unusable
 * (`balanceUnknown`), storage keeps whole sats, and the key may have been
 * replaced while the read was in flight.
 */

import type { BalanceManager } from "./BalanceManager";
import type { StorageAdapter } from "./interfaces";
import { getBalanceInSats } from "./tokenUtils";

/** A `/v1/wallet/info` read, as `BalanceManager.getTokenBalance` returns it.
 *  `amount` is the provider's available balance (`total_balance`), already net
 *  of `reserved`. */
export type BalanceRead = Awaited<
  ReturnType<BalanceManager["getTokenBalance"]>
>;

/** The storage surface needed to save a balance onto its key. */
type ApiKeyStorage = Pick<
  StorageAdapter,
  "getApiKey" | "updateApiKeyBalance"
>;

/**
 * Save the balance a provider reported for `key`, floored to whole sats.
 *
 * Stored `balance` keeps the provider's `amount` verbatim, so it means
 * *available* sats — the same figure the node's admission check uses. Stored
 * `reserved` is a diagnostic snapshot and must never be subtracted from it.
 *
 * Returns the stored values, or `undefined` when nothing was written: the read
 * was unusable, or storage no longer holds `key` (a concurrent request swapped
 * the credential, so the numbers belong to a key we no longer use).
 */
export function persistApiKeyBalance(
  storage: ApiKeyStorage,
  baseUrl: string,
  key: string,
  read: BalanceRead | null | undefined
): { balance: number; reserved: number } | undefined {
  if (
    !read ||
    read.balanceUnknown ||
    read.amount < 0 ||
    read.reserved < 0
  ) {
    return undefined;
  }
  if (storage.getApiKey(baseUrl)?.key !== key) return undefined;
  const balance = Math.floor(getBalanceInSats(read.amount, read.unit));
  const reserved = Math.floor(getBalanceInSats(read.reserved, read.unit));
  storage.updateApiKeyBalance(baseUrl, balance, reserved);
  return { balance, reserved };
}
