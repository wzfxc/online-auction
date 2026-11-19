import { and, eq, isNull, sql } from 'drizzle-orm';
import { assertKopecks } from '@auction/shared';
import type { Db } from '../db/client.js';
import { accounts, ledgerEntries, ledgerTransactions } from '../db/schema.js';

/** A drizzle transaction handle; all balance changes must run inside a transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type SystemAccountType = 'escrow' | 'platform_fee' | 'gateway';
export type UserAccountType = 'user_available' | 'user_hold' | 'seller_payable';
export type AccountRef = { type: SystemAccountType } | { type: UserAccountType; userId: string };

export interface Movement {
  from: AccountRef;
  to: AccountRef;
  /** Positive integer kopecks. */
  amount: number;
}

export interface PostInput {
  kind: string;
  lotId?: string;
  /** Natural key: the same business effect is applied at most once. */
  effectKey?: string;
  movements: readonly Movement[];
}

export interface PostResult {
  txId: string;
  /** false when effectKey was already applied (nothing was written). */
  applied: boolean;
}

export async function getAccountId(tx: Tx, ref: AccountRef): Promise<string> {
  const userId = 'userId' in ref ? ref.userId : null;
  const scope = userId === null ? isNull(accounts.userId) : eq(accounts.userId, userId);
  const find = () => tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.type, ref.type), scope));
  const [existing] = await find();
  if (existing) return existing.id;
  await tx.insert(accounts).values({ type: ref.type, userId }).onConflictDoNothing();
  const [created] = await find();
  if (!created) throw new Error(`Account ${ref.type} could not be created`);
  return created.id;
}

/**
 * Posts one balanced ledger transaction. Every movement yields a debit and a credit entry,
 * so the sum is zero by construction (and the DB deferred trigger re-checks it at commit).
 * Entries are inserted in a stable account order to avoid deadlocks between concurrent transactions.
 */
export async function post(tx: Tx, input: PostInput): Promise<PostResult> {
  if (input.movements.length === 0) throw new RangeError('Ledger transaction needs at least one movement');
  for (const m of input.movements) {
    assertKopecks(m.amount);
    if (m.amount === 0) throw new RangeError('Movement amount must be positive');
  }

  const [row] = await tx
    .insert(ledgerTransactions)
    .values({ kind: input.kind, lotId: input.lotId ?? null, effectKey: input.effectKey ?? null })
    .onConflictDoNothing({ target: ledgerTransactions.effectKey })
    .returning({ id: ledgerTransactions.id });
  if (!row) {
    const [prev] = await tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.effectKey, input.effectKey ?? ''));
    if (!prev) throw new Error('Ledger transaction insert conflicted without an existing effectKey row');
    return { txId: prev.id, applied: false };
  }

  const net = new Map<string, number>();
  for (const m of input.movements) {
    const from = await getAccountId(tx, m.from);
    const to = await getAccountId(tx, m.to);
    net.set(from, (net.get(from) ?? 0) - m.amount);
    net.set(to, (net.get(to) ?? 0) + m.amount);
  }
  const entries = [...net.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([accountId, amount]) => ({ txId: row.id, accountId, amount }));
  if (entries.length > 0) await tx.insert(ledgerEntries).values(entries);
  return { txId: row.id, applied: true };
}

export async function balanceOf(tx: Tx, ref: AccountRef): Promise<number> {
  const id = await getAccountId(tx, ref);
  const [row] = await tx.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return row?.balance ?? 0;
}

/** Transactions whose entries do not sum to zero; must always be empty. */
export async function findUnbalancedTransactions(tx: Tx): Promise<string[]> {
  const r = await tx.execute(sql`select tx_id from ledger_entries group by tx_id having sum(amount) <> 0`);
  return r.rows.map((x) => String((x as { tx_id: string }).tx_id));
}
