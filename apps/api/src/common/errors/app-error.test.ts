import { describe, expect, it } from 'vitest';
import { Errors, toErrorResponse } from './app-error.js';

describe('error envelope', () => {
  it('serialises AppError with code/message/details', () => {
    const r = toErrorResponse(Errors.validation([{ path: 'amount' }]));
    expect(r).toEqual({
      status: 400,
      body: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: [{ path: 'amount' }] },
    });
  });
  it('hides internals of unknown errors', () => {
    const r = toErrorResponse(new Error('secret SQL'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});
