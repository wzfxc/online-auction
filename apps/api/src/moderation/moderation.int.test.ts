import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { REVIEW_LEASE_MINUTES } from '@auction/shared';
import { BidService } from '../bids/bids.js';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { bidderMaxes, categories, cities, lotEvents, lots, users } from '../db/schema.js';
import { findUnbalancedTransactions } from '../ledger/ledger.js';
import { getBalance, topUp } from '../ledger/wallet.js';
import { LotService, type Principal } from '../lots/lots.js';
import { ModerationService } from './moderation.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const mod = new ModerationService(db, clock);
const lotSvc = new LotService(db, clock);
const bidSvc = new BidService(db, clock);

let categoryId: string;
let cityId: string;
let seller: Principal;
let keySeq = 0;

async function newUser(role: Principal['role'] = 'buyer', funds = 0): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'Тест Юзер', passwordHash: 'x', role }).returning();
  if (funds > 0) await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  return { id: u!.id, role };
}

async function newLot(over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'L', description: 'D', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status: 'in_review', createdAt: clock.now(), ...over,
  }).returning();
  return lot!.id;
}

async function clearQueue(): Promise<void> {
  await db.update(lots).set({ status: 'rejected' }).where(eq(lots.status, 'in_review'));
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

describe('review queue', () => {
  it('two moderators claiming at once get different lots', async () => {
    await clearQueue();
    await newLot();
    await newLot();
    const [m1, m2] = [await newUser('moderator'), await newUser('moderator')];
    const [a, b] = await Promise.all([mod.claimNext(m1), mod.claimNext(m2)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it('with one lot only one of many concurrent moderators gets it', async () => {
    await clearQueue();
    await newLot();
    const mods = await Promise.all(Array.from({ length: 8 }, () => newUser('moderator')));
    const got = (await Promise.all(mods.map((m) => mod.claimNext(m)))).filter((x) => x !== null);
    expect(got).toHaveLength(1);
  });

  it('returns the same lot to its holder while the lease is live, and an empty queue gives null', async () => {
    await clearQueue();
    const id = await newLot();
    const m = await newUser('moderator');
    expect((await mod.claimNext(m))!.id).toBe(id);
    expect((await mod.claimNext(m))!.id).toBe(id);
    expect(await mod.claimNext(await newUser('moderator'))).toBeNull();
  });

  it('an abandoned lot returns to the queue after the lease and goes to another moderator', async () => {
    await clearQueue();
    const id = await newLot();
    const [m1, m2] = [await newUser('moderator'), await newUser('moderator')];
    await mod.claimNext(m1);
    clock.advance((REVIEW_LEASE_MINUTES * 60 - 1) * 1000);
    expect(await mod.claimNext(m2)).toBeNull();
    clock.advance(2000);
    expect(await mod.releaseExpiredLeases()).toBe(1);
    expect(await mod.releaseExpiredLeases()).toBe(0);
    expect((await mod.claimNext(m2))!.id).toBe(id);
    const types = (await db.select().from(lotEvents).where(eq(lotEvents.lotId, id)).orderBy(lotEvents.id)).map((e) => e.type);
    expect(types).toEqual(['review_claimed', 'review_lease_expired', 'review_claimed']);
  });

  it('an expired lease is claimable even before the sweeper runs', async () => {
    await clearQueue();
    const id = await newLot();
    await mod.claimNext(await newUser('moderator'));
    clock.advance(REVIEW_LEASE_MINUTES * 60_000);
    expect((await mod.claimNext(await newUser('moderator')))!.id).toBe(id);
  });

  it("another moderator cannot decide a lot under someone's live lease", async () => {
    await clearQueue();
    const id = await newLot();
    const [m1, m2] = [await newUser('moderator'), await newUser('moderator')];
    await mod.claimNext(m1);
    await expect(lotSvc.approve(m2, id)).rejects.toMatchObject({ status: 409, code: 'LOT_CLAIMED' });
    await expect(lotSvc.reject(m2, id, { reason: 'nope nope' })).rejects.toMatchObject({ status: 409, code: 'LOT_CLAIMED' });
    expect((await lotSvc.approve(m1, id)).status).toBe('active');
  });

  it('non-moderators cannot claim', async () => {
    await expect(mod.claimNext(seller)).rejects.toMatchObject({ status: 403 });
  });
});

describe('removing a published lot', () => {
  it('releases every deposit, drops proxy maxima, records who to notify, keeps the ledger balanced', async () => {
    const lotId = await newLot({ status: 'active', endsAt: new Date('2030-01-04T00:00:00Z') });
    const a = await newUser('buyer', 1_000_000);
    const b = await newUser('buyer', 1_000_000);
    await bidSvc.placeBid(a, lotId, { amount: 10_000, maxAmount: 30_000 }, `k-${++keySeq}`);
    await bidSvc.placeBid(b, lotId, { amount: 11_000 }, `k-${++keySeq}`);
    expect((await getBalance(db as never, a.id)).held).toBeGreaterThan(0);

    const m = await newUser('moderator');
    const removed = await mod.removeLot(m, lotId, { reason: 'Prohibited item' });
    expect(removed.status).toBe('removed');
    for (const u of [a, b]) expect(await getBalance(db as never, u.id)).toEqual({ available: 1_000_000, held: 0 });
    expect(await db.select().from(bidderMaxes).where(eq(bidderMaxes.lotId, lotId))).toHaveLength(0);

    const [ev] = (await db.select().from(lotEvents).where(eq(lotEvents.lotId, lotId))).filter((e) => e.type === 'removed');
    expect(ev!.payload).toMatchObject({ reason: 'Prohibited item' });
    // b was already outbid by a's proxy maximum (deposit released then), so only the leader a still holds one.
    expect((ev!.payload as { notifyUserIds: string[] }).notifyUserIds).toEqual([a.id]);
    expect(await findUnbalancedTransactions(db as never)).toEqual([]);
  });

  it('refuses non-active lots, non-moderators and a missing reason; removing twice is a 409', async () => {
    const m = await newUser('moderator');
    const draft = await newLot({ status: 'draft' });
    await expect(mod.removeLot(m, draft, { reason: 'because' })).rejects.toMatchObject({ status: 409, code: 'INVALID_LOT_TRANSITION' });
    const active = await newLot({ status: 'active', endsAt: new Date('2030-01-04T00:00:00Z') });
    await expect(mod.removeLot(seller, active, { reason: 'because' })).rejects.toMatchObject({ status: 403 });
    await expect(mod.removeLot(m, active, {})).rejects.toMatchObject({ status: 400 });
    await mod.removeLot(m, active, { reason: 'because' });
    await expect(mod.removeLot(m, active, { reason: 'because' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('review queue listing and claim by id', () => {
  it('lists in_review lots oldest first with live lease state, and only for moderators', async () => {
    await clearQueue();
    const first = await newLot({ title: 'First', createdAt: new Date('2029-12-31T00:00:00Z') });
    const second = await newLot({ title: 'Second', createdAt: new Date('2029-12-31T01:00:00Z'), reservePrice: 99_000 });
    await newLot({ status: 'active' }); // not in the queue
    const [m1, m2] = [await newUser('moderator'), await newUser('moderator')];

    const q1 = await mod.listQueue(m1);
    expect(q1.map((x) => x.id)).toEqual([first, second]);
    expect(q1.every((x) => !x.claimed && !x.claimedByMe)).toBe(true);
    expect(JSON.stringify(q1)).not.toContain('99000'); // reserve price never in the queue payload

    await mod.claimById(m1, second);
    const mine = await mod.listQueue(m1);
    expect(mine.find((x) => x.id === second)).toMatchObject({ claimed: true, claimedByMe: true });
    expect((await mod.listQueue(m2)).find((x) => x.id === second)).toMatchObject({ claimed: true, claimedByMe: false });

    await expect(mod.listQueue(seller)).rejects.toMatchObject({ status: 403 });
    await expect(mod.claimById(seller, first)).rejects.toMatchObject({ status: 403 });
  });

  it('claimById: foreign live lease → 409 LOT_CLAIMED, expired lease can be taken, non-queued lot → 404', async () => {
    await clearQueue();
    const id = await newLot();
    const [m1, m2] = [await newUser('moderator'), await newUser('moderator')];
    await mod.claimById(m1, id);
    await expect(mod.claimById(m2, id)).rejects.toMatchObject({ status: 409, code: 'LOT_CLAIMED' });
    await expect(mod.claimNext(m2)).resolves.toBeNull(); // claimNext also skips the leased lot
    await expect(mod.claimById(m1, id)).resolves.toMatchObject({ id }); // own lease renews

    clock.advance((REVIEW_LEASE_MINUTES + 1) * 60_000);
    const taken = await mod.claimById(m2, id);
    expect(taken.id).toBe(id);
    const [row] = await db.select().from(lots).where(eq(lots.id, id));
    expect(row!.moderatorId).toBe(m2.id);

    const active = await newLot({ status: 'active' });
    await expect(mod.claimById(m1, active)).rejects.toMatchObject({ status: 404 });
  });

  it('concurrent claimById by two moderators: exactly one wins', async () => {
    await clearQueue();
    const id = await newLot();
    const [m1, m2] = [await newUser('moderator'), await newUser('moderator')];
    const r = await Promise.allSettled([mod.claimById(m1, id), mod.claimById(m2, id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'LOT_CLAIMED' });
  });
});
