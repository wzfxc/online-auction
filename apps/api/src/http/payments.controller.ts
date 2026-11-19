import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';
import { PaymentService } from '../payments/payments.js';
import { StubPaymentProvider } from '../payments-stub/provider.js';
import { SIGNATURE_HEADER } from '../payments-stub/signature.js';
import { Public } from './auth.js';
import { ApiErrors, ZBody, ZResponse } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { payerActionSchema, webhookAckSchema } from './schemas.js';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(StubPaymentProvider) private readonly stub: StubPaymentProvider,
  ) {}

  /** Authenticated by the HMAC over the exact request bytes, not by a user token. */
  @Public()
  @Post('payments/webhook')
  @HttpCode(200)
  @ApiOperation({ operationId: 'paymentWebhook', summary: 'Payment provider webhook (signed)' })
  @ZResponse(200, webhookAckSchema)
  @ApiErrors(400, 401, 404)
  webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers(SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<z.infer<typeof webhookAckSchema>> {
    if (!req.rawBody) throw Errors.validation({ body: 'raw body is required' });
    return this.payments.handleWebhook(req.rawBody.toString('utf8'), signature);
  }

  /** The payer's button on the stub gateway page. */
  @Public()
  @Post('payments-stub/pay/:paymentId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'stubPay', summary: 'Payment stub: the payer picks an outcome' })
  @ZBody(payerActionSchema)
  @ApiErrors(400)
  pay(@Param('paymentId', UuidPipe) paymentId: string, @Body() raw: unknown): void {
    const p = payerActionSchema.safeParse(raw);
    if (!p.success) throw Errors.validation(p.error.issues);
    this.stub.resolve(paymentId, p.data.action);
  }
}
