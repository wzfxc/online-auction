import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { idempotencyKeys } from '../../db/schema.js';
import { Errors } from '../errors/app-error.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface StoredResponse<T> {
  status: number;
  body: T;
  /** true when the response was replayed from a previous identical request. */
  replayed: boolean;
}

/** Canonical JSON: object keys sorted recursively so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * Runs `handler` at most once per (userId, scope, key), atomically with its own effects.
 * The key row is inserted inside the same transaction as the handler: a parallel duplicate blocks on
 * the unique index until the first commits, then replays the stored response (D7).
 * If the handler throws, the key row rolls back too, so the client may retry.
 */
export async function withIdempotency<T>(
  db: Db,
  args: { userId: string; scope: string; key: string; body: unknown },
  handler: (tx: Tx) => Promise<{ status: number; body: T }>,
): Promise<StoredResponse<T>> {
  const requestHash = hashRequest(args.body);
  const rowFilter = and(
    eq(idempotencyKeys.userId, args.userId),
    eq(idempotencyKeys.scope, args.scope),
    eq(idempotencyKeys.key, args.key),
  );
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({ userId: args.userId, scope: args.scope, key: args.key, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [prev] = await tx.select().from(idempotencyKeys).where(rowFilter);
      if (!prev) throw new Error('Idempotency row vanished');
      if (prev.requestHash !== requestHash) throw Errors.idempotencyKeyReused();
      if (prev.responseStatus === null) throw Errors.idempotencyInProgress();
      return { status: prev.responseStatus, body: prev.responseBody as T, replayed: true };
    }

    const result = await handler(tx);
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: result.status, responseBody: result.body })
      .where(rowFilter);
    return { ...result, replayed: false };
  });
}
