/** Money is UAH in kopecks, always integers. */
export type Kopecks = number;

export const MIN_FEE_KOPECKS = 1000;
export const FEE_PERCENT = 5;
export const DEPOSIT_PERCENT = 10;
export const MIN_DEPOSIT_KOPECKS = 5000;

/** Fee rounds down (in seller's favour); at least 10 UAH, never above the price. */
export function calcFee(price: Kopecks): Kopecks {
  assertKopecks(price);
  const fee = Math.max(MIN_FEE_KOPECKS, Math.floor((price * FEE_PERCENT) / 100));
  return Math.min(fee, price);
}

/** Deposit: 10% of max bid, at least 50 UAH (rounded up to a kopeck). */
export function calcDeposit(maxBid: Kopecks): Kopecks {
  assertKopecks(maxBid);
  return Math.max(MIN_DEPOSIT_KOPECKS, Math.ceil((maxBid * DEPOSIT_PERCENT) / 100));
}

/** Bid step by current price: <100 UAH 5, <1000 10, <10000 50, else 100 UAH. */
export function bidStep(price: Kopecks): Kopecks {
  assertKopecks(price);
  if (price < 10_000) return 500;
  if (price < 100_000) return 1000;
  if (price < 1_000_000) return 5000;
  return 10_000;
}

export function assertKopecks(v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`Invalid kopecks amount: ${v}`);
}
