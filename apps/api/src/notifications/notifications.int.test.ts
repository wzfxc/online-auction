import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { BidService } from '../bids/bids.js';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, emailOutbox, favorites, lots, notifications, users } from '../db/schema.js';
import { topUp } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';
import { NotificationService, type EmailSender } from './notifications.js';
import { SmtpEmailSender } from './smtp.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const bidSvc = new BidService(db, clock);
const sent: { to: string; subject: string }[] = [];
let failSends = false;
const sender: EmailSender = {
  async send(to, subject) {
    if (failSends) throw new Error('smtp down');
    sent.push({ to, subject });
  },
};
const svc = new NotificationService(db, clock, sender);

let categoryId = '';
let cityId = '';
let seller: Principal;
let keySeq = 0;
const key = () => `n-${++keySeq}`;

async function newUser(role: Principal['role'] = 'buyer', funds = 0): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'Тест Юзер', passwordHash: 'x', role }).returning();
  if (funds > 0) await db.transaction((tx) => topUp(tx, u!.id, funds, `topup:${u!.id}`));
  return { id: u!.id, role };
}

async function newLot(endsAt: string, over: Partial<typeof lots.$inferInsert> = {}): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'Лот', description: 'D', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status: 'active', endsAt: new Date(endsAt), reservePrice: 777_700, ...over,
  }).returning();
  return lot!.id;
}

const outbidMails = (lotId: string) => db.select().from(emailOutbox).where(eq(emailOutbox.lotId, lotId));

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

describe('outbid notices', () => {
  it('writes an in-app notice every time but at most one email per 15 minutes per lot', async () => {
    const lotId = await newLot('2030-01-04T00:00:00Z');
    const a = await newUser('buyer', 5_000_000);
    const b = await newUser('buyer', 5_000_000);

    await bidSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    await bidSvc.placeBid(b, lotId, { amount: 11_000 }, key()); // a outbid #1
    await bidSvc.placeBid(a, lotId, { amount: 12_000 }, key());
    await bidSvc.placeBid(b, lotId, { amount: 13_000 }, key()); // a outbid #2, inside 15 min

    expect(await svc.list(a.id)).toHaveLength(2);
    expect((await outbidMails(lotId)).filter((m) => m.userId === a.id)).toHaveLength(1);

    clock.advance(16 * 60_000);
    await bidSvc.placeBid(a, lotId, { amount: 14_000 }, key());
    await bidSvc.placeBid(b, lotId, { amount: 15_000 }, key()); // a outbid #3, window passed
    expect(await svc.list(a.id)).toHaveLength(3);
    expect((await outbidMails(lotId)).filter((m) => m.userId === a.id)).toHaveLength(2);
  });

  it('never leaks the reserve price into notices or emails', async () => {
    const lotId = await newLot('2030-02-04T00:00:00Z');
    const a = await newUser('buyer', 5_000_000);
    const b = await newUser('buyer', 5_000_000);
    await bidSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    await bidSvc.placeBid(b, lotId, { amount: 11_000 }, key());
    const dump = JSON.stringify([await svc.list(a.id), await outbidMails(lotId)]);
    expect(dump).not.toContain('777700');
    expect(dump).not.toContain('7777');
  });

  it('keeps inboxes private and marks only own notices as read', async () => {
    const lotId = await newLot('2030-03-04T00:00:00Z');
    const a = await newUser('buyer', 5_000_000);
    const b = await newUser('buyer', 5_000_000);
    await bidSvc.placeBid(a, lotId, { amount: 10_000 }, key());
    await bidSvc.placeBid(b, lotId, { amount: 11_000 }, key());
    const [notice] = await svc.list(a.id);
    expect(await svc.list(b.id)).toHaveLength(0);
    expect(await svc.markRead(b.id, [notice!.id])).toBe(0);
    expect(await svc.unreadCount(a.id)).toBe(1);
    expect(await svc.markRead(a.id, [notice!.id])).toBe(1);
    expect(await svc.unreadCount(a.id)).toBe(0);
  });
});

describe('ending reminders', () => {
  it('sends exactly one reminder per favourite, even with parallel workers, and only inside the last hour', async () => {
    const soon = await newLot(new Date(clock.now().getTime() + 30 * 60_000).toISOString());
    const later = await newLot(new Date(clock.now().getTime() + 5 * 3_600_000).toISOString());
    const fan = await newUser('buyer');
    await db.insert(favorites).values([{ userId: fan.id, lotId: soon }, { userId: fan.id, lotId: later }]);

    const results = await Promise.all([svc.sendEndingReminders(), svc.sendEndingReminders(), svc.sendEndingReminders()]);
    expect(results.reduce((x, y) => x + y, 0)).toBe(1);
    expect(await svc.sendEndingReminders()).toBe(0);
    expect((await svc.list(fan.id)).map((n) => n.type)).toEqual(['ending_soon']);

    clock.advance(4 * 3_600_000); // `later` is now within the hour
    expect(await svc.sendEndingReminders()).toBe(1);
    expect(await svc.sendEndingReminders()).toBe(0);
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.userId, fan.id));
    expect(mails).toHaveLength(2);
  });
});

describe('email delivery', () => {
  it('delivers each letter once across parallel drains and retries after a transport failure', async () => {
    await db.delete(emailOutbox);
    await db.delete(notifications);
    const u = await newUser('buyer');
    await db.insert(emailOutbox).values([1, 2, 3].map((i) => ({
      userId: u.id, kind: 'reminder', subject: `s${i}`, body: 'b', createdAt: clock.now(), dedupeKey: `d${i}`,
    })));

    failSends = true;
    expect(await svc.drainEmails()).toBe(0);
    failSends = false;
    sent.length = 0;
    const counts = await Promise.all([svc.drainEmails(), svc.drainEmails(), svc.drainEmails()]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(3);
    expect(sent.map((m) => m.subject).sort()).toEqual(['s1', 's2', 's3']);
    expect(await svc.drainEmails()).toBe(0);
  });

  it('delivers UTF-8 emails through SmtpEmailSender to Mailpit over SMTP', async () => {
    const smtpHost = process.env.SMTP_HOST ?? '127.0.0.1';
    const smtpPort = Number(process.env.SMTP_PORT ?? '1025');
    const smtpSender = new SmtpEmailSender({ host: smtpHost, port: smtpPort, from: 'auction@example.test' });
    const smtpSvc = new NotificationService(db, clock, smtpSender);

    await db.delete(emailOutbox);
    const u = await newUser('buyer');
    const uniqueSubj = `Тест SMTP ${clock.now().getTime()}`;
    await db.insert(emailOutbox).values({
      userId: u.id, kind: 'outbid', subject: uniqueSubj, body: 'Тіло листа українською 100 ₴',
      createdAt: clock.now(), dedupeKey: `smtp-test-${uniqueSubj}`,
    });

    expect(await smtpSvc.drainEmails()).toBe(1);
    expect(await smtpSvc.drainEmails()).toBe(0);

    const apiRes = await fetch('http://127.0.0.1:8025/api/v1/messages');
    expect(apiRes.ok).toBe(true);
    const data = (await apiRes.json()) as { messages?: { Subject?: string }[] };
    expect(data.messages?.some((m) => m.Subject === uniqueSubj)).toBe(true);
  });
});
