import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export const DEFAULT_DATABASE_URL = 'postgres://auction:auction_dev_password@127.0.0.1:5433/auction';
const MIGRATION_LOCK_KEY = 8_123_456;

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return { pool, db: drizzle(pool, { schema }) };
}

export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = new URL('../../drizzle', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  // Serialize concurrent startups (api1, api2, worker) on a single session connection.
  const client = await db.$client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migrate(drizzle(client, { schema }), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
