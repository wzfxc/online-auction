'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Countdown } from '@/components/Countdown';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Link } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { newIdempotencyKey, unwrap } from '@/lib/api';
import { formatDateTime, formatMoney, uahToKopecks } from '@/lib/format';
import { useApp } from '@/lib/providers';

interface TopUpForm {
  amountUah: string;
}

export default function BuyerDashboardPage() {
  const t = useTranslations('buyer');
  const tLot = useTranslations('lot');
  const tStatus = useTranslations('lotStatus');
  const tSaleStatus = useTranslations('saleStatus');
  const tErrors = useTranslations('errors');
  const locale = useLocale() as AppLocale;
  const qc = useQueryClient();
  const { client, token, user, isReady } = useApp();
  const [actionError, setActionError] = useState<unknown>(null);

  const canAccess = Boolean(token && (user?.role === 'buyer' || user?.role === 'seller'));

  const historyQuery = useQuery({
    queryKey: ['wallet-history', token],
    enabled: canAccess,
    queryFn: async () => unwrap(await client.GET('/wallet/history', { params: { query: { limit: 50 } } })),
  });

  const salesQuery = useQuery({
    queryKey: ['sales', 'buyer', token],
    enabled: canAccess,
    queryFn: async () => unwrap(await client.GET('/sales', { params: { query: { role: 'buyer' } } })),
  });

  const participatingQuery = useQuery({
    queryKey: ['lots-participating', token],
    enabled: canAccess,
    queryFn: async () => unwrap(await client.GET('/lots/participating')),
  });

  const favoritesQuery = useQuery({
    queryKey: ['favorites', token],
    enabled: canAccess,
    queryFn: async () => unwrap(await client.GET('/favorites')),
  });

  const notificationsQuery = useQuery({
    queryKey: ['notifications', 'all', token],
    enabled: Boolean(token),
    queryFn: async () => unwrap(await client.GET('/notifications', { params: { query: { limit: 30 } } })),
  });

  const topUpForm = useForm<TopUpForm>({ defaultValues: { amountUah: '1000' } });
  const topUpMutation = useMutation({
    mutationFn: async (amount: number) =>
      unwrap(
        await client.POST('/wallet/top-ups', {
          params: { header: { 'idempotency-key': newIdempotencyKey() } },
          body: { amount },
        }),
      ),
    onSuccess: (res) => {
      const returnUrl = window.location.href;
      const sep = res.payUrl.includes('?') ? '&' : '?';
      window.location.href = `${res.payUrl}${sep}returnUrl=${encodeURIComponent(returnUrl)}`;
    },
  });

  const paySaleMutation = useMutation({
    mutationFn: async (saleId: string) =>
      unwrap(
        await client.POST('/sales/{id}/pay', {
          params: { path: { id: saleId }, header: { 'idempotency-key': newIdempotencyKey() } },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['wallet-history'] });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (saleId: string) =>
      unwrap(await client.POST('/sales/{id}/confirm', { params: { path: { id: saleId } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  const removeFavMutation = useMutation({
    mutationFn: async (lotId: string) =>
      unwrap(await client.DELETE('/favorites/{id}', { params: { path: { id: lotId } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['favorites'] }),
  });

  const markReadMutation = useMutation({
    mutationFn: async () => unwrap(await client.POST('/notifications/read', { body: {} })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  if (!isReady) return <div className="p-8 text-sm text-slate-500">...</div>;
  if (!canAccess) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        {tErrors('UNAUTHORIZED')}{' '}
        <Link href="/login" className="font-semibold underline">
          Login
        </Link>
      </div>
    );
  }

  const onTopUpSubmit = topUpForm.handleSubmit(async (values) => {
    setActionError(null);
    topUpForm.clearErrors();
    const kop = uahToKopecks(values.amountUah);
    if (!kop || kop < 1000) {
      topUpForm.setError('amountUah', { message: t('topUpAmountLabel') });
      return;
    }
    try {
      await topUpMutation.mutateAsync(kop);
    } catch (e) {
      setActionError(e);
    }
  });

  const wh = historyQuery.data;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
      <ErrorBanner error={actionError ?? topUpMutation.error ?? paySaleMutation.error ?? confirmMutation.error} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
          <h2 className="text-lg font-bold text-slate-900">{t('walletTitle')}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-emerald-50 p-4">
              <div className="text-xs font-medium text-emerald-800">{t('available')}</div>
              <div data-testid="wallet-available" className="mt-1 text-xl font-bold text-emerald-900">
                {wh ? formatMoney(wh.available, locale) : '—'}
              </div>
            </div>
            <div className="rounded-lg bg-amber-50 p-4">
              <div className="text-xs font-medium text-amber-800">{t('held')}</div>
              <div data-testid="wallet-held" className="mt-1 text-xl font-bold text-amber-900">
                {wh ? formatMoney(wh.held, locale) : '—'}
              </div>
            </div>
            <div className="rounded-lg bg-slate-100 p-4">
              <div className="text-xs font-medium text-slate-700">{t('total')}</div>
              <div data-testid="wallet-total" className="mt-1 text-xl font-bold text-slate-900">
                {wh ? formatMoney(wh.total, locale) : '—'}
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">{t('topUpTitle')}</h2>
          <form onSubmit={onTopUpSubmit} className="space-y-3" noValidate>
            <div>
              <label htmlFor="topup-amount" className="mb-1 block text-xs font-medium text-slate-700">
                {t('topUpAmountLabel')}
              </label>
              <input
                id="topup-amount"
                data-testid="topup-amount-input"
                type="text"
                inputMode="decimal"
                aria-invalid={Boolean(topUpForm.formState.errors.amountUah)}
                aria-describedby={topUpForm.formState.errors.amountUah ? 'topup-err' : undefined}
                {...topUpForm.register('amountUah')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              {topUpForm.formState.errors.amountUah && (
                <p id="topup-err" className="mt-1 text-xs text-rose-600">
                  {topUpForm.formState.errors.amountUah.message}
                </p>
              )}
            </div>
            <button
              type="submit"
              data-testid="topup-submit-btn"
              disabled={topUpMutation.isPending}
              className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {t('topUpButton')}
            </button>
          </form>
        </section>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">{t('salesTitle')}</h2>
        {!salesQuery.data || salesQuery.data.length === 0 ? (
          <p className="text-sm text-slate-500">{t('noSales')}</p>
        ) : (
          <div className="space-y-3" data-testid="buyer-sales-list">
            {salesQuery.data.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 p-4">
                <div className="space-y-1">
                  <Link href={`/lots/${s.lotId}`} className="font-semibold text-brand-700 hover:underline">
                    {s.lotTitle}
                  </Link>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                    <span>{formatMoney(s.price, locale)}</span>
                    <span className="rounded bg-slate-100 px-2 py-0.5 font-medium">{tSaleStatus(s.status)}</span>
                    {s.status === 'awaiting_payment' && (
                      <span>
                        {tLot('payDueLabel')}: <Countdown endsAt={s.payDueAt} />
                      </span>
                    )}
                    {s.trackingNumber && (
                      <span className="font-mono">
                        {tLot('trackingLabel')}: {s.trackingNumber}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.status === 'awaiting_payment' && (
                    <button
                      type="button"
                      data-testid={`pay-sale-${s.id}`}
                      disabled={paySaleMutation.isPending}
                      onClick={() => paySaleMutation.mutate(s.id)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      {tLot('payFromWallet')}
                    </button>
                  )}
                  {s.status === 'shipped' && (
                    <button
                      type="button"
                      data-testid={`confirm-sale-${s.id}`}
                      disabled={confirmMutation.isPending}
                      onClick={() => confirmMutation.mutate(s.id)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      {tLot('confirmReceiptButton')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">{t('participatingTitle')}</h2>
          {!participatingQuery.data || participatingQuery.data.length === 0 ? (
            <p className="text-sm text-slate-500">{t('noParticipating')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {participatingQuery.data.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-2">
                  <Link href={`/lots/${l.id}`} className="font-medium text-brand-700 hover:underline">
                    {l.title}
                  </Link>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="font-semibold">{formatMoney(l.currentPrice, locale)}</span>
                    <span className="rounded bg-slate-100 px-2 py-0.5">{tStatus(l.status)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">{t('favoritesTitle')}</h2>
          {!favoritesQuery.data || favoritesQuery.data.length === 0 ? (
            <p className="text-sm text-slate-500">{t('noFavorites')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {favoritesQuery.data.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-2">
                  <Link href={`/lots/${l.id}`} className="font-medium text-brand-700 hover:underline">
                    {l.title}
                  </Link>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="font-semibold">{formatMoney(l.currentPrice, locale)}</span>
                    <button
                      type="button"
                      onClick={() => removeFavMutation.mutate(l.id)}
                      className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-100"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">{t('notificationsTitle')}</h2>
          <button
            type="button"
            onClick={() => markReadMutation.mutate()}
            className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            {t('markAllRead')}
          </button>
        </div>
        {!notificationsQuery.data || notificationsQuery.data.length === 0 ? (
          <p className="text-sm text-slate-500">{t('noNotifications')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-xs">
            {notificationsQuery.data.map((n) => (
              <li key={n.id} className={`flex items-center justify-between py-2 ${n.read ? 'text-slate-500' : 'font-semibold text-slate-900'}`}>
                <span>{n.type}</span>
                <span>{formatDateTime(n.createdAt, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">{t('ledgerTitle')}</h2>
        {!wh || wh.items.length === 0 ? (
          <p className="text-sm text-slate-500">{t('noLedger')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-3">Kind</th>
                  <th className="py-2 pr-3">Account</th>
                  <th className="py-2 pr-3">Lot</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 text-right">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {wh.items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2 pr-3 font-medium">
                      {t.has(`ledgerKinds.${item.kind}`) ? t(`ledgerKinds.${item.kind}`) : item.kind}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{t(`accountTypes.${item.accountType}`)}</td>
                    <td className="py-2 pr-3">
                      {item.lotId ? (
                        <Link href={`/lots/${item.lotId}`} className="text-brand-700 hover:underline">
                          {item.lotTitle ?? item.lotId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={`py-2 pr-3 text-right font-semibold ${item.amount >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {item.amount >= 0 ? '+' : ''}
                      {formatMoney(item.amount, locale)}
                    </td>
                    <td className="py-2 text-right text-slate-500">{formatDateTime(item.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
