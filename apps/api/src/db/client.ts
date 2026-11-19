import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export const DEFAULT_DATABASE_URL = 'postgres://auction:auction_dev_password@127.0.0.1:5433/auction';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return { pool, db: drizzle(pool, { schema }) };
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
}
