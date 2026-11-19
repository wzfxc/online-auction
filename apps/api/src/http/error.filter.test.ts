import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ErrorFilter } from './error.filter.js';

function run(err: unknown): { status: number; body: unknown } {
  const out: { status: number; body: unknown } = { status: 0, body: null };
  const res = {
    getHeader: () => undefined, setHeader: vi.fn(),
    status(code: number) { out.status = code; return this; },
    json(b: unknown) { out.body = b; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new ErrorFilter().catch(err, host);
  return out;
}

describe('ErrorFilter: insufficient funds', () => {
  it('maps the non-negative balance CHECK (even wrapped in a driver error) to 422 INSUFFICIENT_FUNDS, not 500', () => {
    const pg = Object.assign(new Error('violates check constraint'), { code: '23514', constraint: 'accounts_user_nonneg' });
    const wrapped = Object.assign(new Error('Failed query'), { cause: pg });
    for (const e of [pg, wrapped]) {
      expect(run(e)).toEqual({ status: 422, body: { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient available balance' } });
    }
  });

  it('other CHECK violations stay opaque 500s without internals', () => {
    const pg = Object.assign(new Error('secret sql'), { code: '23514', constraint: 'lots_prices' });
    const r = run(pg);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});
