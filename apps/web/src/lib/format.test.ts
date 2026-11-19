import { describe, expect, it } from 'vitest';
import { formatDateTime, formatMoney, kopecksToUahInput, splitRemaining, uahToKopecks } from './format';

describe('localization formatters (uk, en, pl)', () => {
  it('formats UAH money consistently in uk, en and pl', () => {
    expect(formatMoney(123_450, 'uk')).toBe('1 234,50 ₴');
    expect(formatMoney(123_450, 'en')).toBe('1,234.50 ₴');
    // Polish Intl uses space grouping for >= 10000 or >= 1000 depending on ICU; check comma + currency symbol
    expect(formatMoney(123_450, 'pl')).toMatch(/1\s?234,50 ₴/);
    expect(formatMoney(1_234_567, 'pl')).toBe('12 345,67 ₴');
  });

  it('formats dates cleanly per locale', () => {
    const iso = '2030-05-15T14:30:00.000Z';
    expect(formatDateTime(iso, 'uk').length).toBeGreaterThan(5);
    expect(formatDateTime(iso, 'en')).toContain('2030');
    expect(formatDateTime(iso, 'pl')).toContain('2030');
  });

  it('splits remaining time based on provided server time', () => {
    const end = '2030-01-02T01:02:03.000Z';
    const now = new Date('2030-01-01T00:00:00.000Z').getTime();
    expect(splitRemaining(end, now)).toEqual({ ended: false, days: 1, hours: 1, minutes: 2, seconds: 3 });
    expect(splitRemaining(end, new Date(end).getTime() + 1000).ended).toBe(true);
  });

  it('converts UAH inputs with comma or dot to integer kopecks', () => {
    expect(uahToKopecks('100')).toBe(10_000);
    expect(uahToKopecks('123,45')).toBe(12_345);
    expect(uahToKopecks('123.45')).toBe(12_345);
    expect(uahToKopecks('-10')).toBeNull();
    expect(uahToKopecks('1.234')).toBeNull();
    expect(kopecksToUahInput(10_000)).toBe('100');
    expect(kopecksToUahInput(10_050)).toBe('100.50');
  });
});
