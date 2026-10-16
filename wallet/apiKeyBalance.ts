/**
 * Provider-facing API-key balances.
 *
 * Reading what a key holds is a `/v1/wallet/info` call that answers in msat,
 * while storage keeps whole sats, the answer may be unusable
 * (`balanceUnknown`), and the key it was read from may have been replaced
 * while the read was in flight. That policy used to be open-coded at every
 * call site, which is how a key created for a deposit could stay stored at
 * zero forever. These helpers are the single place the rules live.
 */

import type { StorageAdapter } from "./interfaces";
import { getBalanceInSats } from "./tokenUtils";

/** A `/v1/wallet/info` read, as `BalanceManager.getTokenBalance` returns it. */
export interface NodeBalanceRead {
  amount: number;
  reserved?: number;
  unit?: "sat" | "msat" | string;
  /** Set when the read failed (network error, non-OK response); `amount` is
   *  then 0, not a real balance, and MUST NOT be used or stored. */
  balanceUnknown?: boolean;
}

/** A balance snapshot in sats. */
export interface BalanceSats {
  balance: number;
  reserved: number;
}

/** The storage surface needed to save a balance onto its key. */
export type ApiKeyBalanceStorage = Pick<
  StorageAdapter,
  "getApiKey" | "updateApiKeyBalance"
>;

/**
 * Convert a provider balance read to sats, or `undefined` when it must not be
 * trusted: a failed read, or a negative amount no provider should report
 * (which would corrupt stored balances and top-up arithmetic).
 *
 * Keeps the msat fraction — round only when storing.
 */
export function apiKeyBalanceSats(
  read: NodeBalanceRead | null | undefined
): BalanceSats | undefined {
  if (!read || read.balanceUnknown) return undefined;
  const balance = getBalanceInSats(read.amount, read.unit);
  const reserved = getBalanceInSats(read.reserved ?? 0, read.unit);
  if (balance < 0 || reserved < 0) return undefined;
  return { balance, reserved };
}

/**
 * Save the balance a provider reported for `key`, and return it in whole sats.
 *
 * No-op (`undefined`) when the read is unusable, or when storage no longer
 * holds `key` — a concurrent request swapped the credential while the read
 * was in flight, so the numbers belong to a key we no longer use. Storage
 * keeps whole sats, so the value is floored: never claim a sat the provider
 * did not report.
 */
export function persistApiKeyBalance(
  storage: ApiKeyBalanceStorage,
  baseUrl: string,
  key: string,
  read: NodeBalanceRead | null | undefined
): BalanceSats | undefined {
  const sats = apiKeyBalanceSats(read);
  if (!sats) return undefined;
  if (storage.getApiKey(baseUrl)?.key !== key) return undefined;
  const persisted = {
    balance: Math.floor(sats.balance),
    reserved: Math.floor(sats.reserved),
  };
  storage.updateApiKeyBalance(baseUrl, persisted.balance, persisted.reserved);
  return persisted;
}
