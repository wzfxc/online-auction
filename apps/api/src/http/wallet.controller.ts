import { Body, Controller, Get, Headers, Inject, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { getBalance } from '../ledger/wallet.js';
import type { Principal } from '../lots/lots.js';
import { PaymentService } from '../payments/payments.js';
import { CurrentUser, Roles } from './auth.js';
import { ApiErrors, IdempotencyKeyHeader, ZBody, ZResponse } from './openapi-helpers.js';
import { requireIdempotencyKey } from './pipes.js';
import { balanceSchema, topUpRequestSchema, topUpResponseSchema } from './schemas.js';
import { DB } from './tokens.js';

@ApiTags('wallet')
@ApiBearerAuth()
@Roles('buyer', 'seller')
@Controller('wallet')
export class WalletController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PaymentService) private readonly payments: PaymentService,
  ) {}

  /** Only ever the caller's own wallet: the user id comes from the token, never from the URL. */
  @Get()
  @ApiOperation({ operationId: 'getWallet', summary: 'Own balance: available and held (deposits)' })
  @ZResponse(200, balanceSchema)
  @ApiErrors(401, 403)
  getWallet(@CurrentUser() user: Principal | null): Promise<z.infer<typeof balanceSchema>> {
    return this.db.transaction((tx) => getBalance(tx, user!.id));
  }

  @Post('top-ups')
  @ApiOperation({ operationId: 'createTopUp', summary: 'Start a top-up through the payment stub' })
  @IdempotencyKeyHeader()
  @ZBody(topUpRequestSchema)
  @ZResponse(201, topUpResponseSchema, 'Payment created; send the user to payUrl')
  @ApiErrors(400, 401, 403, 409, 422)
  async topUp(
    @CurrentUser() user: Principal | null,
    @Headers('idempotency-key') key: string | undefined,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof topUpResponseSchema>> {
    const p = topUpRequestSchema.safeParse(raw);
    if (!p.success) throw Errors.validation(p.error.issues);
    const r = await this.payments.createTopUp(user!.id, p.data.amount, requireIdempotencyKey(key));
    res.status(r.status).setHeader('Idempotency-Replayed', String(r.replayed));
    return r.body;
  }
}
