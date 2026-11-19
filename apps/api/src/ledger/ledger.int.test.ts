import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, runMigrations } from '../db/client.js';
import { users } from '../db/schema.js';
import { withIdempotency } from '../common/idempotency/idempotency.js';
import { balanceOf, findUnbalancedTransactions } from './ledger.js';
import { getBalance, holdDepositForMax, releaseDeposit, topUp } from './wallet.js';
import { lots, categories, cities } from '../db/schema.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const RELEASED_AT = new Date('2030-01-01T00:00:00Z');

async function newUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${Math.random()}@t.test`, displayName: 'T', passwordHash: 'x' })
    .returning();
  return u!.id;
}

let lotId: string;
beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const seller = await newUser();
  const [cat] = await db.insert(categories).values({ slug: 'c', nameUk: 'c', nameEn: 'c', namePl: 'c' }).returning();
  const [city] = await db.insert(cities).values({ slug: 'k', nameUk: 'k', nameEn: 'k', namePl: 'k' }).returning();
  const [lot] = await db
    .insert(lots)
    .values({
      sellerId: seller, categoryId: cat!.id, cityId: city!.id, title: 'L', description: 'D',
      startPrice: 10_000, currentPrice: 10_000, durationDays: 3, condition: 'good', status: 'active',
    })
    .returning();
  lotId = lot!.id;
});
afterAll(() => pool.end());

describe('wallet', () => {
  it('top-up applies once per effectKey', async () => {
    const u = await newUser();
    await db.transaction(async (tx) => {
      expect((await topUp(tx, u, 10_000, `topup:${u}`)).applied).toBe(true);
      expect((await topUp(tx, u, 10_000, `topup:${u}`)).applied).toBe(false);
    });
    await db.transaction(async (tx) => expect((await getBalance(tx, u)).available).toBe(10_000));
  });

  it('holds only the difference when max grows and refuses decrease', async () => {
    const u = await newUser();
    await db.transaction((tx) => topUp(tx, u, 100_000, `t:${u}`));
    await db.transaction(async (tx) => {
      expect(await holdDepositForMax(tx, u, lotId, 20_000)).toBe(5000);
      expect(await holdDepositForMax(tx, u, lotId, 100_000)).toBe(5000);
      expect(await holdDepositForMax(tx, u, lotId, 200_000)).toBe(10_000);
      await expect(holdDepositForMax(tx, u, lotId, 20_000)).rejects.toMatchObject({ code: 'BID_MAX_DECREASE' });
    });
  });

  it('rejects hold above available and releases in full', async () => {
    const u = await newUser();
    await db.transaction((tx) => topUp(tx, u, 6000, `t:${u}`));
    await expect(
      db.transaction((tx) => holdDepositForMax(tx, u, lotId, 1_000_000)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await db.transaction(async (tx) => {
      await holdDepositForMax(tx, u, lotId, 10_000);
      expect(await getBalance(tx, u)).toEqual({ available: 1000, held: 5000 });
      expect(await releaseDeposit(tx, u, lotId, RELEASED_AT)).toBe(5000);
      expect(await releaseDeposit(tx, u, lotId, RELEASED_AT)).toBe(0);
      expect(await getBalance(tx, u)).toEqual({ available: 6000, held: 0 });
    });
  });

  it('keeps the whole ledger balanced and gateway mirrors user money', async () => {
    await db.transaction(async (tx) => {
      expect(await findUnbalancedTransactions(tx)).toEqual([]);
      const gw = await balanceOf(tx, { type: 'gateway' });
      const r = await tx.execute(sql`select coalesce(sum(balance),0)::bigint as s from accounts where type <> 'gateway'`);
      expect(gw + Number((r.rows[0] as { s: string }).s)).toBe(0);
    });
  });
});

describe('idempotency', () => {
  it('runs the handler once for 10 parallel identical requests', async () => {
    const u = await newUser();
    let calls = 0;
    const run = () =>
      withIdempotency(db, { userId: u, scope: 'topup', key: 'k1', body: { amount: 5, b: 1 } }, async (tx) => {
        calls += 1;
        await topUp(tx, u, 5000, `idem:${u}:k1`);
        return { status: 201, body: { ok: true } };
      });
    const results = await Promise.all(Array.from({ length: 10 }, run));
    expect(calls).toBe(1);
    expect(results.every((r) => r.status === 201 && (r.body as { ok: boolean }).ok)).toBe(true);
    expect(results.filter((r) => r.replayed)).toHaveLength(9);
    await db.transaction(async (tx) => expect((await getBalance(tx, u)).available).toBe(5000));
  });

  it('rejects the same key with a different body (422)', async () => {
    const u = await newUser();
    const h = async () => ({ status: 200, body: {} });
    await withIdempotency(db, { userId: u, scope: 's', key: 'k', body: { a: 1 } }, h);
    await expect(
      withIdempotency(db, { userId: u, scope: 's', key: 'k', body: { a: 2 } }, h),
    ).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    const same = await withIdempotency(db, { userId: u, scope: 's', key: 'k', body: { a: 1 } }, h);
    expect(same.replayed).toBe(true);
  });

  it('does not store the key when the handler fails', async () => {
    const u = await newUser();
    await expect(
      withIdempotency(db, { userId: u, scope: 's', key: 'f', body: {} }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const ok = await withIdempotency(db, { userId: u, scope: 's', key: 'f', body: {} }, async () => ({ status: 200, body: 1 }));
    expect(ok.replayed).toBe(false);
  });
});
