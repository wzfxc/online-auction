import { Meilisearch } from 'meilisearch';
import { SystemClock } from '../common/clock/clock.js';
import { loadEnv } from '../config.js';
import { createDb } from '../db/client.js';
import { SearchIndexer } from './indexer.js';

/**
 * `pnpm reindex` — full rebuild of the search index from Postgres (zero-downtime swap).
 * `pnpm reindex --if-empty` rebuilds only when the index has no documents.
 */
const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const indexer = new SearchIndexer(db, new SystemClock(), new Meilisearch({ host: env.MEILI_URL, apiKey: env.MEILI_MASTER_KEY }));
try {
  if (process.argv.includes('--if-empty')) {
    console.log(await indexer.ensureIndexed());
  } else {
    console.log('reindexed lots:', await indexer.reindexAll());
  }
} finally {
  await pool.end();
}
