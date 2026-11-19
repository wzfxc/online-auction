import { Meilisearch } from 'meilisearch';
import { verifyToken } from './auth/crypto.js';
import { SystemClock } from './common/clock/clock.js';
import { loadEnv } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { createApp } from './http/setup.js';
import { S3Storage } from './media/storage.js';
import { StubPaymentProvider } from './payments-stub/provider.js';
import { SIGNATURE_HEADER } from './payments-stub/signature.js';
import { RealtimeServer } from './realtime/realtime.js';
import { SearchIndexer } from './search/indexer.js';

const STOP_TIMEOUT_MS = 10_000;

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
  await new SearchIndexer(db, clock, meili).ensureIndex();

  const selfUrl = `http://127.0.0.1:${env.PORT}`;
  const provider = new StubPaymentProvider({
    clock, secret: env.PAYMENT_WEBHOOK_SECRET, mode: env.PAYMENT_STUB_MODE, baseUrl: env.PAYMENT_STUB_BASE_URL,
    db,
    random: Math.random,
    schedule: (task, ms) => {
      setTimeout(() => void task().catch((e: unknown) => console.error('webhook delivery failed', e)), ms).unref();
    },
    deliver: async (hook) => {
      const res = await fetch(`${selfUrl}/payments/webhook`, {
        method: 'POST', body: hook.body, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: hook.signature },
      });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    },
  });

  const app = await createApp({
    db, clock, paymentProvider: provider, storage, meili,
    config: { jwtSecret: env.JWT_SECRET, tokenTtlSeconds: env.TOKEN_TTL_SECONDS, webhookSecret: env.PAYMENT_WEBHOOK_SECRET },
  });
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');

  const realtime = new RealtimeServer({
    db, clock, databaseUrl: env.DATABASE_URL, ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    corsOrigin: '*',
    authenticate: (token) => {
      const claims = verifyToken(token, env.JWT_SECRET, Math.floor(clock.now().getTime() / 1000));
      return Promise.resolve(claims ? { id: claims.sub, role: claims.role } : null);
    },
    onError: (e) => console.error('realtime error', e),
  });
  await realtime.start(app.getHttpServer());
  console.log(`${env.INSTANCE_ID} listening on ${env.PORT}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), STOP_TIMEOUT_MS).unref();
    void realtime.stop().then(() => app.close()).then(() => pool.end()).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
