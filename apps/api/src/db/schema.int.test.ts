import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, runMigrations } from './client.js';
import { accounts, ledgerEntries, ledgerTransactions, users } from './schema.js';

const { pool, db } = createDb(process.env.TEST_DATABASE_URL);

async function newUserAccount(email: string) {
  const [u] = await db.insert(users).values({ email, displayName: 'T', passwordHash: 'x' }).returning();
  const [a] = await db.insert(accounts).values({ userId: u!.id, type: 'user_available' }).returning();
  return a!;
}
/** Drizzle wraps driver errors; the Postgres message lives in `cause`. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = e instanceof Error ? (e.cause as Error | undefined) : undefined;
    return cause?.message ?? (e instanceof Error ? e.message : String(e));
  }
  return 'NO_ERROR';
}
async function newTx() {
  const [t] = await db.insert(ledgerTransactions).values({ kind: 'test' }).returning();
  return t!;
}

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
});
afterAll(() => pool.end());

describe('ledger constraints', () => {
  it('rejects an unbalanced transaction at commit', async () => {
    const acc = await newUserAccount(`a${Math.random()}@t.test`);
    const tx = await newTx();
    const msg = await pgError(
      db.transaction((t) => t.insert(ledgerEntries).values({ txId: tx.id, accountId: acc.id, amount: 100 })),
    );
    expect(msg).toMatch(/unbalanced/);
  });

  it('accepts a balanced transaction and maintains balances', async () => {
    const a = await newUserAccount(`b${Math.random()}@t.test`);
    const b = await newUserAccount(`c${Math.random()}@t.test`);
    // Give a funds via a system gateway-like counter entry is not allowed for user accounts to go negative,
    // so move funds from b (credited first in the same tx) is impossible; use mixed tx: +100 a, -100 b fails nonneg.
    const tx = await newTx();
    await expect(
      db.transaction((t) => t.insert(ledgerEntries).values([
        { txId: tx.id, accountId: a.id, amount: 100 },
        { txId: tx.id, accountId: b.id, amount: -100 },
      ])),
    ).rejects.toThrow(); // b would go negative
    const [gw] = await db.insert(accounts).values({ type: 'gateway' }).onConflictDoNothing().returning();
    const gateway = gw ?? (await db.select().from(accounts).where(sql`type = 'gateway'`))[0]!;
    const tx2 = await newTx();
    await db.insert(ledgerEntries).values([
      { txId: tx2.id, accountId: a.id, amount: 500 },
      { txId: tx2.id, accountId: gateway.id, amount: -500 },
    ]);
    const [row] = await db.select().from(accounts).where(sql`id = ${a.id}`);
    expect(row!.balance).toBe(500);
  });

  it('forbids negative user balances and entry mutation', async () => {
    const a = await newUserAccount(`d${Math.random()}@t.test`);
    const gateway = (await db.select().from(accounts).where(sql`type = 'gateway'`))[0]!;
    const tx = await newTx();
    await expect(
      db.insert(ledgerEntries).values([
        { txId: tx.id, accountId: a.id, amount: -1 },
        { txId: tx.id, accountId: gateway.id, amount: 1 },
      ]),
    ).rejects.toThrow();
    expect(await pgError(db.execute(sql`delete from ledger_entries`))).toMatch(/append-only/);
  });

  it('allows only one open sale per lot', async () => {
    const r = await db.execute(sql`select indexdef from pg_indexes where indexname = 'sales_one_open_per_lot_uq'`);
    expect(r.rows).toHaveLength(1);
  });
});
