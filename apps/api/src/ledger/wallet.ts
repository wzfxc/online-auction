import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { calcDeposit } from '@auction/shared';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { accounts, deposits, ledgerEntries, ledgerTransactions, lots, sales } from '../db/schema.js';
import { balanceOf, post, type PostResult, type Tx, type UserAccountType } from './ledger.js';

export interface WalletBalance {
  available: number;
  held: number;
}

export interface WalletHistoryItemDto {
  id: number;
  txId: string;
  kind: string;
  accountType: UserAccountType;
  amount: number;
  lotId: string | null;
  lotTitle: string | null;
  createdAt: string;
}

export interface WalletHistoryDto {
  available: number;
  held: number;
  total: number;
  payable: number;
  pendingPayout: number;
  items: WalletHistoryItemDto[];
}

export async function getBalance(tx: Tx, userId: string): Promise<WalletBalance> {
  return {
    available: await balanceOf(tx, { type: 'user_available', userId }),
    held: await balanceOf(tx, { type: 'user_hold', userId }),
  };
}

export async function getWalletHistory(db: Db, userId: string, limit = 50): Promise<WalletHistoryDto> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const { available, held, payable } = await db.transaction(async (tx) => ({
    available: await balanceOf(tx, { type: 'user_available', userId }),
    held: await balanceOf(tx, { type: 'user_hold', userId }),
    payable: await balanceOf(tx, { type: 'seller_payable', userId }),
  }));

  const [pendingRow] = await db
    .select({ pending: sql<number>`coalesce(sum(${sales.price} - ${sales.fee}), 0)::bigint` })
    .from(sales)
    .innerJoin(lots, eq(lots.id, sales.lotId))
    .where(and(eq(lots.sellerId, userId), inArray(sales.status, ['paid', 'shipped'])));

  const rows = await db
    .select({
      id: ledgerEntries.id,
      txId: ledgerEntries.txId,
      kind: ledgerTransactions.kind,
      accountType: accounts.type,
      amount: ledgerEntries.amount,
      lotId: ledgerTransactions.lotId,
      lotTitle: lots.title,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txId))
    .leftJoin(lots, eq(lots.id, ledgerTransactions.lotId))
    .where(eq(accounts.userId, userId))
    .orderBy(desc(ledgerEntries.id))
    .limit(safeLimit);

  return {
    available,
    held,
    total: available + held,
    payable,
    pendingPayout: Number(pendingRow?.pending ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      txId: r.txId,
      kind: r.kind,
      accountType: r.accountType as UserAccountType,
      amount: r.amount,
      lotId: r.lotId,
      lotTitle: r.lotTitle ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** Credits the wallet from the payment gateway; `effectKey` (e.g. `topup:<paymentId>`) makes it happen once. */
export function topUp(tx: Tx, userId: string, amount: number, effectKey: string): Promise<PostResult> {
  return post(tx, {
    kind: 'topup',
    effectKey,
    movements: [{ from: { type: 'gateway' }, to: { type: 'user_available', userId }, amount }],
  });
}

/**
 * Brings the deposit a user holds on a lot up to `calcDeposit(maxBid)`.
 * Raising the maximum holds only the difference; lowering is forbidden (D1).
 * Must run in a transaction that already locks the lot row.
 */
export async function holdDepositForMax(tx: Tx, userId: string, lotId: string, maxBid: number): Promise<number> {
  const target = calcDeposit(maxBid);
  const [current] = await tx
    .select({ amount: deposits.amount })
    .from(deposits)
    .where(and(eq(deposits.lotId, lotId), eq(deposits.userId, userId)))
    .for('update');
  const held = current?.amount ?? 0;
  if (target < held) throw Errors.unprocessable('BID_MAX_DECREASE', 'Maximum bid cannot be decreased');
  const delta = target - held;
  if (delta === 0) return 0;

  const { available } = await getBalance(tx, userId);
  if (available < delta) throw Errors.insufficientFunds({ required: delta, available });

  await post(tx, {
    kind: 'deposit_hold',
    lotId,
    movements: [{ from: { type: 'user_available', userId }, to: { type: 'user_hold', userId }, amount: delta }],
  });
  await tx
    .insert(deposits)
    .values({ lotId, userId, amount: target })
    .onConflictDoUpdate({ target: [deposits.lotId, deposits.userId], set: { amount: target, releasedAt: null } });
  return delta;
}

/** Releases the whole deposit back to available in the caller's transaction; no-op when nothing is held. */
export async function releaseDeposit(tx: Tx, userId: string, lotId: string, releasedAt: Date): Promise<number> {
  const [row] = await tx
    .select({ amount: deposits.amount })
    .from(deposits)
    .where(and(eq(deposits.lotId, lotId), eq(deposits.userId, userId), gt(deposits.amount, 0)))
    .for('update');
  if (!row) return 0;
  await post(tx, {
    kind: 'deposit_release',
    lotId,
    movements: [{ from: { type: 'user_hold', userId }, to: { type: 'user_available', userId }, amount: row.amount }],
  });
  await tx
    .update(deposits)
    .set({ amount: 0, releasedAt })
    .where(and(eq(deposits.lotId, lotId), eq(deposits.userId, userId)));
  return row.amount;
}
