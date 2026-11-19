/** Anti-sniping window: a bid this close to the end moves the end to `now + window`. */
export const ANTI_SNIPE_WINDOW_MS = 2 * 60_000;
/** Time the second-chance (and any later) bidder gets to pay. */
export const SECOND_CHANCE_WINDOW_HOURS = 24;

/**
 * New end of an auction after a bid accepted at `now`.
 * Extensions are unlimited; the end never moves earlier.
 */
export function endsAtAfterBid(endsAt: Date, now: Date): Date {
  if (endsAt.getTime() - now.getTime() > ANTI_SNIPE_WINDOW_MS) return endsAt;
  return new Date(Math.max(endsAt.getTime(), now.getTime() + ANTI_SNIPE_WINDOW_MS));
}

export interface SecondChanceCandidate {
  userId: string;
  /** Highest maximum this user ever authorised on the lot. */
  maxAmount: number;
  /** Seq of the first bid that reached that maximum (earlier wins ties, D10). */
  reachedSeq: number;
}

/** Orders bidders for payment offers: higher maximum first, then earlier. */
export function rankCandidates(list: readonly SecondChanceCandidate[]): SecondChanceCandidate[] {
  return [...list].sort((a, b) => b.maxAmount - a.maxAmount || a.reachedSeq - b.reachedSeq);
}
