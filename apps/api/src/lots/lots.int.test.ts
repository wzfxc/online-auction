import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, lots, users } from '../db/schema.js';
import { LotService, type Principal } from './lots.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const svc = new LotService(db, clock);

let categoryId: string;
let cityId: string;
let seller: Principal;
let otherSeller: Principal;
let moderator: Principal;
let buyer: Principal;

async function newUser(role: Principal['role']): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'T', passwordHash: 'x', role }).returning();
  return { id: u!.id, role };
}

const input = () => ({
  title: 'Vintage camera', description: 'Works well', categoryId, cityId, condition: 'good',
  startPrice: 10_000, reservePrice: 50_000, buyNowPrice: 90_000, durationDays: 3,
});

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
  otherSeller = await newUser('seller');
  moderator = await newUser('moderator');
  buyer = await newUser('buyer');
});
afterAll(() => pool.end());

describe('lot lifecycle', () => {
  it('create → submit → approve sets ends_at from the clock and logs history', async () => {
    const lot = await svc.create(seller, input());
    expect(lot.status).toBe('draft');
    expect(lot.currentPrice).toBe(10_000);
    await svc.submit(seller, lot.id);
    const approved = await svc.approve(moderator, lot.id);
    expect(approved.status).toBe('active');
    expect(approved.endsAt).toBe('2030-01-04T00:00:00.000Z');
    const types = (await svc.history(seller, lot.id)).map((e) => e.type);
    expect(types).toEqual(['created', 'submitted', 'approved']);
  });

  it('rejects with a reason and lets the seller reopen', async () => {
    const lot = await svc.create(seller, input());
    await svc.submit(seller, lot.id);
    const rejected = await svc.reject(moderator, lot.id, { reason: 'Blurry photos' });
    expect(rejected.rejectionReason).toBe('Blurry photos');
    expect((await svc.reviseRejected(seller, lot.id)).status).toBe('draft');
  });

  it('refuses invalid transitions with 409', async () => {
    const lot = await svc.create(seller, input());
    await expect(svc.approve(moderator, lot.id)).rejects.toMatchObject({ status: 409, code: 'INVALID_LOT_TRANSITION' });
  });
});

describe('editing rules', () => {
  it('draft can change freely; startPrice resets currentPrice', async () => {
    const lot = await svc.create(seller, input());
    const updated = await svc.update(seller, lot.id, { title: 'New title', startPrice: 20_000 });
    expect(updated.title).toBe('New title');
    expect(updated.currentPrice).toBe(20_000);
  });

  it('rejects an update that breaks price consistency', async () => {
    const lot = await svc.create(seller, input());
    await expect(svc.update(seller, lot.id, { startPrice: 95_000 })).rejects.toMatchObject({ status: 400 });
  });

  it('active lot with 0 bids can edit fields; once a bid exists, only description can be appended', async () => {
    const lot = await svc.create(seller, input());
    await svc.submit(seller, lot.id);
    await svc.approve(moderator, lot.id);

    const editedActive = await svc.update(seller, lot.id, { title: 'Updated Before First Bid', startPrice: 20_000 });
    expect(editedActive.title).toBe('Updated Before First Bid');
    expect(editedActive.currentPrice).toBe(20_000);

    // Simulate first bid placed:
    await db.update(lots).set({ bidCount: 1, currentPrice: 20_000 }).where(sql`id = ${lot.id}`);
    await expect(svc.update(seller, lot.id, { title: 'Hacked' })).rejects.toMatchObject({ status: 422, code: 'LOT_PUBLISHED' });
    const after = await svc.update(seller, lot.id, { append: 'Extra info' });
    expect(after.description).toBe('Works well\n\nExtra info');
    expect(after.title).toBe('Updated Before First Bid');
  });

  it('rejects unknown categoryId or cityId with 400 validation error instead of 500', async () => {
    await expect(svc.create(seller, { ...input(), categoryId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(svc.create(seller, { ...input(), cityId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('permissions and privacy', () => {
  it('only sellers create; moderators-only for review', async () => {
    await expect(svc.create(buyer, input())).rejects.toMatchObject({ status: 403 });
    const lot = await svc.create(seller, input());
    await svc.submit(seller, lot.id);
    await expect(svc.approve(seller, lot.id)).rejects.toMatchObject({ status: 403 });
  });

  it("another seller cannot edit or submit someone else's lot", async () => {
    const lot = await svc.create(seller, input());
    await expect(svc.update(otherSeller, lot.id, { title: 'x y z' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.submit(otherSeller, lot.id)).rejects.toMatchObject({ status: 404 });
  });

  it('hides drafts from the public but not from the owner or moderator', async () => {
    const lot = await svc.create(seller, input());
    await expect(svc.get(buyer, lot.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.get(null, lot.id)).rejects.toMatchObject({ status: 404 });
    expect((await svc.get(seller, lot.id)).id).toBe(lot.id);
    expect((await svc.get(moderator, lot.id)).id).toBe(lot.id);
  });

  it('never exposes reservePrice in public DTOs; only the owner DTO has it', async () => {
    const created = await svc.create(seller, input());
    expect(created.reservePrice).toBe(50_000);
    await svc.submit(seller, created.id);
    await svc.approve(moderator, created.id);
    for (const viewer of [buyer, moderator, seller, null]) {
      const dto = await svc.get(viewer, created.id);
      expect(JSON.stringify(dto)).not.toContain('50000');
      expect(dto).not.toHaveProperty('reservePrice');
      expect(dto.reserveMet).toBe(false);
    }
  });

  it('reserveMet becomes true once the price reaches the reserve', async () => {
    const created = await svc.create(seller, input());
    await svc.submit(seller, created.id);
    await svc.approve(moderator, created.id);
    await db.update(lots).set({ bidCount: 1, currentPrice: 50_000 }).where(sql`id = ${created.id}`);
    expect((await svc.get(buyer, created.id)).reserveMet).toBe(true);
  });

  it('history is private to the seller and moderators', async () => {
    const lot = await svc.create(seller, input());
    await expect(svc.history(buyer, lot.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.history(otherSeller, lot.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('concurrency', () => {
  it('two moderators approving the same lot: exactly one succeeds', async () => {
    const lot = await svc.create(seller, input());
    await svc.submit(seller, lot.id);
    const mod2 = await newUser('moderator');
    const results = await Promise.allSettled([svc.approve(moderator, lot.id), svc.approve(mod2, lot.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await svc.history(seller, lot.id)).filter((e) => e.type === 'approved')).toHaveLength(1);
  });
});
