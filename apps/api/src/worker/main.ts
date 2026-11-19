import { Meilisearch } from 'meilisearch';
import { SystemClock } from '../common/clock/clock.js';
import { ClosingService } from '../closing/closing.js';
import { loadEnv } from '../config.js';
import { createDb, runMigrations } from '../db/client.js';
import { MediaService } from '../media/media.js';
import { S3Storage } from '../media/storage.js';
import { ModerationService } from '../moderation/moderation.js';
import { NotificationService, type EmailSender } from '../notifications/notifications.js';
import { PaymentService } from '../payments/payments.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { SearchIndexer } from '../search/indexer.js';
import { startLoops, type Loop } from './loops.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Mail stub: the message is logged instead of leaving the system (no external services). */
const logSender: EmailSender = {
  send(to, subject): Promise<void> {
    console.log(`[mail] to=${to} subject=${subject}`);
    return Promise.resolve();
  },
};

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

  const closing = new ClosingService(db, clock);
  const moderation = new ModerationService(db, clock);
  const notifications = new NotificationService(db, clock, logSender);
  const media = new MediaService(db, clock, storage);
  // The worker only reconciles from the provider's status; the stub has no remote state here, so it never delivers.
  const provider = new StubPaymentProvider({
    clock, secret: env.PAYMENT_WEBHOOK_SECRET, mode: 'none', baseUrl: env.PAYMENT_STUB_BASE_URL,
    random: Math.random, schedule: () => undefined, deliver: () => Promise.resolve(),
  });
  const payments = new PaymentService(db, clock, provider, env.PAYMENT_WEBHOOK_SECRET);

  const processPhotos = async (): Promise<number> => {
    const ids = await media.findUnprocessed();
    for (const id of ids) await media.processPhoto(id);
    return ids.length;
  };

  const loops: Loop[] = [
    { name: 'search-drain', intervalMs: SECOND, run: () => indexer.drain() },
    { name: 'close-ended-lots', intervalMs: SECOND, run: () => closing.sweepEndedLots() },
    { name: 'overdue-sales', intervalMs: 10 * SECOND, run: () => closing.sweepOverdueSales() },
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
