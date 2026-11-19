import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { rejectLotSchema } from '@auction/shared';
import type { LotDto, Principal } from '../lots/lots.js';
import { ModerationService } from '../moderation/moderation.js';
import { CurrentUser, Roles } from './auth.js';
import { ApiErrors, ZBody, ZResponse } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { lotSchema } from './schemas.js';

@ApiTags('moderation')
@ApiBearerAuth()
@Roles('moderator')
@Controller('moderation')
export class ModerationController {
  constructor(@Inject(ModerationService) private readonly moderation: ModerationService) {}

  /** A null body means the queue is empty. */
  @Post('claim')
  @HttpCode(200)
  @ApiOperation({ operationId: 'claimNextLot', summary: 'Take the next lot from the review queue (15 min lease)' })
  @ZResponse(200, lotSchema.nullable(), 'Claimed lot, or null when the queue is empty')
  @ApiErrors(401, 403)
  claim(@CurrentUser() user: Principal | null): Promise<LotDto | null> {
    return this.moderation.claimNext(user!);
  }

  @Post('lots/:id/remove')
  @HttpCode(200)
  @ApiOperation({ operationId: 'removeLot', summary: 'Take a published lot down; deposits are released' })
  @ZBody(rejectLotSchema)
  @ZResponse(200, lotSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  remove(@CurrentUser() user: Principal | null, @Param('id', UuidPipe) lotId: string, @Body() body: unknown): Promise<LotDto> {
    return this.moderation.removeLot(user!, lotId, body);
  }
}
