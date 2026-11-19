import { and, eq, lte } from 'drizzle-orm';
import { assertKopecks } from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import { withIdempotency, type StoredResponse } from '../common/idempotency/idempotency.js';
import type { Db } from '../db/client.js';
import { paymentWebhookEvents, payments } from '../db/schema.js';
import type { Tx } from '../ledger/ledger.js';
import { topUp } from '../ledger/wallet.js';
import type { PaymentProvider, ProviderStatus, WebhookEvent } from '../payments-stub/provider.js';
import { verifyWebhookSignature } from '../payments-stub/signature.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECONCILE_GRACE_MS = 60_000;
export const RECONCILE_BATCH = 100;

export interface CreatedPayment {
  paymentId: string;
  amount: number;
  payUrl: string;
}

export interface SettleResult {
  /** Status after the call. */
  status: ProviderStatus;
  /** true only for the call that actually credited the wallet. */
  credited: boolean;
}

/**
 * Applies a provider outcome to a payment under a row lock (D19).
 * `succeeded` is terminal and wins over any later `failed`/`expired`; it credits the wallet exactly once
 * (the `topup:<paymentId>` effectKey backs this up). `failed`/`expired` only apply to a pending payment.
 */
export async function settlePayment(
  tx: Tx,
  paymentId: string,
  outcome: Exclude<ProviderStatus, 'pending'>,
  now: Date,
): Promise<SettleResult> {
  const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
  if (!p) throw Errors.notFound('Payment');
  if (p.status === 'succeeded') return { status: 'succeeded', credited: false };

  if (outcome === 'succeeded') {
    const posted = await topUp(tx, p.userId, p.amount, `topup:${p.id}`);
    await tx.update(payments).set({ status: 'succeeded', settledAt: now }).where(eq(payments.id, p.id));
    return { status: 'succeeded', credited: posted.applied };
  }
  if (p.status !== 'pending') return { status: p.status, credited: false };
  await tx.update(payments).set({ status: outcome, settledAt: now }).where(eq(payments.id, p.id));
  return { status: outcome, credited: false };
}

export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly provider: PaymentProvider,
    private readonly webhookSecret: string,
  ) {}

  /** Starts a top-up; the same Idempotency-Key returns the same payment (invariant 7). */
  createTopUp(userId: string, amount: number, idempotencyKey: string): Promise<StoredResponse<CreatedPayment>> {
    assertKopecks(amount);
    if (amount <= 0) throw Errors.validation({ amount: 'must be positive' });
    return withIdempotency(
      this.db,
      { userId, scope: 'topup', key: idempotencyKey, body: { amount } },
      async (tx) => {
        const [p] = await tx.insert(payments).values({ userId, amount, createdAt: this.clock.now() }).returning({ id: payments.id });
        if (!p) throw new Error('Payment insert returned no row');
        const { payUrl } = this.provider.createSession(p.id, amount);
        return { status: 201, body: { paymentId: p.id, amount, payUrl } };
      },
    );
  }

  /**
   * Webhook entry point. Bad signature → 401 and nothing is read from the body.
   * A repeated `providerEventId` is acknowledged without effect.
   */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ duplicate: boolean }> {
    if (!verifyWebhookSignature(rawBody, signature, this.webhookSecret)) {
      throw Errors.unauthorized('Invalid webhook signature');
    }
    const event = parseEvent(rawBody);
    return this.db.transaction(async (tx) => {
      const [payment] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.id, event.paymentId));
      if (!payment) throw Errors.notFound('Payment');
      const inserted = await tx
        .insert(paymentWebhookEvents)
        .values({ providerEventId: event.providerEventId, paymentId: event.paymentId, type: event.type })
        .onConflictDoNothing()
        .returning({ id: paymentWebhookEvents.providerEventId });
      if (inserted.length === 0) return { duplicate: true };
      const outcome = event.type === 'payment.succeeded' ? 'succeeded' : 'failed';
      await settlePayment(tx, event.paymentId, outcome, this.clock.now());
      return { duplicate: false };
    });
  }

  /** Finds pending payments whose webhook is overdue and settles them from the provider's status. */
  async reconcile(): Promise<{ checked: number; settled: number }> {
    const cutoff = new Date(this.clock.now().getTime() - RECONCILE_GRACE_MS);
    const stale = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.status, 'pending'), lte(payments.createdAt, cutoff)))
      .limit(RECONCILE_BATCH);
    let settled = 0;
    for (const { id } of stale) {
      const status = this.provider.getStatus(id);
      if (status === 'pending') continue;
      await this.db.transaction((tx) => settlePayment(tx, id, status, this.clock.now()));
      settled += 1;
    }
    return { checked: stale.length, settled };
  }
}

function parseEvent(rawBody: string): WebhookEvent {
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw Errors.validation({ body: 'not JSON' });
  }
  const e = data as Partial<WebhookEvent> | null;
  const typeOk = e?.type === 'payment.succeeded' || e?.type === 'payment.failed';
  if (!e || typeof e.providerEventId !== 'string' || typeof e.paymentId !== 'string' || !typeOk
    || !UUID_RE.test(e.paymentId)) {
    throw Errors.validation({ body: 'unexpected webhook shape' });
  }
  return { providerEventId: e.providerEventId, paymentId: e.paymentId, type: e.type as WebhookEvent['type'] };
}
