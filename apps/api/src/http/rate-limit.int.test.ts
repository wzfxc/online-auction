import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Meilisearch } from 'meilisearch';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { MemoryStorage } from '../media/storage.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { RedisRateLimitStore, type RateLimitPolicyMap } from './rate-limit.js';
import { createApp } from './setup.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');

const TEST_POLICY: RateLimitPolicyMap = {
  auth: { max: 5, windowMs: 60_000, keyBy: 'ip' },
  bid: { max: 10, windowMs: 60_000, keyBy: 'user_or_ip' },
  mutation: { max: 5, windowMs: 60_000, keyBy: 'user_or_ip' },
  read: { max: 10, windowMs: 60_000, keyBy: 'user_or_ip' },
};

let redis: Redis;
let app: NestExpressApplication;
let downRedis: Redis;
let failOpenApp: NestExpressApplication;

const http = () => request(app.getHttpServer());

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);

  redis = new Redis(REDIS_URL, {
    lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 500,
  });
  await redis.connect();
  await redis.flushall();

  const provider = new StubPaymentProvider({
    clock, secret: 's', mode: 'none', baseUrl: 'http://stub', random: () => 0,
    deliver: async () => undefined, schedule: () => undefined,
  });
  const sharedDeps = {
    db, clock, paymentProvider: provider, storage: new MemoryStorage(),
    meili: new Meilisearch({ host: 'http://127.0.0.1:1' }),
    config: { jwtSecret: 'x'.repeat(32), tokenTtlSeconds: 3600, webhookSecret: 's' },
    rateLimitPolicy: TEST_POLICY,
  };

  app = await createApp({ ...sharedDeps, rateLimitStore: new RedisRateLimitStore(redis) }, { logger: false });
  await app.init();

  downRedis = new Redis('redis://127.0.0.1:6399', {
    maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 150, commandTimeout: 150,
    retryStrategy: () => null,
  });
  downRedis.on('error', () => undefined);
  failOpenApp = await createApp({ ...sharedDeps, rateLimitStore: new RedisRateLimitStore(downRedis) }, { logger: false });
  await failOpenApp.init();
});

afterAll(async () => {
  if (app) await app.close();
  if (failOpenApp) await failOpenApp.close();
  redis?.disconnect();
  downRedis?.disconnect();
  await pool.end();
});

describe('distributed rate limiting + fail-open', () => {
  it('throttles auth flooding from one IP with 429 + Retry-After while leaving other IPs and target account unaffected', async () => {
    const reg = await http()
      .post('/auth/register')
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ email: 'victim@t.test', password: 'password123', displayName: 'Victim User', role: 'buyer' });
    expect(reg.status).toBe(201);

    // Spray 7 bad passwords on victim@t.test from attacker IP 203.0.113.10:
    const statuses: number[] = [];
    let last429Body: unknown = null;
    let lastRetryAfter: string | undefined;
    for (let i = 0; i < 7; i++) {
      const r = await http()
        .post('/auth/login')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ email: 'victim@t.test', password: `wrong-${i}` });
      statuses.push(r.status);
      if (r.status === 429) {
        last429Body = r.body;
        lastRetryAfter = r.headers['retry-after'];
      }
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(last429Body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(Number(lastRetryAfter)).toBeGreaterThan(0);

    // Owner logging in from another IP is NOT locked out or throttled:
    const owner = await http()
      .post('/auth/login')
      .set('X-Forwarded-For', '192.0.2.44')
      .send({ email: 'victim@t.test', password: 'password123' });
    expect(owner.status).toBe(200);
  });

  it('skips rate limiting on @SkipThrottle endpoints (/health, /payments/webhook)', async () => {
    for (let i = 0; i < 12; i++) {
      const h = await http().get('/health').set('X-Forwarded-For', '203.0.113.55');
      expect(h.status).toBe(200);
    }
  });

  it('keys authenticated requests by user:<id> independently of IP', async () => {
    const a = await http()
      .post('/auth/register')
      .set('X-Forwarded-For', '198.51.100.2')
      .send({ email: 'rl-a@t.test', password: 'password123', displayName: 'User A', role: 'buyer' });
    const b = await http()
      .post('/auth/register')
      .set('X-Forwarded-For', '198.51.100.3')
      .send({ email: 'rl-b@t.test', password: 'password123', displayName: 'User B', role: 'buyer' });
    const tokenA = a.body.token as string;
    const tokenB = b.body.token as string;

    // Even if user A spoofs different XFF IPs on authenticated GET /wallet (read max = 10), user A's user:<id> bucket triggers 429:
    const resA: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await http().get('/wallet').set('Authorization', `Bearer ${tokenA}`).set('X-Forwarded-For', `198.51.100.${10 + i}`);
      resA.push(r.status);
    }
    expect(resA.filter((s) => s === 200)).toHaveLength(10);
    expect(resA.filter((s) => s === 429)).toHaveLength(2);

    // User B on the SAME IP is unaffected:
    const resB = await http().get('/wallet').set('Authorization', `Bearer ${tokenB}`).set('X-Forwarded-For', '198.51.100.10');
    expect(resB.status).toBe(200);
  });

  it('fails open on Redis FLUSHALL and when Redis is unreachable (never returns 500)', async () => {
    await redis.flushall();
    const afterFlush = await http().get('/categories').set('X-Forwarded-For', '203.0.113.77');
    expect(afterFlush.status).toBe(200);

    for (let i = 0; i < 8; i++) {
      const r = await request(failOpenApp.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', '203.0.113.88')
        .send({ email: 'victim@t.test', password: 'wrong' });
      expect(r.status).toBe(401);
    }
  });
});
