import { describe, expect, it } from 'vitest';
import { hashPassword, signToken, verifyPassword, verifyToken } from './crypto.js';

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('tokens', () => {
  const claims = { sub: 'u1', role: 'buyer' as const, exp: 1000 };
  it('accepts valid token', () => {
    expect(verifyToken(signToken(claims, 's'), 's', 999)).toEqual(claims);
  });
  it('rejects expired, tampered and wrong-secret tokens', () => {
    const t = signToken(claims, 's');
    expect(verifyToken(t, 's', 1000)).toBeNull();
    expect(verifyToken(t, 'other', 1)).toBeNull();
    const [h, , sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'finance' })).toString('base64url');
    expect(verifyToken(`${h}.${forged}.${sig}`, 's', 1)).toBeNull();
  });
});
