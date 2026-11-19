'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ITEM_CONDITIONS } from '@auction/shared';
import { Countdown } from '@/components/Countdown';
import { ErrorBanner } from '@/components/ErrorBanner';
import { LotThumbnail } from '@/components/LotThumbnail';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { ApiClientError, unwrap } from '@/lib/api';
import { formatMoney, localizedName, uahToKopecks } from '@/lib/format';
import { useApp } from '@/lib/providers';

const PAGE_SIZE = 20;
type SortOption = 'relevance' | 'price_asc' | 'price_desc' | 'ending_soon' | 'newest';
type SearchStatus = 'active' | 'ended_unsold' | 'awaiting_payment' | 'paid' | 'shipped' | 'completed';

const STATUS_OPTIONS: readonly SearchStatus[] = [
  'active',
  'ended_unsold',
  'awaiting_payment',
  'paid',
  'shipped',
  'completed',
];

const SORT_OPTIONS: readonly SortOption[] = ['relevance', 'price_asc', 'price_desc', 'ending_soon', 'newest'];

function CatalogContent() {
  const t = useTranslations('catalog');
  const tPlurals = useTranslations('plurals');
  const tStatus = useTranslations('lotStatus');
  const tCond = useTranslations('condition');
  const locale = useLocale() as AppLocale;
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { client, categories, cities } = useApp();

  const q = searchParams.get('q') ?? '';
  const categoryId = searchParams.get('categoryId') ?? '';
  const cityId = searchParams.get('cityId') ?? '';
  const condition = searchParams.get('condition') ?? '';
  const status = (STATUS_OPTIONS.includes(searchParams.get('status') as SearchStatus)
    ? searchParams.get('status')
    : 'active') as SearchStatus;
  const minPriceParam = searchParams.get('minPrice') ?? '';
  const maxPriceParam = searchParams.get('maxPrice') ?? '';
  const noBids = searchParams.get('noBids') === 'true';
  const endingSoon = searchParams.get('endingSoon') === 'true';
  const sort = (SORT_OPTIONS.includes(searchParams.get('sort') as SortOption)
    ? searchParams.get('sort')
    : 'relevance') as SortOption;
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const [qInput, setQInput] = useState(q);
  const [minInput, setMinInput] = useState(minPriceParam);
  const [maxInput, setMaxInput] = useState(maxPriceParam);

  useEffect(() => {
    setQInput(q);
    setMinInput(minPriceParam);
    setMaxInput(maxPriceParam);
  }, [q, minPriceParam, maxPriceParam]);

  const updateUrl = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const minPriceKop = minPriceParam ? uahToKopecks(minPriceParam) ?? undefined : undefined;
  const maxPriceKop = maxPriceParam ? uahToKopecks(maxPriceParam) ?? undefined : undefined;

  const searchQuery = useQuery({
    queryKey: [
      'search',
      { q, categoryId, cityId, condition, status, minPriceKop, maxPriceKop, noBids, endingSoon, sort, page },
    ],
    queryFn: async () =>
      unwrap(
        await client.GET('/search', {
          params: {
            query: {
              q,
              ...(categoryId ? { categoryId } : {}),
              ...(cityId ? { cityId } : {}),
              ...(condition ? { condition: condition as (typeof ITEM_CONDITIONS)[number] } : {}),
              status,
              ...(minPriceKop !== undefined ? { minPrice: minPriceKop } : {}),
              ...(maxPriceKop !== undefined ? { maxPrice: maxPriceKop } : {}),
              ...(noBids ? { noBids: 'true' } : {}),
              ...(endingSoon ? { endingWithinMinutes: 60 } : {}),
              sort,
              page,
              pageSize: PAGE_SIZE,
            },
          },
        }),
      ),
  });

  const data = searchQuery.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const isSearchDown =
    searchQuery.error instanceof ApiClientError && searchQuery.error.code === 'SEARCH_UNAVAILABLE';

  const catMap = new Map(categories.map((c) => [c.id, localizedName(c, locale)]));
  const cityMap = new Map(cities.map((c) => [c.id, localizedName(c, locale)]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-900">{t('title')}</h1>
        {data && (
          <p className="text-sm text-slate-600" data-testid="catalog-total">
            {tPlurals('lots', { count: data.total })}
          </p>
        )}
      </div>

      <section aria-label="Search and filters" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            updateUrl({ q: qInput.trim(), minPrice: minInput.trim(), maxPrice: maxInput.trim() });
          }}
        >
          <div className="sm:col-span-2">
            <label htmlFor="search-q" className="mb-1 block text-xs font-medium text-slate-600">
              {t('searchLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id="search-q"
                type="search"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                {t('searchSubmit')}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="filter-category" className="mb-1 block text-xs font-medium text-slate-600">
              {t('categoryLabel')}
            </label>
            <select
              id="filter-category"
              value={categoryId}
              onChange={(e) => updateUrl({ categoryId: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">{t('allCategories')}</option>
              {categories.map((c) => {
                const count = data?.facets.categoryId[c.id];
                return (
                  <option key={c.id} value={c.id}>
                    {localizedName(c, locale)}
                    {count !== undefined ? ` (${count})` : ''}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label htmlFor="filter-city" className="mb-1 block text-xs font-medium text-slate-600">
              {t('cityLabel')}
            </label>
            <select
              id="filter-city"
              value={cityId}
              onChange={(e) => updateUrl({ cityId: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">{t('allCities')}</option>
              {cities.map((c) => {
                const count = data?.facets.cityId[c.id];
                return (
                  <option key={c.id} value={c.id}>
                    {localizedName(c, locale)}
                    {count !== undefined ? ` (${count})` : ''}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label htmlFor="filter-condition" className="mb-1 block text-xs font-medium text-slate-600">
              {t('conditionLabel')}
            </label>
            <select
              id="filter-condition"
              value={condition}
              onChange={(e) => updateUrl({ condition: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">{t('allConditions')}</option>
              {ITEM_CONDITIONS.map((cond) => {
                const count = data?.facets.condition[cond];
                return (
                  <option key={cond} value={cond}>
                    {tCond(cond)}
                    {count !== undefined ? ` (${count})` : ''}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label htmlFor="filter-status" className="mb-1 block text-xs font-medium text-slate-600">
              {t('statusLabel')}
            </label>
            <select
              id="filter-status"
              value={status}
              onChange={(e) => updateUrl({ status: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {STATUS_OPTIONS.map((st) => (
                <option key={st} value={st}>
                  {tStatus(st)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="filter-min" className="mb-1 block text-xs font-medium text-slate-600">
                {t('minPriceLabel')}
              </label>
              <input
                id="filter-min"
                type="number"
                min={0}
                value={minInput}
                onChange={(e) => setMinInput(e.target.value)}
                onBlur={() => updateUrl({ minPrice: minInput.trim() })}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="filter-max" className="mb-1 block text-xs font-medium text-slate-600">
                {t('maxPriceLabel')}
              </label>
              <input
                id="filter-max"
                type="number"
                min={0}
                value={maxInput}
                onChange={(e) => setMaxInput(e.target.value)}
                onBlur={() => updateUrl({ maxPrice: maxInput.trim() })}
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="filter-sort" className="mb-1 block text-xs font-medium text-slate-600">
              {t('sortLabel')}
            </label>
            <select
              id="filter-sort"
              value={sort}
              onChange={(e) => updateUrl({ sort: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="relevance">{t('sortRelevance')}</option>
              <option value="price_asc">{t('sortPriceAsc')}</option>
              <option value="price_desc">{t('sortPriceDesc')}</option>
              <option value="ending_soon">{t('sortEndingSoon')}</option>
              <option value="newest">{t('sortNewest')}</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-1 sm:col-span-2 lg:col-span-4">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={noBids}
                onChange={(e) => updateUrl({ noBids: e.target.checked ? 'true' : null })}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t('noBidsOnly')}
            </label>

            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={endingSoon}
                onChange={(e) => updateUrl({ endingSoon: e.target.checked ? 'true' : null })}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t('endingSoonOnly')}
            </label>

            <button
              type="button"
              onClick={() => router.push(pathname)}
              className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              {t('resetFilters')}
            </button>
          </div>
        </form>
      </section>

      {isSearchDown ? (
        <div role="alert" data-testid="search-unavailable" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {t('searchUnavailable')}
        </div>
      ) : (
        <ErrorBanner error={searchQuery.error} />
      )}

      {searchQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, idx) => (
            <div key={idx} className="h-72 animate-pulse rounded-xl border border-slate-200 bg-white" />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          {t('empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="catalog-grid">
          {data?.items.map((item) => (
            <Link
              key={item.id}
              href={`/lots/${item.id}`}
              data-testid={`lot-card-${item.id}`}
              className="group flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-brand-500 hover:shadow-md"
            >
              <LotThumbnail lotId={item.id} title={item.title} />
              <div className="flex flex-1 flex-col justify-between p-4">
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span>{catMap.get(item.categoryId) ?? ''}</span>
                    <span>{cityMap.get(item.cityId) ?? ''}</span>
                  </div>
                  <h2 className="line-clamp-2 text-base font-semibold text-slate-900 group-hover:text-brand-700">
                    {item.title}
                  </h2>
                </div>

                <div className="mt-4 space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-lg font-bold text-slate-900">
                      {formatMoney(item.currentPrice, locale)}
                    </span>
                    <span className="text-xs text-slate-600">
                      {item.bidCount === 0
                        ? t('noBidsBadge')
                        : tPlurals('bids', { count: item.bidCount })}
                    </span>
                  </div>

                  {item.buyNowPrice !== null && item.bidCount === 0 && item.status === 'active' && (
                    <div className="text-xs font-medium text-brand-700">
                      {t('buyNowBadge', { price: formatMoney(item.buyNowPrice, locale) })}
                    </div>
                  )}

                  <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                      {tCond(item.condition as (typeof ITEM_CONDITIONS)[number])}
                    </span>
                    {item.status === 'active' && item.endsAt !== null ? (
                      <Countdown endsAt={new Date(item.endsAt).toISOString()} endedLabel={t('ended')} />
                    ) : (
                      <span className="text-slate-500">
                        {tStatus(item.status as SearchStatus)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {data && totalPages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => updateUrl({ page: String(page - 1) }, false)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            {t('prevPage')}
          </button>
          <span className="text-sm text-slate-600">{t('pageOf', { page, total: totalPages })}</span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => updateUrl({ page: String(page + 1) }, false)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            {t('nextPage')}
          </button>
        </nav>
      )}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-slate-500">...</div>}>
      <CatalogContent />
    </Suspense>
  );
}
