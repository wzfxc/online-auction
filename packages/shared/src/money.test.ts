import { describe, expect, it } from 'vitest';
import { bidStep, calcDeposit, calcFee } from './money.js';

describe('money rules', () => {
  it('uses the tiered bid step', () => {
    expect(bidStep(9_999)).toBe(500);
    expect(bidStep(10_000)).toBe(1000);
    expect(bidStep(99_999)).toBe(1000);
    expect(bidStep(100_000)).toBe(5000);
    expect(bidStep(999_999)).toBe(5000);
    expect(bidStep(1_000_000)).toBe(10_000);
  });
  it('rounds fee down with a 10 UAH minimum', () => {
    expect(calcFee(10_000)).toBe(1000);
    expect(calcFee(100_001)).toBe(5000);
    expect(calcFee(500)).toBe(500);
  });
  it('applies deposit minimum of 50 UAH', () => {
    expect(calcDeposit(10_000)).toBe(5000);
    expect(calcDeposit(1_000_000)).toBe(100_000);
  });
  it('rejects non-integer amounts', () => {
    expect(() => calcFee(10.5)).toThrow(RangeError);
  });
});
