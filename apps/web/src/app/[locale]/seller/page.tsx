'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ITEM_CONDITIONS, LOT_STATUSES, PHOTO_CONTENT_TYPES, type LotStatus } from '@auction/shared';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Link } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { unwrap, type OwnLotDto } from '@/lib/api';
import { formatMoney, kopecksToUahInput, localizedName, uahToKopecks } from '@/lib/format';
import { useApp } from '@/lib/providers';

interface LotFormValues {
  title: string;
  description: string;
  categoryId: string;
  cityId: string;
  condition: (typeof ITEM_CONDITIONS)[number];
  startPriceUah: string;
  reservePriceUah: string;
  buyNowPriceUah: string;
  durationDays: string;
}

export default function SellerDashboardPage() {
  const t = useTranslations('seller');
  const tLot = useTranslations('lot');
  const tStatus = useTranslations('lotStatus');
  const tSaleStatus = useTranslations('saleStatus');
  const tCond = useTranslations('condition');
  const tErrors = useTranslations('errors');
  const locale = useLocale() as AppLocale;
  const qc = useQueryClient();
  const { client, token, user, isReady, categories, cities } = useApp();

  const [statusFilter, setStatusFilter] = useState<LotStatus | ''>('');
  const [selectedLot, setSelectedLot] = useState<OwnLotDto | null>(null);
  const [appendText, setAppendText] = useState('');
  const [trackingBySale, setTrackingBySale] = useState<Record<string, string>>({});
  const [uploadError, setUploadError] = useState<unknown>(null);

  const canAccess = Boolean(token && user?.role === 'seller');

  const myLotsQuery = useQuery({
    queryKey: ['lots-mine', statusFilter, token],
    enabled: canAccess,
    queryFn: async () =>
      unwrap(
        await client.GET('/lots/mine', {
          params: { query: statusFilter ? { status: statusFilter } : {} },
        }),
      ),
  });

  const sellerSalesQuery = useQuery({
    queryKey: ['sales', 'seller', token],
    enabled: canAccess,
    queryFn: async () => unwrap(await client.GET('/sales', { params: { query: { role: 'seller' } } })),
  });

  const draftPhotosQuery = useQuery({
    queryKey: ['lot-photos-seller', selectedLot?.id, token],
    enabled: Boolean(canAccess && selectedLot),
    queryFn: async () =>
      unwrap(await client.GET('/lots/{id}/photos', { params: { path: { id: selectedLot!.id } } })),
  });

  const form = useForm<LotFormValues>({
    defaultValues: {
      title: '',
      description: '',
      categoryId: categories[0]?.id ?? '',
      cityId: cities[0]?.id ?? '',
      condition: 'good',
      startPriceUah: '100',
      reservePriceUah: '',
      buyNowPriceUah: '',
      durationDays: '3',
    },
  });

  useEffect(() => {
    if (!selectedLot && categories[0] && !form.getValues('categoryId')) {
      form.setValue('categoryId', categories[0].id);
    }
    if (!selectedLot && cities[0] && !form.getValues('cityId')) {
      form.setValue('cityId', cities[0].id);
    }
  }, [categories, cities, selectedLot, form]);

  const startEdit = (lot: OwnLotDto) => {
    setSelectedLot(lot);
    form.reset({
      title: lot.title,
      description: lot.description,
      categoryId: lot.categoryId,
      cityId: lot.cityId,
      condition: lot.condition,
      startPriceUah: kopecksToUahInput(lot.startPrice),
      reservePriceUah: lot.reservePrice !== null ? kopecksToUahInput(lot.reservePrice) : '',
      buyNowPriceUah: lot.buyNowPrice !== null ? kopecksToUahInput(lot.buyNowPrice) : '',
      durationDays: String(lot.durationDays),
    });
  };

  const resetCreate = () => {
    setSelectedLot(null);
    form.reset({
      title: '',
      description: '',
      categoryId: categories[0]?.id ?? '',
      cityId: cities[0]?.id ?? '',
      condition: 'good',
      startPriceUah: '100',
      reservePriceUah: '',
      buyNowPriceUah: '',
      durationDays: '3',
    });
  };

  const saveMutation = useMutation({
    mutationFn: async (body: {
      title: string;
      description: string;
      categoryId: string;
      cityId: string;
      condition: (typeof ITEM_CONDITIONS)[number];
      startPrice: number;
      reservePrice: number | null;
      buyNowPrice: number | null;
      durationDays: number;
    }) => {
      if (selectedLot && selectedLot.status === 'draft') {
        return unwrap(
          await client.PATCH('/lots/{id}', {
            params: { path: { id: selectedLot.id } },
            body,
          }),
        );
      }
      return unwrap(await client.POST('/lots', { body }));
    },
    onSuccess: (lot) => {
      setSelectedLot(lot);
      void qc.invalidateQueries({ queryKey: ['lots-mine'] });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (lotId: string) =>
      unwrap(await client.POST('/lots/{id}/submit', { params: { path: { id: lotId } } })),
    onSuccess: (lot) => {
      if (selectedLot?.id === lot.id) setSelectedLot(lot);
      void qc.invalidateQueries({ queryKey: ['lots-mine'] });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async (lotId: string) =>
      unwrap(await client.POST('/lots/{id}/reopen', { params: { path: { id: lotId } } })),
    onSuccess: (lot) => {
      startEdit(lot);
      void qc.invalidateQueries({ queryKey: ['lots-mine'] });
    },
  });

  const appendMutation = useMutation({
    mutationFn: async (args: { lotId: string; append: string }) =>
      unwrap(
        await client.PATCH('/lots/{id}', {
          params: { path: { id: args.lotId } },
          body: { append: args.append },
        }),
      ),
    onSuccess: (lot) => {
      setSelectedLot(lot);
      setAppendText('');
      void qc.invalidateQueries({ queryKey: ['lots-mine'] });
    },
  });

  const deletePhotoMutation = useMutation({
    mutationFn: async (args: { lotId: string; photoId: string }) => {
      const res = await client.DELETE('/lots/{id}/photos/{photoId}', {
        params: { path: { id: args.lotId, photoId: args.photoId } },
      });
      if (!res.response.ok) unwrap(res);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lot-photos-seller'] }),
  });

  const shipMutation = useMutation({
    mutationFn: async (args: { saleId: string; trackingNumber: string }) =>
      unwrap(
        await client.POST('/sales/{id}/ship', {
          params: { path: { id: args.saleId } },
          body: { trackingNumber: args.trackingNumber },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['lots-mine'] });
    },
  });

  if (!isReady) return <div className="p-8 text-sm text-slate-500">...</div>;
  if (!canAccess) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        {tErrors('FORBIDDEN')}
      </div>
    );
  }

  const onSaveLot = form.handleSubmit(async (values) => {
    form.clearErrors();
    const startKop = uahToKopecks(values.startPriceUah);
    if (!startKop) {
      form.setError('startPriceUah', { message: t('startPriceLabel') });
      return;
    }
    const reserveKop = values.reservePriceUah.trim() ? uahToKopecks(values.reservePriceUah) : null;
    if (values.reservePriceUah.trim() && (!reserveKop || reserveKop < startKop)) {
      form.setError('reservePriceUah', { message: t('reservePriceLabel') });
      return;
    }
    const buyNowKop = values.buyNowPriceUah.trim() ? uahToKopecks(values.buyNowPriceUah) : null;
    if (values.buyNowPriceUah.trim() && (!buyNowKop || buyNowKop < startKop)) {
      form.setError('buyNowPriceUah', { message: t('buyNowPriceLabel') });
      return;
    }
    const duration = Number.parseInt(values.durationDays, 10);
    if (!Number.isFinite(duration) || duration < 1 || duration > 10) {
      form.setError('durationDays', { message: t('durationLabel') });
      return;
    }
    await saveMutation.mutateAsync({
      title: values.title.trim(),
      description: values.description.trim(),
      categoryId: values.categoryId,
      cityId: values.cityId,
      condition: values.condition,
      startPrice: startKop,
      reservePrice: reserveKop,
      buyNowPrice: buyNowKop,
      durationDays: duration,
    });
  });

  const handlePhotoUpload = async (file: File | undefined) => {
    if (!file || !selectedLot) return;
    setUploadError(null);
    try {
      const contentType = file.type as (typeof PHOTO_CONTENT_TYPES)[number];
      if (!PHOTO_CONTENT_TYPES.includes(contentType)) {
        throw new Error('JPEG / PNG / WebP only');
      }
      const presigned = unwrap(
        await client.POST('/lots/{id}/photos', {
          params: { path: { id: selectedLot.id } },
          body: { contentType, sizeBytes: file.size },
        }),
      );
      const fd = new FormData();
      for (const [k, v] of Object.entries(presigned.upload.fields)) fd.append(k, v);
      fd.append('file', file);
      const s3Res = await fetch(presigned.upload.url, { method: 'POST', body: fd });
      if (!s3Res.ok) throw new Error(`Upload failed (${s3Res.status})`);
      unwrap(
        await client.POST('/lots/{id}/photos/{photoId}/confirm', {
          params: { path: { id: selectedLot.id, photoId: presigned.photoId } },
        }),
      );
      void qc.invalidateQueries({ queryKey: ['lot-photos-seller', selectedLot.id] });
    } catch (e) {
      setUploadError(e);
    }
  };

  const mine = myLotsQuery.data;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
        <div className="flex flex-wrap gap-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm">
            <div className="text-xs text-amber-800">{t('pendingPayout')}</div>
            <div data-testid="seller-pending-payout" className="font-bold text-amber-900">
              {mine ? formatMoney(mine.pendingPayout, locale) : '—'}
            </div>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm">
            <div className="text-xs text-emerald-800">{t('paidOutTotal')}</div>
            <div data-testid="seller-paid-out" className="font-bold text-emerald-900">
              {mine ? formatMoney(mine.paidOutTotal, locale) : '—'}
            </div>
          </div>
        </div>
      </div>

      <ErrorBanner
        error={
          saveMutation.error ??
          submitMutation.error ??
          reopenMutation.error ??
          appendMutation.error ??
          shipMutation.error ??
          uploadError
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900">
              {selectedLot?.status === 'draft' ? t('editLotTitle') : t('createLotTitle')}
            </h2>
            {selectedLot && (
              <button
                type="button"
                onClick={resetCreate}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                + {t('createLotTitle')}
              </button>
            )}
          </div>

          <form onSubmit={onSaveLot} className="space-y-3" noValidate>
            <div>
              <label htmlFor="lot-title" className="mb-1 block text-xs font-medium text-slate-700">
                {t('titleLabel')}
              </label>
              <input
                id="lot-title"
                data-testid="lot-title-input"
                type="text"
                {...form.register('title', { required: true, minLength: 3 })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="lot-desc" className="mb-1 block text-xs font-medium text-slate-700">
                {t('descriptionLabel')}
              </label>
              <textarea
                id="lot-desc"
                data-testid="lot-desc-input"
                rows={3}
                {...form.register('description', { required: true })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="lot-cat" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('categoryLabel')}
                </label>
                <select id="lot-cat" {...form.register('categoryId')} className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm">
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {localizedName(c, locale)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="lot-city" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('cityLabel')}
                </label>
                <select id="lot-city" {...form.register('cityId')} className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm">
                  {cities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {localizedName(c, locale)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="lot-cond" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('conditionLabel')}
                </label>
                <select id="lot-cond" {...form.register('condition')} className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm">
                  {ITEM_CONDITIONS.map((cond) => (
                    <option key={cond} value={cond}>
                      {tCond(cond)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="lot-start" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('startPriceLabel')}
                </label>
                <input
                  id="lot-start"
                  data-testid="lot-start-price"
                  type="text"
                  inputMode="decimal"
                  aria-invalid={Boolean(form.formState.errors.startPriceUah)}
                  {...form.register('startPriceUah')}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="lot-reserve" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('reservePriceLabel')}
                </label>
                <input
                  id="lot-reserve"
                  data-testid="lot-reserve-price"
                  type="text"
                  inputMode="decimal"
                  aria-invalid={Boolean(form.formState.errors.reservePriceUah)}
                  {...form.register('reservePriceUah')}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="lot-buynow" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('buyNowPriceLabel')}
                </label>
                <input
                  id="lot-buynow"
                  data-testid="lot-buynow-price"
                  type="text"
                  inputMode="decimal"
                  aria-invalid={Boolean(form.formState.errors.buyNowPriceUah)}
                  {...form.register('buyNowPriceUah')}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="lot-duration" className="mb-1 block text-xs font-medium text-slate-700">
                  {t('durationLabel')}
                </label>
                <input
                  id="lot-duration"
                  type="number"
                  min={1}
                  max={10}
                  {...form.register('durationDays')}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                />
              </div>
            </div>

            <button
              type="submit"
              data-testid="save-lot-btn"
              disabled={saveMutation.isPending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {selectedLot?.status === 'draft' ? t('saveDraftButton') : t('createButton')}
            </button>
          </form>

          {selectedLot?.status === 'draft' && (
            <div className="space-y-3 border-t border-slate-200 pt-4">
              <h3 className="text-sm font-bold text-slate-800">{t('photosTitle')}</h3>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => void handlePhotoUpload(e.target.files?.[0])}
                className="block text-xs text-slate-600"
              />
              {draftPhotosQuery.data && draftPhotosQuery.data.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {draftPhotosQuery.data.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 rounded border border-slate-200 px-2 py-1 text-xs">
                      <span>#{p.position + 1} ({p.status})</span>
                      <button
                        type="button"
                        onClick={() => deletePhotoMutation.mutate({ lotId: selectedLot.id, photoId: p.id })}
                        className="text-rose-600 hover:underline"
                      >
                        {t('deletePhotoButton')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                data-testid="submit-lot-btn"
                onClick={() => submitMutation.mutate(selectedLot.id)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                {t('submitButton')}
              </button>
            </div>
          )}

          {selectedLot?.status === 'active' && (
            <div className="space-y-2 border-t border-slate-200 pt-4">
              <h3 className="text-sm font-bold text-slate-800">{t('appendTitle')}</h3>
              <textarea
                rows={2}
                value={appendText}
                onChange={(e) => setAppendText(e.target.value)}
                placeholder={t('appendPlaceholder')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="button"
                disabled={!appendText.trim()}
                onClick={() => appendMutation.mutate({ lotId: selectedLot.id, append: appendText })}
                className="rounded-lg border border-brand-600 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
              >
                {t('appendButton')}
              </button>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">{t('salesTitle')}</h2>
          {!sellerSalesQuery.data || sellerSalesQuery.data.length === 0 ? (
            <p className="text-sm text-slate-500">{t('noSales')}</p>
          ) : (
            <div className="space-y-3" data-testid="seller-sales-list">
              {sellerSalesQuery.data.map((s) => (
                <div key={s.id} className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/lots/${s.lotId}`} className="font-semibold text-brand-700 hover:underline">
                      {s.lotTitle}
                    </Link>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium">{tSaleStatus(s.status)}</span>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                    <span>{tLot('buyerLabel')}: {s.buyerName} {s.buyerEmail ? `(${s.buyerEmail})` : ''}</span>
                    <span>{tLot('payoutLabel')}: {formatMoney(s.sellerPayout, locale)}</span>
                  </div>
                  {s.status === 'paid' && (
                    <div className="flex gap-2 pt-1">
                      <input
                        type="text"
                        value={trackingBySale[s.id] ?? ''}
                        onChange={(e) => setTrackingBySale((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        placeholder={tLot('trackingPlaceholder')}
                        className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                      <button
                        type="button"
                        data-testid={`seller-ship-${s.id}`}
                        disabled={(trackingBySale[s.id] ?? '').trim().length < 3 || shipMutation.isPending}
                        onClick={() => shipMutation.mutate({ saleId: s.id, trackingNumber: trackingBySale[s.id]!.trim() })}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                      >
                        {tLot('shipButton')}
                      </button>
                    </div>
                  )}
                  {s.trackingNumber && (
                    <div className="font-mono text-xs text-slate-600">{tLot('trackingLabel')}: {s.trackingNumber}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900">{t('myLotsTitle')}</h2>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setStatusFilter('')}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${statusFilter === '' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700'}`}
            >
              {t('allStatuses')}
            </button>
            {LOT_STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium ${statusFilter === st ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700'}`}
              >
                {tStatus(st)} ({mine?.countsByStatus[st] ?? 0})
              </button>
            ))}
          </div>
        </div>

        {!mine || mine.items.length === 0 ? (
          <p className="text-sm text-slate-500">{t('noLots')}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {mine.items.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <Link href={`/lots/${l.id}`} className="font-semibold text-brand-700 hover:underline">
                    {l.title}
                  </Link>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                    <span>{tStatus(l.status)}</span>
                    <span>{formatMoney(l.currentPrice, locale)}</span>
                    {l.reservePrice !== null && (
                      <span>{t('reserveHiddenLabel', { price: formatMoney(l.reservePrice, locale) })}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {l.status === 'draft' && (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(l)}
                        className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
                      >
                        {t('editLotTitle')}
                      </button>
                      <button
                        type="button"
                        onClick={() => submitMutation.mutate(l.id)}
                        className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                      >
                        {t('submitButton')}
                      </button>
                    </>
                  )}
                  {(l.status === 'rejected' || l.status === 'ended_unsold') && (
                    <button
                      type="button"
                      onClick={() => reopenMutation.mutate(l.id)}
                      className="rounded border border-brand-600 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                    >
                      {t('reopenButton')}
                    </button>
                  )}
                  {l.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => setSelectedLot(l)}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      {t('appendButton')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
