import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Header } from '@/components/Header';
import { routing, type AppLocale } from '@/i18n/routing';
import { AppProviders } from '@/lib/providers';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const safeLocale = routing.locales.includes(locale as AppLocale) ? locale : routing.defaultLocale;
  const t = await getTranslations({ locale: safeLocale, namespace: 'app' });
  return {
    title: t('brand'),
    description: t('tagline'),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as AppLocale)) {
    notFound();
  }

  const messages = await getMessages();
  const apiUrl = process.env.PUBLIC_API_URL ?? 'http://localhost:8080';

  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AppProviders apiUrl={apiUrl}>
            <Header />
            <main id="main-content" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
              {children}
            </main>
          </AppProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
