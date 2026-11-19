import { Meilisearch } from 'meilisearch';
import { sql } from 'drizzle-orm';
import { SystemClock } from '../common/clock/clock.js';
import { ClosingService } from '../closing/closing.js';
import { loadEnv } from '../config.js';
import { createDb, runMigrations } from '../db/client.js';
import { MediaService } from '../media/media.js';
import { S3Storage } from '../media/storage.js';
import { ModerationService } from '../moderation/moderation.js';
import { NotificationService } from '../notifications/notifications.js';
import { SmtpEmailSender } from '../notifications/smtp.js';
import { PaymentService } from '../payments/payments.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { SalesService } from '../sales/sales.js';
import { runSeed } from '../seed/seed.js';
import { SearchIndexer } from '../search/indexer.js';
import { startLoops, type Loop } from './loops.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

async function main(): Promise<void> {
  const env = loadEnv();
  const clock = new SystemClock();
  const { db, pool } = createDb(env.DATABASE_URL);
  await runMigrations(db);

  const storage = new S3Storage({
    endpoint: env.S3_ENDPOINT, publicEndpoint: env.S3_PUBLIC_ENDPOINT, accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET, region: env.S3_REGION,
  });
  await storage.ensureBucket();
  const meili = new Meilisearch({ host: env.MEILI_URL, apiKey: env.MEILI_MASTER_KEY });
  const indexer = new SearchIndexer(db, clock, meili);
  await indexer.ensureIndex();

  if (env.SEED_ON_START === 'true') {
    const summary = await runSeed(db, pool, clock.now(), storage);
    console.log('seed', summary);
    if (summary.seeded) {
      // The bulk insert queued every lot in the outbox; one rebuild is much cheaper than draining 50k rows in batches.
      await db.execute(sql`update search_outbox set processed_at = now() where processed_at is null`);
      console.log('seed: reindexed', await indexer.reindexAll(), 'lots');
    }
  }

  const closing = new ClosingService(db, clock);
  const sales = new SalesService(db, clock);
  const moderation = new ModerationService(db, clock);
  const mailSender = new SmtpEmailSender({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.MAIL_FROM });
  const notifications = new NotificationService(db, clock, mailSender);
  const media = new MediaService(db, clock, storage);
  // Shared session state in Postgres lets the worker reconcile payments created on any API replica.
  const provider = new StubPaymentProvider({
    clock, secret: env.PAYMENT_WEBHOOK_SECRET, mode: 'none', baseUrl: env.PAYMENT_STUB_BASE_URL,
    db,
    random: Math.random, schedule: () => undefined, deliver: () => Promise.resolve(),
  });
  const payments = new PaymentService(db, clock, provider, env.PAYMENT_WEBHOOK_SECRET);

  /** Keeps draining while a backlog exists (bounded per tick) so search lag stays small after bursts. */
  const drainSearch = async (): Promise<number> => {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const n = await indexer.drain();
      total += n;
      if (n === 0) break;
    }
    return total;
  };

  const processPhotos = async (): Promise<number> => {
    const ids = await media.findUnprocessed();
    for (const id of ids) await media.processPhoto(id);
    return ids.length;
  };

  const loops: Loop[] = [
    { name: 'search-drain', intervalMs: SECOND, run: drainSearch },
    { name: 'close-ended-lots', intervalMs: SECOND, run: () => closing.sweepEndedLots() },
    { name: 'overdue-sales', intervalMs: 10 * SECOND, run: () => closing.sweepOverdueSales() },
    { name: 'auto-confirm-sales', intervalMs: 30 * SECOND, run: () => sales.sweepAutoConfirmSales() },
    { name: 'moderation-leases', intervalMs: 30 * SECOND, run: () => moderation.releaseExpiredLeases() },
    { name: 'photos', intervalMs: 2 * SECOND, run: processPhotos },
    { name: 'emails', intervalMs: 2 * SECOND, run: () => notifications.drainEmails() },
    { name: 'ending-reminders', intervalMs: MINUTE, run: () => notifications.sendEndingReminders() },
    { name: 'reconcile-payments', intervalMs: 30 * SECOND, run: () => payments.reconcile() },
  ];
  const runner = startLoops(loops, (name, e) => console.error(`loop ${name} failed`, e));
  console.log('worker started');

  const stop = (): void => {
    void runner.stop().then(() => pool.end()).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
