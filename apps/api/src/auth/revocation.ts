import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { revokedTokens } from '../db/schema.js';

export async function revokeToken(db: Db, jti: string, expiresAt: Date): Promise<void> {
  await db.insert(revokedTokens).values({ jti, expiresAt }).onConflictDoNothing();
}

export async function isTokenRevoked(db: Db, jti: string | undefined, now: Date): Promise<boolean> {
  if (!jti) return false;
  const [row] = await db
    .select({ jti: revokedTokens.jti })
    .from(revokedTokens)
    .where(and(eq(revokedTokens.jti, jti), gt(revokedTokens.expiresAt, now)))
    .limit(1);
  return Boolean(row);
}
