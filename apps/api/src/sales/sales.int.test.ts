import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { BidService } from '../bids/bids.js';
import { ClosingService } from '../closing/closing.js';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, emailOutbox, lots, sales, users } from '../db/schema.js';
import { balanceOf, findUnbalancedTransactions } from '../ledger/ledger.js';
import { getBalance, getWalletHistory, topUp } from '../ledger/wallet.js';
import { LotService, type Principal } from '../lots/lots.js';
import { NotificationService } from '../notifications/notifications.js';
import { SalesService } from './sales.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const lotSvc = new LotService(db, clock);
const bidSvc = new BidService(db, clock);
const closingSvc = new ClosingService(db, clock);
const salesSvc = new SalesService(db, clock);

let categoryId = '';
let cityId = '';
let keySeq = 0;
const key = () => `sale-k-${++keySeq}`;

async function newUser(role: Principal['role'] = 'buyer', funds = 0, name = 'Олег Коваль'): Promise<Principal> {
  const [u] = await db.insert(users).values({
    email: `${Math.random()}@t.test`, displayName: name, passwordHash: 'x', role,
  }).returning();
  if (funds > 0) await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  return { id: u!.id, role };
}

async function newActiveLot(seller: Principal, over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'Вінтажний годинник', description: 'Механіка',
    startPrice: 100_000, currentPrice: 100_000, reservePrice: 100_000, buyNowPrice: 200_000,
    durationDays: 3, condition: 'good', status: 'active',
    endsAt: new Date(clock.now().getTime() + 3_600_000),
    createdAt: clock.now(), updatedAt: clock.now(),
    ...over,
  }).returning();
  return lot!.id;
}

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const [cat] = await db.insert(categories).values({
    slug: 'watches', nameUk: 'Годинники', nameEn: 'Watches', namePl: 'Zegarki',
  }).returning();
  const [city] = await db.insert(cities).values({
    slug: 'kyiv', nameUk: 'Київ', nameEn: 'Kyiv', namePl: 'Kijów',
  }).returning();
  categoryId = cat!.id;
  cityId = city!.id;
});

afterAll(() => pool.end());

describe('sale payment, shipping, confirmation and payout', () => {
  it('credits the held deposit toward payment, masks winner before payment, ships and pays out minus fee', async () => {
    const seller = await newUser('seller', 0, 'Продавець Іван');
    const buyer = await newUser('buyer', 500_000, 'Олена Бойко');
    const lotId = await newActiveLot(seller);

    await bidSvc.placeBid(buyer, lotId, { amount: 100_000, maxAmount: 120_000 }, key());
    // Held deposit is 10% of 120_000 = 12_000; currentPrice is 100_000.
    expect(await db.transaction((tx) => getBalance(tx, buyer.id))).toEqual({
      available: 500_000 - 12_000, held: 12_000,
    });

    clock.advance(3_600_001);
    expect(await closingSvc.closeLot(lotId)).toBe('awaiting_payment');
    const saleBefore = await salesSvc.getLotSale(seller, lotId);
    expect(saleBefore).not.toBeNull();
    // Before payment, seller sees masked buyer name and no email:
    expect(saleBefore!.buyerName).toBe('О***о');
    expect(saleBefore!.buyerEmail).toBeNull();
    expect(JSON.stringify(saleBefore)).not.toContain('reservePrice');

    // Pay with idempotency key: deposit (12_000) + available (88_000) = 100_000 into escrow.
    const payKey = key();
    const paid1 = await salesSvc.paySale(buyer, saleBefore!.id, payKey);
    expect(paid1.replayed).toBe(false);
    expect(paid1.body.status).toBe('paid');

    const paidReplay = await salesSvc.paySale(buyer, saleBefore!.id, payKey);
    expect(paidReplay.replayed).toBe(true);
    expect(paidReplay.body).toEqual(paid1.body);

    // Same key with a different body → 422 IDEMPOTENCY_KEY_REUSED (invariant 7).
    await expect(salesSvc.paySale(buyer, saleBefore!.id, payKey, { extra: true })).rejects.toMatchObject({
      status: 422, code: 'IDEMPOTENCY_KEY_REUSED',
    });

    expect(await db.transaction((tx) => getBalance(tx, buyer.id))).toEqual({
      available: 400_000, held: 0,
    });

    // After payment, the seller sees the winner's unmasked name and email, plus pendingPayout:
    const saleForSeller = await salesSvc.getSale(seller, saleBefore!.id);
    expect(saleForSeller.buyerName).toBe('Олена Бойко');
    expect(saleForSeller.buyerEmail).toContain('@t.test');

    const mineWhilePaid = await lotSvc.listMine(seller, 'paid');
    expect(mineWhilePaid.items).toHaveLength(1);
    expect(mineWhilePaid.pendingPayout).toBe(95_000); // 100_000 - 5% fee (5_000)
    expect(mineWhilePaid.paidOutTotal).toBe(0);

    // Seller marks shipped with tracking number:
    const shipped = await salesSvc.shipSale(seller, saleBefore!.id, { trackingNumber: 'NP-20450012345' });
    expect(shipped.status).toBe('shipped');
    expect(shipped.trackingNumber).toBe('NP-20450012345');

    // Buyer confirms receipt → payout to seller_payable (95_000) and platform_fee (5_000):
    const completed = await salesSvc.confirmReceipt(buyer, saleBefore!.id);
    expect(completed.status).toBe('completed');
    expect(completed.paidOutAt).not.toBeNull();

    const mineAfterComplete = await lotSvc.listMine(seller);
    expect(mineAfterComplete.pendingPayout).toBe(0);
    expect(mineAfterComplete.paidOutTotal).toBe(95_000);

    const buyerHistory = await getWalletHistory(db, buyer.id);
    expect(buyerHistory.available).toBe(400_000);
    expect(buyerHistory.held).toBe(0);
    expect(buyerHistory.items.map((i) => i.kind)).toContain('sale_payment');

    const sellerHistory = await getWalletHistory(db, seller.id);
    expect(sellerHistory.payable).toBe(95_000);
    expect(sellerHistory.items.map((i) => i.kind)).toContain('sale_payout');

    expect(await db.transaction((tx) => findUnbalancedTransactions(tx))).toEqual([]);
  });

  it('auto-confirms receipt 7 days after shipment and rejects payment after the 48h window', async () => {
    const seller = await newUser('seller');
    const buyer = await newUser('buyer', 500_000);
    const lotId = await newActiveLot(seller, { buyNowPrice: 50_000, startPrice: 20_000, currentPrice: 20_000, reservePrice: null });

    const bought = await bidSvc.buyNow(buyer, lotId, key());
    await salesSvc.paySale(buyer, bought.body.saleId, key());
    await salesSvc.shipSale(seller, bought.body.saleId, { trackingNumber: 'UA-999888777' });

    // 6 days later: auto-confirm is a no-op
    clock.advance(6 * 86_400_000);
    expect(await salesSvc.sweepAutoConfirmSales()).toBe(0);

    // 7 days + 1 second after shipment: parallel sweepers confirm exactly once
    clock.advance(86_400_001);
    const sweepCounts = await Promise.all([
      salesSvc.sweepAutoConfirmSales(),
      salesSvc.sweepAutoConfirmSales(),
      salesSvc.sweepAutoConfirmSales(),
    ]);
    expect(sweepCounts.reduce((a, b) => a + b, 0)).toBe(1);
    const finalSale = await salesSvc.getSale(seller, bought.body.saleId);
    expect(finalSale.status).toBe('completed');
    expect(await db.transaction((tx) => balanceOf(tx, { type: 'seller_payable', userId: seller.id }))).toBe(47_500);

    // Expired 48h payment window test:
    const lot2 = await newActiveLot(seller, { buyNowPrice: 40_000, startPrice: 20_000, currentPrice: 20_000, reservePrice: null });
    const bought2 = await bidSvc.buyNow(buyer, lot2, key());
    clock.advance(48 * 3_600_000 + 1000);
    await expect(salesSvc.paySale(buyer, bought2.body.saleId, key())).rejects.toMatchObject({
      status: 409, code: 'PAYMENT_WINDOW_EXPIRED',
    });
  });

  it('reopens an ended_unsold lot back to draft so the seller can edit and republish it', async () => {
    const seller = await newUser('seller');
    const moderator = await newUser('moderator');
    const buyer = await newUser('buyer', 500_000);
    const lotId = await newActiveLot(seller, { reservePrice: 300_000 });

    await bidSvc.placeBid(buyer, lotId, { amount: 100_000 }, key());
    clock.advance(3_600_001);
    expect(await closingSvc.closeLot(lotId)).toBe('ended_unsold');

    const reopened = await lotSvc.reviseRejected(seller, lotId);
    expect(reopened.status).toBe('draft');
    expect(reopened.bidCount).toBe(0);

    const edited = await lotSvc.update(seller, lotId, { reservePrice: null, startPrice: 80_000 });
    expect(edited.startPrice).toBe(80_000);
    await lotSvc.submit(seller, lotId);
    const active = await lotSvc.approve(moderator, lotId);
    expect(active.status).toBe('active');

    const bid = await bidSvc.placeBid(buyer, lotId, { amount: 80_000 }, key());
    expect(bid.body.status).toBe('leading');
  });
});

describe('Redis loss and parallel workers resilience (invariant 13, acceptance 15)', () => {
  it('survives Redis FLUSHALL and 3 concurrent workers without losing jobs or duplicating effects', async () => {
    const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
    const redis = new Redis(redisUrl);
    await redis.set('ephemeral-state', 'will-be-flushed');

    const seller = await newUser('seller');
    const buyer = await newUser('buyer', 500_000);
    const lotId = await newActiveLot(seller, {
      reservePrice: null,
      endsAt: new Date(clock.now().getTime() + 1800_000),
    });

    await lotSvc.addFavorite(buyer, lotId);
    await bidSvc.placeBid(buyer, lotId, { amount: 100_000 }, key());

    // Wipe Redis completely:
    await redis.flushall();
    expect(await redis.get('ephemeral-state')).toBeNull();
    await redis.quit();

    // 3 concurrent workers run ending reminders:
    const sentEmails: string[] = [];
    const notifWorkers = [1, 2, 3].map(() =>
      new NotificationService(db, clock, {
        send: async (to, subject) => { sentEmails.push(`${to}:${subject}`); },
      }));
    const remCounts = await Promise.all(notifWorkers.map((w) => w.sendEndingReminders()));
    expect(remCounts.reduce((a, b) => a + b, 0)).toBe(1);

    // Advance past auction end and run 3 concurrent workers closing lots:
    clock.advance(1800_001);
    const closeWorkers = [1, 2, 3].map(() => new ClosingService(db, clock));
    await Promise.all(closeWorkers.map((w) => w.sweepEndedLots()));
    const lotAfterClose = await lotSvc.get(buyer, lotId);
    expect(lotAfterClose.status).toBe('awaiting_payment');
    const lotSales = await db.select().from(sales).where(eq(sales.lotId, lotId));
    expect(lotSales).toHaveLength(1);

    // Drain emails with 3 concurrent workers: each queued email is sent once:
    await db.update(emailOutbox).set({ sentAt: clock.now() });
    await db.insert(emailOutbox).values({
      userId: buyer.id, lotId, kind: 'test_flush', subject: 'After flushall', body: 'ok',
      createdAt: clock.now(), dedupeKey: `flushall:${lotId}`,
    });
    sentEmails.length = 0;
    const drainCounts = await Promise.all(notifWorkers.map((w) => w.drainEmails()));
    expect(drainCounts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(await db.transaction((tx) => findUnbalancedTransactions(tx))).toEqual([]);
  });
});
