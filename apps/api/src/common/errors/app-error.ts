/** Unified error envelope: { code, message, details } (invariant 15). */
export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
  toBody(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export const Errors = {
  validation: (details: unknown, message = 'Invalid input') => new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Forbidden', code = 'FORBIDDEN') => new AppError(403, code, message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  unprocessable: (code: string, message: string, details?: unknown) => new AppError(422, code, message, details),
  insufficientFunds: (details?: unknown) =>
    new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient available balance', details),
  idempotencyKeyReused: () =>
    new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request body'),
  idempotencyInProgress: () =>
    new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed'),
};

/** Maps any thrown value to a status + envelope; unknown errors never leak internals. */
export function toErrorResponse(e: unknown): { status: number; body: ErrorBody } {
  if (e instanceof AppError) return { status: e.status, body: e.toBody() };
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } };
}
