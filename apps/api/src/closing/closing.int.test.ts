import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, lotEvents, lots, sales, users } from '../db/schema.js';
import { BidService } from '../bids/bids.js';
import { balanceOf, findUnbalancedTransactions } from '../ledger/ledger.js';
import { getBalance, topUp } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';
import { ClosingService } from './closing.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const bidsSvc = new BidService(db, clock);
const closing = new ClosingService(db, clock);

let categoryId: string;
let cityId: string;
let seller: Principal;
let keySeq = 0;
const key = () => `c-${++keySeq}`;
const END = '2030-01-01T12:00:00.000Z';

async function newUser(role: Principal['role'] = 'buyer', funds = 0): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'Тест Юзер', passwordHash: 'x', role }).returning();
  if (funds > 0) await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  return { id: u!.id, role };
}

async function newLot(over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'L', description: 'D', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status: 'active', endsAt: new Date(END), ...over,
  }).returning();
  return lot!.id;
}

const getLot = async (id: string) => (await db.select().from(lots).where(eq(lots.id, id)))[0]!;
const salesOf = (id: string) => db.select().from(sales).where(eq(sales.lotId, id)).orderBy(sales.attempt);
const balances = (id: string) => db.transaction((tx) => getBalance(tx, id));

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const [cat] = await db.insert(categories).values({ slug: 'c', nameUk: 'c', nameEn: 'c', namePl: 'c' }).returning();
  const [city] = await db.insert(cities).values({ slug: 'k', nameUk: 'k', nameEn: 'k', namePl: 'k' }).returning();
  categoryId = cat!.id;
  cityId = city!.id;
  seller = await newUser('seller');
});
afterAll(() => pool.end());

describe('anti-sniping', () => {
  it('a bid in the last 2 minutes moves the end to now + 2 min, repeatedly', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    const b = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T11:59:00.000Z');
    await bidsSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    expect((await getLot(lotId)).endsAt!.toISOString()).toBe('2030-01-01T12:01:00.000Z');
    clock.set('2030-01-01T12:00:30.000Z');
    await bidsSvc.placeBid(b, lotId, { amount: 11_000 }, key());
    expect((await getLot(lotId)).endsAt!.toISOString()).toBe('2030-01-01T12:02:30.000Z');
    const events = await db.select().from(lotEvents).where(eq(lotEvents.lotId, lotId));
    expect(events.filter((e) => e.type === 'extended')).toHaveLength(2);
  });

  it('a bid earlier than the last 2 minutes leaves the end untouched; a bid after the end is refused', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T11:00:00.000Z');
    await bidsSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    expect((await getLot(lotId)).endsAt!.toISOString()).toBe(END);
    clock.set(END);
    await expect(bidsSvc.placeBid(a, lotId, { amount: 20_000 }, key())).rejects.toMatchObject({ code: 'AUCTION_ENDED' });
  });
});

describe('closing', () => {
  it('does nothing before the end (a stale job is a no-op) and closes exactly once after', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T10:00:00.000Z');
    await bidsSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    expect(await closing.closeLot(lotId)).toBe('noop');
    clock.set('2030-01-01T12:00:01.000Z');
    const results = await Promise.all(Array.from({ length: 5 }, () => closing.closeLot(lotId)));
    expect(results.filter((r) => r === 'awaiting_payment')).toHaveLength(1);
    expect(await closing.closeLot(lotId)).toBe('noop');
    const [sale] = await salesOf(lotId);
    expect(sale).toMatchObject({ buyerId: a.id, attempt: 1, price: 10_000, fee: 1_000, status: 'awaiting_payment' });
    expect(sale!.payDueAt.toISOString()).toBe('2030-01-03T12:00:01.000Z');
    expect((await getLot(lotId)).status).toBe('awaiting_payment');
  });

  it('no bids → ended_unsold', async () => {
    const lotId = await newLot();
    clock.set('2030-01-02T00:00:00.000Z');
    expect(await closing.closeLot(lotId)).toBe('ended_unsold');
    expect((await getLot(lotId)).status).toBe('ended_unsold');
  });

  it('reserve not met → ended_unsold and the leader deposit is released', async () => {
    const lotId = await newLot({ reservePrice: 100_000 });
    const a = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T10:00:00.000Z');
    await bidsSvc.placeBid(a, lotId, { amount: 10_000, maxAmount: 20_000 }, key());
    expect(await balances(a.id)).toEqual({ available: 1_000_000 - 5_000, held: 5_000 });
    clock.set('2030-01-01T12:00:01.000Z');
    expect(await closing.closeLot(lotId)).toBe('ended_unsold');
    expect(await balances(a.id)).toEqual({ available: 1_000_000, held: 0 });
    expect(await salesOf(lotId)).toHaveLength(0);
  });

  it('winner keeps the deposit, the sweeper closes due lots from the DB alone', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T10:00:00.000Z');
    await bidsSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    clock.set('2030-01-01T12:00:01.000Z');
    expect(await closing.sweepEndedLots()).toBeGreaterThanOrEqual(1);
    expect((await getLot(lotId)).status).toBe('awaiting_payment');
    expect(await balances(a.id)).toEqual({ available: 1_000_000 - 5_000, held: 5_000 });
  });
});

describe('unpaid sales → second chance', () => {
  it('winner defaults → deposit to seller, second bidder offered at their max for 24 h, then third, then unsold', async () => {
    const lotId = await newLot({ startPrice: 100_000, currentPrice: 100_000 });
    const a = await newUser('buyer', 1_000_000);
    const b = await newUser('buyer', 1_000_000);
    const c = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T09:00:00.000Z');
    await bidsSvc.placeBid(c, lotId, { amount: 100_000, maxAmount: 110_000 }, key());
    await bidsSvc.placeBid(b, lotId, { amount: 111_000, maxAmount: 150_000 }, key());
    await bidsSvc.placeBid(a, lotId, { amount: 155_000, maxAmount: 200_000 }, key());
    // c and b were outbid and released; a leads at 155000.
    clock.set('2030-01-01T12:00:01.000Z');
    await closing.closeLot(lotId);
    const sellerBefore = await db.transaction((tx) => balanceOf(tx, { type: 'seller_payable', userId: seller.id }));

    // Not yet due → no-op.
    const [first] = await salesOf(lotId);
    expect(await closing.defaultSale(first!.id)).toBe('noop');

    clock.set('2030-01-03T12:00:02.000Z');
    expect(await closing.defaultSale(first!.id)).toBe('offered_next');
    expect(await closing.defaultSale(first!.id)).toBe('noop');
    const afterFirst = await salesOf(lotId);
    expect(afterFirst.map((s) => [s.attempt, s.buyerId, s.status, s.price])).toEqual([
      [1, a.id, 'defaulted', 155_000],
      [2, b.id, 'awaiting_payment', 150_000],
    ]);
    expect(afterFirst[1]!.payDueAt.toISOString()).toBe('2030-01-04T12:00:02.000Z');
    const sellerAfter = await db.transaction((tx) => balanceOf(tx, { type: 'seller_payable', userId: seller.id }));
    expect(sellerAfter - sellerBefore).toBe(20_000);
    expect(await balances(a.id)).toEqual({ available: 1_000_000 - 20_000, held: 0 });
    expect(await balances(b.id)).toEqual({ available: 1_000_000 - 15_000, held: 15_000 });
    expect((await getLot(lotId)).leaderId).toBe(b.id);

    clock.set('2030-01-04T12:00:03.000Z');
    expect(await closing.sweepOverdueSales()).toBeGreaterThanOrEqual(1); // sweeper is global; other lots may be due too
    const third = (await salesOf(lotId))[2]!;
    expect([third.buyerId, third.price]).toEqual([c.id, 110_000]);

    clock.set('2030-01-05T12:00:04.000Z');
    await closing.sweepOverdueSales();
    expect((await getLot(lotId)).status).toBe('ended_unsold');
    expect(await balances(c.id)).toEqual({ available: 1_000_000 - 11_000, held: 0 });
    expect(await db.transaction((tx) => findUnbalancedTransactions(tx))).toEqual([]);
  });

  it('skips a runner-up who cannot fund the deposit for the offer', async () => {
    const lotId = await newLot();
    const otherLot = await newLot();
    const a = await newUser('buyer', 1_000_000);
    const broke = await newUser('buyer', 12_000);
    const ok = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T09:00:00.000Z');
    await bidsSvc.placeBid(ok, lotId, { amount: 10_000, maxAmount: 20_000 }, key());
    await bidsSvc.placeBid(broke, lotId, { amount: 21_000, maxAmount: 60_000 }, key());
    await bidsSvc.placeBid(a, lotId, { amount: 61_000, maxAmount: 90_000 }, key());
    // broke was outbid (deposit released) and now locks all their money on another lot.
    await bidsSvc.placeBid(broke, otherLot, { amount: 10_000, maxAmount: 120_000 }, key());
    expect(await balances(broke.id)).toEqual({ available: 0, held: 12_000 });
    clock.set('2030-01-01T12:00:01.000Z');
    await closing.closeLot(lotId);
    const [first] = await salesOf(lotId);
    clock.set('2030-01-03T12:00:02.000Z');
    await closing.defaultSale(first!.id);
    const all = await salesOf(lotId);
    expect(all[1]!.buyerId).toBe(ok.id);
  });

  it('on equal maxAmount in second chance, picks the bidder who reached that max earlier (not earlier lower bid)', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    const b = await newUser('buyer', 1_000_000);
    const winner = await newUser('buyer', 1_000_000);
    clock.set('2030-01-01T09:00:00.000Z');
    // A places an early lower max (15_000) at seq 1:
    await bidsSvc.placeBid(a, lotId, { amount: 10_000, maxAmount: 15_000 }, key());
    // B reaches 25_000 FIRST at seq 2:
    await bidsSvc.placeBid(b, lotId, { amount: 11_000, maxAmount: 25_000 }, key());
    // A later raises to 25_000 at seq 3 (ties B's max later):
    await bidsSvc.placeBid(a, lotId, { amount: 25_000, maxAmount: 25_000 }, key());
    // C wins at 50_000 and defaults:
    await bidsSvc.placeBid(winner, lotId, { amount: 26_000, maxAmount: 50_000 }, key());

    clock.set('2030-01-01T12:00:01.000Z');
    await closing.closeLot(lotId);
    const [first] = await salesOf(lotId);
    expect(first!.buyerId).toBe(winner.id);

    clock.set('2030-01-03T12:00:02.000Z');
    expect(await closing.defaultSale(first!.id)).toBe('offered_next');
    const all = await salesOf(lotId);
    expect(all[1]!.buyerId).toBe(b.id);
  });
});
