import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';

describe('FakeClock', () => {
  it('advances deterministically and returns copies', () => {
    const c = new FakeClock('2030-01-01T00:00:00.000Z');
    c.advance(1500);
    expect(c.now().toISOString()).toBe('2030-01-01T00:00:01.500Z');
    c.now().setFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2030);
  });
});
