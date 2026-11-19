import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, type ErrorBody } from '../common/errors/app-error.js';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED',
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
    res.status(status).json(body);
  }

  private map(e: unknown): { status: number; body: ErrorBody } {
    if (e instanceof AppError) return { status: e.status, body: e.toBody() };
    const status = httpStatusOf(e);
    if (status !== null) {
      const message = e instanceof Error ? e.message : 'Bad request';
      return { status, body: { code: CODE_BY_STATUS[status] ?? 'BAD_REQUEST', message } };
    }
    this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } };
  }
}
