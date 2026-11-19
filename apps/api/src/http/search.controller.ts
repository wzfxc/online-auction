import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { SearchService, searchQuerySchema, type SearchResult } from '../search/search.js';
import { Public } from './auth.js';
import { ApiErrors, ZQuery, ZResponse } from './openapi-helpers.js';

const facet = z.record(z.number().int());
const searchResultSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(), title: z.string(), description: z.string(), categoryId: z.string().uuid(),
    cityId: z.string().uuid(), condition: z.string(), status: z.string(), startPrice: z.number().int(),
    currentPrice: z.number().int(), buyNowPrice: z.number().int().nullable(), bidCount: z.number().int(),
    reserveMet: z.boolean().nullable(), endsAt: z.number().int().nullable(), createdAt: z.number().int(),
  })),
  total: z.number().int(), page: z.number().int(), pageSize: z.number().int(),
  facets: z.object({ categoryId: facet, cityId: facet, condition: facet }),
});

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Public()
  @Get()
  @ApiOperation({ operationId: 'searchLots', summary: 'Full-text search with filters, sorting and facets' })
  @ZQuery(searchQuerySchema)
  @ZResponse(200, searchResultSchema)
  @ApiErrors(400)
  @ZResponse(503, z.object({ code: z.string(), message: z.string() }), 'Search unavailable (SEARCH_UNAVAILABLE)')
  find(@Query() query: unknown): Promise<SearchResult> {
    return this.search.search(query);
  }
}
