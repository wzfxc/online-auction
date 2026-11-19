import { and, desc, eq, lt } from 'drizzle-orm';
import {
  calcFee, maskName, minNextBid, PAYMENT_WINDOW_HOURS, placeBidSchema, resolveBid,
  type BidRejection, type LotBidState,
} from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import { withIdempotency } from '../common/idempotency/idempotency.js';
import type { Db } from '../db/client.js';
import { bidderMaxes, bids, lotEvents, lots, sales, users } from '../db/schema.js';
import type { Tx } from '../ledger/ledger.js';
import { holdDepositForMax, releaseDeposit } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';

const HOUR_MS = 3_600_000;
const MAX_PAGE = 100;
const PUBLIC_BID_STATUSES = ['active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed'];

/** Result of a bid for the bidder. Never carries the reserve price or other bidders' maxima. */
export interface BidResultDto {
  bidId: string;
  lotId: string;
  seq: number;
  status: 'leading' | 'outbid';
  currentPrice: number;
  yourMax: number;
  minNextBid: number;
}

export interface BuyNowResultDto {
  lotId: string;
  saleId: string;
  price: number;
  fee: number;
  payDueAt: string;
}

export interface BidHistoryItemDto {
  seq: number;
  bidder: string;
  own: boolean;
  priceAfter: number;
  auto: boolean;
  createdAt: string;
}

type LotRow = typeof lots.$inferSelect;

export class BidService {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async placeBid(user: Principal, lotId: string, raw: unknown, idempotencyKey: string) {
    const parsed = placeBidSchema.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const input = parsed.data;
    const max = input.maxAmount ?? input.amount;
    return withIdempotency<BidResultDto>(
      this.db,
      { userId: user.id, scope: `bid:${lotId}`, key: idempotencyKey, body: raw },
      async (tx) => {
        const lot = await this.lockBiddable(tx, user, lotId);
        const state = await this.loadState(tx, lot);
        const res = resolveBid(state, { userId: user.id, amount: input.amount, max });
        if ('rejected' in res) throw this.rejection(res.rejected, state);

        await holdDepositForMax(tx, user.id, lotId, max);
        const now = this.clock.now();
        let seq = lot.lastSeq;
        let ownBid: { id: string; seq: number } | null = null;
        for (const step of res.steps) {
          seq += 1;
          const [row] = await tx.insert(bids).values({
            lotId, userId: step.userId, seq, priceAfter: step.priceAfter, maxAmount: step.max,
            kind: step.kind, outcome: step.outcome, createdAt: now,
          }).returning({ id: bids.id });
          await tx.insert(lotEvents).values({
            lotId, actorId: step.userId, type: 'bid', createdAt: now,
            payload: { seq, priceAfter: step.priceAfter, auto: step.kind === 'auto' },
          });
          if (step.userId === user.id && ownBid === null) ownBid = { id: row!.id, seq };
        }

        const leaderChanged = state.leader?.userId !== res.leader.userId || state.leader.max !== res.leader.max;
        if (leaderChanged) {
          await tx.insert(bidderMaxes).values({
            lotId, userId: res.leader.userId, maxAmount: res.leader.max, reachedAt: now, reachedSeq: seq,
          }).onConflictDoUpdate({
            target: [bidderMaxes.lotId, bidderMaxes.userId],
            set: { maxAmount: res.leader.max, reachedAt: now, reachedSeq: seq },
          });
        }
        if (res.outbidUserId !== null) {
          // D2: the outbid bidder's deposit is released in the same transaction.
          await tx.delete(bidderMaxes).where(and(eq(bidderMaxes.lotId, lotId), eq(bidderMaxes.userId, res.outbidUserId)));
          await releaseDeposit(tx, res.outbidUserId, lotId, now);
        }
        await tx.update(lots).set({
          currentPrice: res.price, bidCount: lot.bidCount + res.steps.length, leaderId: res.leader.userId,
          lastSeq: seq, updatedAt: now,
        }).where(eq(lots.id, lotId));

        const body: BidResultDto = {
          bidId: ownBid!.id, lotId, seq: ownBid!.seq,
          status: res.leader.userId === user.id ? 'leading' : 'outbid',
          currentPrice: res.price, yourMax: max,
          minNextBid: minNextBid({ startPrice: lot.startPrice, currentPrice: res.price, bidCount: lot.bidCount + res.steps.length }),
        };
        return { status: 201, body };
      },
    );
  }

  /** Buy-now is possible only before the first bid; it races with bids on the same lot row lock (invariant 5). */
  async buyNow(user: Principal, lotId: string, idempotencyKey: string) {
    return withIdempotency<BuyNowResultDto>(
      this.db,
      { userId: user.id, scope: `buynow:${lotId}`, key: idempotencyKey, body: { lotId } },
      async (tx) => {
        const lot = await this.lockBiddable(tx, user, lotId);
        if (lot.buyNowPrice === null || lot.bidCount > 0) {
          throw Errors.conflict('BUY_NOW_UNAVAILABLE', 'Buy now is not available for this lot');
        }
        const now = this.clock.now();
        const price = lot.buyNowPrice;
        const fee = calcFee(price);
        const payDueAt = new Date(now.getTime() + PAYMENT_WINDOW_HOURS * HOUR_MS);
        const seq = lot.lastSeq + 1;
        await tx.insert(bids).values({
          lotId, userId: user.id, seq, priceAfter: price, maxAmount: price, kind: 'manual',
          outcome: 'bought_now', createdAt: now,
        });
        const [sale] = await tx.insert(sales).values({
          lotId, buyerId: user.id, attempt: 1, price, fee, payDueAt, createdAt: now,
        }).returning({ id: sales.id });
        await tx.update(lots).set({
          status: 'awaiting_payment', currentPrice: price, bidCount: 1, leaderId: user.id,
          lastSeq: seq, updatedAt: now,
        }).where(eq(lots.id, lotId));
        await tx.insert(lotEvents).values({
          lotId, actorId: user.id, type: 'buy_now', createdAt: now, payload: { seq, price },
        });
        return { status: 201, body: { lotId, saleId: sale!.id, price, fee, payDueAt: payDueAt.toISOString() } };
      },
    );
  }

  /** Public bid history, newest first, keyset-paginated by seq. Maxima are never exposed; names are masked (D8). */
  async history(viewer: Principal | null, lotId: string, opts: { beforeSeq?: number; limit?: number } = {}) {
    const [lot] = await this.db.select({ status: lots.status }).from(lots).where(eq(lots.id, lotId));
    if (!lot || !PUBLIC_BID_STATUSES.includes(lot.status)) throw Errors.notFound('Lot');
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_PAGE);
    const where = opts.beforeSeq === undefined
      ? eq(bids.lotId, lotId)
      : and(eq(bids.lotId, lotId), lt(bids.seq, opts.beforeSeq));
    const rows = await this.db
      .select({
        seq: bids.seq, userId: bids.userId, priceAfter: bids.priceAfter, kind: bids.kind,
        createdAt: bids.createdAt, name: users.displayName,
      })
      .from(bids).innerJoin(users, eq(users.id, bids.userId))
      .where(where).orderBy(desc(bids.seq)).limit(limit);
    const items: BidHistoryItemDto[] = rows.map((r) => {
      const own = viewer?.id === r.userId;
      return {
        seq: r.seq, bidder: own ? r.name : maskName(r.name), own, priceAfter: r.priceAfter,
        auto: r.kind === 'auto', createdAt: r.createdAt.toISOString(),
      };
    });
    return { items, nextBeforeSeq: items.length === limit ? items[items.length - 1]!.seq : null };
  }

  /** Locks the lot and checks it may take bids right now, by the server clock (invariant 3). */
  private async lockBiddable(tx: Tx, user: Principal, lotId: string): Promise<LotRow> {
    if (user.role !== 'buyer' && user.role !== 'seller') throw Errors.forbidden('This role cannot bid');
    const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
    if (!lot || !PUBLIC_BID_STATUSES.includes(lot.status)) throw Errors.notFound('Lot');
    if (lot.sellerId === user.id) throw Errors.forbidden('You cannot bid on your own lot', 'OWN_LOT');
    if (lot.status !== 'active') throw Errors.conflict('LOT_NOT_ACTIVE', 'Lot is not accepting bids');
    if (lot.endsAt === null || this.clock.now().getTime() >= lot.endsAt.getTime()) {
      throw Errors.conflict('AUCTION_ENDED', 'The auction has ended');
    }
    return lot;
  }

  private async loadState(tx: Tx, lot: LotRow): Promise<LotBidState> {
    let leader: LotBidState['leader'] = null;
    if (lot.leaderId !== null) {
      const [row] = await tx.select({ max: bidderMaxes.maxAmount }).from(bidderMaxes)
        .where(and(eq(bidderMaxes.lotId, lot.id), eq(bidderMaxes.userId, lot.leaderId)));
      if (!row) throw new Error(`Lot ${lot.id} has a leader without a stored maximum`);
      leader = { userId: lot.leaderId, max: row.max };
    }
    return { startPrice: lot.startPrice, currentPrice: lot.currentPrice, bidCount: lot.bidCount, leader };
  }

  private rejection(code: BidRejection, state: LotBidState) {
    return code === 'BID_TOO_LOW'
      ? Errors.unprocessable(code, 'Bid is below the minimum', { minAmount: minNextBid(state) })
      : Errors.unprocessable(code, 'New maximum must exceed your current maximum', { currentMax: state.leader?.max });
  }
}
