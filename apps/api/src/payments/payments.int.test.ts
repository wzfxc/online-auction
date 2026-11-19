import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { payments, users } from '../db/schema.js';
import { findUnbalancedTransactions } from '../ledger/ledger.js';
import { getBalance } from '../ledger/wallet.js';
import { StubPaymentProvider, type DeliveredWebhook } from '../payments-stub/provider.js';
import { signWebhook } from '../payments-stub/signature.js';
import { PaymentService, RECONCILE_GRACE_MS } from './payments.js';

const SECRET = 'int-secret';
const { pool, db } = createDb(process.env.TEST_DATABASE_URL);

async function newUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${Math.random()}@t.test`, displayName: 'T', passwordHash: 'x' })
    .returning();
  return u!.id;
}

function setup() {
  const clock = new FakeClock();
  const inbox: DeliveredWebhook[] = [];
  const provider = new StubPaymentProvider({
    clock, secret: SECRET, mode: 'none', baseUrl: 'http://stub', random: () => 0,
    deliver: async (h) => {
      inbox.push(h);
    },
    schedule: (task) => {
      void task();
    },
  });
  const service = new PaymentService(db, clock, provider, SECRET);
  return { clock, provider, service, inbox };
}

const available = (userId: string) => db.transaction(async (tx) => (await getBalance(tx, userId)).available);

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
});
afterAll(() => pool.end());

describe('top-up payments', () => {
  it('same Idempotency-Key returns one payment; different body is refused', async () => {
    const { service } = setup();
    const u = await newUser();
    const a = await service.createTopUp(u, 50_000, 'k1');
    const b = await service.createTopUp(u, 50_000, 'k1');
    expect(b.replayed).toBe(true);
    expect(b.body.paymentId).toBe(a.body.paymentId);
    await expect(service.createTopUp(u, 60_000, 'k1')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('credits exactly once for duplicate and parallel webhooks', async () => {
    const { service, provider, inbox } = setup();
    const u = await newUser();
    const { body } = await service.createTopUp(u, 50_000, 'k');
    provider.resolve(body.paymentId, 'success');
    await Promise.resolve();
    const hook = inbox[0]!;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => service.handleWebhook(hook.body, hook.signature)));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await available(u)).toBe(50_000);
  });

  it('rejects a bad or missing signature without touching the payment', async () => {
    const { service } = setup();
    const u = await newUser();
    const { body } = await service.createTopUp(u, 50_000, 'k');
    const forged = JSON.stringify({ providerEventId: 'evt_x', paymentId: body.paymentId, type: 'payment.succeeded' });
    await expect(service.handleWebhook(forged, signWebhook(forged, 'wrong'))).rejects.toMatchObject({ status: 401 });
    await expect(service.handleWebhook(forged, undefined)).rejects.toMatchObject({ status: 401 });
    expect(await available(u)).toBe(0);
    const [p] = await db.select().from(payments).where(eq(payments.id, body.paymentId));
    expect(p!.status).toBe('pending');
  });

  it('a "failed" arriving after "succeeded" changes nothing', async () => {
    const { service, provider, inbox } = setup();
    const u = await newUser();
    const { body } = await service.createTopUp(u, 50_000, 'k');
    provider.resolve(body.paymentId, 'success');
    await Promise.resolve();
    await service.handleWebhook(inbox[0]!.body, inbox[0]!.signature);
    const failed = JSON.stringify({ providerEventId: 'evt_late_fail', paymentId: body.paymentId, type: 'payment.failed' });
    await service.handleWebhook(failed, signWebhook(failed, SECRET));
    const [p] = await db.select().from(payments).where(eq(payments.id, body.paymentId));
    expect(p!.status).toBe('succeeded');
    expect(await available(u)).toBe(50_000);
  });

  it('reconciler credits a payment whose webhook never arrived, once', async () => {
    const { service, provider, clock, inbox } = setup();
    const u = await newUser();
    const { body } = await service.createTopUp(u, 50_000, 'k');
    provider.resolve(body.paymentId, 'success');
    await Promise.resolve();
    inbox.length = 0; // the webhook is lost

    await service.reconcile(); // inside the grace period: untouched
    expect(await available(u)).toBe(0);
    clock.advance(RECONCILE_GRACE_MS + 1);
    await service.reconcile();
    await service.reconcile(); // a second run must not credit again
    expect(await available(u)).toBe(50_000);
  });

  it('reconciler expires an abandoned payment without crediting', async () => {
    const { service, provider, clock } = setup();
    const u = await newUser();
    const { body } = await service.createTopUp(u, 50_000, 'k');
    provider.resolve(body.paymentId, 'close');
    clock.advance(31 * 60_000);
    await service.reconcile();
    const [p] = await db.select().from(payments).where(eq(payments.id, body.paymentId));
    expect(p!.status).toBe('expired');
    expect(await available(u)).toBe(0);
  });

  it('keeps the ledger balanced', async () => {
    await db.transaction(async (tx) => expect(await findUnbalancedTransactions(tx)).toEqual([]));
  });

  it('shares stub payment sessions across replicas and worker via Postgres (D25)', async () => {
    const clock = new FakeClock();
    const inbox2: DeliveredWebhook[] = [];
    // Replica 1 creates the top-up session; Replica 2 resolves it; Worker reconciles if webhook is dropped.
    const replica1Provider = new StubPaymentProvider({
      clock, secret: SECRET, mode: 'none', baseUrl: 'http://stub', db, random: () => 0,
      deliver: async () => undefined, schedule: () => undefined,
    });
    const replica2Provider = new StubPaymentProvider({
      clock, secret: SECRET, mode: 'none', baseUrl: 'http://stub', db, random: () => 0,
      deliver: async (h) => { inbox2.push(h); },
      schedule: (task) => { void task(); },
    });
    const workerProvider = new StubPaymentProvider({
      clock, secret: SECRET, mode: 'none', baseUrl: 'http://stub', db, random: () => 0,
      deliver: async () => undefined, schedule: () => undefined,
    });
    const replica1Payments = new PaymentService(db, clock, replica1Provider, SECRET);
    const workerPayments = new PaymentService(db, clock, workerProvider, SECRET);

    const u = await newUser();
    const { body } = await replica1Payments.createTopUp(u, 75_000, 'cross-replica-1');
    // Replica 2 can inspect and resolve the session created on Replica 1:
    expect(await replica2Provider.getSession(body.paymentId)).toEqual({
      paymentId: body.paymentId, amount: 75_000, status: 'pending',
    });
    await replica2Provider.resolve(body.paymentId, 'success');
    expect(await workerProvider.getStatus(body.paymentId)).toBe('succeeded');

    // Even if the webhook is dropped, the worker reconciles from the shared session state:
    clock.advance(RECONCILE_GRACE_MS + 1);
    await workerPayments.reconcile();
    expect(await available(u)).toBe(75_000);
  });
});
