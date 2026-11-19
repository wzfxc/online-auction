import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';

const uuid = z.string().uuid();

/** Path ids that are not UUIDs are a client error, not a database error. */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const r = uuid.safeParse(value);
    if (!r.success) throw Errors.validation([{ path: ['id'], message: 'must be a UUID' }]);
    return r.data;
  }
}

const keySchema = z.string().min(8).max(128).regex(/^[\x21-\x7e]+$/);

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const r = keySchema.safeParse(header);
  if (!r.success) {
    throw Errors.validation([{ path: ['Idempotency-Key'], message: 'required header, 8-128 printable ASCII characters' }]);
  }
  return r.data;
}
