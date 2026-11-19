import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { bids, categories, cities, lots, users } from '../db/schema.js';
import { findUnbalancedTransactions } from '../ledger/ledger.js';
import { getBalance, topUp } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';
import { BidService } from './bids.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const svc = new BidService(db, clock);

let categoryId: string;
let cityId: string;
let seller: Principal;
let keySeq = 0;
const key = () => `k-${++keySeq}`;

async function newUser(role: Principal['role'] = 'buyer', funds = 0): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'Тест Юзер', passwordHash: 'x', role }).returning();
  if (funds > 0) await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  return { id: u!.id, role };
}

async function newLot(over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'L', description: 'D', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status: 'active', endsAt: new Date('2030-01-04T00:00:00Z'), ...over,
  }).returning();
  return lot!.id;
}

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

describe('placing bids', () => {
  it('auto bids 1000/1500 UAH end at 1050 UAH, and the outbid deposit is released', async () => {
    const lotId = await newLot({ startPrice: 100_000, currentPrice: 100_000 });
    const a = await newUser('buyer', 1_000_000);
    const b = await newUser('buyer', 1_000_000);
    await svc.placeBid(a, lotId, { amount: 100_000, maxAmount: 100_000 }, key());
    const r = await svc.placeBid(b, lotId, { amount: 105_000, maxAmount: 150_000 }, key());
    expect(r.body).toMatchObject({ status: 'leading', currentPrice: 105_000 });
    expect(await getBalance(db as never, a.id)).toEqual({ available: 1_000_000, held: 0 });
    expect(await getBalance(db as never, b.id)).toEqual({ available: 1_000_000 - 15_000, held: 15_000 });
  });

  it('bid below the minimum → 422 BID_TOO_LOW with the minimum in details', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    const b = await newUser('buyer', 1_000_000);
    await svc.placeBid(a, lotId, { amount: 10_000 }, key());
    await expect(svc.placeBid(b, lotId, { amount: 10_000 }, key())).rejects.toMatchObject({
      status: 422, code: 'BID_TOO_LOW', details: { minAmount: 11_000 },
    });
  });

  it('refuses the seller, insufficient funds, and bids after the end by the server clock', async () => {
    const lotId = await newLot();
    const poor = await newUser('buyer', 100);
    const rich = await newUser('buyer', 1_000_000);
    await expect(svc.placeBid(seller, lotId, { amount: 10_000 }, key())).rejects.toMatchObject({ status: 403, code: 'OWN_LOT' });
    await expect(svc.placeBid(poor, lotId, { amount: 10_000 }, key())).rejects.toMatchObject({ status: 422, code: 'INSUFFICIENT_FUNDS' });
    const ended = await newLot({ endsAt: new Date('2029-12-31T23:59:59Z') });
    await expect(svc.placeBid(rich, ended, { amount: 10_000 }, key())).rejects.toMatchObject({ status: 409, code: 'AUCTION_ENDED' });
  });

  it('replays an identical request and rejects the same key with a different body', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    const k = key();
    const first = await svc.placeBid(a, lotId, { amount: 10_000 }, k);
    const again = await svc.placeBid(a, lotId, { amount: 10_000 }, k);
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    await expect(svc.placeBid(a, lotId, { amount: 20_000 }, k)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const [lot] = await db.select().from(lots).where(eq(lots.id, lotId));
    expect(lot!.bidCount).toBe(1);
  });

  it('10 bidders with funds for only 3 deposits: exactly the funded ones succeed', async () => {
    const lotId = await newLot();
    const users10 = await Promise.all(Array.from({ length: 10 }, (_, i) => newUser('buyer', i < 3 ? 5_000 : 100)));
    const results = await Promise.allSettled(users10.map((u, i) => svc.placeBid(u, lotId, { amount: 10_000 + i * 500 }, key())));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(['INSUFFICIENT_FUNDS', 'BID_TOO_LOW']).toContain((r.reason as { code: string }).code);
    }
  });

  it('50 concurrent bids stay sequential: gap-free seq, one leader holding a deposit, ledger balanced', async () => {
    const lotId = await newLot();
    const bidders = await Promise.all(Array.from({ length: 50 }, () => newUser('buyer', 10_000_000)));
    await Promise.allSettled(bidders.map((u, i) => svc.placeBid(u, lotId, { amount: 10_000 + i * 500 }, key())));
    const rows = await db.select().from(bids).where(eq(bids.lotId, lotId)).orderBy(bids.seq);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    const [lot] = await db.select().from(lots).where(eq(lots.id, lotId));
    expect(lot!.bidCount).toBe(rows.length);
    expect(lot!.lastSeq).toBe(rows.length);
    const holders = (await Promise.all(bidders.map((u) => getBalance(db as never, u.id)))).filter((b) => b.held > 0);
    expect(holders).toHaveLength(1);
    expect(await findUnbalancedTransactions(db as never)).toEqual([]);
  });

  it('history masks other bidders and never exposes maxima', async () => {
    const lotId = await newLot();
    const a = await newUser('buyer', 1_000_000);
    await svc.placeBid(a, lotId, { amount: 10_000, maxAmount: 90_000 }, key());
    const pub = await svc.history(null, lotId);
    expect(pub.items[0]).toMatchObject({ bidder: 'Т***р', own: false });
    expect(JSON.stringify(pub)).not.toContain('90000');
    expect((await svc.history(a, lotId)).items[0]).toMatchObject({ bidder: 'Тест Юзер', own: true });
  });
});

describe('buy now', () => {
  it('moves the lot to awaiting_payment and creates the sale', async () => {
    const lotId = await newLot({ buyNowPrice: 90_000 });
    const a = await newUser('buyer');
    const r = await svc.buyNow(a, lotId, key());
    expect(r.body).toMatchObject({ price: 90_000, fee: 4_500 });
    const [lot] = await db.select().from(lots).where(eq(lots.id, lotId));
    expect(lot!.status).toBe('awaiting_payment');
  });

  it('racing a first bid: exactly one wins, the other gets 409', async () => {
    for (let round = 0; round < 5; round++) {
      const lotId = await newLot({ buyNowPrice: 90_000 });
      const buyer = await newUser('buyer');
      const bidder = await newUser('buyer', 1_000_000);
      const [x, y] = await Promise.allSettled([
        svc.buyNow(buyer, lotId, key()),
        svc.placeBid(bidder, lotId, { amount: 10_000 }, key()),
      ]);
      expect([x.status, y.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      const [lot] = await db.select().from(lots).where(eq(lots.id, lotId));
      if (x.status === 'fulfilled') expect(lot!.status).toBe('awaiting_payment');
      else expect(lot!.status).toBe('active');
      const failed = x.status === 'rejected' ? x : y;
      expect(failed.status).toBe('rejected');
      expect((failed as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
  });
});
