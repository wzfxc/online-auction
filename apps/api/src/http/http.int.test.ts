import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { hashPassword } from '../auth/crypto.js';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, users } from '../db/schema.js';
import { topUp } from '../ledger/wallet.js';
import { signWebhook } from '../payments-stub/signature.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { Meilisearch } from 'meilisearch';
import { MemoryStorage } from '../media/storage.js';
import { createApp } from './setup.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock();
let app: NestExpressApplication;
let categoryId = '';
let cityId = '';

const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function register(role: 'buyer' | 'seller', email: string) {
  const res = await http().post('/auth/register').send({ email, password: 'password123', displayName: 'Тест Юзер', role });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

const lotBody = () => ({
  title: 'Фотоапарат Canon', description: 'Робочий, у гарному стані', categoryId, cityId, condition: 'good',
  startPrice: 10_000, reservePrice: 50_000, durationDays: 3,
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
  const provider = new StubPaymentProvider({
    clock, secret: 's', mode: 'none', baseUrl: 'http://stub', random: () => 0,
    deliver: async () => undefined, schedule: () => undefined,
  });
  app = await createApp(
    { db, clock, paymentProvider: provider, storage: new MemoryStorage(), meili: new Meilisearch({ host: 'http://127.0.0.1:1' }), config: { jwtSecret: 'x'.repeat(32), tokenTtlSeconds: 3600, webhookSecret: 's' } },
    { logger: false },
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('error envelope (invariant 15)', () => {
  it('returns {code,message} for malformed JSON, unknown routes, bad uuids and missing auth', async () => {
    const bad = await http().post('/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_ERROR' });

    const missing = await http().get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');

    const uuid = await http().get('/lots/not-a-uuid');
    expect(uuid.status).toBe(400);
    expect(uuid.body.code).toBe('VALIDATION_ERROR');

    const noAuth = await http().get('/wallet');
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.code).toBe('UNAUTHORIZED');
  });

  it('validates registration input and rejects duplicates and wrong passwords', async () => {
    const invalid = await http().post('/auth/register').send({ email: 'nope', password: '1' });
    expect(invalid.status).toBe(400);
    expect(Array.isArray(invalid.body.details)).toBe(true);

    await register('buyer', 'dup@t.test');
    const dup = await http().post('/auth/register').send({ email: 'dup@t.test', password: 'password123', displayName: 'Other' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');

    const wrong = await http().post('/auth/login').send({ email: 'dup@t.test', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('lot → bid flow over HTTP', () => {
  it('enforces roles, hides the reserve, and makes bids idempotent', async () => {
    const seller = await register('seller', 'seller@t.test');
    const buyer = await register('buyer', 'buyer@t.test');
    const [mod] = await db.insert(users).values({
      email: 'mod@t.test', displayName: 'Mod', role: 'moderator', passwordHash: await hashPassword('password123'),
    }).returning();
    const modLogin = await http().post('/auth/login').send({ email: 'mod@t.test', password: 'password123' });
    expect(modLogin.status).toBe(200);
    expect(modLogin.body.user.id).toBe(mod!.id);
    const moderator = modLogin.body.token as string;

    expect((await http().post('/lots').set(bearer(buyer.token)).send(lotBody())).status).toBe(403);
    expect((await http().post('/lots').set(bearer(seller.token)).send({ title: 'x' })).status).toBe(400);

    const created = await http().post('/lots').set(bearer(seller.token)).send(lotBody());
    expect(created.status).toBe(201);
    expect(created.body.reservePrice).toBe(50_000);
    const lotId = created.body.id as string;

    // Unpublished lot: invisible to the public, visible to the owner.
    expect((await http().get(`/lots/${lotId}`)).status).toBe(404);
    expect((await http().get(`/lots/${lotId}`).set(bearer(seller.token))).status).toBe(200);

    expect((await http().post(`/lots/${lotId}/submit`).set(bearer(seller.token))).status).toBe(200);
    expect((await http().post(`/lots/${lotId}/approve`).set(bearer(seller.token))).status).toBe(403);
    expect((await http().post(`/lots/${lotId}/approve`).set(bearer(moderator))).status).toBe(200);

    const pub = await http().get(`/lots/${lotId}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('reservePrice');

    await db.transaction((tx) => topUp(tx, buyer.id, 1_000_000, 'seed:buyer'));
    const key = 'bid-key-0001';
    const noKey = await http().post(`/lots/${lotId}/bids`).set(bearer(buyer.token)).send({ amount: 10_000 });
    expect(noKey.status).toBe(400);

    const first = await http().post(`/lots/${lotId}/bids`).set(bearer(buyer.token)).set('Idempotency-Key', key).send({ amount: 10_000 });
    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBe('false');
    const replay = await http().post(`/lots/${lotId}/bids`).set(bearer(buyer.token)).set('Idempotency-Key', key).send({ amount: 10_000 });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);

    const reused = await http().post(`/lots/${lotId}/bids`).set(bearer(buyer.token)).set('Idempotency-Key', key).send({ amount: 20_000 });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const own = await http().post(`/lots/${lotId}/bids`).set(bearer(seller.token)).set('Idempotency-Key', 'seller-key-1').send({ amount: 20_000 });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('OWN_LOT');

    const wallet = await http().get('/wallet').set(bearer(buyer.token));
    expect(wallet.body).toEqual({ available: 1_000_000 - 5_000, held: 5_000 });

    const history = await http().get(`/lots/${lotId}/bids`);
    expect(history.status).toBe(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].bidder).toContain('***');
  });
});

describe('remaining endpoints', () => {
  it('guards moderation and notifications, and keeps search outages in the error envelope', async () => {
    const buyer = await register('buyer', 'rest-buyer@t.test');
    expect((await http().post('/moderation/claim').set(bearer(buyer.token))).status).toBe(403);
    expect((await http().get('/notifications')).status).toBe(401);
    const list = await http().get('/notifications').set(bearer(buyer.token));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    const read = await http().post('/notifications/read').set(bearer(buyer.token)).send({});
    expect(read.body).toEqual({ updated: 0 });
    expect((await http().post('/notifications/read').set(bearer(buyer.token)).send({ ids: ['x'] })).status).toBe(400);

    const search = await http().get('/search').query({ q: 'canon' });
    expect(search.status).toBe(503);
    expect(search.body.code).toBe('SEARCH_UNAVAILABLE');
    expect((await http().get('/search').query({ page: '0' })).status).toBe(400);
  });

  it('accepts a signed payment webhook exactly once and rejects a bad signature', async () => {
    const buyer = await register('buyer', 'pay-buyer@t.test');
    const top = await http().post('/wallet/top-ups').set(bearer(buyer.token)).set('Idempotency-Key', 'topup-key-01').send({ amount: 20_000 });
    expect(top.status).toBe(201);
    const body = JSON.stringify({ providerEventId: 'evt_1', paymentId: top.body.paymentId, type: 'payment.succeeded' });

    const bad = await http().post('/payments/webhook').set('Content-Type', 'application/json').set('x-payment-signature', 'nope').send(body);
    expect(bad.status).toBe(401);
    const sig = signWebhook(body, 's');
    const ok = await http().post('/payments/webhook').set('Content-Type', 'application/json').set('x-payment-signature', sig).send(body);
    expect(ok.body).toEqual({ duplicate: false });
    const dup = await http().post('/payments/webhook').set('Content-Type', 'application/json').set('x-payment-signature', sig).send(body);
    expect(dup.body).toEqual({ duplicate: true });
    const wallet = await http().get('/wallet').set(bearer(buyer.token));
    expect(wallet.body).toEqual({ available: 20_000, held: 0 });
  });
});
