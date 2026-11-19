import { createDb, runMigrations } from './client.js';

const { pool, db } = createDb();
await runMigrations(db);
await pool.end();
