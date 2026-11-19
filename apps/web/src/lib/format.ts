import type { AppLocale } from '@/i18n/routing';

const INTL_LOCALE: Record<AppLocale, string> = {
  uk: 'uk-UA',
  en: 'en-US',
  pl: 'pl-PL',
};

/** Formats integer kopecks into localized UAH currency (`1 234,50 ₴` in uk/pl, `1,234.50 ₴` in en). */
export function formatMoney(kopecks: number, locale: AppLocale): string {
  const formatted = new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(kopecks / 100);
  // Normalize NBSP / narrow NBSP from Intl to regular spaces for consistent rendering and assertions.
  return `${formatted.replace(/[\u00a0\u202f]/g, ' ')} ₴`;
}

export function formatDateTime(iso: string, locale: AppLocale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatDateYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function formatPercent(fraction: number, locale: AppLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(fraction);
}

export interface RemainingParts {
  ended: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function splitRemaining(endsAtIso: string | null, nowMs: number): RemainingParts {
  if (!endsAtIso) return { ended: true, days: 0, hours: 0, minutes: 0, seconds: 0 };
  const diffMs = new Date(endsAtIso).getTime() - nowMs;
  if (diffMs <= 0 || Number.isNaN(diffMs)) {
    return { ended: true, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }
  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return { ended: false, days, hours, minutes, seconds };
}

/** Parses user UAH input (with `.` or `,` decimal separator) into integer kopecks. */
export function uahToKopecks(raw: string): number | null {
  const normalized = raw.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  const kop = Math.round(num * 100);
  return Number.isSafeInteger(kop) && kop > 0 ? kop : null;
}

export function kopecksToUahInput(kopecks: number): string {
  return kopecks % 100 === 0 ? String(kopecks / 100) : (kopecks / 100).toFixed(2);
}

export function localizedName(
  item: { nameUk: string; nameEn: string; namePl: string },
  locale: AppLocale,
): string {
  if (locale === 'en') return item.nameEn;
  if (locale === 'pl') return item.namePl;
  return item.nameUk;
}
