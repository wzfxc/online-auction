import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { BidService } from '../bids/bids.js';
import { ClosingService } from '../closing/closing.js';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { accounts, categories, cities, lots, users } from '../db/schema.js';
import { topUp } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';
import { PaymentService, RECONCILE_GRACE_MS } from '../payments/payments.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { SalesService } from '../sales/sales.js';
import { ReportService } from './reports.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-06-01T12:00:00.000Z');
const SECRET = 'rep-secret';
const provider = new StubPaymentProvider({
  clock, secret: SECRET, mode: 'none', baseUrl: 'http://stub', db, random: () => 0,
  deliver: async () => undefined,
  schedule: () => undefined, // drop webhooks so we can test discrepancy before and after reconcile()
});
const paymentsSvc = new PaymentService(db, clock, provider, SECRET);
const bidSvc = new BidService(db, clock);
const closingSvc = new ClosingService(db, clock);
const salesSvc = new SalesService(db, clock);
const reportSvc = new ReportService(db, clock, provider);

let catPhotoId = '';
let catAudioId = '';
let cityId = '';
let finance: Principal;
let seller: Principal;
let buyer1: Principal;
let buyer2: Principal;
let moderator: Principal;
let keySeq = 0;
const key = () => `rep-k-${++keySeq}`;

async function newUser(role: Principal['role'], funds = 0): Promise<Principal> {
  const [u] = await db.insert(users).values({
    email: `${Math.random()}@t.test`, displayName: 'Тест Фінанс', passwordHash: 'x', role,
  }).returning();
  if (funds > 0) await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  return { id: u!.id, role };
}

async function newLot(catId: string, price: number): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId: catId, cityId, title: 'Лот для звіту', description: 'Опис',
    startPrice: price, currentPrice: price, buyNowPrice: price, durationDays: 3, condition: 'good',
    status: 'active', endsAt: new Date(clock.now().getTime() + 3_600_000),
    createdAt: clock.now(), updatedAt: clock.now(),
  }).returning();
  return lot!.id;
}

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const [c1] = await db.insert(categories).values({
    slug: 'photo', nameUk: 'Фототехніка', nameEn: 'Photo Gear', namePl: 'Sprzęt foto',
  }).returning();
  const [c2] = await db.insert(categories).values({
    slug: 'audio', nameUk: 'Аудіо', nameEn: 'Audio', namePl: 'Audio',
  }).returning();
  const [city] = await db.insert(cities).values({
    slug: 'lviv', nameUk: 'Львів', nameEn: 'Lviv', namePl: 'Lwów',
  }).returning();
  catPhotoId = c1!.id;
  catAudioId = c2!.id;
  cityId = city!.id;
  finance = await newUser('finance');
  seller = await newUser('seller');
  buyer1 = await newUser('buyer', 2_000_000);
  buyer2 = await newUser('buyer', 2_000_000);
  moderator = await newUser('moderator');
});

afterAll(() => pool.end());

describe('finance period report', () => {
  it('computes turnover, commission, unpaid share and category breakdown quickly (< 500 ms for 90 days)', async () => {
    // Sale 1 (Photo): 1000 UAH (100_000 kop), fee 50 UAH (5_000 kop) → paid & completed
    const lot1 = await newLot(catPhotoId, 100_000);
    const s1 = await bidSvc.buyNow(buyer1, lot1, key());
    await salesSvc.paySale(buyer1, s1.body.saleId, key());
    await salesSvc.shipSale(seller, s1.body.saleId, { trackingNumber: 'NP-1001' });
    await salesSvc.confirmReceipt(buyer1, s1.body.saleId);

    // Sale 2 (Audio): 2000 UAH (200_000 kop), fee 100 UAH (10_000 kop) → paid
    const lot2 = await newLot(catAudioId, 200_000);
    const s2 = await bidSvc.buyNow(buyer1, lot2, key());
    await salesSvc.paySale(buyer1, s2.body.saleId, key());

    // Sale 3 (Photo): 500 UAH (50_000 kop) → winner defaults after 48h (unpaid win)
    const lot3 = await newLot(catPhotoId, 50_000);
    const s3 = await bidSvc.buyNow(buyer2, lot3, key());
    clock.advance(48 * 3_600_000 + 1000);
    expect(await closingSvc.defaultSale(s3.body.saleId)).toBe('ended_unsold');

    const t0 = Date.now();
    const rep = await reportSvc.periodReport(finance, { from: '2030-05-01', to: '2030-06-15' });
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(500);

    expect(rep.turnover).toBe(300_000);
    expect(rep.commission).toBe(15_000);
    expect(rep.totalWins).toBe(3);
    expect(rep.paidWins).toBe(2);
    expect(rep.unpaidWins).toBe(1);
    expect(rep.unpaidShare).toBeCloseTo(1 / 3, 3);
    expect(rep.byCategory).toEqual([
      {
        categoryId: catAudioId, slug: 'audio', nameUk: 'Аудіо', nameEn: 'Audio', namePl: 'Audio',
        paidCount: 1, unpaidCount: 0, turnover: 200_000, commission: 10_000,
      },
      {
        categoryId: catPhotoId, slug: 'photo', nameUk: 'Фототехніка', nameEn: 'Photo Gear', namePl: 'Sprzęt foto',
        paidCount: 1, unpaidCount: 1, turnover: 100_000, commission: 5_000,
      },
    ]);
  });

  it('enforces finance role and validates period parameters', async () => {
    for (const u of [buyer1, seller, moderator]) {
      await expect(reportSvc.periodReport(u, {})).rejects.toMatchObject({ status: 403 });
      await expect(reportSvc.reconcileReport(u)).rejects.toMatchObject({ status: 403 });
    }
    await expect(reportSvc.periodReport(finance, { from: 'not-a-date' })).rejects.toMatchObject({ status: 400 });
    await expect(reportSvc.periodReport(finance, { from: '2030-07-01', to: '2030-06-01' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('finance reconciliation report', () => {
  it('verifies zero ledger sum, account balances = sum of entries, and detects/resolves payment stub discrepancies', async () => {
    const clean = await reportSvc.reconcileReport(finance);
    expect(clean.healthy).toBe(true);
    expect(clean.entriesSum).toBe(0);
    expect(clean.unbalancedTransactions).toEqual([]);
    expect(clean.walletMismatches).toEqual([]);
    expect(clean.paymentDiscrepancies).toEqual([]);

    // Start a top-up and press "Success" on the stub while the webhook is dropped:
    const top = await paymentsSvc.createTopUp(buyer1.id, 40_000, key());
    await provider.resolve(top.body.paymentId, 'success');

    // Before reconciliation sweeper runs, the stub is 'succeeded' while the DB payment is 'pending':
    const withDiscrepancy = await reportSvc.reconcileReport(finance);
    expect(withDiscrepancy.healthy).toBe(false);
    expect(withDiscrepancy.paymentDiscrepancies).toEqual([
      {
        paymentId: top.body.paymentId,
        userId: buyer1.id,
        amount: 40_000,
        dbStatus: 'pending',
        providerStatus: 'succeeded',
        ledgerCredited: false,
        reason: 'status_mismatch',
      },
    ]);

    // After the reconciler settles the payment, the discrepancy disappears:
    clock.advance(RECONCILE_GRACE_MS + 1000);
    await paymentsSvc.reconcile();
    const afterReconcile = await reportSvc.reconcileReport(finance);
    expect(afterReconcile.healthy).toBe(true);
    expect(afterReconcile.paymentDiscrepancies).toEqual([]);
    expect(afterReconcile.entriesSum).toBe(0);

    // Tamper with an account balance directly and check that walletMismatches catches it:
    const [acc] = await db.select().from(accounts).where(eq(accounts.userId, buyer1.id));
    await db.update(accounts).set({ balance: acc!.balance + 100 }).where(eq(accounts.id, acc!.id));
    const tampered = await reportSvc.reconcileReport(finance);
    expect(tampered.healthy).toBe(false);
    expect(tampered.walletMismatches).toHaveLength(1);
    expect(tampered.walletMismatches[0]!.accountId).toBe(acc!.id);

    // Restore balance:
    await db.update(accounts).set({ balance: acc!.balance }).where(eq(accounts.id, acc!.id));
    expect((await reportSvc.reconcileReport(finance)).healthy).toBe(true);
  });
});
