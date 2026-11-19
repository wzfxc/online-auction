import { and, eq, gt } from 'drizzle-orm';
import { calcDeposit } from '@auction/shared';
import { Errors } from '../common/errors/app-error.js';
import { deposits } from '../db/schema.js';
import { balanceOf, post, type PostResult, type Tx } from './ledger.js';

export interface WalletBalance {
  available: number;
  held: number;
}

export async function getBalance(tx: Tx, userId: string): Promise<WalletBalance> {
  return {
    available: await balanceOf(tx, { type: 'user_available', userId }),
    held: await balanceOf(tx, { type: 'user_hold', userId }),
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
