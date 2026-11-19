import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { placeBidSchema } from '@auction/shared';
import { BidService } from '../bids/bids.js';
import type { Principal } from '../lots/lots.js';
import { CurrentUser, Public, Roles } from './auth.js';
import { ApiErrors, IdempotencyKeyHeader, ZBody, ZQuery, ZResponse, ZUuidParam } from './openapi-helpers.js';
import { requireIdempotencyKey, UuidPipe } from './pipes.js';
import { RateLimitTier } from './rate-limit.js';
import { bidHistoryQuerySchema, bidHistorySchema, bidResultSchema, buyNowResultSchema } from './schemas.js';
import { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';

const REPLAY_HEADER = 'Idempotency-Replayed';

@ApiTags('bids')
@ApiBearerAuth()
@Controller('lots/:id')
export class BidsController {
  constructor(@Inject(BidService) private readonly bids: BidService) {}

  @Roles('buyer', 'seller')
  @RateLimitTier('bid')
  @Post('bids')
  @ApiOperation({ operationId: 'placeBid', summary: 'Place a bid, optionally with an auto-bid ceiling' })
  @ZUuidParam('id')
  @IdempotencyKeyHeader()
  @ZBody(placeBidSchema)
  @ZResponse(201, bidResultSchema, 'Bid accepted (replayed responses carry Idempotency-Replayed: true)')
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async place(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof bidResultSchema>> {
    const r = await this.bids.placeBid(user!, lotId, body, requireIdempotencyKey(key));
    res.status(r.status).setHeader(REPLAY_HEADER, String(r.replayed));
    return r.body;
  }

  @Roles('buyer', 'seller')
  @RateLimitTier('bid')
  @Post('buy-now')
  @ApiOperation({ operationId: 'buyNow', summary: 'Buy the lot at the buy-now price (before the first bid)' })
  @ZUuidParam('id')
  @IdempotencyKeyHeader()
  @ZResponse(201, buyNowResultSchema, 'Lot bought; payment due within the payment window')
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async buyNow(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof buyNowResultSchema>> {
    const r = await this.bids.buyNow(user!, lotId, requireIdempotencyKey(key));
    res.status(r.status).setHeader(REPLAY_HEADER, String(r.replayed));
    return r.body;
  }

  @Public()
  @Get('bids')
  @ApiOperation({ operationId: 'getBidHistory', summary: 'Bid history, newest first, names masked' })
  @ZUuidParam('id')
  @ZQuery(bidHistoryQuerySchema)
  @ZResponse(200, bidHistorySchema)
  @ApiErrors(400, 404)
  history(
    @CurrentUser() user: Principal | null,
    @Param('id', UuidPipe) lotId: string,
    @Query() query: unknown,
  ): Promise<z.infer<typeof bidHistorySchema>> {
    const q = bidHistoryQuerySchema.safeParse(query);
    if (!q.success) throw Errors.validation(q.error.issues);
    return this.bids.history(user, lotId, q.data);
  }
}
