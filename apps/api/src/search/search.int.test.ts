import { beforeAll, describe, expect, it } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import { Meilisearch } from 'meilisearch';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, lots, searchOutbox, users } from '../db/schema.js';
import { SearchIndexer } from './indexer.js';
import { SearchService } from './search.js';

const { db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const meiliUrl = process.env.TEST_MEILI_URL ?? 'http://127.0.0.1:7700';
const apiKey = process.env.MEILI_MASTER_KEY ?? 'dev_meili_master_key_change_me_32chars';
const meili = new Meilisearch({ host: meiliUrl, apiKey });
const INDEX = 'lots_test';
const indexer = new SearchIndexer(db, clock, meili, INDEX);
const deadMeili = new Meilisearch({ host: 'http://127.0.0.1:1', apiKey });

let categoryId: string;
let cityId: string;
let sellerId: string;

async function newLot(over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId, categoryId, cityId, title: 'Vintage camera', description: 'Works well', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status: 'active', endsAt: new Date(clock.now().getTime() + 3_600_000),
    createdAt: clock.now(), ...over,
  }).returning();
  return lot!.id;
}

async function drainAll(i: SearchIndexer = indexer): Promise<void> {
  while ((await i.drain()) > 0) { /* keep draining until the queue is empty */ }
}

function search(q: Record<string, unknown> = {}, client: Meilisearch = meili) {
  return new SearchService(client, () => clock.now(), INDEX).search(q);
}

async function pending(): Promise<number> {
  return (await db.select().from(searchOutbox).where(isNull(searchOutbox.processedAt))).length;
}

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  await meili.deleteIndexIfExists(INDEX);
  await indexer.ensureIndex();
  const [cat] = await db.insert(categories).values({ slug: 'c', nameUk: 'c', nameEn: 'c', namePl: 'c' }).returning();
  const [city] = await db.insert(cities).values({ slug: 'k', nameUk: 'k', nameEn: 'k', namePl: 'k' }).returning();
  const [u] = await db.insert(users).values({ email: 's@t.test', displayName: 'Seller One', passwordHash: 'x', role: 'seller' }).returning();
  categoryId = cat!.id;
  cityId = city!.id;
  sellerId = u!.id;
});

describe('search outbox + index', () => {
  it('enqueues on insert and on indexed changes only', async () => {
    const id = await newLot();
    expect(await pending()).toBe(1);
    await drainAll();
    await db.update(lots).set({ lastSeq: 5 }).where(eq(lots.id, id)); // not an indexed column
    expect(await pending()).toBe(0);
    await db.update(lots).set({ currentPrice: 12_000, bidCount: 1 }).where(eq(lots.id, id));
    expect(await pending()).toBe(1);
    await drainAll();
  });

  it('indexes only public lots and never the reserve price', async () => {
    const pub = await newLot({ title: 'Reserved vase', reservePrice: 777_777 });
    const draft = await newLot({ title: 'Reserved draft', status: 'draft' });
    await drainAll();
    const res = await search({ q: 'Reserved' });
    expect(res.items.map((i) => i.id)).toEqual([pub]);
    expect(res.items.map((i) => i.id)).not.toContain(draft);
    const raw = JSON.stringify(await meili.index(INDEX).getDocument(pub));
    expect(raw).not.toContain('777777');
    expect(raw).not.toContain('reservePrice');
    expect(res.items[0]!.reserveMet).toBe(false);
  });

  it('removes a lot from the index when it is taken down', async () => {
    const id = await newLot({ title: 'Doomed lamp' });
    await drainAll();
    expect((await search({ q: 'Doomed' })).total).toBe(1);
    await db.update(lots).set({ status: 'removed' }).where(eq(lots.id, id));
    await drainAll();
    expect((await search({ q: 'Doomed' })).total).toBe(0);
  });

  it('filters, sorts and returns facets', async () => {
    const [other] = await db.insert(categories).values({ slug: 'c2', nameUk: 'c', nameEn: 'c', namePl: 'c' }).returning();
    const otherCat = other!.id;
    await newLot({
      title: 'Zeta watch', categoryId: otherCat, currentPrice: 500_000, startPrice: 500_000,
      endsAt: new Date(clock.now().getTime() + 10 * 60_000),
    });
    await drainAll();
    const byCat = await search({ q: 'Zeta', categoryId: otherCat });
    expect(byCat.items).toHaveLength(1);
    expect(byCat.facets.categoryId[otherCat]).toBe(1);
    expect((await search({ q: 'Zeta', maxPrice: 1000 })).total).toBe(0);
    expect((await search({ endingWithinMinutes: 30 })).items.map((i) => i.title)).toContain('Zeta watch');
    const asc = await search({ sort: 'price_asc', pageSize: 100 });
    const prices = asc.items.map((i) => i.currentPrice);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('rejects invalid search input with a validation error', async () => {
    await expect(search({ pageSize: 1000 })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('lag is far below 5 s: a change is searchable right after one drain', async () => {
    const id = await newLot({ title: 'Lagtest sofa' });
    const t0 = Date.now();
    await drainAll();
    expect((await search({ q: 'Lagtest' })).items[0]!.id).toBe(id);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('concurrent drains do not lose or duplicate work', async () => {
    for (let i = 0; i < 20; i++) await newLot({ title: `Parallel item ${i}` });
    await Promise.all([indexer.drain(), indexer.drain(), indexer.drain()]);
    await drainAll();
    expect(await pending()).toBe(0);
    expect((await search({ q: 'Parallel', pageSize: 100 })).total).toBe(20);
  });
});

describe('Meilisearch outage (acceptance 13)', () => {
  it('keeps writes working, search gives a clear 503, and the index catches up from the outbox', async () => {
    const down = new SearchIndexer(db, clock, deadMeili, INDEX);
    const id = await newLot({ title: 'Outage piano' }); // writes are unaffected by the index being down
    await expect(down.drain()).rejects.toThrow();
    expect(await pending()).toBeGreaterThan(0); // rolled back, nothing lost
    await expect(search({ q: 'Outage' }, deadMeili)).rejects.toMatchObject({ status: 503, code: 'SEARCH_UNAVAILABLE' });

    await drainAll(); // Meilisearch is back
    expect((await search({ q: 'Outage' })).items.map((i) => i.id)).toEqual([id]);
  });
});

describe('full reindex', () => {
  it('rebuilds from Postgres in one call and drops stale documents', async () => {
    await meili.index(INDEX).addDocuments([{ id: '00000000-0000-0000-0000-00000000dead', title: 'Ghost', status: 'active' }]).waitTask();
    expect((await search({ q: 'Ghost' })).total).toBe(1);
    const expected = (await db.select().from(lots)).filter((l) => l.status === 'active').length;
    const total = await indexer.reindexAll();
    await drainAll();
    expect(total).toBe(expected);
    expect((await search({ q: 'Ghost' })).total).toBe(0);
    expect((await search({ pageSize: 100, status: 'active' })).total).toBe(expected);
  });
});
