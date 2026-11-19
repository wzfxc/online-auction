import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Meilisearch } from 'meilisearch';
import { sql } from 'drizzle-orm';
import { SystemClock } from '../../api/src/common/clock/clock.js';
import { ClosingService } from '../../api/src/closing/closing.js';
import { loadEnv } from '../../api/src/config.js';
import { createDb, runMigrations } from '../../api/src/db/client.js';
import { MediaService } from '../../api/src/media/media.js';
import { S3Storage } from '../../api/src/media/storage.js';
import { ModerationService } from '../../api/src/moderation/moderation.js';
import { NotificationService } from '../../api/src/notifications/notifications.js';
import { SmtpEmailSender } from '../../api/src/notifications/smtp.js';
import { PaymentService } from '../../api/src/payments/payments.js';
import { StubPaymentProvider } from '../../api/src/payments-stub/provider.js';
import { SalesService } from '../../api/src/sales/sales.js';
import { runSeed } from '../../api/src/seed/seed.js';
import { SearchIndexer } from '../../api/src/search/indexer.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
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

  if (env.SEED_ON_START === 'true') {
    await indexer.ensureIndex();
    const summary = await runSeed(db, pool, clock.now(), storage);
    console.log('seed', summary);
    if (summary.seeded) {
      // The bulk insert queued every lot in the outbox; one rebuild is much cheaper than draining 50k rows in batches.
      await db.execute(sql`update search_outbox set processed_at = now() where processed_at is null`);
      console.log('seed: reindexed', await indexer.reindexAll(), 'lots');
    }
  }
  // Missing or empty index → recreate/reindex now; if Meilisearch is down, the `search-recover` job retries.
  await indexer.ensureIndexed().then(
    (r) => console.log('search index', r),
    (e: unknown) => console.error('search index check failed, will retry', e instanceof Error ? e.message : e),
  );

  const mailSender = new SmtpEmailSender({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.MAIL_FROM });
  // Shared session state in Postgres lets the worker reconcile payments created on any API replica.
  const provider = new StubPaymentProvider({
    clock, secret: env.PAYMENT_WEBHOOK_SECRET, mode: 'none', baseUrl: env.PAYMENT_STUB_BASE_URL,
    db, random: Math.random, schedule: () => undefined, deliver: () => Promise.resolve(),
  });

  const app = await NestFactory.createApplicationContext(
    WorkerModule.register({
      redisUrl: env.REDIS_URL,
      clock,
      onShutdown: () => pool.end(),
      services: {
        indexer,
        closing: new ClosingService(db, clock),
        sales: new SalesService(db, clock),
        moderation: new ModerationService(db, clock),
        notifications: new NotificationService(db, clock, mailSender),
        media: new MediaService(db, clock, storage),
        payments: new PaymentService(db, clock, provider, env.PAYMENT_WEBHOOK_SECRET),
      },
    }),
    { logger: ['log', 'warn', 'error'] },
  );
  // SIGTERM/SIGINT → QueueRunner.onApplicationShutdown (in-flight jobs finish), then the DB pool is closed.
  app.enableShutdownHooks();
  console.log('worker started');
}

bootstrap().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
