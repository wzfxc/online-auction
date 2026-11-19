import { describe, expect, it } from 'vitest';
import { bidStep } from './money.js';
import {
  maskName, minNextBid, placeBidSchema, resolveBid, type BidResolution, type LotBidState,
} from './bidding.js';

const START = 10_000;
const fresh = (): LotBidState => ({ startPrice: START, currentPrice: START, bidCount: 0, leader: null });

/** Applies one bid at the minimum amount allowed, returning the new state or null if rejected. */
function apply(state: LotBidState, userId: string, max: number): LotBidState | null {
  const r = resolveBid(state, { userId, amount: minNextBid(state), max });
  if ('rejected' in r) return null;
  return { ...state, currentPrice: r.price, bidCount: state.bidCount + r.steps.length, leader: r.leader };
}

// Small deterministic PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('resolveBid', () => {
  it('first bid sets price to the amount', () => {
    const r = resolveBid(fresh(), { userId: 'a', amount: START, max: 100_000 }) as BidResolution;
    expect(r.price).toBe(START);
    expect(r.leader).toEqual({ userId: 'a', max: 100_000 });
  });

  it('rejects below the minimum next bid', () => {
    const s = apply(fresh(), 'a', 50_000)!;
    expect(resolveBid(s, { userId: 'b', amount: s.currentPrice, max: 60_000 })).toEqual({ rejected: 'BID_TOO_LOW' });
  });

  it('auto bids 1000/1500 UAH resolve to 1050 in either order', () => {
    const a = 100_000;
    const b = 150_000;
    const ab = apply(apply(fresh(), 'a', a)!, 'b', b)!;
    const ba = apply(apply(fresh(), 'b', b)!, 'a', a)!;
    expect(ab.currentPrice).toBe(105_000);
    expect(ba.currentPrice).toBe(105_000);
    expect(ab.leader?.userId).toBe('b');
    expect(ba.leader?.userId).toBe('b');
  });

  it('equal maxima favour the earlier bidder at their max', () => {
    const s = apply(apply(fresh(), 'a', 50_000)!, 'b', 50_000)!;
    expect(s.leader?.userId).toBe('a');
    expect(s.currentPrice).toBe(50_000);
  });

  it('outbid-at-once records the bidder then an auto bid for the leader', () => {
    const s = apply(fresh(), 'a', 100_000)!;
    const r = resolveBid(s, { userId: 'b', amount: minNextBid(s), max: 20_000 }) as BidResolution;
    expect(r.steps.map((x) => [x.userId, x.kind, x.outcome])).toEqual([
      ['b', 'manual', 'outbid_by_auto'], ['a', 'auto', 'leading'],
    ]);
    expect(r.outbidUserId).toBe('b');
    expect(r.price).toBe(20_000 + bidStep(20_000));
  });

  it('leader may only raise their own maximum', () => {
    const s = apply(fresh(), 'a', 50_000)!;
    expect(resolveBid(s, { userId: 'a', amount: 50_000, max: 50_000 })).toEqual({ rejected: 'BID_MAX_NOT_HIGHER' });
    const r = resolveBid(s, { userId: 'a', amount: s.currentPrice, max: 80_000 }) as BidResolution;
    expect(r.price).toBe(s.currentPrice);
    expect(r.outbidUserId).toBeNull();
  });

  it('final leader is the highest maximum regardless of arrival order', () => {
    const rnd = mulberry32(42);
    for (let round = 0; round < 200; round++) {
      const maxes = Array.from({ length: 2 + Math.floor(rnd() * 5) }, (_, i) => ({
        id: `u${i}`, max: 50_000 + i * 20_000 + 20_000 * Math.floor(rnd() * 3) * 6,
      }));
      const top = maxes.reduce((m, x) => (x.max > m.max ? x : m));
      for (let perm = 0; perm < 5; perm++) {
        const order = [...maxes].sort(() => rnd() - 0.5);
        let s: LotBidState | null = fresh();
        for (const m of order) s = apply(s, m.id, m.max) ?? s;
        if (new Set(maxes.map((m) => m.max)).size === maxes.length) expect(s.leader?.userId).toBe(top.id);
        expect(s.currentPrice).toBeLessThanOrEqual(s.leader!.max);
      }
    }
  });
});

describe('placeBidSchema', () => {
  it('rejects maxAmount below amount and non-integers', () => {
    expect(placeBidSchema.safeParse({ amount: 100, maxAmount: 50 }).success).toBe(false);
    expect(placeBidSchema.safeParse({ amount: 10.5 }).success).toBe(false);
    expect(placeBidSchema.safeParse({ amount: 100, maxAmount: 100 }).success).toBe(true);
  });
});

describe('maskName', () => {
  it('keeps first and last letters', () => {
    expect(maskName('Олена Коваль')).toBe('О***ь');
    expect(maskName('X')).toBe('X***');
  });
});
