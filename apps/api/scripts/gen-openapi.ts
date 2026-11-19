import { writeFileSync } from 'node:fs';
import { Meilisearch } from 'meilisearch';
import { SystemClock } from '../src/common/clock/clock.js';
import { createDb } from '../src/db/client.js';
import { MemoryStorage } from '../src/media/storage.js';
import { buildOpenApi, createApp } from '../src/http/setup.js';
import { StubPaymentProvider } from '../src/payments-stub/provider.js';

/** Builds the Nest app without touching the network (the pool connects lazily) and dumps its OpenAPI document. */
const clock = new SystemClock();
const { db, pool } = createDb('postgres://unused:unused@127.0.0.1:1/unused');
const provider = new StubPaymentProvider({
  clock, secret: 'x', mode: 'none', baseUrl: 'http://localhost', random: () => 0,
  deliver: async () => undefined, schedule: () => undefined,
});
const app = await createApp(
  { db, clock, paymentProvider: provider, storage: new MemoryStorage(), meili: new Meilisearch({ host: 'http://127.0.0.1:1' }), config: { jwtSecret: 'x', tokenTtlSeconds: 1, webhookSecret: 'x' } },
  { logger: false },
);
await app.init();
const out = new URL('../../../packages/api-client/openapi.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(buildOpenApi(app), null, 2)}\n`);
await app.close();
await pool.end();
