import { describe, expect, it } from 'vitest';
import uk from '../../messages/uk.json' with { type: 'json' };
import en from '../../messages/en.json' with { type: 'json' };
import pl from '../../messages/pl.json' with { type: 'json' };

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('i18n message catalogs (uk, en, pl)', () => {
  it('keep identical translation key sets across uk, en and pl', () => {
    const ukKeys = flattenKeys(uk as Record<string, unknown>);
    const enKeys = flattenKeys(en as Record<string, unknown>);
    const plKeys = flattenKeys(pl as Record<string, unknown>);
    expect(enKeys).toEqual(ukKeys);
    expect(plKeys).toEqual(ukKeys);
  });

  it('defines ICU plural rules for bids and lots in all three locales', () => {
    expect(uk.plurals.bids).toContain('one {# ставка}');
    expect(uk.plurals.bids).toContain('few {# ставки}');
    expect(uk.plurals.bids).toContain('many {# ставок}');
    expect(en.plurals.bids).toContain('one {# bid}');
    expect(en.plurals.bids).toContain('other {# bids}');
    expect(pl.plurals.bids).toContain('one {# oferta}');
    expect(pl.plurals.bids).toContain('few {# oferty}');
    expect(pl.plurals.bids).toContain('many {# ofert}');
  });
});
