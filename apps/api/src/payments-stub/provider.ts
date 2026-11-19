import { and, eq, isNull } from 'drizzle-orm';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { paymentStubSessions } from '../db/schema.js';
import { signWebhook } from './signature.js';

export type ProviderStatus = 'pending' | 'succeeded' | 'failed' | 'expired';
export type StubMode = 'none' | 'chaos';
export type PayerAction = 'success' | 'fail' | 'close';

export interface WebhookEvent {
  providerEventId: string;
  paymentId: string;
  type: 'payment.succeeded' | 'payment.failed';
}

export interface PaymentProvider {
  createSession(paymentId: string, amount: number): { payUrl: string } | Promise<{ payUrl: string }>;
  /** Authoritative status; the reconciler relies on it when a webhook never arrives. */
  getStatus(paymentId: string): ProviderStatus | Promise<ProviderStatus>;
}

export interface DeliveredWebhook {
  body: string;
  signature: string;
}

export interface StubDeps {
  clock: Clock;
  secret: string;
  mode: StubMode;
  baseUrl: string;
  /** Optional database handle so multiple API replicas and the worker share stub sessions (D25). */
  db?: Db;
  /** Sends a signed webhook to the API; failures are the caller's concern. */
  deliver: (hook: DeliveredWebhook) => Promise<void>;
  /** Defers a delivery by `ms`; injectable so tests need no real timers. */
  schedule: (task: () => Promise<void>, ms: number) => void;
  /** Uniform [0, 1); injectable for deterministic chaos in tests. */
  random: () => number;
}

export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_CHAOS_DELAY_MS = 60_000;

interface Session {
  amount: number;
  createdAt: Date;
  outcome: 'succeeded' | 'failed' | null;
}

export interface StubSessionDto {
  paymentId: string;
  amount: number;
  status: ProviderStatus;
}

/** Fake gateway: the payer picks an outcome, the stub reports it by signed webhook, optionally in chaos mode. */
export class StubPaymentProvider implements PaymentProvider {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: StubDeps) {}

  createSession(paymentId: string, amount: number): { payUrl: string } | Promise<{ payUrl: string }> {
    const now = this.deps.clock.now();
    if (!this.sessions.has(paymentId)) {
      this.sessions.set(paymentId, { amount, createdAt: now, outcome: null });
    }
    const payUrl = `${this.deps.baseUrl}/payments-stub/pay/${paymentId}`;
    if (!this.deps.db) return { payUrl };
    return this.deps.db
      .insert(paymentStubSessions)
      .values({ paymentId, amount, outcome: null, createdAt: now })
      .onConflictDoNothing()
      .then(() => ({ payUrl }));
  }

  getStatus(paymentId: string): ProviderStatus | Promise<ProviderStatus> {
    if (!this.deps.db) return this.statusFromMemory(paymentId);
    return this.loadSession(paymentId).then((s) => this.computeStatus(s));
  }

  async getSession(paymentId: string): Promise<StubSessionDto | null> {
    const s = await this.loadSession(paymentId);
    if (!s) return null;
    return { paymentId, amount: s.amount, status: this.computeStatus(s) };
  }

  /** The payer's button press. "close" sends nothing and leaves the session pending. */
  resolve(paymentId: string, action: PayerAction): void | Promise<void> {
    if (!this.deps.db) {
      this.resolveInMemory(paymentId, action);
      return;
    }
    return this.resolveInDb(paymentId, action);
  }

  private statusFromMemory(paymentId: string): ProviderStatus {
    return this.computeStatus(this.sessions.get(paymentId) ?? null);
  }

  private computeStatus(s: Session | null): ProviderStatus {
    if (!s) return 'expired';
    if (s.outcome) return s.outcome;
    const age = this.deps.clock.now().getTime() - s.createdAt.getTime();
    return age >= SESSION_TTL_MS ? 'expired' : 'pending';
  }

  private async loadSession(paymentId: string): Promise<Session | null> {
    if (this.deps.db) {
      const [row] = await this.deps.db
        .select()
        .from(paymentStubSessions)
        .where(eq(paymentStubSessions.paymentId, paymentId));
      if (row) {
        const s: Session = {
          amount: row.amount,
          createdAt: row.createdAt,
          outcome: (row.outcome as Session['outcome']) ?? null,
        };
        this.sessions.set(paymentId, s);
        return s;
      }
    }
    return this.sessions.get(paymentId) ?? null;
  }

  private resolveInMemory(paymentId: string, action: PayerAction): void {
    const s = this.sessions.get(paymentId);
    if (!s || s.outcome || action === 'close') return;
    s.outcome = action === 'success' ? 'succeeded' : 'failed';
    const type = s.outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed';
    this.emit(paymentId, [type]);
  }

  private async resolveInDb(paymentId: string, action: PayerAction): Promise<void> {
    if (action === 'close') return;
    const outcome: 'succeeded' | 'failed' = action === 'success' ? 'succeeded' : 'failed';
    const updated = await this.deps.db!
      .update(paymentStubSessions)
      .set({ outcome })
      .where(and(eq(paymentStubSessions.paymentId, paymentId), isNull(paymentStubSessions.outcome)))
      .returning({ paymentId: paymentStubSessions.paymentId });
    if (updated.length === 0) {
      this.resolveInMemory(paymentId, action);
      return;
    }
    const cached = this.sessions.get(paymentId);
    if (cached) cached.outcome = outcome;
    const type = outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed';
    this.emit(paymentId, [type]);
  }

  private event(paymentId: string, type: WebhookEvent['type']): DeliveredWebhook {
    // Stable id per (payment, type): a re-sent event is a true duplicate.
    const evt: WebhookEvent = { providerEventId: `evt_${paymentId}_${type}`, paymentId, type };
    const body = JSON.stringify(evt);
    return { body, signature: signWebhook(body, this.deps.secret) };
  }

  private emit(paymentId: string, types: WebhookEvent['type'][]): void {
    const hooks = types.map((t) => this.event(paymentId, t));
    if (this.deps.mode === 'none') {
      for (const h of hooks) this.deps.schedule(() => this.deps.deliver(h), 0);
      return;
    }
    this.emitChaotic(paymentId, hooks);
  }

  private emitChaotic(paymentId: string, hooks: DeliveredWebhook[]): void {
    const first = hooks[0];
    if (!first) return;
    const roll = Math.floor(this.deps.random() * 4);
    const delay = () => Math.floor(this.deps.random() * MAX_CHAOS_DELAY_MS);
    if (roll === 0) return; // dropped: only reconciliation can find it
    if (roll === 1) {
      this.deps.schedule(() => this.deps.deliver(first), 0);
      this.deps.schedule(() => this.deps.deliver(first), delay()); // duplicate
      return;
    }
    if (roll === 2) {
      this.deps.schedule(() => this.deps.deliver(first), delay()); // late
      return;
    }
    // Out of order: the success is followed by a bogus "failed" for the same payment.
    this.deps.schedule(() => this.deps.deliver(first), 0);
    const stale = this.event(paymentId, 'payment.failed');
    this.deps.schedule(() => this.deps.deliver(stale), delay());
  }
}
