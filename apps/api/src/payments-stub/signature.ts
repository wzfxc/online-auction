import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-payment-signature';

/** HMAC-SHA256 (hex) over the raw request body. */
export function signWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time check; a missing or malformed signature is simply invalid. */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signWebhook(rawBody, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
