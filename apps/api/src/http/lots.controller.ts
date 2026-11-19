import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { appendDescriptionSchema, createLotSchema, rejectLotSchema, updateLotSchema } from '@auction/shared';
import type { LotDto, OwnLotDto, Principal } from '../lots/lots.js';
import { LotService } from '../lots/lots.js';
import { CurrentUser, Public, Roles } from './auth.js';
import { ApiErrors, ZBody, ZResponse } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { lotEventSchema, lotSchema, ownLotSchema } from './schemas.js';

const id = 'id';

@ApiTags('lots')
@ApiBearerAuth()
@Controller('lots')
export class LotsController {
  constructor(@Inject(LotService) private readonly lots: LotService) {}

  @Roles('seller')
  @Post()
  @ApiOperation({ operationId: 'createLot', summary: 'Create a draft lot (seller)' })
  @ZBody(createLotSchema)
  @ZResponse(201, ownLotSchema, 'Draft created')
  @ApiErrors(400, 401, 403)
  create(@CurrentUser() user: Principal | null, @Body() body: unknown): Promise<OwnLotDto> {
    return this.lots.create(user!, body);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ operationId: 'getLot', summary: 'Lot details; unpublished lots only for owner/moderators' })
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 404)
  get(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<LotDto> {
    return this.lots.get(user, lotId);
  }

  @Roles('seller')
  @Patch(':id')
  @ApiOperation({ operationId: 'updateLot', summary: 'Edit a draft, or append to the description of a published lot' })
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
  @ZResponse(200, ownLotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  submit(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<OwnLotDto> {
    return this.lots.submit(user!, lotId);
  }

  @Roles('seller')
  @Post(':id/reopen')
  @HttpCode(200)
  @ApiOperation({ operationId: 'reopenLot', summary: 'Return a rejected lot to draft' })
  @ZResponse(200, ownLotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  reopen(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<OwnLotDto> {
    return this.lots.reviseRejected(user!, lotId);
  }

  @Roles('moderator')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ operationId: 'approveLot', summary: 'Publish a lot (moderator)' })
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  approve(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string): Promise<LotDto> {
    return this.lots.approve(user!, lotId);
  }

  @Roles('moderator')
  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ operationId: 'rejectLot', summary: 'Reject a lot with a reason (moderator)' })
  @ZBody(rejectLotSchema)
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  reject(@CurrentUser() user: Principal | null, @Param(id, UuidPipe) lotId: string, @Body() body: unknown): Promise<LotDto> {
    return this.lots.reject(user!, lotId, body);
  }

  @Roles('seller', 'moderator')
  @Get(':id/history')
  @ApiOperation({ operationId: 'getLotHistory', summary: 'Lot event history (owner/moderators)' })
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
