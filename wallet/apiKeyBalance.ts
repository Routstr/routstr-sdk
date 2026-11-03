/**
 * Single writer for API-key balances: a provider read may be unusable
 * (`balanceUnknown`), storage keeps whole sats, the key may have been
 * replaced while the read was in flight, and an older read may land after a
 * newer one.
 */

import type { BalanceManager } from "./BalanceManager";
import type { StorageAdapter } from "./interfaces";
import { getBalanceInSats } from "./tokenUtils";

/**
 * Order in which balance reads are issued.
 *
 * A read is stamped before its request leaves, because a response is not
 * ordered by when it arrives: accounting behind a paid reply runs off the
 * response path, so two requests on one key can settle in either order and the
 * older read can be the last to write. Ordering the writes by arrival would
 * move the stored snapshot backwards (and drive an unnecessary topup, or hide
 * a needed one).
 *
 * The import direction (`BalanceManager` -> here) is safe: this module's import
 * of `BalanceManager` is type-only and erased at build time.
 */
let balanceReadSeq = 0;

/** Stamp a balance read before it is issued. Monotonic, never reused. */
export function stampBalanceRead(): number {
  balanceReadSeq += 1;
  return balanceReadSeq;
}

/**
 * Highest read stamp already settled per storage adapter and key. The stamp is
 * only meaningful within one client, so the map lives on the adapter rather
 * than in module scope.
 */
const settledReadSeq = new WeakMap<ApiKeyStorage, Map<string, number>>();

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

/** A read as this writer takes it: a hand-built or test-double read need not
 *  carry the stamp, and is then written without the ordering check. */
export type PersistedBalanceRead = Omit<BalanceRead, "readSeq"> & {
  readSeq?: number;
};

/**
 * Save the balance a provider reported for `key`, floored to whole sats.
 *
 * Stored `balance` keeps the provider's `amount` verbatim, so it means
 * *available* sats — the same figure the node's admission check uses. Stored
 * `reserved` is a diagnostic snapshot and must never be subtracted from it.
 *
 * Returns the stored values, or `undefined` when nothing was written: the read
 * was unusable, storage no longer holds `key` (a concurrent request swapped
 * the credential, so the numbers belong to a key we no longer use), or a read
 * issued later has already settled (its figures are newer than this one).
 *
 * Ordering is by `read.readSeq`, not by arrival, so a slow read cannot undo a
 * fast one. A read that carries no stamp (hand-built reads, test doubles) is
 * written as before — ordering needs both sides to be stamped.
 *
 * A negative available figure is one of the unusable reads. It is a real node
 * state (core reports `balance - reserved`, which goes below zero while a key
 * is over-reserved), but a transient one: it clears as in-flight requests
 * settle. The stored snapshot drives the proactive topup trigger, and the last
 * non-negative figure describes that key better than a number that is about to
 * be wrong again, so we skip the write and let the next live read correct it.
 */
export function persistApiKeyBalance(
  storage: ApiKeyStorage,
  baseUrl: string,
  key: string,
  read: PersistedBalanceRead | null | undefined
): { balance: number; reserved: number } | undefined {
  if (!read) return undefined;
  if (storage.getApiKey(baseUrl)?.key !== key) return undefined;

  // Retire older reads whether or not this one is usable: an unusable read is
  // still newer information than one issued before it.
  const seq = read.readSeq;
  let settled = settledReadSeq.get(storage);
  if (!settled) {
    settled = new Map();
    settledReadSeq.set(storage, settled);
  }
  const settledKey = `${baseUrl}\u0000${key}`;
  const newest = settled.get(settledKey);
  if (seq !== undefined && newest !== undefined && seq <= newest) {
    return undefined;
  }
  if (seq !== undefined) settled.set(settledKey, seq);

  if (read.balanceUnknown || read.amount < 0 || read.reserved < 0) {
    return undefined;
  }
  const balance = Math.floor(getBalanceInSats(read.amount, read.unit));
  const reserved = Math.floor(getBalanceInSats(read.reserved, read.unit));
  storage.updateApiKeyBalance(baseUrl, balance, reserved);
  return { balance, reserved };
}
