import { SystemClock } from '../common/clock/clock.js';
import { loadEnv } from '../config.js';
import { createDb, runMigrations } from '../db/client.js';
import { S3Storage } from '../media/storage.js';
import { runSeed } from './seed.js';

/** `pnpm --filter @auction/api seed` — manual run; the worker does the same on start when SEED_ON_START=true. */
const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db);
const storage = new S3Storage({
  endpoint: env.S3_ENDPOINT, publicEndpoint: env.S3_PUBLIC_ENDPOINT, accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET, region: env.S3_REGION,
});
await storage.ensureBucket();
console.log(await runSeed(db, pool, new SystemClock().now(), storage));
await pool.end();
