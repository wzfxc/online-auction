/* global process, fetch, console, setTimeout */
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:8080';

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email, password = 'password123') {
  const r = await json(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200, `login failed for ${email}`);
  return r.body.token;
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  console.log('1) Checking health & docs...');
  assert.equal((await json(`${API}/health`)).status, 200);
  const docsRes = await fetch(`${API}/docs-json`);
  assert.equal(docsRes.status, 200);

  const sellerToken = await login('seller1@auction.test');
  const modToken = await login('moderator1@auction.test');
  const buyerToken = await login('buyer1@auction.test');
  const finToken = await login('finance1@auction.test');

  const cats = (await json(`${API}/categories`)).body;
  const cities = (await json(`${API}/cities`)).body;
  assert.equal(cats.length, 30);
  assert.equal(cities.length, 15);

  console.log('2) Acceptance 13: stopping Meilisearch -> bids still work, search returns 503, then catches up...');
  const uniqueTitle = `MeiliOutage-${Date.now()}`;
  const created = await json(`${API}/lots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sellerToken}` },
    body: JSON.stringify({
      title: uniqueTitle,
      description: 'Outage recovery check',
      categoryId: cats[0].id,
      cityId: cities[0].id,
      condition: 'good',
      startPrice: 15_000,
      durationDays: 3,
    }),
  });
  assert.equal(created.status, 201);
  const lotId = created.body.id;
  await json(`${API}/lots/${lotId}/submit`, { method: 'POST', headers: { authorization: `Bearer ${sellerToken}` } });
  await json(`${API}/lots/${lotId}/approve`, { method: 'POST', headers: { authorization: `Bearer ${modToken}` } });

  run('docker compose stop meilisearch');
  try {
    const downSearch = await json(`${API}/search?q=${encodeURIComponent(uniqueTitle)}`);
    assert.equal(downSearch.status, 503);
    assert.equal(downSearch.body.code, 'SEARCH_UNAVAILABLE');

    // Bidding must keep working while Meilisearch is down:
    const bidRes = await json(`${API}/lots/${lotId}/bids`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${buyerToken}`,
        'idempotency-key': `accept-13-${Date.now()}`,
      },
      body: JSON.stringify({ amount: 15_000 }),
    });
    assert.equal(bidRes.status, 201);
  } finally {
    run('docker compose start meilisearch');
  }

  let caughtUp = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await json(`${API}/search?q=${encodeURIComponent(uniqueTitle)}`);
    if (s.status === 200 && s.body.items.some((x) => x.id === lotId && x.currentPrice === 15_000)) {
      caughtUp = true;
      break;
    }
  }
  assert.equal(caughtUp, true, 'Meilisearch did not catch up from outbox within 30s');

  console.log('3) Acceptance 15: Redis FLUSHALL + 3 worker replicas...');
  run('docker compose exec -T redis redis-cli FLUSHALL');
  run('docker compose restart worker');
  run('docker compose up -d --scale worker=3 --no-recreate');
  await new Promise((r) => setTimeout(r, 4000));
  const ps = run('docker compose ps worker');
  assert.match(ps, /worker-1/);
  assert.match(ps, /worker-2/);
  assert.match(ps, /worker-3/);
  run('docker compose up -d --scale worker=1 --no-recreate');

  console.log('4) Acceptance 17: Finance reconciliation check after all operations...');
  const rec = await json(`${API}/reports/reconciliation`, {
    headers: { authorization: `Bearer ${finToken}` },
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.healthy, true, `Reconciliation unhealthy: ${JSON.stringify(rec.body)}`);
  assert.equal(rec.body.entriesSum, 0);
  assert.deepEqual(rec.body.unbalancedTransactions, []);
  assert.deepEqual(rec.body.walletMismatches, []);
  assert.deepEqual(rec.body.paymentDiscrepancies, []);
  console.log('All live Docker Compose acceptance checks passed:', {
    checkedAccounts: rec.body.checkedAccounts,
    checkedPayments: rec.body.checkedPayments,
    entriesSum: rec.body.entriesSum,
    healthy: rec.body.healthy,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
