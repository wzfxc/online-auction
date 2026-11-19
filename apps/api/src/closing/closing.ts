import { and, asc, eq, lte, sql } from 'drizzle-orm';
import {
  calcDeposit, calcFee, PAYMENT_WINDOW_HOURS, rankCandidates, SECOND_CHANCE_WINDOW_HOURS,
  type SecondChanceCandidate,
} from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { deposits, lotEvents, lots, sales } from '../db/schema.js';
import { post, type Tx } from '../ledger/ledger.js';
import { getBalance, holdDepositForMax, releaseDeposit } from '../ledger/wallet.js';

const HOUR_MS = 3_600_000;
const SWEEP_BATCH = 100;

export type CloseOutcome = 'noop' | 'ended_unsold' | 'awaiting_payment';
export type DefaultOutcome = 'noop' | 'offered_next' | 'ended_unsold';

type LotRow = typeof lots.$inferSelect;

/**
 * Closes auctions and drives the payment-default chain. Every transition is a compare-and-set on
 * a row locked FOR UPDATE, so parallel workers, repeated jobs and a lost queue (D14) are harmless:
 * the effect happens exactly once (invariants 3, 8).
 */
export class ClosingService {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** Closes one lot if, by the server clock, it is really over. Re-reads `ends_at` under the lock (D6). */
  async closeLot(lotId: string): Promise<CloseOutcome> {
    return this.db.transaction(async (tx) => {
      const lot = await this.lock(tx, lotId);
      const now = this.clock.now();
      if (!lot || lot.status !== 'active' || lot.endsAt === null || lot.endsAt.getTime() > now.getTime()) {
        return 'noop';
      }
      const reserveMet = lot.reservePrice === null || lot.currentPrice >= lot.reservePrice;
      if (lot.leaderId === null || !reserveMet) {
        await this.releaseAll(tx, lotId, now);
        await this.setStatus(tx, lot, 'ended_unsold', now, lot.leaderId === null ? 'no_bids' : 'reserve_not_met');
        return 'ended_unsold';
      }
      const leaderId = lot.leaderId;
      // Everyone but the winner gets the deposit back in the same transaction (invariant 4).
      await this.releaseAll(tx, lotId, now, leaderId);
      const payDueAt = new Date(now.getTime() + PAYMENT_WINDOW_HOURS * HOUR_MS);
      await tx.insert(sales).values({
        lotId, buyerId: leaderId, attempt: 1, price: lot.currentPrice, fee: calcFee(lot.currentPrice),
        payDueAt, createdAt: now,
      });
      await this.setStatus(tx, lot, 'awaiting_payment', now, 'won', { winnerId: leaderId, price: lot.currentPrice });
      return 'awaiting_payment';
    });
  }

  /**
   * Handles an unpaid sale past its due time: the buyer's deposit goes to the seller (D4) and the lot
   * is offered to the next bidder at their maximum for 24 h (D5), or ends unsold when nobody is left.
   */
  async defaultSale(saleId: string): Promise<DefaultOutcome> {
    return this.db.transaction(async (tx) => {
      const [probe] = await tx.select({ lotId: sales.lotId }).from(sales).where(eq(sales.id, saleId));
      if (!probe) return 'noop';
      // Lock order is always lot → sale, matching every other writer.
      const lot = await this.lock(tx, probe.lotId);
      const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
      const now = this.clock.now();
      if (!lot || !sale || sale.status !== 'awaiting_payment' || sale.payDueAt.getTime() > now.getTime()) {
        return 'noop';
      }
      await tx.update(sales).set({ status: 'defaulted' }).where(eq(sales.id, sale.id));
      await this.forfeitDeposit(tx, lot.id, sale.buyerId, lot.sellerId);

      const next = await this.nextOffer(tx, lot);
      if (next === null) {
        await this.setStatus(tx, lot, 'ended_unsold', now, 'no_more_bidders');
        return 'ended_unsold';
      }
      await tx.insert(sales).values({
        lotId: lot.id, buyerId: next.userId, attempt: sale.attempt + 1, price: next.maxAmount,
        fee: calcFee(next.maxAmount), payDueAt: new Date(now.getTime() + SECOND_CHANCE_WINDOW_HOURS * HOUR_MS),
        createdAt: now,
      });
      const seq = lot.lastSeq + 1;
      await tx.update(lots).set({ currentPrice: next.maxAmount, leaderId: next.userId, lastSeq: seq, updatedAt: now })
        .where(eq(lots.id, lot.id));
      await tx.insert(lotEvents).values({
        lotId: lot.id, actorId: null, type: 'second_chance', createdAt: now,
        payload: { seq, buyerId: next.userId, price: next.maxAmount, attempt: sale.attempt + 1 },
      });
      return 'offered_next';
    });
  }

  /** Closes every lot that is over by the server clock. DB-driven, so it works with Redis gone (D14). */
  async sweepEndedLots(): Promise<number> {
    const due = await this.db.select({ id: lots.id }).from(lots)
      .where(and(eq(lots.status, 'active'), lte(lots.endsAt, this.clock.now())))
      .orderBy(asc(lots.endsAt)).limit(SWEEP_BATCH);
    let closed = 0;
    for (const { id } of due) if ((await this.closeLot(id)) !== 'noop') closed += 1;
    return closed;
  }

  /** Processes every unpaid sale past its due time. */
  async sweepOverdueSales(): Promise<number> {
    const due = await this.db.select({ id: sales.id }).from(sales)
      .where(and(eq(sales.status, 'awaiting_payment'), lte(sales.payDueAt, this.clock.now())))
      .orderBy(asc(sales.payDueAt)).limit(SWEEP_BATCH);
    let done = 0;
    for (const { id } of due) if ((await this.defaultSale(id)) !== 'noop') done += 1;
    return done;
  }

  private async lock(tx: Tx, lotId: string): Promise<LotRow | undefined> {
    const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
    return lot;
  }

  private async setStatus(
    tx: Tx, lot: LotRow, status: 'ended_unsold' | 'awaiting_payment', now: Date, reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const seq = lot.lastSeq + 1;
    await tx.update(lots).set({ status, lastSeq: seq, updatedAt: now }).where(eq(lots.id, lot.id));
    await tx.insert(lotEvents).values({
      lotId: lot.id, actorId: null, type: 'status', createdAt: now,
      payload: { seq, from: lot.status, to: status, reason, ...extra },
    });
  }

  /** Releases all remaining deposits on the lot, optionally keeping one user's. */
  private async releaseAll(tx: Tx, lotId: string, now: Date, exceptUserId?: string): Promise<void> {
    const held = await tx.select({ userId: deposits.userId }).from(deposits)
      .where(and(eq(deposits.lotId, lotId), sql`${deposits.amount} > 0`))
      .orderBy(asc(deposits.userId));
    for (const { userId } of held) {
      if (userId !== exceptUserId) await releaseDeposit(tx, userId, lotId, now);
    }
  }

  /** The defaulter's held deposit becomes the seller's money; the deposits row mirrors it. */
  private async forfeitDeposit(tx: Tx, lotId: string, buyerId: string, sellerId: string): Promise<void> {
    const [dep] = await tx.select({ amount: deposits.amount }).from(deposits)
      .where(and(eq(deposits.lotId, lotId), eq(deposits.userId, buyerId))).for('update');
    if (!dep || dep.amount === 0) return;
    await post(tx, {
      kind: 'deposit_forfeit', lotId, effectKey: `forfeit:${lotId}:${buyerId}`,
      movements: [{ from: { type: 'user_hold', userId: buyerId }, to: { type: 'seller_payable', userId: sellerId }, amount: dep.amount }],
    });
    await tx.update(deposits).set({ amount: 0 }).where(and(eq(deposits.lotId, lotId), eq(deposits.userId, buyerId)));
  }

  /**
   * Next bidder to offer the lot to: highest maximum first (earlier wins ties), skipping anyone who already
   * had an attempt. A bidder who cannot fund the 10% deposit for the offer is skipped too.
   */
  private async nextOffer(tx: Tx, lot: LotRow): Promise<SecondChanceCandidate | null> {
    const rows = await tx.execute(sql`
      select b.user_id, max(b.max_amount) as max_amount, min(b.seq) as reached_seq
      from bids b
      where b.lot_id = ${lot.id}
        and b.user_id not in (select buyer_id from sales where lot_id = ${lot.id})
        and b.user_id <> ${lot.sellerId}
      group by b.user_id`);
    const list = rows.rows.map((r) => {
      const x = r as { user_id: string; max_amount: string | number; reached_seq: string | number };
      return { userId: x.user_id, maxAmount: Number(x.max_amount), reachedSeq: Number(x.reached_seq) };
    });
    for (const c of rankCandidates(list)) {
      const { available } = await getBalance(tx, c.userId);
      const [dep] = await tx.select({ amount: deposits.amount }).from(deposits)
        .where(and(eq(deposits.lotId, lot.id), eq(deposits.userId, c.userId)));
      if (available < calcDeposit(c.maxAmount) - (dep?.amount ?? 0)) continue;
      await holdDepositForMax(tx, c.userId, lot.id, c.maxAmount);
      return c;
    }
    return null;
  }
}

