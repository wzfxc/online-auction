'use client';

import { useTranslations } from 'next-intl';
import { ApiClientError } from '@/lib/api';

const KNOWN_CODES = new Set([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_FUNDS',
  'BID_TOO_LOW',
  'BID_MAX_NOT_HIGHER',
  'BID_MAX_DECREASE',
  'OWN_LOT',
  'LOT_NOT_ACTIVE',
  'AUCTION_ENDED',
  'BUY_NOW_UNAVAILABLE',
  'LOT_NOT_EDITABLE',
  'LOT_PUBLISHED',
  'LOT_CLAIMED',
  'INVALID_LOT_TRANSITION',
  'INVALID_SALE_TRANSITION',
  'SALE_NOT_PAYABLE',
  'PAYMENT_WINDOW_EXPIRED',
  'PHOTO_LIMIT',
  'PHOTO_NOT_UPLOADED',
  'PHOTO_TOO_LARGE',
  'SEARCH_UNAVAILABLE',
  'IDEMPOTENCY_KEY_REUSED',
  'INTERNAL_ERROR',
]);

export function useErrorMessage() {
  const t = useTranslations('errors');
  return (err: unknown): string => {
    if (err instanceof ApiClientError) {
      if (KNOWN_CODES.has(err.code)) {
        return t(err.code);
      }
      return t('generic', { message: err.message });
    }
    if (err instanceof Error) return t('generic', { message: err.message });
    return t('INTERNAL_ERROR');
  };
}

export function ErrorBanner({ error, className = '' }: { error: unknown; className?: string }) {
  const formatErr = useErrorMessage();
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid="error-banner"
      className={`rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 ${className}`}
    >
      {formatErr(error)}
    </div>
  );
}
