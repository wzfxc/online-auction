import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:8080';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://auction:auction_dev_password@127.0.0.1:5433/auction';

async function registerUser(
  request: APIRequestContext,
  role: 'buyer' | 'seller',
  prefix: string,
): Promise<{ email: string; password: string; token: string; id: string; displayName: string }> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `${prefix}-${suffix}@e2e.test`;
  const password = 'password123';
  const displayName = `${prefix} User ${suffix.slice(-4)}`;
  const res = await request.post(`${API_URL}/auth/register`, {
    data: { email, password, displayName, role },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { email, password, token: body.token, id: body.user.id, displayName };
}

async function loginApi(request: APIRequestContext, email: string, password = 'password123'): Promise<string> {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function uiLogin(page: Page, email: string, password = 'password123'): Promise<void> {
  await page.goto('/uk/login');
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('user-badge')).toBeVisible();
}

async function uiTopUpViaStub(page: Page, amountUah: string): Promise<void> {
  await page.goto('/uk/buyer');
  await page.getByTestId('topup-amount-input').fill(amountUah);
  await page.getByTestId('topup-submit-btn').click();
  await page.waitForURL(/\/payments-stub\/pay\//);
  await page.getByTestId('pay-success').click();
  await page.waitForURL(/\/uk\/buyer/);
  await expect
    .poll(async () => (await page.getByTestId('wallet-available').textContent()) ?? '', { timeout: 10_000 })
    .not.toBe('0,00 ₴');
}

async function createAndApproveLot(
  request: APIRequestContext,
  sellerToken: string,
  modToken: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const cats = (await (await request.get(`${API_URL}/categories`)).json()) as { id: string }[];
  const cities = (await (await request.get(`${API_URL}/cities`)).json()) as { id: string }[];
  const createRes = await request.post(`${API_URL}/lots`, {
    headers: { Authorization: `Bearer ${sellerToken}` },
    data: {
      title: `E2E Lot ${Date.now()}`,
      description: 'Playwright live test lot',
      categoryId: cats[0]!.id,
      cityId: cities[0]!.id,
      condition: 'good',
      startPrice: 10_000, // 100 UAH
      durationDays: 3,
      ...overrides,
    },
  });
  expect(createRes.status()).toBe(201);
  const lot = (await createRes.json()) as { id: string };
  expect((await request.post(`${API_URL}/lots/${lot.id}/submit`, { headers: { Authorization: `Bearer ${sellerToken}` } })).status()).toBe(200);
  expect((await request.post(`${API_URL}/lots/${lot.id}/approve`, { headers: { Authorization: `Bearer ${modToken}` } })).status()).toBe(200);
  return lot.id;
}

test.describe('Online Auction E2E', () => {
  test('1) two browsers on one lot: live bid sync and auto-bid outbid alert', async ({ browser, request }) => {
    const seller = await registerUser(request, 'seller', 'e2e-s1');
    const buyerA = await registerUser(request, 'buyer', 'e2e-a1');
    const buyerB = await registerUser(request, 'buyer', 'e2e-b1');
    const modToken = await loginApi(request, 'moderator1@auction.test');

    const lotId = await createAndApproveLot(request, seller.token, modToken);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await uiLogin(pageA, buyerA.email);
      await uiTopUpViaStub(pageA, '1000');

      await uiLogin(pageB, buyerB.email);
      await uiTopUpViaStub(pageB, '1000');

      await pageA.goto(`/uk/lots/${lotId}`);
      await pageB.goto(`/uk/lots/${lotId}`);
      await expect(pageA.getByTestId('live-status')).toContainText('увімкнено');
      await expect(pageB.getByTestId('live-status')).toContainText('увімкнено');

      // Buyer A places bid 100 UAH with auto-bid max 300 UAH:
      await pageA.getByTestId('bid-amount-input').fill('100');
      await pageA.getByTestId('bid-max-input').fill('300');
      await pageA.getByTestId('place-bid-btn').click();
      await expect(pageA.getByTestId('bid-feedback')).toBeVisible();

      // Browser B receives live update without reload (< 2s):
      await expect(pageB.getByTestId('lot-current-price')).toContainText('100,00 ₴', { timeout: 5_000 });
      await expect(pageB.getByTestId('lot-bid-count')).toContainText('1 ставка');

      // Buyer B places bid 110 UAH with auto-bid max 500 UAH -> outbids A at 310 UAH:
      await pageB.getByTestId('bid-amount-input').fill('110');
      await pageB.getByTestId('bid-max-input').fill('500');
      await pageB.getByTestId('place-bid-btn').click();
      await expect(pageB.getByTestId('lot-current-price')).toContainText('310,00 ₴');

      // Browser A immediately receives both live price and private outbid notification:
      await expect(pageA.getByTestId('lot-current-price')).toContainText('310,00 ₴', { timeout: 5_000 });
      await expect(pageA.getByTestId('lot-outbid-alert')).toBeVisible({ timeout: 5_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('2) anti-sniping in last 2 minutes extends end time for both browsers', async ({ browser, request }) => {
    const seller = await registerUser(request, 'seller', 'e2e-s2');
    const buyerA = await registerUser(request, 'buyer', 'e2e-a2');
    const buyerB = await registerUser(request, 'buyer', 'e2e-b2');
    const modToken = await loginApi(request, 'moderator1@auction.test');

    const lotId = await createAndApproveLot(request, seller.token, modToken);

    // Move ends_at to 50 seconds from now so the next bid triggers anti-sniping (+2 min):
    const pool = new pg.Pool({ connectionString: DB_URL });
    try {
      await pool.query("update lots set ends_at = now() + interval '50 seconds' where id = $1", [lotId]);
    } finally {
      await pool.end();
    }

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await uiLogin(pageA, buyerA.email);
      await uiTopUpViaStub(pageA, '500');

      await uiLogin(pageB, buyerB.email);

      await pageA.goto(`/uk/lots/${lotId}`);
      await pageB.goto(`/uk/lots/${lotId}`);
      await expect(pageA.getByTestId('live-status')).toContainText('увімкнено');
      await expect(pageB.getByTestId('live-status')).toContainText('увімкнено');

      const endsBefore = await pageB.getByTestId('lot-ends-at').textContent();

      await pageA.getByTestId('bid-amount-input').fill('100');
      await pageA.getByTestId('place-bid-btn').click();
      await expect(pageA.getByTestId('bid-feedback')).toBeVisible();

      await expect
        .poll(async () => await pageB.getByTestId('lot-ends-at').textContent(), { timeout: 5_000 })
        .not.toBe(endsBefore);
      await expect
        .poll(async () => await pageA.getByTestId('lot-ends-at').textContent(), { timeout: 5_000 })
        .not.toBe(endsBefore);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('3) full flow: stub top-up -> buy-now (keyboard) -> pay (keyboard) -> ship -> confirm -> payout & reconciliation', async ({
    browser,
    request,
  }) => {
    const seller = await registerUser(request, 'seller', 'e2e-s3');
    const buyer = await registerUser(request, 'buyer', 'e2e-b3');
    const modToken = await loginApi(request, 'moderator1@auction.test');

    const sellerCtx = await browser.newContext();
    const buyerCtx = await browser.newContext();
    const finCtx = await browser.newContext();
    const sellerPage = await sellerCtx.newPage();
    const buyerPage = await buyerCtx.newPage();
    const finPage = await finCtx.newPage();

    try {
      // Seller creates a draft lot via UI and submits it:
      await uiLogin(sellerPage, seller.email);
      await sellerPage.goto('/uk/seller');
      const title = `E2E Full Flow ${Date.now()}`;
      await sellerPage.getByTestId('lot-title-input').fill(title);
      await sellerPage.getByTestId('lot-desc-input').fill('E2E full deal lifecycle item');
      await sellerPage.getByTestId('lot-start-price').fill('100');
      await sellerPage.getByTestId('lot-buynow-price').fill('200');
      await sellerPage.getByTestId('save-lot-btn').click();
      await expect(sellerPage.getByTestId('submit-lot-btn')).toBeVisible();
      await sellerPage.getByTestId('submit-lot-btn').click();

      // Locate created lot id and approve via moderator API:
      const mineRes = await request.get(`${API_URL}/lots/mine`, {
        headers: { Authorization: `Bearer ${seller.token}` },
      });
      const mine = (await mineRes.json()) as { items: { id: string; title: string }[] };
      const lotId = mine.items.find((l) => l.title === title)!.id;
      expect((await request.post(`${API_URL}/lots/${lotId}/approve`, { headers: { Authorization: `Bearer ${modToken}` } })).status()).toBe(200);

      // Buyer logs in, tops up via stub, buys now and pays using keyboard:
      await uiLogin(buyerPage, buyer.email);
      await uiTopUpViaStub(buyerPage, '500');

      await buyerPage.goto(`/uk/lots/${lotId}`);
      await expect(buyerPage.getByTestId('buy-now-btn')).toBeVisible();
      await buyerPage.getByTestId('buy-now-btn').focus();
      await buyerPage.keyboard.press('Enter');

      await expect(buyerPage.getByTestId('lot-sale-panel')).toBeVisible();
      await expect(buyerPage.getByTestId('pay-sale-btn')).toBeVisible();
      await buyerPage.getByTestId('pay-sale-btn').focus();
      await buyerPage.keyboard.press('Enter');
      await expect(buyerPage.getByTestId('lot-status-badge')).toContainText('Оплачено');

      // Seller ships with tracking number on the lot page:
      await sellerPage.goto(`/uk/lots/${lotId}`);
      await expect(sellerPage.getByTestId('tracking-input')).toBeVisible();
      await sellerPage.getByTestId('tracking-input').fill('NP-E2E-777888');
      await sellerPage.getByTestId('ship-sale-btn').click();
      await expect(sellerPage.getByTestId('lot-status-badge')).toContainText('Відправлено');

      // Buyer confirms receipt -> seller payout credited (200 - 5% = 190 UAH):
      await buyerPage.reload();
      await expect(buyerPage.getByTestId('confirm-receipt-btn')).toBeVisible();
      await buyerPage.getByTestId('confirm-receipt-btn').click();
      await expect(buyerPage.getByTestId('lot-status-badge')).toContainText('Завершено');

      await sellerPage.goto('/uk/seller');
      await expect(sellerPage.getByTestId('seller-paid-out')).toContainText('190,00 ₴');

      // Finance verifies healthy reconciliation (sum = 0, no mismatches/discrepancies):
      await uiLogin(finPage, 'finance1@auction.test');
      await finPage.goto('/uk/finance');
      await expect(finPage.getByTestId('reconcile-status')).toContainText('розбіжностей немає');
    } finally {
      await sellerCtx.close();
      await buyerCtx.close();
      await finCtx.close();
    }
  });

  test('4) catalog URL state (reload/back), uk/en/pl locales, and seeded latency SLA', async ({ page, request }) => {
    await page.goto('/uk');
    await expect(page.getByTestId('catalog-grid')).toBeVisible();

    await page.locator('#filter-sort').selectOption('price_asc');
    await expect(page).toHaveURL(/sort=price_asc/);
    await page.reload();
    await expect(page.locator('#filter-sort')).toHaveValue('price_asc');

    await page.locator('#filter-sort').selectOption('price_desc');
    await expect(page).toHaveURL(/sort=price_desc/);
    await page.goBack();
    await expect(page).toHaveURL(/sort=price_asc/);

    // Switch locales uk -> en -> pl keeping URL query:
    await page.getByTestId('locale-en').click();
    await expect(page).toHaveURL(/\/en\?sort=price_asc/);
    await expect(page.locator('h1')).toContainText('Lot catalog');

    await page.getByTestId('locale-pl').click();
    await expect(page).toHaveURL(/\/pl\?sort=price_asc/);
    await expect(page.locator('h1')).toContainText('Katalog aukcji');

    // Performance checks on seeded data (50k lots / 500k bids):
    // Warm up once, then measure search, lot + bid history, and 90-day finance report:
    await request.get(`${API_URL}/search?q=Фотоапарат&sort=price_asc`);
    const tSearch0 = performance.now();
    const searchRes = await request.get(`${API_URL}/search?q=Фотоапарат&sort=price_asc`);
    const searchMs = performance.now() - tSearch0;
    expect(searchRes.status()).toBe(200);
    expect(searchMs).toBeLessThan(200);
    const searchJson = (await searchRes.json()) as { items: { id: string }[] };
    const sampleLotId = searchJson.items[0]!.id;

    const tLot0 = performance.now();
    const [lotRes, bidsRes] = await Promise.all([
      request.get(`${API_URL}/lots/${sampleLotId}`),
      request.get(`${API_URL}/lots/${sampleLotId}/bids`),
    ]);
    const lotMs = performance.now() - tLot0;
    expect(lotRes.status()).toBe(200);
    expect(bidsRes.status()).toBe(200);
    expect(lotMs).toBeLessThan(200);

    const finToken = await loginApi(request, 'finance1@auction.test');
    const tRep0 = performance.now();
    const repRes = await request.get(`${API_URL}/reports/period`, {
      headers: { Authorization: `Bearer ${finToken}` },
    });
    const repMs = performance.now() - tRep0;
    expect(repRes.status()).toBe(200);
    expect(repMs).toBeLessThan(500);
  });
});
