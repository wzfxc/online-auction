import type { Settings } from 'meilisearch';
import type { LotStatus } from '@auction/shared';
import type { LotRow } from '../lots/lots.js';

/** Statuses visible in the public catalog; any other lot is removed from the index. */
export const SEARCHABLE_STATUSES: readonly LotStatus[] = ['active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed'];

/**
 * Search document. Explicit allow-list mapper: the reserve price itself never reaches the index (CLAUDE.md);
 * only the public "reserve met" flag does.
 */
export interface LotSearchDoc {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  cityId: string;
  condition: string;
  status: LotStatus;
  startPrice: number;
  currentPrice: number;
  buyNowPrice: number | null;
  bidCount: number;
  reserveMet: boolean | null;
  /** Epoch ms, so the index can sort and filter by "ends within the hour". */
  endsAt: number | null;
  createdAt: number;
}

export function toSearchDoc(lot: LotRow): LotSearchDoc {
  return {
    id: lot.id,
    title: lot.title,
    description: lot.description,
    categoryId: lot.categoryId,
    cityId: lot.cityId,
    condition: lot.condition,
    status: lot.status,
    startPrice: lot.startPrice,
    currentPrice: lot.currentPrice,
    buyNowPrice: lot.buyNowPrice,
    bidCount: lot.bidCount,
    reserveMet: lot.reservePrice === null ? null : lot.bidCount > 0 && lot.currentPrice >= lot.reservePrice,
    endsAt: lot.endsAt?.getTime() ?? null,
    createdAt: lot.createdAt.getTime(),
  };
}

export const INDEX_SETTINGS: Settings = {
  searchableAttributes: ['title', 'description'],
  filterableAttributes: ['categoryId', 'cityId', 'condition', 'status', 'currentPrice', 'endsAt', 'reserveMet'],
  sortableAttributes: ['currentPrice', 'endsAt', 'bidCount', 'createdAt'],
  pagination: { maxTotalHits: 10_000 },
};
