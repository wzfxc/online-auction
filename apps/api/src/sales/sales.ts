import { and, asc, desc, eq, lte, or } from 'drizzle-orm';
import {
  AUTO_CONFIRM_DAYS, canTransition, maskName, shipSaleSchema,
  type SaleStatus,
} from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import { withIdempotency, type StoredResponse } from '../common/idempotency/idempotency.js';
import type { Db } from '../db/client.js';
import {
  bidderMaxes, deposits, emailOutbox, lotEvents, lots, notifications, sales, users,
} from '../db/schema.js';
import { post, type Movement, type Tx } from '../ledger/ledger.js';
import { getBalance, lockWallet } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';

const DAY_MS = 86_400_000;
const AUTO_CONFIRM_MS = AUTO_CONFIRM_DAYS * DAY_MS;
const SWEEP_BATCH = 100;

type LotRow = typeof lots.$inferSelect;
type SaleRow = typeof sales.$inferSelect;

const PAID_STATUSES: readonly SaleStatus[] = ['paid', 'shipped', 'completed'];

export interface SaleDto {
  id: string;
  lotId: string;
  lotTitle: string;
  sellerId: string;
  buyerId: string;
  /** Masked for the seller before payment; unmasked for the buyer and for the seller after payment. */
  buyerName: string;
  /** Hidden (null) for the seller before payment. */
  buyerEmail: string | null;
  attempt: number;
  price: number;
  fee: number;
  sellerPayout: number;
  depositHeld: number;
  status: SaleStatus;
  payDueAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  trackingNumber: string | null;
  confirmedAt: string | null;
  paidOutAt: string | null;
  createdAt: string;
}

export class SalesService {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /**
   * Pays for a won lot from the buyer's wallet within the payment window (48h for winner, 24h for second chance).
   * The buyer's held deposit on the lot is credited toward the price; the remainder is taken from `user_available`,
   * and the full sale price sits in `escrow` until delivery is confirmed. Idempotent by `Idempotency-Key` (invariant 7).
   */
  async paySale(
    buyer: Principal,
    saleId: string,
    idempotencyKey: string,
    rawBody: unknown = {},
  ): Promise<StoredResponse<SaleDto>> {
    if (buyer.role !== 'buyer' && buyer.role !== 'seller') {
      throw Errors.forbidden('This role cannot pay for lots');
    }
    return withIdempotency<SaleDto>(
      this.db,
      { userId: buyer.id, scope: 'sale_pay', key: idempotencyKey, body: { saleId, body: rawBody ?? {} } },
      async (tx) => {
        const { lot, sale } = await this.lockSaleAndLot(tx, saleId);
        if (sale.buyerId !== buyer.id) {
          throw Errors.forbidden('Only the winning buyer may pay for this sale');
        }
        if (sale.status !== 'awaiting_payment' || lot.status !== 'awaiting_payment'
          || !canTransition(lot.status, 'paid', 'system')) {
          throw Errors.conflict('SALE_NOT_PAYABLE', 'Sale is not awaiting payment');
        }
        const now = this.clock.now();
        if (now.getTime() > sale.payDueAt.getTime()) {
          throw Errors.conflict('PAYMENT_WINDOW_EXPIRED', 'The payment window has expired');
        }

        const [dep] = await tx
          .select({ amount: deposits.amount })
          .from(deposits)
          .where(and(eq(deposits.lotId, lot.id), eq(deposits.userId, buyer.id)))
          .for('update');
        const heldDeposit = dep?.amount ?? 0;
        const fromHold = Math.min(heldDeposit, sale.price);
        const excessHold = heldDeposit - fromHold;
        const fromAvailable = sale.price - fromHold;

        if (fromAvailable > 0) {
          await lockWallet(tx, buyer.id);
          const { available } = await getBalance(tx, buyer.id);
          if (available < fromAvailable) {
            throw Errors.insufficientFunds({ required: fromAvailable, available });
          }
        }

        const movements: Movement[] = [];
        if (fromHold > 0) {
          movements.push({ from: { type: 'user_hold', userId: buyer.id }, to: { type: 'escrow' }, amount: fromHold });
        }
        if (fromAvailable > 0) {
          movements.push({ from: { type: 'user_available', userId: buyer.id }, to: { type: 'escrow' }, amount: fromAvailable });
        }
        if (excessHold > 0) {
          movements.push({ from: { type: 'user_hold', userId: buyer.id }, to: { type: 'user_available', userId: buyer.id }, amount: excessHold });
        }

        await post(tx, {
          kind: 'sale_payment',
          lotId: lot.id,
          effectKey: `sale_pay:${sale.id}`,
          movements,
        });

        if (heldDeposit > 0) {
          await tx
            .update(deposits)
            .set({ amount: 0, releasedAt: now })
            .where(and(eq(deposits.lotId, lot.id), eq(deposits.userId, buyer.id)));
        }
        await tx.delete(bidderMaxes).where(eq(bidderMaxes.lotId, lot.id));

        const [updatedSale] = await tx
          .update(sales)
          .set({ status: 'paid', paidAt: now })
          .where(eq(sales.id, sale.id))
          .returning();
        const seq = lot.lastSeq + 1;
        await tx
          .update(lots)
          .set({ status: 'paid', lastSeq: seq, updatedAt: now })
          .where(eq(lots.id, lot.id));
        await tx.insert(lotEvents).values({
          lotId: lot.id,
          actorId: buyer.id,
          type: 'paid',
          createdAt: now,
          payload: { seq, saleId: sale.id, price: sale.price, depositApplied: fromHold, paidFromAvailable: fromAvailable },
        });

        const noticeKey = `sale_paid:${sale.id}`;
        await tx.insert(notifications).values({
          userId: lot.sellerId,
          type: 'sale_paid',
          createdAt: now,
          dedupeKey: noticeKey,
          payload: { lotId: lot.id, lotTitle: lot.title, saleId: sale.id, price: sale.price },
        }).onConflictDoNothing();
        await tx.insert(emailOutbox).values({
          userId: lot.sellerId,
          lotId: lot.id,
          kind: 'sale_paid',
          createdAt: now,
          dedupeKey: noticeKey,
          subject: `Лот «${lot.title}» оплачено`,
          body: `Покупець оплатив лот «${lot.title}» на суму ${(sale.price / 100).toFixed(2)} ₴. Відправте замовлення та вкажіть трек-номер.`,
        }).onConflictDoNothing();

        return { status: 200, body: await this.mapSale(tx, updatedSale!, lot, buyer) };
      },
    );
  }

  /** Marks a paid sale as shipped with a tracking number (seller only). */
  async shipSale(seller: Principal, saleId: string, raw: unknown): Promise<SaleDto> {
    if (seller.role !== 'seller') throw Errors.forbidden('Seller role required');
    const parsed = shipSaleSchema.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const { trackingNumber } = parsed.data;

    return this.db.transaction(async (tx) => {
      const { lot, sale } = await this.lockSaleAndLot(tx, saleId);
      if (lot.sellerId !== seller.id) {
        throw Errors.forbidden('Only the lot seller can mark it as shipped');
      }
      if (sale.status !== 'paid' || !canTransition(lot.status, 'shipped', 'seller')) {
        throw Errors.conflict('INVALID_SALE_TRANSITION', 'Sale must be paid before it can be shipped');
      }
      const now = this.clock.now();
      const [updatedSale] = await tx
        .update(sales)
        .set({ status: 'shipped', shippedAt: now, trackingNumber })
        .where(eq(sales.id, sale.id))
        .returning();
      const seq = lot.lastSeq + 1;
      await tx
        .update(lots)
        .set({ status: 'shipped', lastSeq: seq, updatedAt: now })
        .where(eq(lots.id, lot.id));
      await tx.insert(lotEvents).values({
        lotId: lot.id,
        actorId: seller.id,
        type: 'shipped',
        createdAt: now,
        payload: { seq, saleId: sale.id, trackingNumber },
      });

      const noticeKey = `sale_shipped:${sale.id}`;
      await tx.insert(notifications).values({
        userId: sale.buyerId,
        type: 'sale_shipped',
        createdAt: now,
        dedupeKey: noticeKey,
        payload: { lotId: lot.id, lotTitle: lot.title, saleId: sale.id, trackingNumber },
      }).onConflictDoNothing();
      await tx.insert(emailOutbox).values({
        userId: sale.buyerId,
        lotId: lot.id,
        kind: 'sale_shipped',
        createdAt: now,
        dedupeKey: noticeKey,
        subject: `Лот «${lot.title}» відправлено`,
        body: `Продавець відправив лот «${lot.title}». Трек-номер: ${trackingNumber}.`,
      }).onConflictDoNothing();

      return this.mapSale(tx, updatedSale!, lot, seller);
    });
  }

  /** Buyer confirms receipt; escrow is released to seller_payable (minus fee) and platform_fee. */
  async confirmReceipt(buyer: Principal, saleId: string): Promise<SaleDto> {
    if (buyer.role !== 'buyer' && buyer.role !== 'seller') {
      throw Errors.forbidden('This role cannot confirm receipt');
    }
    return this.db.transaction(async (tx) => {
      const { lot, sale } = await this.lockSaleAndLot(tx, saleId);
      if (sale.buyerId !== buyer.id) {
        throw Errors.forbidden('Only the buyer can confirm receipt');
      }
      if (sale.status !== 'shipped' || !canTransition(lot.status, 'completed', 'buyer')) {
        throw Errors.conflict('INVALID_SALE_TRANSITION', 'Sale must be shipped before confirming receipt');
      }
      const updatedSale = await this.completeAndPayOut(tx, lot, sale, buyer.id, 'confirmed', this.clock.now());
      return this.mapSale(tx, updatedSale, lot, buyer);
    });
  }

  /**
   * Auto-confirms a shipped sale 7 days after shipment if the buyer has not confirmed yet.
   * Compare-and-set under row locks makes parallel workers and repeated sweeps produce one payout.
   */
  async autoConfirmSale(saleId: string): Promise<'noop' | 'completed'> {
    return this.db.transaction(async (tx) => {
      const [probe] = await tx.select({ lotId: sales.lotId }).from(sales).where(eq(sales.id, saleId));
      if (!probe) return 'noop';
      const [lot] = await tx.select().from(lots).where(eq(lots.id, probe.lotId)).for('update');
      const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
      const now = this.clock.now();
      if (!lot || !sale || sale.status !== 'shipped' || !canTransition(lot.status, 'completed', 'system')
        || sale.shippedAt === null || sale.shippedAt.getTime() + AUTO_CONFIRM_MS > now.getTime()) {
        return 'noop';
      }
      await this.completeAndPayOut(tx, lot, sale, null, 'auto_confirmed', now);
      return 'completed';
    });
  }

  /** Sweeps all shipped sales whose 7-day confirmation window has elapsed by the server clock. */
  async sweepAutoConfirmSales(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - AUTO_CONFIRM_MS);
    const due = await this.db
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.status, 'shipped'), lte(sales.shippedAt, cutoff)))
      .orderBy(asc(sales.shippedAt))
      .limit(SWEEP_BATCH);
    let done = 0;
    for (const { id } of due) {
      if ((await this.autoConfirmSale(id)) === 'completed') done += 1;
    }
    return done;
  }

  async getSale(viewer: Principal, saleId: string): Promise<SaleDto> {
    return this.db.transaction(async (tx) => {
      const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId));
      if (!sale) throw Errors.notFound('Sale');
      const [lot] = await tx.select().from(lots).where(eq(lots.id, sale.lotId));
      if (!lot) throw Errors.notFound('Sale');
      if (viewer.id !== sale.buyerId && viewer.id !== lot.sellerId) {
        throw Errors.notFound('Sale');
      }
      return this.mapSale(tx, sale, lot, viewer);
    });
  }

  /** Latest sale for a lot, visible only to the lot seller or the buyer of that sale. */
  async getLotSale(viewer: Principal, lotId: string): Promise<SaleDto | null> {
    return this.db.transaction(async (tx) => {
      const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId));
      if (!lot) throw Errors.notFound('Lot');
      const rows = await tx
        .select()
        .from(sales)
        .where(eq(sales.lotId, lotId))
        .orderBy(desc(sales.attempt));
      const visible = rows.find((s) => viewer.id === lot.sellerId || viewer.id === s.buyerId);
      if (!visible) return null;
      return this.mapSale(tx, visible, lot, viewer);
    });
  }

  /** Lists the caller's sales (as buyer, seller, or both). */
  async listSales(
    viewer: Principal,
    opts: { role?: 'buyer' | 'seller'; status?: SaleStatus } = {},
  ): Promise<SaleDto[]> {
    if (viewer.role !== 'buyer' && viewer.role !== 'seller') {
      throw Errors.forbidden('This role cannot access sales');
    }
    return this.db.transaction(async (tx) => {
      const roleFilter = opts.role === 'buyer'
        ? eq(sales.buyerId, viewer.id)
        : opts.role === 'seller'
          ? eq(lots.sellerId, viewer.id)
          : or(eq(sales.buyerId, viewer.id), eq(lots.sellerId, viewer.id));
      const where = opts.status ? and(roleFilter, eq(sales.status, opts.status)) : roleFilter;
      const rows = await tx
        .select({ sale: sales, lot: lots })
        .from(sales)
        .innerJoin(lots, eq(lots.id, sales.lotId))
        .where(where)
        .orderBy(desc(sales.createdAt), desc(sales.attempt))
        .limit(100);
      const out: SaleDto[] = [];
      for (const { sale, lot } of rows) {
        out.push(await this.mapSale(tx, sale, lot, viewer));
      }
      return out;
    });
  }

  private async completeAndPayOut(
    tx: Tx,
    lot: LotRow,
    sale: SaleRow,
    actorId: string | null,
    eventType: 'confirmed' | 'auto_confirmed',
    now: Date,
  ): Promise<SaleRow> {
    const fee = sale.fee;
    const sellerPayout = sale.price - fee;
    const movements: Movement[] = [];
    if (sellerPayout > 0) {
      movements.push({
        from: { type: 'escrow' },
        to: { type: 'seller_payable', userId: lot.sellerId },
        amount: sellerPayout,
      });
    }
    if (fee > 0) {
      movements.push({
        from: { type: 'escrow' },
        to: { type: 'platform_fee' },
        amount: fee,
      });
    }
    await post(tx, {
      kind: 'sale_payout',
      lotId: lot.id,
      effectKey: `payout:${sale.id}`,
      movements,
    });

    const [updatedSale] = await tx
      .update(sales)
      .set({ status: 'completed', confirmedAt: now, paidOutAt: now })
      .where(eq(sales.id, sale.id))
      .returning();
    const seq = lot.lastSeq + 1;
    await tx
      .update(lots)
      .set({ status: 'completed', lastSeq: seq, updatedAt: now })
      .where(eq(lots.id, lot.id));
    await tx.insert(lotEvents).values({
      lotId: lot.id,
      actorId,
      type: eventType,
      createdAt: now,
      payload: { seq, saleId: sale.id, price: sale.price, fee, sellerPayout },
    });

    const noticeKey = `sale_completed:${sale.id}`;
    await tx.insert(notifications).values({
      userId: lot.sellerId,
      type: 'sale_completed',
      createdAt: now,
      dedupeKey: noticeKey,
      payload: { lotId: lot.id, lotTitle: lot.title, saleId: sale.id, sellerPayout, fee },
    }).onConflictDoNothing();
    await tx.insert(emailOutbox).values({
      userId: lot.sellerId,
      lotId: lot.id,
      kind: 'sale_completed',
      createdAt: now,
      dedupeKey: noticeKey,
      subject: `Виплату за лот «${lot.title}» нараховано`,
      body: `Отримання лота «${lot.title}» підтверджено. Нараховано виплату: ${(sellerPayout / 100).toFixed(2)} ₴ (комісія: ${(fee / 100).toFixed(2)} ₴).`,
    }).onConflictDoNothing();

    return updatedSale!;
  }

  private async lockSaleAndLot(tx: Tx, saleId: string): Promise<{ lot: LotRow; sale: SaleRow }> {
    const [probe] = await tx.select({ lotId: sales.lotId }).from(sales).where(eq(sales.id, saleId));
    if (!probe) throw Errors.notFound('Sale');
    const [lot] = await tx.select().from(lots).where(eq(lots.id, probe.lotId)).for('update');
    const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for('update');
    if (!lot || !sale) throw Errors.notFound('Sale');
    return { lot, sale };
  }

  private async mapSale(tx: Tx, sale: SaleRow, lot: LotRow, viewer: Principal): Promise<SaleDto> {
    const [buyer] = await tx
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, sale.buyerId));
    const [dep] = await tx
      .select({ amount: deposits.amount })
      .from(deposits)
      .where(and(eq(deposits.lotId, lot.id), eq(deposits.userId, sale.buyerId)));

    // Rule: "продавец видит победителя после оплаты". Before payment, the seller only sees a masked name.
    const canSeeBuyerIdentity = viewer.id === sale.buyerId
      || (viewer.id === lot.sellerId && PAID_STATUSES.includes(sale.status));
    const rawName = buyer?.displayName ?? 'Покупець';

    return {
      id: sale.id,
      lotId: sale.lotId,
      lotTitle: lot.title,
      sellerId: lot.sellerId,
      buyerId: sale.buyerId,
      buyerName: canSeeBuyerIdentity ? rawName : maskName(rawName),
      buyerEmail: canSeeBuyerIdentity ? (buyer?.email ?? null) : null,
      attempt: sale.attempt,
      price: sale.price,
      fee: sale.fee,
      sellerPayout: sale.price - sale.fee,
      depositHeld: dep?.amount ?? 0,
      status: sale.status,
      payDueAt: sale.payDueAt.toISOString(),
      paidAt: sale.paidAt?.toISOString() ?? null,
      shippedAt: sale.shippedAt?.toISOString() ?? null,
      trackingNumber: sale.trackingNumber ?? null,
      confirmedAt: sale.confirmedAt?.toISOString() ?? null,
      paidOutAt: sale.paidOutAt?.toISOString() ?? null,
      createdAt: sale.createdAt.toISOString(),
    };
  }
}
