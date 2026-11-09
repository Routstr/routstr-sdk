/**
 * The funds rule pre-warming shares with the API-key top-up (no Node
 * imports: `RoutstrClient` is part of the browser-safe bundle).
 *
 * The pool arms a session for a key only while the key's available balance
 * (the node's balance minus every reservation, armed sessions included) is at
 * least `fundsHeadroom` × R, R being the reservation of one session. The
 * top-up has to keep the key above that line, or the pool never arms: it
 * would otherwise refill only to `TOPUP_MARGIN` × R.
 */

/** Default `fundsHeadroom`: the new arm plus one cold request. */
export const PREWARM_FUNDS_HEADROOM = 2;

/** The pre-warm settings the top-up looks at. */
export interface PrewarmFundsOptions {
  enabled?: boolean;
  fundsHeadroom?: number;
}

/** The `fundsHeadroom` in effect (a non-finite or negative value: the default). */
export function prewarmFundsHeadroom(prewarm: PrewarmFundsOptions | undefined): number {
  const h = prewarm?.fundsHeadroom;
  return typeof h === "number" && Number.isFinite(h) && h >= 0 ? h : PREWARM_FUNDS_HEADROOM;
}

/**
 * The multiple of a request's price the proactive top-up keeps available on
 * a key. Without pre-warming it is `topupMargin`. With pre-warming the pool
 * needs `fundsHeadroom` × R available after every armed session's
 * reservation, so the top-up keeps `fundsHeadroom` × R plus the margin the
 * request itself spends from (`topupMargin` − 1) × R. Because the available
 * balance already excludes the armed sessions, the key's balance grows with
 * the number of armed sessions, which `maxPerKey` / `maxTotal` bound.
 */
export function prewarmTopupFactor(
  prewarm: PrewarmFundsOptions | undefined,
  topupMargin: number,
): number {
  if (prewarm === undefined || prewarm.enabled === false) return topupMargin;
  return Math.max(topupMargin, prewarmFundsHeadroom(prewarm) + topupMargin - 1);
}
