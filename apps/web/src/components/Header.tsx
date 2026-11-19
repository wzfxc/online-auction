'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { LOCALES, type AppLocale } from '@/i18n/routing';
import { formatMoney } from '@/lib/format';
import { useApp } from '@/lib/providers';

export function Header() {
  const tNav = useTranslations('nav');
  const tApp = useTranslations('app');
  const tRoles = useTranslations('roles');
  const tLot = useTranslations('lot');
  const tLocale = useTranslations('locale');
  const locale = useLocale() as AppLocale;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, wallet, unreadNotifications, logout, outbidToast, dismissOutbidToast } = useApp();

  const switchLocale = (nextLocale: AppLocale) => {
    const qs = searchParams.toString();
    const target = qs ? `${pathname}?${qs}` : pathname;
    router.replace(target, { locale: nextLocale });
  };

  return (
    <header className="border-b border-slate-200 bg-white">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-brand-600 focus:px-3 focus:py-1.5 focus:text-white"
      >
        {tApp('skipToContent')}
      </a>

      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-5">
          <Link href="/" className="text-lg font-bold tracking-tight text-brand-700">
            {tApp('brand')}
          </Link>
          <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-3 text-sm font-medium">
            <Link href="/" className="rounded px-2 py-1 text-slate-700 hover:bg-slate-100">
              {tNav('catalog')}
            </Link>
            {(user?.role === 'buyer' || user?.role === 'seller') && (
              <Link href="/buyer" className="rounded px-2 py-1 text-slate-700 hover:bg-slate-100">
                {tNav('buyer')}
                {unreadNotifications > 0 && (
                  <span
                    data-testid="unread-badge"
                    className="ml-1.5 inline-flex items-center rounded-full bg-rose-600 px-1.5 py-0.5 text-xs font-semibold text-white"
                  >
                    {unreadNotifications}
                  </span>
                )}
              </Link>
            )}
            {user?.role === 'seller' && (
              <Link href="/seller" className="rounded px-2 py-1 text-slate-700 hover:bg-slate-100">
                {tNav('seller')}
              </Link>
            )}
            {user?.role === 'moderator' && (
              <Link href="/moderator" className="rounded px-2 py-1 text-slate-700 hover:bg-slate-100">
                {tNav('moderator')}
              </Link>
            )}
            {user?.role === 'finance' && (
              <Link href="/finance" className="rounded px-2 py-1 text-slate-700 hover:bg-slate-100">
                {tNav('finance')}
              </Link>
            )}
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          {wallet && (
            <Link
              href="/buyer"
              data-testid="header-wallet"
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1 text-xs"
            >
              <span>
                {tNav('walletAvailable')}:{' '}
                <strong className="text-emerald-700">{formatMoney(wallet.available, locale)}</strong>
              </span>
              <span className="text-slate-300">|</span>
              <span>
                {tNav('walletHeld')}: <strong className="text-amber-700">{formatMoney(wallet.held, locale)}</strong>
              </span>
            </Link>
          )}

          <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5" role="group" aria-label={tLocale('label')}>
            {LOCALES.map((loc) => (
              <button
                key={loc}
                type="button"
                data-testid={`locale-${loc}`}
                onClick={() => switchLocale(loc)}
                className={`rounded px-2 py-1 text-xs font-semibold ${
                  locale === loc ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {tLocale(loc)}
              </button>
            ))}
          </div>

          {user ? (
            <div className="flex items-center gap-2">
              <span data-testid="user-badge" className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                {user.displayName} ({tRoles(user.role)})
              </span>
              <button
                type="button"
                data-testid="logout-btn"
                onClick={logout}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                {tNav('logout')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                data-testid="login-link"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                {tNav('login')}
              </Link>
              <Link
                href="/register"
                data-testid="register-link"
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                {tNav('register')}
              </Link>
            </div>
          )}
        </div>
      </div>

      {outbidToast && (
        <div
          role="alert"
          data-testid="global-outbid-toast"
          className="border-t border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <Link href={`/lots/${outbidToast.lotId}`} className="font-medium underline">
              {tLot('outbidBanner', {
                price: formatMoney(outbidToast.currentPrice, locale),
                minNext: formatMoney(outbidToast.minNextBid, locale),
              })}
            </Link>
            <button
              type="button"
              onClick={dismissOutbidToast}
              className="rounded px-2 py-0.5 text-xs font-semibold hover:bg-amber-200"
            >
              {tApp('close')}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
