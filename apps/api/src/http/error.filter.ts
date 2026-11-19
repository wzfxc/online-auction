import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, Errors, type ErrorBody } from '../common/errors/app-error.js';
import {
  PG_CHECK_VIOLATION, PG_FOREIGN_KEY_VIOLATION, PG_INVALID_BYTE_SEQUENCE, PG_NUMERIC_VALUE_OUT_OF_RANGE,
  pgConstraint, pgErrorCode,
} from '../common/errors/pg-errors.js';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMIT_EXCEEDED',
};

function httpStatusOf(e: unknown): number | null {
  if (e instanceof HttpException) return e.getStatus();
  // body-parser / express errors carry a numeric client-error status (malformed JSON, oversized body).
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

/** Maps every thrown value to `{code, message, details}`; unknown errors never leak internals (invariant 15). */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('ErrorFilter');

  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(e);
    if (status === 429 && !res.getHeader('Retry-After')) {
      const retry = (body.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (typeof retry === 'number' && retry > 0) res.setHeader('Retry-After', String(retry));
    }
    res.status(status).json(body);
  }

  private map(e: unknown): { status: number; body: ErrorBody } {
    if (e instanceof AppError) return { status: e.status, body: e.toBody() };
    const status = httpStatusOf(e);
    if (status !== null) {
      const message = e instanceof Error ? e.message : 'Bad request';
      return { status, body: { code: CODE_BY_STATUS[status] ?? 'BAD_REQUEST', message } };
    }
    const pgCode = pgErrorCode(e);
    // Safety net: a spend that slipped past the explicit check hits the non-negative balance CHECK.
    if (pgCode === PG_CHECK_VIOLATION && pgConstraint(e) === 'accounts_user_nonneg') {
      const err = Errors.insufficientFunds();
      return { status: err.status, body: err.toBody() };
    }
    if (pgCode === PG_INVALID_BYTE_SEQUENCE) {
      return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Invalid characters in input' } };
    }
    if (pgCode === PG_FOREIGN_KEY_VIOLATION) {
      return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Referenced record does not exist' } };
    }
    if (pgCode === PG_NUMERIC_VALUE_OUT_OF_RANGE) {
      return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Numeric value out of range' } };
    }
    this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } };
  }
}
