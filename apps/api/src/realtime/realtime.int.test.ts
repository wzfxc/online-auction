import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import { FakeClock } from '../common/clock/clock.js';
import { BidService } from '../bids/bids.js';
import { DEFAULT_DATABASE_URL, createDb, runMigrations } from '../db/client.js';
import { categories, cities, lots, users } from '../db/schema.js';
import { topUp } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';
import { RealtimeServer, type SubscribeAck } from './realtime.js';

const dbUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const { pool, db } = createDb(dbUrl);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const bidSvc = new BidService(db, clock);

const tokens = new Map<string, Principal>();
const servers: { rt: RealtimeServer; http: HttpServer; url: string }[] = [];
const sockets: Socket[] = [];

let categoryId = '';
let cityId = '';
let seller: Principal;
let keySeq = 0;
const key = () => `rt-${++keySeq}`;

async function newUser(funds = 1_000_000): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'Тест Юзер', passwordHash: 'x', role: 'buyer' }).returning();
  await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  const p: Principal = { id: u!.id, role: 'buyer' };
  tokens.set(`tok-${u!.id}`, p);
  return p;
}

async function newLot(over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'L', description: 'D', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status: 'active', endsAt: new Date('2030-01-04T00:00:00Z'), ...over,
  }).returning();
  return lot!.id;
}

async function startReplica(): Promise<{ rt: RealtimeServer; http: HttpServer; url: string }> {
  const http = createServer();
  const rt = new RealtimeServer({
    db, clock, databaseUrl: dbUrl, redisUrl,
    authenticate: (t) => Promise.resolve(tokens.get(t) ?? null),
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  await rt.start(http);
  const s = { rt, http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
  servers.push(s);
  return s;
}

async function client(url: string, user?: Principal): Promise<Socket> {
  const s = connect(url, { auth: user ? { token: `tok-${user.id}` } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
  return s;
}

const subscribe = (s: Socket, lotId: string, lastSeq?: number): Promise<SubscribeAck> =>
  s.timeout(5000).emitWithAck('lot:subscribe', { lotId, lastSeq }) as Promise<SubscribeAck>;

function next<T>(s: Socket, event: string, ms = 3000): Promise<{ data: T; at: number }> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no ${event} within ${ms}ms`)), ms);
    s.once(event, (data: T) => { clearTimeout(t); res({ data, at: Date.now() }); });
  });
}

const quiet = (s: Socket, event: string, ms = 600): Promise<boolean> =>
  new Promise((res) => {
    let got = false;
    s.once(event, () => { got = true; });
    setTimeout(() => res(!got), ms);
  });

let a: Awaited<ReturnType<typeof startReplica>>;
let b: Awaited<ReturnType<typeof startReplica>>;

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const [cat] = await db.insert(categories).values({ slug: 'c', nameUk: 'c', nameEn: 'c', namePl: 'c' }).returning();
  const [city] = await db.insert(cities).values({ slug: 'k', nameUk: 'k', nameEn: 'k', namePl: 'k' }).returning();
  categoryId = cat!.id;
  cityId = city!.id;
  const [s] = await db.insert(users).values({ email: 's@t.test', displayName: 'Seller', passwordHash: 'x', role: 'seller' }).returning();
  seller = { id: s!.id, role: 'seller' };
  a = await startReplica();
  b = await startReplica();
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  for (const s of servers) {
    await s.rt.stop();
    s.http.close();
  }
  await pool.end();
});

describe('live updates across two api replicas', () => {
  it('a bid committed through replica A reaches a client on replica B in under a second', async () => {
    const lotId = await newLot({ reservePrice: 99_999 });
    const bidder = await newUser();
    const watcher = await client(b.url);
    expect((await subscribe(watcher, lotId)).ok).toBe(true);
    const got = next<{ seq: number; currentPrice: number }>(watcher, 'lot:update');
    const start = Date.now();
    await bidSvc.placeBid(bidder, lotId, { amount: 10_000 }, key());
    const { data, at } = await got;
    expect(at - start).toBeLessThan(1000);
    expect(data).toMatchObject({ seq: 1, currentPrice: 10_000 });
  });

  it('never exposes the reserve price or the leader in snapshots, updates or catch-up', async () => {
    const lotId = await newLot({ reservePrice: 77_777 });
    const bidder = await newUser();
    const watcher = await client(a.url);
    const ack = await subscribe(watcher, lotId, 0);
    const update = next<unknown>(watcher, 'lot:update');
    await bidSvc.placeBid(bidder, lotId, { amount: 10_000, maxAmount: 50_000 }, key());
    const payloads = JSON.stringify([ack, (await update).data, await subscribe(watcher, lotId, 0)]);
    expect(payloads).not.toMatch(/reserve|77777|leader|maxAmount|50000/i);
  });

  it('the private outbid notice reaches only the outbid user, on whichever replica they are on', async () => {
    const lotId = await newLot();
    const first = await newUser();
    const second = await newUser();
    const bystander = await newUser();
    await bidSvc.placeBid(first, lotId, { amount: 10_000 }, key());
    const victim = await client(b.url, first);
    const winner = await client(a.url, second);
    const other = await client(b.url, bystander);
    const notice = next<{ lotId: string; currentPrice: number }>(victim, 'user:outbid');
    const winnerQuiet = quiet(winner, 'user:outbid');
    const otherQuiet = quiet(other, 'user:outbid');
    await bidSvc.placeBid(second, lotId, { amount: 11_000 }, key());
    expect((await notice).data).toMatchObject({ lotId, currentPrice: 11_000 });
    expect(await winnerQuiet).toBe(true);
    expect(await otherQuiet).toBe(true);
  });

  it('a reconnecting client catches up missed bids by seq and gets the current price', async () => {
    const lotId = await newLot();
    const x = await newUser();
    const y = await newUser();
    const watcher = await client(a.url, x);
    const first = await subscribe(watcher, lotId);
    expect(first.ok && first.snapshot.seq).toBe(0);
    watcher.disconnect();
    await bidSvc.placeBid(x, lotId, { amount: 10_000 }, key());
    await bidSvc.placeBid(y, lotId, { amount: 11_000 }, key());
    const again = await client(b.url, x);
    const ack = await subscribe(again, lotId, 0);
    if (!ack.ok) throw new Error('subscribe failed');
    expect(ack.snapshot).toMatchObject({ seq: 2, currentPrice: 11_000 });
    expect(ack.missed.map((m) => m.seq)).toEqual([1, 2]);
    expect(ack.missed[0]).toMatchObject({ own: true });
    expect(ack.missed[1]).toMatchObject({ own: false, bidder: 'Т***р' });
  });

  it('timer base is the server clock: time:sync and snapshots carry server time, not the client clock', async () => {
    const lotId = await newLot();
    const c = await client(a.url);
    const sync = await c.timeout(5000).emitWithAck('time:sync') as { serverTime: string };
    expect(sync.serverTime).toBe(clock.now().toISOString());
    const ack = await subscribe(c, lotId);
    expect(ack.ok && ack.snapshot.serverTime).toBe(clock.now().toISOString());
  });

  it('refuses invalid tokens, invalid payloads and non-public lots', async () => {
    const lotId = await newLot();
    const draft = await newLot({ status: 'draft', endsAt: null });
    const anon = await client(a.url);
    expect(await subscribe(anon, draft)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await subscribe(anon, 'not-a-uuid')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(await subscribe(anon, lotId, 1e20)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    await expect(client(a.url, { id: 'nope', role: 'buyer' })).rejects.toThrow('UNAUTHORIZED');
  });

  it('announces removal when a lot leaves the public statuses', async () => {
    const lotId = await newLot();
    const w = await client(b.url);
    await subscribe(w, lotId);
    const removed = next<{ lotId: string }>(w, 'lot:removed');
    await db.execute(sql`update lots set status = 'removed', updated_at = now() where id = ${lotId}`);
    expect((await removed).data).toEqual({ lotId });
  });
});
