'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { calcDeposit, minNextBid } from '@auction/shared';
import { Countdown } from '@/components/Countdown';
import { ErrorBanner, useErrorMessage } from '@/components/ErrorBanner';
import { Link } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import {
  newIdempotencyKey,
  unwrap,
  type BidHistoryDto,
  type BidResultDto,
  type PhotoDto,
} from '@/lib/api';
import { syncServerTime } from '@/lib/clock';
import { formatDateTime, formatMoney, kopecksToUahInput, localizedName, uahToKopecks } from '@/lib/format';
import { useApp } from '@/lib/providers';

interface LotLiveSnapshot {
  lotId: string;
  seq: number;
  status: string;
  currentPrice: number;
  bidCount: number;
  minNextBid: number;
  endsAt: string | null;
  serverTime: string;
}

interface LiveBidItem {
  seq: number;
  bidder: string;
  own: boolean;
  priceAfter: number;
  auto: boolean;
  createdAt: string;
}

type SubscribeAck =
  | { ok: true; snapshot: LotLiveSnapshot; missed: LiveBidItem[]; truncated: boolean }
  | { ok: false; error: { code: string; message: string } };

interface BidFormValues {
  amountUah: string;
  maxAmountUah: string;
}

interface ShipFormValues {
  trackingNumber: string;
}

export default function LotDetailPage() {
  const params = useParams<{ id: string }>();
  const lotId = params.id;
  const t = useTranslations('lot');
  const tStatus = useTranslations('lotStatus');
  const tSaleStatus = useTranslations('saleStatus');
  const tCond = useTranslations('condition');
  const tPlurals = useTranslations('plurals');
  const locale = useLocale() as AppLocale;
  const qc = useQueryClient();
  const formatErr = useErrorMessage();
  const { client, token, user, socket, socketConnected, categories, cities } = useApp();

  const [liveState, setLiveState] = useState<LotLiveSnapshot | null>(null);
  const lastSeqRef = useRef<number>(0);
  const [liveBids, setLiveBids] = useState<BidHistoryDto['items']>([]);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  const [outbidNotice, setOutbidNotice] = useState<{ currentPrice: number; minNextBid: number } | null>(null);
  const [bidFeedback, setBidFeedback] = useState<BidResultDto | null>(null);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);

  const lotQuery = useQuery({
    queryKey: ['lot', lotId, token],
    queryFn: async () => unwrap(await client.GET('/lots/{id}', { params: { path: { id: lotId } } })),
  });

  const bidsQuery = useQuery({
    queryKey: ['lot-bids', lotId, token],
    enabled: Boolean(lotQuery.data && lotQuery.data.status !== 'draft' && lotQuery.data.status !== 'in_review' && lotQuery.data.status !== 'rejected'),
    queryFn: async () =>
      unwrap(await client.GET('/lots/{id}/bids', { params: { path: { id: lotId }, query: { limit: 30 } } })),
  });

  const photosQuery = useQuery({
    queryKey: ['lot-photos', lotId, token],
    enabled: Boolean(lotQuery.data),
    queryFn: async () => unwrap(await client.GET('/lots/{id}/photos', { params: { path: { id: lotId } } })),
  });

  const favoritesQuery = useQuery({
    queryKey: ['favorites', token],
    enabled: Boolean(token && (user?.role === 'buyer' || user?.role === 'seller')),
    queryFn: async () => unwrap(await client.GET('/favorites')),
  });

  const isPrivilegedRole = user?.role === 'buyer' || user?.role === 'seller';
  const currentStatus = liveState?.status ?? lotQuery.data?.status;
  const saleQuery = useQuery({
    queryKey: ['lot-sale', lotId, token],
    enabled: Boolean(
      token &&
        isPrivilegedRole &&
        currentStatus &&
        ['awaiting_payment', 'paid', 'shipped', 'completed'].includes(currentStatus),
    ),
    queryFn: async () => unwrap(await client.GET('/lots/{id}/sale', { params: { path: { id: lotId } } })),
  });

  const auditHistoryQuery = useQuery({
    queryKey: ['lot-audit', lotId, token],
    enabled: Boolean(
      token &&
        lotQuery.data &&
        (user?.role === 'moderator' || user?.id === lotQuery.data.sellerId),
    ),
    queryFn: async () => unwrap(await client.GET('/lots/{id}/history', { params: { path: { id: lotId } } })),
  });

  useEffect(() => {
    if (bidsQuery.data) {
      setLiveBids(bidsQuery.data.items);
      setNextBeforeSeq(bidsQuery.data.nextBeforeSeq);
      const maxSeq = bidsQuery.data.items.reduce((m, b) => Math.max(m, b.seq), 0);
      if (maxSeq > lastSeqRef.current) lastSeqRef.current = maxSeq;
    }
  }, [bidsQuery.data]);

  const applySnapshot = useCallback((snap: LotLiveSnapshot) => {
    syncServerTime(snap.serverTime);
    if (snap.seq >= lastSeqRef.current) {
      lastSeqRef.current = snap.seq;
      setLiveState(snap);
    }
  }, []);

  useEffect(() => {
    if (!socket || !lotId) return;

    const subscribe = () => {
      socket.emit('lot:subscribe', { lotId, lastSeq: lastSeqRef.current }, (ack: SubscribeAck) => {
        if (!ack?.ok) return;
        applySnapshot(ack.snapshot);
        if (ack.missed.length > 0) {
          setLiveBids((prev) => {
            const map = new Map(prev.map((b) => [b.seq, b]));
            for (const m of ack.missed) map.set(m.seq, m);
            return [...map.values()].sort((a, b) => b.seq - a.seq);
          });
        }
        if (ack.truncated) {
          void qc.invalidateQueries({ queryKey: ['lot-bids', lotId] });
        }
      });
    };

    const onUpdate = (upd: LotLiveSnapshot) => {
      if (upd.lotId !== lotId) return;
      const prevSeq = lastSeqRef.current;
      applySnapshot(upd);
      if (upd.seq > prevSeq) {
        void qc.invalidateQueries({ queryKey: ['lot-bids', lotId] });
        void qc.invalidateQueries({ queryKey: ['lot', lotId] });
        void qc.invalidateQueries({ queryKey: ['wallet'] });
      }
      if (['awaiting_payment', 'paid', 'shipped', 'completed'].includes(upd.status)) {
        void qc.invalidateQueries({ queryKey: ['lot-sale', lotId] });
      }
    };

    const onRemoved = (ev: { lotId: string }) => {
      if (ev.lotId !== lotId) return;
      void qc.invalidateQueries({ queryKey: ['lot', lotId] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
    };

    const onOutbid = (ev: { lotId: string; seq: number; currentPrice: number; minNextBid: number }) => {
      if (ev.lotId !== lotId) return;
      setOutbidNotice({ currentPrice: ev.currentPrice, minNextBid: ev.minNextBid });
      setBidFeedback(null);
    };

    socket.on('connect', subscribe);
    socket.on('lot:update', onUpdate);
    socket.on('lot:removed', onRemoved);
    socket.on('user:outbid', onOutbid);
    if (socket.connected) subscribe();

    return () => {
      socket.off('connect', subscribe);
      socket.off('lot:update', onUpdate);
      socket.off('lot:removed', onRemoved);
      socket.off('user:outbid', onOutbid);
      socket.emit('lot:unsubscribe', { lotId });
    };
  }, [socket, lotId, applySnapshot, qc]);

  const lot = lotQuery.data;
  const effectivePrice = liveState?.currentPrice ?? lot?.currentPrice ?? 0;
  const effectiveBidCount = liveState?.bidCount ?? lot?.bidCount ?? 0;
  const effectiveEndsAt = liveState?.endsAt !== undefined ? liveState.endsAt : (lot?.endsAt ?? null);
  const effectiveStatus = liveState?.status ?? lot?.status ?? 'active';
  const effectiveMinNext =
    liveState?.minNextBid ??
    (lot ? minNextBid({ startPrice: lot.startPrice, currentPrice: effectivePrice, bidCount: effectiveBidCount }) : 0);

  const bidForm = useForm<BidFormValues>({
    defaultValues: { amountUah: '', maxAmountUah: '' },
  });

  useEffect(() => {
    if (effectiveMinNext > 0 && !bidForm.formState.isDirty) {
      bidForm.setValue('amountUah', kopecksToUahInput(effectiveMinNext));
    }
  }, [effectiveMinNext, bidForm]);

  const watchedMax = bidForm.watch('maxAmountUah');
  const watchedAmount = bidForm.watch('amountUah');
  const expectedDeposit = useMemo(() => {
    const maxKop = watchedMax.trim() ? uahToKopecks(watchedMax) : uahToKopecks(watchedAmount);
    if (!maxKop) return null;
    return calcDeposit(maxKop);
  }, [watchedMax, watchedAmount]);

  const bidMutation = useMutation({
    mutationFn: async (values: { amount: number; maxAmount?: number }) =>
      unwrap(
        await client.POST('/lots/{id}/bids', {
          params: { path: { id: lotId }, header: { 'idempotency-key': newIdempotencyKey() } },
          body: values,
        }),
      ),
    onSuccess: (res) => {
      setBidFeedback(res);
      setOutbidNotice(null);
      bidForm.reset({ amountUah: kopecksToUahInput(res.minNextBid), maxAmountUah: '' });
      void qc.invalidateQueries({ queryKey: ['lot', lotId] });
      void qc.invalidateQueries({ queryKey: ['lot-bids', lotId] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  const buyNowMutation = useMutation({
    mutationFn: async () =>
      unwrap(
        await client.POST('/lots/{id}/buy-now', {
          params: { path: { id: lotId }, header: { 'idempotency-key': newIdempotencyKey() } },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lot', lotId] });
      void qc.invalidateQueries({ queryKey: ['lot-sale', lotId] });
      void qc.invalidateQueries({ queryKey: ['lot-bids', lotId] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  const isFavorited = Boolean(favoritesQuery.data?.some((f) => f.id === lotId));
  const favoriteMutation = useMutation({
    mutationFn: async () =>
      isFavorited
        ? unwrap(await client.DELETE('/favorites/{id}', { params: { path: { id: lotId } } }))
        : unwrap(await client.POST('/favorites/{id}', { params: { path: { id: lotId } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['favorites'] }),
  });

  const paySaleMutation = useMutation({
    mutationFn: async (saleId: string) =>
      unwrap(
        await client.POST('/sales/{id}/pay', {
          params: { path: { id: saleId }, header: { 'idempotency-key': newIdempotencyKey() } },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lot', lotId] });
      void qc.invalidateQueries({ queryKey: ['lot-sale', lotId] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  const shipForm = useForm<ShipFormValues>({ defaultValues: { trackingNumber: '' } });
  const shipMutation = useMutation({
    mutationFn: async (args: { saleId: string; trackingNumber: string }) =>
      unwrap(
        await client.POST('/sales/{id}/ship', {
          params: { path: { id: args.saleId } },
          body: { trackingNumber: args.trackingNumber },
        }),
      ),
    onSuccess: () => {
      shipForm.reset();
      void qc.invalidateQueries({ queryKey: ['lot', lotId] });
      void qc.invalidateQueries({ queryKey: ['lot-sale', lotId] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (saleId: string) =>
      unwrap(await client.POST('/sales/{id}/confirm', { params: { path: { id: saleId } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lot', lotId] });
      void qc.invalidateQueries({ queryKey: ['lot-sale', lotId] });
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  const loadMoreBids = async () => {
    if (nextBeforeSeq === null) return;
    const more = unwrap(
      await client.GET('/lots/{id}/bids', {
        params: { path: { id: lotId }, query: { beforeSeq: nextBeforeSeq, limit: 30 } },
      }),
    );
    setLiveBids((prev) => {
      const map = new Map(prev.map((b) => [b.seq, b]));
      for (const item of more.items) map.set(item.seq, item);
      return [...map.values()].sort((a, b) => b.seq - a.seq);
    });
    setNextBeforeSeq(more.nextBeforeSeq);
  };

  if (lotQuery.isLoading) {
    return <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white" />;
  }

  if (lotQuery.error || !lot) {
    return (
      <div className="space-y-4">
        <Link href="/" className="text-sm font-medium text-brand-700 hover:underline">
          ← {t('backToCatalog')}
        </Link>
        <ErrorBanner error={lotQuery.error} />
      </div>
    );
  }

  const category = categories.find((c) => c.id === lot.categoryId);
  const city = cities.find((c) => c.id === lot.cityId);
  const isOwner = user?.id === lot.sellerId;
  const canBidRole = user?.role === 'buyer' || user?.role === 'seller';
  const sale = saleQuery.data;

  const onBidSubmit = bidForm.handleSubmit(async (values) => {
    bidForm.clearErrors();
    const amountKop = uahToKopecks(values.amountUah);
    if (!amountKop) {
      bidForm.setError('amountUah', { message: t('minNextHint', { amount: formatMoney(effectiveMinNext, locale) }) });
      return;
    }
    let maxKop: number | undefined;
    if (values.maxAmountUah.trim()) {
      const parsedMax = uahToKopecks(values.maxAmountUah);
      if (!parsedMax || parsedMax < amountKop) {
        bidForm.setError('maxAmountUah', { message: t('maxAmountHint') });
        return;
      }
      maxKop = parsedMax;
    }
    try {
      await bidMutation.mutateAsync({ amount: amountKop, ...(maxKop !== undefined ? { maxAmount: maxKop } : {}) });
    } catch {
      // Displayed via bidMutation.error
    }
  });

  const onShipSubmit = shipForm.handleSubmit(async (values) => {
    if (!sale) return;
    shipForm.clearErrors();
    const trk = values.trackingNumber.trim();
    if (trk.length < 3) {
      shipForm.setError('trackingNumber', { message: t('trackingPlaceholder') });
      return;
    }
    await shipMutation.mutateAsync({ saleId: sale.id, trackingNumber: trk });
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-sm font-medium text-brand-700 hover:underline">
          ← {t('backToCatalog')}
        </Link>
        <span
          data-testid="live-status"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            socketConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${socketConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {socketConnected ? t('liveConnected') : t('liveReconnecting')}
        </span>
      </div>

      {outbidNotice && (
        <div
          role="alert"
          data-testid="lot-outbid-alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
        >
          {t('outbidBanner', {
            price: formatMoney(outbidNotice.currentPrice, locale),
            minNext: formatMoney(outbidNotice.minNextBid, locale),
          })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <PhotoGallery
            lotId={lotId}
            photos={photosQuery.data ?? []}
            activeIdx={activePhotoIdx}
            onSelect={setActivePhotoIdx}
            title={lot.title}
            emptyLabel={t('noPhotos')}
          />

          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {category && <span>{localizedName(category, locale)}</span>}
                  {city && <span>• {localizedName(city, locale)}</span>}
                  <span>• {tCond(lot.condition)}</span>
                </div>
                <h1 className="text-2xl font-bold text-slate-900">{lot.title}</h1>
              </div>

              <div className="flex items-center gap-2">
                <span
                  data-testid="lot-status-badge"
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
                >
                  {tStatus(effectiveStatus as keyof typeof tStatus)}
                </span>
                {canBidRole && effectiveStatus === 'active' && (
                  <button
                    type="button"
                    data-testid="favorite-toggle"
                    disabled={favoriteMutation.isPending}
                    onClick={() => favoriteMutation.mutate()}
                    className={`rounded-lg border px-3 py-1 text-xs font-medium ${
                      isFavorited
                        ? 'border-amber-400 bg-amber-50 text-amber-800'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {isFavorited ? t('removeFavorite') : t('addFavorite')}
                  </button>
                )}
              </div>
            </div>

            {lot.rejectionReason && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <strong>{t('rejectionReason')}:</strong> {lot.rejectionReason}
              </div>
            )}

            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{lot.description}</p>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-bold text-slate-900">{t('historyTitle')}</h2>
            {liveBids.length === 0 ? (
              <p className="text-sm text-slate-500">{t('historyEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="bid-history-table">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">#</th>
                      <th className="py-2 pr-3">{t('buyerLabel')}</th>
                      <th className="py-2 pr-3">{t('currentPrice')}</th>
                      <th className="py-2 text-right">{t('endsAt')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {liveBids.map((b) => (
                      <tr key={b.seq} className={b.own ? 'bg-brand-50/50 font-medium' : ''}>
                        <td className="py-2 pr-3 text-xs text-slate-500">{b.seq}</td>
                        <td className="py-2 pr-3">
                          {b.bidder}{' '}
                          {b.own && (
                            <span className="ml-1 rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-700">
                              {t('historyOwn')}
                            </span>
                          )}
                          {b.auto && (
                            <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                              {t('historyAuto')}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-semibold">{formatMoney(b.priceAfter, locale)}</td>
                        <td className="py-2 text-right text-xs text-slate-500">{formatDateTime(b.createdAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {nextBeforeSeq !== null && (
              <button
                type="button"
                onClick={loadMoreBids}
                className="mt-4 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {t('loadMoreBids')}
              </button>
            )}
          </section>

          {auditHistoryQuery.data && auditHistoryQuery.data.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-3 text-base font-bold text-slate-900">{t('auditHistoryTitle')}</h2>
              <ul className="space-y-1.5 text-xs text-slate-600">
                {auditHistoryQuery.data.map((ev) => (
                  <li key={ev.id} className="flex justify-between gap-4 border-b border-slate-100 pb-1">
                    <span className="font-mono font-semibold text-slate-800">{ev.type}</span>
                    <span>{formatDateTime(ev.createdAt, locale)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <div className="text-xs font-medium uppercase text-slate-500">{t('currentPrice')}</div>
              <div data-testid="lot-current-price" className="mt-1 text-3xl font-extrabold text-slate-900">
                {formatMoney(effectivePrice, locale)}
              </div>
              <div data-testid="lot-bid-count" className="mt-1 text-sm text-slate-600">
                {tPlurals('bids', { count: effectiveBidCount })}
              </div>
            </div>

            <div className="space-y-1 border-t border-slate-100 pt-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">{t('startPrice')}</span>
                <span className="font-medium">{formatMoney(lot.startPrice, locale)}</span>
              </div>
              {lot.buyNowPrice !== null && (
                <div className="flex justify-between">
                  <span className="text-slate-500">{t('buyNowPrice')}</span>
                  <span className="font-medium text-brand-700">{formatMoney(lot.buyNowPrice, locale)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-500">{t('timeLeft')}</span>
                <Countdown endsAt={effectiveEndsAt} />
              </div>
              {effectiveEndsAt && (
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{t('endsAt')}</span>
                  <span data-testid="lot-ends-at">{formatDateTime(effectiveEndsAt, locale)}</span>
                </div>
              )}
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700" data-testid="reserve-status">
              {lot.reserveMet === null
                ? t('noReserve')
                : lot.reserveMet
                  ? t('reserveMet')
                  : t('reserveNotMet')}
            </div>

            {effectiveStatus === 'active' && (
              <div className="space-y-4 border-t border-slate-200 pt-4">
                {!user || !canBidRole ? (
                  <p className="text-sm text-slate-600">
                    <Link href="/login" className="font-semibold text-brand-700 underline">
                      {t('loginToBid')}
                    </Link>
                  </p>
                ) : isOwner ? (
                  <p className="text-sm text-slate-600">{t('ownLotHint')}</p>
                ) : (
                  <>
                    <h2 className="text-base font-bold text-slate-900">{t('placeBidTitle')}</h2>

                    {bidFeedback && (
                      <div
                        role="status"
                        data-testid="bid-feedback"
                        className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                          bidFeedback.status === 'leading'
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                            : 'border-amber-300 bg-amber-50 text-amber-900'
                        }`}
                      >
                        {bidFeedback.status === 'leading'
                          ? t('bidAcceptedLeading', { price: formatMoney(bidFeedback.currentPrice, locale) })
                          : t('bidAcceptedOutbid', { price: formatMoney(bidFeedback.currentPrice, locale) })}
                      </div>
                    )}

                    <ErrorBanner error={bidMutation.error ?? buyNowMutation.error} />

                    <form onSubmit={onBidSubmit} className="space-y-3" noValidate>
                      <div>
                        <label htmlFor="bid-amount" className="mb-1 block text-xs font-medium text-slate-700">
                          {t('bidAmountLabel')}
                        </label>
                        <input
                          id="bid-amount"
                          data-testid="bid-amount-input"
                          type="text"
                          inputMode="decimal"
                          aria-invalid={Boolean(bidForm.formState.errors.amountUah)}
                          aria-describedby="bid-min-hint bid-amount-err"
                          {...bidForm.register('amountUah')}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                        <p id="bid-min-hint" className="mt-1 text-xs text-slate-500">
                          {t('minNextHint', { amount: formatMoney(effectiveMinNext, locale) })}
                        </p>
                        {bidForm.formState.errors.amountUah && (
                          <p id="bid-amount-err" className="mt-1 text-xs text-rose-600">
                            {bidForm.formState.errors.amountUah.message}
                          </p>
                        )}
                      </div>

                      <div>
                        <label htmlFor="bid-max" className="mb-1 block text-xs font-medium text-slate-700">
                          {t('maxAmountLabel')}
                        </label>
                        <input
                          id="bid-max"
                          data-testid="bid-max-input"
                          type="text"
                          inputMode="decimal"
                          aria-invalid={Boolean(bidForm.formState.errors.maxAmountUah)}
                          aria-describedby="bid-max-hint bid-max-err"
                          {...bidForm.register('maxAmountUah')}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                        <p id="bid-max-hint" className="mt-1 text-xs text-slate-500">
                          {t('maxAmountHint')}
                        </p>
                        {bidForm.formState.errors.maxAmountUah && (
                          <p id="bid-max-err" className="mt-1 text-xs text-rose-600">
                            {bidForm.formState.errors.maxAmountUah.message}
                          </p>
                        )}
                      </div>

                      {expectedDeposit !== null && (
                        <p className="text-xs font-medium text-slate-600">
                          {t('depositHint', { deposit: formatMoney(expectedDeposit, locale) })}
                        </p>
                      )}

                      <button
                        type="submit"
                        data-testid="place-bid-btn"
                        disabled={bidMutation.isPending}
                        className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                      >
                        {t('placeBidButton')}
                      </button>
                    </form>

                    {lot.buyNowPrice !== null && effectiveBidCount === 0 && (
                      <button
                        type="button"
                        data-testid="buy-now-btn"
                        disabled={buyNowMutation.isPending}
                        onClick={() => buyNowMutation.mutate()}
                        className="w-full rounded-lg border border-brand-600 bg-white px-4 py-2.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                      >
                        {t('buyNowButton', { price: formatMoney(lot.buyNowPrice, locale) })}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {sale && (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="lot-sale-panel">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900">{t('saleTitle')}</h2>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                  {tSaleStatus(sale.status)}
                </span>
              </div>

              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">{t('buyerLabel')}</span>
                  <span className="font-medium">{sale.buyerName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t('priceLabel')}</span>
                  <span className="font-semibold">{formatMoney(sale.price, locale)}</span>
                </div>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{t('feeLabel')}</span>
                  <span>{formatMoney(sale.fee, locale)}</span>
                </div>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{t('payoutLabel')}</span>
                  <span>{formatMoney(sale.sellerPayout, locale)}</span>
                </div>
                {sale.status === 'awaiting_payment' && (
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">{t('payDueLabel')}</span>
                    <Countdown endsAt={sale.payDueAt} />
                  </div>
                )}
                {sale.trackingNumber && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('trackingLabel')}</span>
                    <span className="font-mono font-semibold">{sale.trackingNumber}</span>
                  </div>
                )}
              </div>

              <ErrorBanner error={paySaleMutation.error ?? shipMutation.error ?? confirmMutation.error} />

              {sale.status === 'awaiting_payment' && user?.id === sale.buyerId && (
                <button
                  type="button"
                  data-testid="pay-sale-btn"
                  disabled={paySaleMutation.isPending}
                  onClick={() => paySaleMutation.mutate(sale.id)}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {t('payFromWallet')}
                </button>
              )}

              {paySaleMutation.isSuccess && (
                <p className="text-xs font-medium text-emerald-700">{t('paySuccess')}</p>
              )}

              {sale.status === 'paid' && user?.id === sale.sellerId && (
                <form onSubmit={onShipSubmit} className="space-y-2 border-t border-slate-100 pt-3">
                  <label htmlFor="lot-ship-tracking" className="block text-xs font-medium text-slate-700">
                    {t('trackingInputLabel')}
                  </label>
                  <input
                    id="lot-ship-tracking"
                    data-testid="tracking-input"
                    type="text"
                    placeholder={t('trackingPlaceholder')}
                    aria-invalid={Boolean(shipForm.formState.errors.trackingNumber)}
                    {...shipForm.register('trackingNumber')}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  {shipForm.formState.errors.trackingNumber && (
                    <p className="text-xs text-rose-600">{shipForm.formState.errors.trackingNumber.message}</p>
                  )}
                  <button
                    type="submit"
                    data-testid="ship-sale-btn"
                    disabled={shipMutation.isPending}
                    className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {t('shipButton')}
                  </button>
                </form>
              )}

              {sale.status === 'shipped' && user?.id === sale.buyerId && (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    data-testid="confirm-receipt-btn"
                    disabled={confirmMutation.isPending}
                    onClick={() => confirmMutation.mutate(sale.id)}
                    className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {t('confirmReceiptButton')}
                  </button>
                  <p className="text-xs text-slate-500">{t('autoConfirmNote')}</p>
                </div>
              )}

              {saleQuery.error && (
                <p className="text-xs text-rose-600">{formatErr(saleQuery.error)}</p>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function PhotoGallery({
  lotId,
  photos,
  activeIdx,
  onSelect,
  title,
  emptyLabel,
}: {
  lotId: string;
  photos: PhotoDto[];
  activeIdx: number;
  onSelect: (idx: number) => void;
  title: string;
  emptyLabel: string;
}) {
  const { client, token } = useApp();
  const active = photos[activeIdx] ?? photos[0];

  const mainUrlQuery = useQuery({
    queryKey: ['lot-photo-url', lotId, active?.id, 'original', token],
    enabled: Boolean(active && active.status !== 'pending_upload'),
    staleTime: 180_000,
    queryFn: async () =>
      unwrap(
        await client.GET('/lots/{id}/photos/{photoId}/url', {
          params: { path: { id: lotId, photoId: active!.id }, query: { variant: 'original' } },
        }),
      ),
  });

  if (photos.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-400">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex h-80 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
        {mainUrlQuery.data?.url ? (
          <img src={mainUrlQuery.data.url} alt={title} className="max-h-80 w-auto object-contain" />
        ) : (
          <span className="text-xs text-slate-400">{title}</span>
        )}
      </div>
      {photos.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {photos.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(idx)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                idx === activeIdx ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600'
              }`}
            >
              #{p.position + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
