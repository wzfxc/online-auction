import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { shipSaleSchema } from '@auction/shared';
import { Errors } from '../common/errors/app-error.js';
import type { Principal } from '../lots/lots.js';
import { SalesService, type SaleDto } from '../sales/sales.js';
import { CurrentUser, Roles } from './auth.js';
import { ApiErrors, IdempotencyKeyHeader, ZBody, ZQuery, ZResponse, ZUuidParam } from './openapi-helpers.js';
import { requireIdempotencyKey, UuidPipe } from './pipes.js';
import { saleSchema, salesQuerySchema } from './schemas.js';

const REPLAY_HEADER = 'Idempotency-Replayed';

@ApiTags('sales')
@ApiBearerAuth()
@Roles('buyer', 'seller')
@Controller('sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Get()
  @ApiOperation({ operationId: 'listSales', summary: 'Own sales as buyer or seller' })
  @ZQuery(salesQuerySchema)
  @ZResponse(200, z.array(saleSchema))
  @ApiErrors(400, 401, 403)
  list(@CurrentUser() user: Principal | null, @Query() query: unknown): Promise<SaleDto[]> {
    const q = salesQuerySchema.safeParse(query);
    if (!q.success) throw Errors.validation(q.error.issues);
    return this.sales.listSales(user!, q.data);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getSale', summary: 'Sale details (buyer or seller of the lot only)' })
  @ZUuidParam('id')
  @ZResponse(200, saleSchema)
  @ApiErrors(400, 401, 403, 404)
  get(@CurrentUser() user: Principal | null, @Param('id', UuidPipe) saleId: string): Promise<SaleDto> {
    return this.sales.getSale(user!, saleId);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @ApiOperation({ operationId: 'paySale', summary: 'Pay for a won lot from the wallet (deposit is credited)' })
  @ZUuidParam('id')
  @IdempotencyKeyHeader()
  @ZResponse(200, saleSchema, 'Sale paid; deposit credited and balance moved to escrow')
  @ApiErrors(400, 401, 403, 404, 409, 422)
  async pay(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) saleId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleDto> {
    const r = await this.sales.paySale(user!, saleId, requireIdempotencyKey(key), body);
    res.status(r.status).setHeader(REPLAY_HEADER, String(r.replayed));
    return r.body;
  }

  @Roles('seller')
  @Post(':id/ship')
  @HttpCode(200)
  @ApiOperation({ operationId: 'shipSale', summary: 'Mark a paid sale as shipped with a tracking number (seller)' })
  @ZUuidParam('id')
  @ZBody(shipSaleSchema)
  @ZResponse(200, saleSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  ship(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) saleId: string,
    @Body() body: unknown,
  ): Promise<SaleDto> {
    return this.sales.shipSale(user!, saleId, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @ApiOperation({ operationId: 'confirmReceipt', summary: 'Confirm receipt of a shipped order; triggers payout to the seller' })
  @ZUuidParam('id')
  @ZResponse(200, saleSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  confirm(@CurrentUser() user: Principal | null, @Param('id', UuidPipe) saleId: string): Promise<SaleDto> {
    return this.sales.confirmReceipt(user!, saleId);
  }
}
