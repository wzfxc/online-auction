'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { usePathname, useRouter } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { unwrap } from '@/lib/api';
import { serverNowMs } from '@/lib/clock';
import { formatDateYmd, formatMoney, formatPercent, localizedName } from '@/lib/format';
import { useApp } from '@/lib/providers';

function FinanceContent() {
  const t = useTranslations('finance');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const locale = useLocale() as AppLocale;
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { client, token, user, isReady } = useApp();

  const defaultTo = formatDateYmd(new Date(serverNowMs()));
  const defaultFrom = formatDateYmd(new Date(serverNowMs() - 90 * 86_400_000));

  const from = searchParams.get('from') ?? defaultFrom;
  const to = searchParams.get('to') ?? defaultTo;

  const [fromInput, setFromInput] = useState(from);
  const [toInput, setToInput] = useState(to);

  useEffect(() => {
    setFromInput(from);
    setToInput(to);
  }, [from, to]);

  const canAccess = Boolean(token && user?.role === 'finance');

  const periodQuery = useQuery({
    queryKey: ['finance-period', from, to, token],
    enabled: canAccess,
    queryFn: async () =>
      unwrap(await client.GET('/reports/period', { params: { query: { from, to } } })),
  });

  const reconcileQuery = useQuery({
    queryKey: ['finance-reconcile', token],
    enabled: canAccess,
    queryFn: async () => unwrap(await client.GET('/reports/reconciliation')),
  });

  if (!isReady) return <div className="p-8 text-sm text-slate-500">...</div>;
  if (!canAccess) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        {tErrors('FORBIDDEN')}
      </div>
    );
  }

  const applyPeriod = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(searchParams.toString());
    if (fromInput) next.set('from', fromInput);
    else next.delete('from');
    if (toInput) next.set('to', toInput);
    else next.delete('to');
    router.push(`${pathname}?${next.toString()}`);
  };

  const rep = periodQuery.data;
  const rec = reconcileQuery.data;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
      <ErrorBanner error={periodQuery.error ?? reconcileQuery.error} />

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">{t('periodTitle')}</h2>

        <form onSubmit={applyPeriod} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="rep-from" className="mb-1 block text-xs font-medium text-slate-700">
              {t('fromLabel')}
            </label>
            <input
              id="rep-from"
              type="date"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="rep-to" className="mb-1 block text-xs font-medium text-slate-700">
              {t('toLabel')}
            </label>
            <input
              id="rep-to"
              type="date"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            data-testid="apply-period-btn"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t('applyPeriod')}
          </button>
        </form>

        {rep && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-4">
                <div className="text-xs text-slate-600">{t('turnover')}</div>
                <div data-testid="report-turnover" className="mt-1 text-xl font-bold text-slate-900">
                  {formatMoney(rep.turnover, locale)}
                </div>
              </div>
              <div className="rounded-lg bg-emerald-50 p-4">
                <div className="text-xs text-emerald-800">{t('commission')}</div>
                <div data-testid="report-commission" className="mt-1 text-xl font-bold text-emerald-900">
                  {formatMoney(rep.commission, locale)}
                </div>
              </div>
              <div className="rounded-lg bg-amber-50 p-4">
                <div className="text-xs text-amber-800">{t('unpaidShare')}</div>
                <div data-testid="report-unpaid-share" className="mt-1 text-xl font-bold text-amber-900">
                  {formatPercent(rep.unpaidShare, locale)}
                </div>
              </div>
            </div>

            <p className="text-xs text-slate-600">
              {t('winsSummary', {
                total: rep.totalWins,
                paid: rep.paidWins,
                unpaid: rep.unpaidWins,
                awaiting: rep.awaitingPaymentWins,
              })}
            </p>

            {rep.byCategory.length === 0 ? (
              <p className="text-sm text-slate-500">{t('noCategoryData')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="report-categories-table">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">{t('categoryColumn')}</th>
                      <th className="py-2 pr-3 text-right">{t('paidCountColumn')}</th>
                      <th className="py-2 pr-3 text-right">{t('unpaidCountColumn')}</th>
                      <th className="py-2 pr-3 text-right">{t('turnoverColumn')}</th>
                      <th className="py-2 text-right">{t('commissionColumn')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rep.byCategory.map((c) => (
                      <tr key={c.categoryId}>
                        <td className="py-2 pr-3 font-medium">{localizedName(c, locale)}</td>
                        <td className="py-2 pr-3 text-right">{c.paidCount}</td>
                        <td className="py-2 pr-3 text-right">{c.unpaidCount}</td>
                        <td className="py-2 pr-3 text-right font-semibold">{formatMoney(c.turnover, locale)}</td>
                        <td className="py-2 text-right text-emerald-700">{formatMoney(c.commission, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">{t('reconcileTitle')}</h2>
          <button
            type="button"
            onClick={() => void reconcileQuery.refetch()}
            className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            {tApp('refresh')}
          </button>
        </div>

        {rec && (
          <div className="space-y-4">
            <div
              data-testid="reconcile-status"
              className={`rounded-lg border px-4 py-3 text-sm font-semibold ${
                rec.healthy
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  : 'border-rose-300 bg-rose-50 text-rose-900'
              }`}
            >
              {rec.healthy ? t('healthy') : t('unhealthy')}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 text-sm">
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t('entriesSum')}</div>
                <div className="font-mono font-bold">{formatMoney(rec.entriesSum, locale)}</div>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t('checkedAccounts')}</div>
                <div className="font-mono font-bold">{rec.checkedAccounts}</div>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t('checkedPayments')}</div>
                <div className="font-mono font-bold">{rec.checkedPayments}</div>
              </div>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('walletMismatches')}</h3>
              {rec.walletMismatches.length === 0 ? (
                <p className="text-xs text-slate-500">{t('none')}</p>
              ) : (
                <ul className="space-y-1 text-xs text-rose-700">
                  {rec.walletMismatches.map((m) => (
                    <li key={m.accountId}>
                      {m.accountId} ({m.type}): balance={m.accountBalance}, sum={m.entriesSum}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('paymentDiscrepancies')}</h3>
              {rec.paymentDiscrepancies.length === 0 ? (
                <p className="text-xs text-slate-500">{t('none')}</p>
              ) : (
                <ul className="space-y-1 text-xs text-rose-700">
                  {rec.paymentDiscrepancies.map((d) => (
                    <li key={d.paymentId}>
                      {d.paymentId}: db={d.dbStatus}, provider={d.providerStatus}, reason={d.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function FinanceDashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-slate-500">...</div>}>
      <FinanceContent />
    </Suspense>
  );
}
