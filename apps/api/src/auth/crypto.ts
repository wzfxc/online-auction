import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface TokenClaims {
  sub: string;
  role: 'buyer' | 'seller' | 'moderator' | 'finance';
  /** Expiry, seconds since epoch (computed from the injected Clock by the caller). */
  exp: number;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const sign = (data: string, secret: string): string => createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(claims: TokenClaims, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

/** Returns claims for a valid, unexpired token; null otherwise. `nowSec` comes from Clock. */
export function verifyToken(token: string, secret: string, nowSec: number): TokenClaims | null {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const expected = Buffer.from(sign(`${head}.${body}`, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || claims.exp <= nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}

export type Role = TokenClaims['role'];
