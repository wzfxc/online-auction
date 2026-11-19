import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Errors } from '../common/errors/app-error.js';
import { PaymentService } from '../payments/payments.js';
import { StubPaymentProvider, type StubSessionDto } from '../payments-stub/provider.js';
import { SIGNATURE_HEADER } from '../payments-stub/signature.js';
import { Public } from './auth.js';
import { ApiErrors, ZBody, ZResponse, ZUuidParam } from './openapi-helpers.js';
import { UuidPipe } from './pipes.js';
import { SkipThrottle } from './rate-limit.js';
import { payerActionSchema, stubSessionSchema, webhookAckSchema } from './schemas.js';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(StubPaymentProvider) private readonly stub: StubPaymentProvider,
  ) {}

  /** Authenticated by the HMAC over the exact request bytes, not by a user token. */
  @Public()
  @SkipThrottle()
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

  /** Inspects a stub payment session (shared across replicas). */
  @Public()
  @Get('payments-stub/sessions/:paymentId')
  @ApiOperation({ operationId: 'getStubSession', summary: 'Payment stub session details' })
  @ZUuidParam('paymentId')
  @ZResponse(200, stubSessionSchema)
  @ApiErrors(400, 404)
  async getSession(@Param('paymentId', UuidPipe) paymentId: string): Promise<StubSessionDto> {
    const s = await this.stub.getSession(paymentId);
    if (!s) throw Errors.notFound('Payment session');
    return s;
  }

  /** Standalone payment stub page with "Success", "Fail", and "Close without answer" buttons. */
  @Public()
  @Get('payments-stub/pay/:paymentId')
  @ApiOperation({ operationId: 'getStubPayPage', summary: 'HTML payment stub page' })
  @ZUuidParam('paymentId')
  @ApiErrors(400, 404)
  async payPage(@Param('paymentId', UuidPipe) paymentId: string, @Res() res: Response): Promise<void> {
    const s = await this.stub.getSession(paymentId);
    if (!s) throw Errors.notFound('Payment session');
    const uah = (s.amount / 100).toFixed(2);
    const html = `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Платіжна заглушка — ${uah} ₴</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 48px auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; }
    .amount { font-size: 1.5rem; font-weight: 700; margin: 12px 0; }
    .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
    button { padding: 12px 16px; font-size: 1rem; border-radius: 8px; border: 1px solid #d1d5db; cursor: pointer; font-weight: 600; }
    button.success { background: #16a34a; color: #fff; border-color: #16a34a; }
    button.fail { background: #dc2626; color: #fff; border-color: #dc2626; }
    button.close { background: #f3f4f6; color: #1f2937; }
    #result { margin-top: 16px; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Платіжна заглушка</h1>
  <p>Платіж: <code data-testid="payment-id">${s.paymentId}</code></p>
  <p class="amount" data-testid="payment-amount">${uah} ₴</p>
  <p>Статус: <strong id="status" data-testid="payment-status">${s.status}</strong></p>
  <div class="actions">
    <button type="button" class="success" data-testid="pay-success" ${s.status !== 'pending' ? 'disabled' : ''} onclick="act('success')">Успех / Успіх / Success</button>
    <button type="button" class="fail" data-testid="pay-fail" ${s.status !== 'pending' ? 'disabled' : ''} onclick="act('fail')">Отказ / Відмова / Fail</button>
    <button type="button" class="close" data-testid="pay-close" ${s.status !== 'pending' ? 'disabled' : ''} onclick="act('close')">Закрыть без ответа / Закрити без відповіді</button>
  </div>
  <p id="result" role="status" aria-live="polite"></p>
  <script>
    async function act(action) {
      const res = await fetch('/payments-stub/pay/${s.paymentId}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const el = document.getElementById('result');
      const st = document.getElementById('status');
      if (res.ok) {
        st.textContent = action === 'success' ? 'succeeded' : action === 'fail' ? 'failed' : 'pending';
        el.textContent = action === 'success' ? 'Оплату підтверджено' : action === 'fail' ? 'Оплату відхилено' : 'Закрито без відповіді';
        const ret = new URLSearchParams(window.location.search).get('returnUrl');
        if (ret) window.location.href = ret;
      } else {
        el.textContent = 'Помилка';
      }
    }
  </script>
</body>
</html>`;
    res.status(200).type('text/html; charset=utf-8').send(html);
  }

  /** The payer's button on the stub gateway page. */
  @Public()
  @Post('payments-stub/pay/:paymentId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'stubPay', summary: 'Payment stub: the payer picks an outcome' })
  @ZUuidParam('paymentId')
  @ZBody(payerActionSchema)
  @ApiErrors(400, 404, 409)
  async pay(@Param('paymentId', UuidPipe) paymentId: string, @Body() raw: unknown): Promise<void> {
    const p = payerActionSchema.safeParse(raw);
    if (!p.success) throw Errors.validation(p.error.issues);
    const outcome = await this.stub.resolve(paymentId, p.data.action);
    if (outcome === 'not_found') throw Errors.notFound('Payment session');
    if (outcome === 'expired') throw Errors.conflict('PAYMENT_SESSION_EXPIRED', 'Payment session has expired');
  }
}
