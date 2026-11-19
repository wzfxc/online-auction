import { z } from 'zod';
import { bidStep, type Kopecks } from './money.js';

/** Payment window for a won lot (hours); used by buy-now and by closing. */
export const PAYMENT_WINDOW_HOURS = 48;

/**
 * `amount` is the bid itself; `maxAmount` is an optional auto-bid ceiling (>= amount).
 * The bidder's effective maximum is `maxAmount ?? amount`.
 */
export const placeBidSchema = z
  .object({
    amount: z.number().int().positive().safe(),
    maxAmount: z.number().int().positive().safe().optional(),
  })
  .refine((v) => v.maxAmount === undefined || v.maxAmount >= v.amount, {
    message: 'maxAmount must be >= amount',
    path: ['maxAmount'],
  });
export type PlaceBidInput = z.infer<typeof placeBidSchema>;

export interface LeaderState {
  userId: string;
  max: Kopecks;
}

export interface LotBidState {
  startPrice: Kopecks;
  currentPrice: Kopecks;
  bidCount: number;
  leader: LeaderState | null;
}

export interface BidRequest {
  userId: string;
  amount: Kopecks;
  max: Kopecks;
}

export interface BidStep {
  userId: string;
  /** Price the lot stood at after this step. */
  priceAfter: Kopecks;
  max: Kopecks;
  kind: 'manual' | 'auto';
  outcome: 'leading' | 'outbid_by_auto';
}

export interface BidResolution {
  leader: LeaderState;
  price: Kopecks;
  /** Bids to record, in sequence order (the bidder's own bid first). */
  steps: BidStep[];
  /** The user that lost the lead because of this bid (their deposit must be released). */
  outbidUserId: string | null;
}

export type BidRejection = 'BID_TOO_LOW' | 'BID_MAX_NOT_HIGHER';

/** Lowest acceptable amount for a bidder who is not the current leader. */
export function minNextBid(s: Pick<LotBidState, 'startPrice' | 'currentPrice' | 'bidCount'>): Kopecks {
  return s.bidCount === 0 ? s.startPrice : s.currentPrice + bidStep(s.currentPrice);
}

/**
 * Pure proxy-bidding resolution. Only the leader's maximum matters, so the outcome depends on the
 * set of maxima and not on the order in which they arrived; equal maxima favour the earlier one (D10).
 */
export function resolveBid(state: LotBidState, bid: BidRequest): BidResolution | { rejected: BidRejection } {
  const { leader } = state;
  if (leader?.userId === bid.userId) {
    if (bid.max <= leader.max) return { rejected: 'BID_MAX_NOT_HIGHER' };
    const price = Math.max(state.currentPrice, bid.amount);
    return {
      leader: { userId: bid.userId, max: bid.max },
      price,
      steps: [{ userId: bid.userId, priceAfter: price, max: bid.max, kind: 'manual', outcome: 'leading' }],
      outbidUserId: null,
    };
  }
  if (bid.amount < minNextBid(state)) return { rejected: 'BID_TOO_LOW' };
  if (!leader) {
    return {
      leader: { userId: bid.userId, max: bid.max },
      price: bid.amount,
      steps: [{ userId: bid.userId, priceAfter: bid.amount, max: bid.max, kind: 'manual', outcome: 'leading' }],
      outbidUserId: null,
    };
  }
  if (bid.max > leader.max) {
    const price = Math.min(bid.max, Math.max(bid.amount, leader.max + bidStep(leader.max)));
    return {
      leader: { userId: bid.userId, max: bid.max },
      price,
      steps: [{ userId: bid.userId, priceAfter: price, max: bid.max, kind: 'manual', outcome: 'leading' }],
      outbidUserId: leader.userId,
    };
  }
  const price = bid.max === leader.max ? leader.max : Math.min(leader.max, bid.max + bidStep(bid.max));
  return {
    leader,
    price,
    steps: [
      { userId: bid.userId, priceAfter: bid.amount, max: bid.max, kind: 'manual', outcome: 'outbid_by_auto' },
      { userId: leader.userId, priceAfter: price, max: leader.max, kind: 'auto', outcome: 'leading' },
    ],
    outbidUserId: bid.userId,
  };
}

/** `first***last` letters; own bids are shown unmasked by the caller (D8). */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length === 0) return '***';
  if (chars.length === 1) return `${chars[0]}***`;
  return `${chars[0]}***${chars[chars.length - 1]}`;
}
