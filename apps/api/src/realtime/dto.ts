import { maskName, minNextBid } from '@auction/shared';
import type { lots } from '../db/schema.js';

type LotRow = typeof lots.$inferSelect;

/** Statuses whose lot page (and therefore live feed) is public. Everything else is invisible to sockets. */
export const LIVE_STATUSES: readonly string[] = ['active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed'];

/**
 * Public live state of a lot. `seq` orders updates: a client applies an update only if `seq` is not lower than
 * the one it already holds (equal is allowed: closing changes status without a new bid), so a late or replayed
 * message can never show a stale price. `serverTime` lets the client correct its clock (invariant 10).
 * Explicit mapper: reservePrice, leader and maxima are never included.
 */
export interface LotLiveDto {
  lotId: string;
  seq: number;
  status: string;
  currentPrice: number;
  bidCount: number;
  minNextBid: number;
  endsAt: string | null;
  serverTime: string;
}

export interface LiveBidDto {
  seq: number;
  bidder: string;
  own: boolean;
  priceAfter: number;
  auto: boolean;
  createdAt: string;
}

/** Private notification, delivered to the outbid user's room only. */
export interface OutbidDto {
  lotId: string;
  seq: number;
  currentPrice: number;
  minNextBid: number;
}

export function toLiveDto(lot: LotRow, now: Date): LotLiveDto {
  return {
    lotId: lot.id,
    seq: lot.lastSeq,
    status: lot.status,
    currentPrice: lot.currentPrice,
    bidCount: lot.bidCount,
    minNextBid: minNextBid({ startPrice: lot.startPrice, currentPrice: lot.currentPrice, bidCount: lot.bidCount }),
    endsAt: lot.endsAt?.toISOString() ?? null,
    serverTime: now.toISOString(),
  };
}

export function toOutbidDto(lot: LotRow): OutbidDto {
  return {
    lotId: lot.id,
    seq: lot.lastSeq,
    currentPrice: lot.currentPrice,
    minNextBid: minNextBid({ startPrice: lot.startPrice, currentPrice: lot.currentPrice, bidCount: lot.bidCount }),
  };
}

export function toLiveBid(
  row: { seq: number; userId: string; name: string; priceAfter: number; kind: string; createdAt: Date },
  viewerId: string | null,
): LiveBidDto {
  const own = viewerId === row.userId;
  return {
    seq: row.seq, bidder: own ? row.name : maskName(row.name), own, priceAfter: row.priceAfter,
    auto: row.kind === 'auto', createdAt: row.createdAt.toISOString(),
  };
}
