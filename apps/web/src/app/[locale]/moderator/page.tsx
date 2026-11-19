'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Link } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { unwrap, type LotDto } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useApp } from '@/lib/providers';

export default function ModeratorDashboardPage() {
  const t = useTranslations('moderator');
  const tLot = useTranslations('lot');
  const tErrors = useTranslations('errors');
  const locale = useLocale() as AppLocale;
  const { client, token, user, isReady } = useApp();

  const [claimedLot, setClaimedLot] = useState<LotDto | null | undefined>(undefined);
  const [rejectReason, setRejectReason] = useState('');
  const [removeLotId, setRemoveLotId] = useState('');
  const [removeReason, setRemoveReason] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canAccess = Boolean(token && user?.role === 'moderator');

  const claimMutation = useMutation({
    mutationFn: async () => unwrap(await client.POST('/moderation/claim')),
    onSuccess: (lot) => {
      setClaimedLot(lot);
      setStatusMessage(null);
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (lotId: string) =>
      unwrap(await client.POST('/lots/{id}/approve', { params: { path: { id: lotId } } })),
    onSuccess: () => {
      setClaimedLot(undefined);
      setStatusMessage(t('statusApproved'));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (args: { lotId: string; reason: string }) =>
      unwrap(
        await client.POST('/lots/{id}/reject', {
          params: { path: { id: args.lotId } },
          body: { reason: args.reason },
        }),
      ),
    onSuccess: () => {
      setClaimedLot(undefined);
      setRejectReason('');
      setStatusMessage(t('statusRejected'));
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (args: { lotId: string; reason: string }) =>
      unwrap(
        await client.POST('/moderation/lots/{id}/remove', {
          params: { path: { id: args.lotId } },
          body: { reason: args.reason },
        }),
      ),
    onSuccess: () => {
      setRemoveLotId('');
      setRemoveReason('');
      setStatusMessage(t('statusRemoved'));
    },
  });

  const claimedPhotosQuery = useQuery({
    queryKey: ['mod-photos', claimedLot?.id, token],
    enabled: Boolean(canAccess && claimedLot?.id),
    queryFn: async () =>
      unwrap(await client.GET('/lots/{id}/photos', { params: { path: { id: claimedLot!.id } } })),
  });

  if (!isReady) return <div className="p-8 text-sm text-slate-500">...</div>;
  if (!canAccess) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        {tErrors('FORBIDDEN')}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
      <ErrorBanner error={claimMutation.error ?? approveMutation.error ?? rejectMutation.error ?? removeMutation.error} />

      {statusMessage && (
        <div role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {statusMessage}
        </div>
      )}

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-slate-600">{t('leaseNote')}</p>
          <button
            type="button"
            data-testid="mod-claim-btn"
            disabled={claimMutation.isPending}
            onClick={() => claimMutation.mutate()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {t('claimButton')}
          </button>
        </div>

        {claimedLot === null && <p className="text-sm text-slate-500">{t('queueEmpty')}</p>}

        {claimedLot && (
          <div className="space-y-4 rounded-lg border border-slate-200 p-4" data-testid="mod-claimed-lot">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{claimedLot.title}</h2>
                <p className="text-xs text-slate-500">ID: {claimedLot.id}</p>
              </div>
              <Link href={`/lots/${claimedLot.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                {t('openLot')}
              </Link>
            </div>
            <p className="whitespace-pre-line text-sm text-slate-700">{claimedLot.description}</p>
            <div className="flex flex-wrap gap-4 text-xs text-slate-600">
              <span>{tLot('startPrice')}: {formatMoney(claimedLot.startPrice, locale)}</span>
              {claimedLot.buyNowPrice !== null && (
                <span>{tLot('buyNowPrice')}: {formatMoney(claimedLot.buyNowPrice, locale)}</span>
              )}
              <span>{t('photosCount', { count: claimedPhotosQuery.data?.length ?? 0 })}</span>
            </div>

            <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
              <button
                type="button"
                data-testid="mod-approve-btn"
                disabled={approveMutation.isPending}
                onClick={() => approveMutation.mutate(claimedLot.id)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                {t('approveButton')}
              </button>

              <div className="flex flex-1 flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <label htmlFor="mod-reject-reason" className="mb-1 block text-xs font-medium text-slate-700">
                    {t('rejectReasonLabel')}
                  </label>
                  <input
                    id="mod-reject-reason"
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={t('rejectReasonPlaceholder')}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="button"
                  data-testid="mod-reject-btn"
                  disabled={rejectReason.trim().length < 3 || rejectMutation.isPending}
                  onClick={() => rejectMutation.mutate({ lotId: claimedLot.id, reason: rejectReason.trim() })}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {t('rejectButton')}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">{t('removeSectionTitle')}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="mod-remove-id" className="mb-1 block text-xs font-medium text-slate-700">
              {t('removeLotIdLabel')}
            </label>
            <input
              id="mod-remove-id"
              type="text"
              value={removeLotId}
              onChange={(e) => setRemoveLotId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="mod-remove-reason" className="mb-1 block text-xs font-medium text-slate-700">
              {t('removeReasonLabel')}
            </label>
            <input
              id="mod-remove-reason"
              type="text"
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              disabled={!removeLotId.trim() || removeReason.trim().length < 3 || removeMutation.isPending}
              onClick={() => removeMutation.mutate({ lotId: removeLotId.trim(), reason: removeReason.trim() })}
              className="w-full rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {t('removeButton')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
