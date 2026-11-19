import type { Meilisearch } from 'meilisearch';
import { MAX_KOPECKS } from '@auction/shared';
import { z } from 'zod';
import { AppError, Errors } from '../common/errors/app-error.js';
import type { LotSearchDoc } from './document.js';
import { LOTS_INDEX } from './indexer.js';

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  categoryId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).optional(),
  status: z.enum(['active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed']).default('active'),
  minPrice: z.coerce.number().int().min(0).max(MAX_KOPECKS).optional(),
  maxPrice: z.coerce.number().int().min(0).max(MAX_KOPECKS).optional(),
  noBids: z.enum(['true', 'false']).optional(),
  endingWithinMinutes: z.coerce.number().int().min(1).max(14 * 24 * 60).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'ending_soon', 'newest']).default('relevance'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface SearchResult {
  items: LotSearchDoc[];
  total: number;
  page: number;
  pageSize: number;
  facets: { categoryId: Record<string, number>; cityId: Record<string, number>; condition: Record<string, number> };
}

const SORTS: Record<string, string[] | undefined> = {
  relevance: undefined, price_asc: ['currentPrice:asc'], price_desc: ['currentPrice:desc'],
  ending_soon: ['endsAt:asc'], newest: ['createdAt:desc'],
};

export class SearchService {
  constructor(private readonly meili: Meilisearch, private readonly now: () => Date, private readonly indexName = LOTS_INDEX) {}

  async search(raw: unknown): Promise<SearchResult> {
    const parsed = searchQuerySchema.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const p = parsed.data;
    if (p.minPrice !== undefined && p.maxPrice !== undefined && p.minPrice > p.maxPrice) {
      throw Errors.validation([{ path: ['minPrice'], message: 'minPrice must not exceed maxPrice' }]);
    }
    const filter: string[] = [`status = ${p.status}`];
    if (p.categoryId) filter.push(`categoryId = "${p.categoryId}"`);
    if (p.cityId) filter.push(`cityId = "${p.cityId}"`);
    if (p.condition) filter.push(`condition = ${p.condition}`);
    if (p.minPrice !== undefined) filter.push(`currentPrice >= ${p.minPrice}`);
    if (p.maxPrice !== undefined) filter.push(`currentPrice <= ${p.maxPrice}`);
    if (p.noBids === 'true') filter.push('bidCount = 0');
    if (p.endingWithinMinutes !== undefined) {
      const t = this.now().getTime();
      filter.push(`endsAt >= ${t} AND endsAt <= ${t + p.endingWithinMinutes * 60_000}`);
    }
    try {
      const r = await this.meili.index<LotSearchDoc>(this.indexName).search(p.q, {
        filter, sort: SORTS[p.sort], facets: ['categoryId', 'cityId', 'condition'],
        page: p.page, hitsPerPage: p.pageSize,
      });
      const d = r.facetDistribution ?? {};
      return {
        items: r.hits as LotSearchDoc[], total: r.totalHits, page: p.page, pageSize: p.pageSize,
        facets: { categoryId: d.categoryId ?? {}, cityId: d.cityId ?? {}, condition: d.condition ?? {} },
      };
    } catch (e) {
      // Index down or missing: lots and bids keep working, only search degrades, with a clear error.
      if (e instanceof AppError) throw e;
      throw new AppError(503, 'SEARCH_UNAVAILABLE', 'Search is temporarily unavailable, please try again shortly');
    }
  }
}
