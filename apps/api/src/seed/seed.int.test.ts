import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { bidStep } from '@auction/shared';
import { BidService } from '../bids/bids.js';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { lots, users } from '../db/schema.js';
import { findUnbalancedTransactions } from '../ledger/ledger.js';
import { MemoryStorage } from '../media/storage.js';
import { runSeed, SEED_DEFAULTS, type SeedOptions } from './seed.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const storage = new MemoryStorage();
const small: SeedOptions = {
  ...SEED_DEFAULTS, users: 300, lots: 1_000, active: 100, endingSoon: 20, inReview: 10, bids: 5_000, sellers: 40,
};

const scalar = async (q: ReturnType<typeof sql>): Promise<number> => {
  const row = (await db.execute(q)).rows[0] as Record<string, unknown>;
  return Number(Object.values(row)[0]);
};

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
});
afterAll(() => pool.end());

describe('seed', () => {
  it('creates the requested volumes, is idempotent, and leaves the ledger balanced', async () => {
    const first = await runSeed(db, pool, clock.now(), storage, small);
    expect(first).toMatchObject({ seeded: true, users: 300, lots: 1_000, bids: 5_000 });
    expect(first.photos).toBe(110); // active + in_review lots

    expect(await scalar(sql`select count(*)::int from categories`)).toBe(30);
    expect(await scalar(sql`select count(*)::int from cities`)).toBe(15);
    expect(await scalar(sql`select count(*)::int from lots where status = 'active'`)).toBe(100);
    expect(await scalar(sql`select count(*)::int from lots where status = 'active' and ends_at <= ${clock.now().toISOString()}::timestamptz + interval '1 hour'`)).toBe(20);
    expect(await scalar(sql`select count(*)::int from lots l where bid_count <> (select count(*) from bids b where b.lot_id = l.id)`)).toBe(0);
    expect(storage.objects.size).toBe(220);

    const second = await runSeed(db, pool, clock.now(), storage, small);
    expect(second).toMatchObject({ seeded: false, users: 300, lots: 1_000, bids: 5_000, photos: 0 });

    // Concurrent runs (several workers) must not duplicate anything either.
    await Promise.all([1, 2, 3].map(() => runSeed(db, pool, clock.now(), storage, small)));
    expect(await scalar(sql`select count(*)::int from lots`)).toBe(1_000);

    expect(await findUnbalancedTransactions(db as never)).toEqual([]);
    expect(await scalar(sql`select count(*)::int from accounts a where a.balance <> coalesce((select sum(amount) from ledger_entries e where e.account_id = a.id), 0)`)).toBe(0);
  });

  it('seeded active lots accept real bids from a demo buyer with funds', async () => {
    const [lot] = await db.select().from(lots).where(eq(lots.status, 'active')).limit(1);
    const [demo] = await db.select().from(users).where(eq(users.email, 'buyer1@auction.test'));
    const amount = lot!.currentPrice + bidStep(lot!.currentPrice);
    const res = await new BidService(db, clock).placeBid({ id: demo!.id, role: 'buyer' }, lot!.id, { amount }, 'seed-bid-0001');
    expect(res.body.status).toBe('leading');
  });
});
