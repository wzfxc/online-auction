import { describe, expect, it } from 'vitest';
import { ANTI_SNIPE_WINDOW_MS, endsAtAfterBid, rankCandidates } from './closing.js';

const at = (s: string) => new Date(`2030-01-01T${s}Z`);

describe('endsAtAfterBid', () => {
  it('keeps the end when the bid is earlier than the last 2 minutes', () => {
    expect(endsAtAfterBid(at('12:00:00'), at('11:57:00'))).toEqual(at('12:00:00'));
  });

  it('moves the end to now + 2 minutes for a bid in the last 2 minutes', () => {
    expect(endsAtAfterBid(at('12:00:00'), at('11:59:00'))).toEqual(at('12:01:00'));
  });

  it('extends again and again without a cap', () => {
    let end = at('12:00:00');
    let now = at('11:59:30');
    for (let i = 0; i < 20; i++) {
      end = endsAtAfterBid(end, now);
      expect(end.getTime()).toBe(now.getTime() + ANTI_SNIPE_WINDOW_MS);
      now = new Date(end.getTime() - 1_000);
    }
  });

  it('never moves the end earlier', () => {
    expect(endsAtAfterBid(at('12:00:00'), at('11:58:00'))).toEqual(at('12:00:00'));
  });
});

describe('rankCandidates', () => {
  it('sorts by max desc, then earlier seq', () => {
    const r = rankCandidates([
      { userId: 'c', maxAmount: 100, reachedSeq: 5 },
      { userId: 'a', maxAmount: 200, reachedSeq: 9 },
      { userId: 'b', maxAmount: 100, reachedSeq: 2 },
    ]);
    expect(r.map((x) => x.userId)).toEqual(['a', 'b', 'c']);
  });
});
