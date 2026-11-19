import { describe, expect, it } from 'vitest';
import { LOT_STATUSES, LOT_TRANSITIONS, canTransition, createLotSchema } from './lots.js';

const valid = {
  title: 'Camera', description: 'Nice', categoryId: '11111111-1111-4111-8111-111111111111',
  cityId: '22222222-2222-4222-8222-222222222222', condition: 'good' as const,
  startPrice: 10_000, durationDays: 3,
};

describe('lot status table', () => {
  it('uses only known statuses', () => {
    for (const t of LOT_TRANSITIONS) {
      expect(LOT_STATUSES).toContain(t.from);
      expect(LOT_STATUSES).toContain(t.to);
    }
  });
  it('allows only the listed actor', () => {
    expect(canTransition('in_review', 'active', 'moderator')).toBe(true);
    expect(canTransition('in_review', 'active', 'seller')).toBe(false);
    expect(canTransition('draft', 'active', 'seller')).toBe(false);
    expect(canTransition('removed', 'active', 'moderator')).toBe(false);
    expect(canTransition('ended_unsold', 'draft', 'seller')).toBe(true);
    expect(canTransition('ended_unsold', 'draft', 'buyer')).toBe(false);
  });
  it('has no way out of terminal statuses', () => {
    for (const s of ['completed', 'removed'] as const) {
      expect(LOT_TRANSITIONS.some((t) => t.from === s)).toBe(false);
    }
  });
});

describe('createLotSchema', () => {
  it('accepts a valid lot', () => expect(createLotSchema.safeParse(valid).success).toBe(true));
  it.each([
    ['duration 0', { durationDays: 0 }],
    ['duration 11', { durationDays: 11 }],
    ['fractional price', { startPrice: 10.5 }],
    ['reserve below start', { reservePrice: 5_000 }],
    ['buy-now below start', { buyNowPrice: 5_000 }],
    ['bad condition', { condition: 'broken' }],
  ])('rejects %s', (_n, patch) => {
    expect(createLotSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
