import { defineRouting } from 'next-intl/routing';

export const LOCALES = ['uk', 'en', 'pl'] as const;
export type AppLocale = (typeof LOCALES)[number];

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: 'uk',
});
