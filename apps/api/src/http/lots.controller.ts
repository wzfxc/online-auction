import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { appendDescriptionSchema, createLotSchema, rejectLotSchema, updateLotSchema } from '@auction/shared';
import { Errors } from '../common/errors/app-error.js';
import type { LotDto, MyLotsResultDto, OwnLotDto, Principal } from '../lots/lots.js';
import { LotService } from '../lots/lots.js';
import { SalesService, type SaleDto } from '../sales/sales.js';
import { CurrentUser, Public, Roles } from './auth.js';
import { ApiErrors, ZBody, ZQuery, ZResponse, ZUuidParam } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { lotEventSchema, lotSchema, myLotsQuerySchema, myLotsResultSchema, ownLotSchema, saleSchema } from './schemas.js';

const id = 'id';

@ApiTags('lots')
@ApiBearerAuth()
@Controller('lots')
export class LotsController {
  constructor(
    @Inject(LotService) private readonly lots: LotService,
    @Inject(SalesService) private readonly sales: SalesService,
  ) {}

  @Roles('seller')
  @Post()
  @ApiOperation({ operationId: 'createLot', summary: 'Create a draft lot (seller)' })
  @ZBody(createLotSchema)
  @ZResponse(201, ownLotSchema, 'Draft created')
  @ApiErrors(400, 401, 403)
  create(@CurrentUser() user: Principal | null, @Body() body: unknown): Promise<OwnLotDto> {
    return this.lots.create(user!, body);
  }

  @Roles('seller')
  @Get('mine')
  @ApiOperation({ operationId: 'listMyLots', summary: 'Seller lots filtered by status, plus pending and completed payout totals' })
  @ZQuery(myLotsQuerySchema)
  @ZResponse(200, myLotsResultSchema)
  @ApiErrors(400, 401, 403)
  mine(@CurrentUser() user: Principal | null, @Query() query: unknown): Promise<MyLotsResultDto> {
    const q = myLotsQuerySchema.safeParse(query);
    if (!q.success) throw Errors.validation(q.error.issues);
    return this.lots.listMine(user!, q.data.status);
  }

  @Roles('buyer', 'seller')
  @Get('participating')
  @ApiOperation({ operationId: 'listParticipatingLots', summary: 'Public lots where the caller has placed bids' })
  @ZResponse(200, z.array(lotSchema))
  @ApiErrors(401, 403)
  participating(@CurrentUser() user: Principal | null): Promise<LotDto[]> {
    return this.lots.listParticipating(user!);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ operationId: 'getLot', summary: 'Lot details; unpublished lots only for owner/moderators' })
  @ZUuidParam('id')
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 404)
  get(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<LotDto> {
    return this.lots.get(user, lotId);
  }

  @Roles('buyer', 'seller')
  @Get(':id/sale')
  @ApiOperation({ operationId: 'getLotSale', summary: 'Current/latest sale for a lot (visible to the buyer or seller)' })
  @ZUuidParam('id')
  @ZResponse(200, saleSchema.nullable())
  @ApiErrors(400, 401, 403, 404)
  getSale(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<SaleDto | null> {
    return this.sales.getLotSale(user!, lotId);
  }

  @Roles('seller')
  @Patch(':id')
  @ApiOperation({ operationId: 'updateLot', summary: 'Edit a draft, or append to the description of a published lot' })
  @ZUuidParam('id')
  @ZBody(updateLotSchema.or(appendDescriptionSchema))
  @ZResponse(200, ownLotSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422)
  update(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string, @Body() body: unknown): Promise<OwnLotDto> {
    return this.lots.update(user!, lotId, body);
  }

  @Roles('seller')
  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({ operationId: 'submitLot', summary: 'Send a draft to moderation' })
  @ZUuidParam('id')
  @ZResponse(200, ownLotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  submit(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<OwnLotDto> {
    return this.lots.submit(user!, lotId);
  }

  @Roles('seller')
  @Post(':id/reopen')
  @HttpCode(200)
  @ApiOperation({ operationId: 'reopenLot', summary: 'Return a rejected or ended_unsold lot to draft' })
  @ZUuidParam('id')
  @ZResponse(200, ownLotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  reopen(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<OwnLotDto> {
    return this.lots.reviseRejected(user!, lotId);
  }

  @Roles('moderator')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ operationId: 'approveLot', summary: 'Publish a lot (moderator)' })
  @ZUuidParam('id')
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  approve(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<LotDto> {
    return this.lots.approve(user!, lotId);
  }

  @Roles('moderator')
  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ operationId: 'rejectLot', summary: 'Reject a lot with a reason (moderator)' })
  @ZUuidParam('id')
  @ZBody(rejectLotSchema)
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  reject(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string, @Body() body: unknown): Promise<LotDto> {
    return this.lots.reject(user!, lotId, body);
  }

  @Roles('seller', 'moderator')
  @Get(':id/history')
  @ApiOperation({ operationId: 'getLotHistory', summary: 'Lot event history (owner/moderators)' })
  @ZUuidParam('id')
  @ZResponse(200, z.array(lotEventSchema))
  @ApiErrors(400, 401, 403, 404)
  async history(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<z.infer<typeof lotEventSchema>[]> {
    const rows = await this.lots.history(user!, lotId);
    return rows.map((r) => ({
      id: r.id, type: r.type, actorId: r.actorId, payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
