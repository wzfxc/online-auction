import { describe, expect, it } from 'vitest';
import { FakeClock } from '../common/clock/clock.js';
import { SESSION_TTL_MS, StubPaymentProvider, type DeliveredWebhook, type StubMode } from './provider.js';
import { signWebhook, verifyWebhookSignature } from './signature.js';

const SECRET = 'test-secret';

function capture(mode: StubMode, rolls: number[]) {
  const sent: DeliveredWebhook[] = [];
  const clock = new FakeClock();
  const queue = [...rolls];
  const provider = new StubPaymentProvider({
    clock, secret: SECRET, mode, baseUrl: 'http://stub',
    random: () => queue.shift() ?? 0,
    deliver: async (h) => {
      sent.push(h);
    },
    schedule: (task) => {
      void task();
    },
  });
  return { clock, provider, sent };
}

describe('webhook signature', () => {
  it('accepts a correct signature and rejects wrong, missing or tampered ones', () => {
    const sig = signWebhook('{"a":1}', SECRET);
    expect(verifyWebhookSignature('{"a":1}', sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature('{"a":2}', sig, SECRET)).toBe(false);
    expect(verifyWebhookSignature('{"a":1}', sig, 'other')).toBe(false);
    expect(verifyWebhookSignature('{"a":1}', undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature('{"a":1}', 'short', SECRET)).toBe(false);
  });
});

describe('stub provider', () => {
  it('sends one signed webhook on success in normal mode', async () => {
    const { provider, sent } = capture('none', []);
    provider.createSession('p1', 1000);
    provider.resolve('p1', 'success');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(verifyWebhookSignature(sent[0]!.body, sent[0]!.signature, SECRET)).toBe(true);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: 'payment.succeeded', paymentId: 'p1' });
    expect(provider.getStatus('p1')).toBe('succeeded');
  });

  it('"close" sends nothing and leaves the payment pending until the session expires', async () => {
    const { provider, sent, clock } = capture('none', []);
    provider.createSession('p1', 1000);
    provider.resolve('p1', 'close');
    await Promise.resolve();
    expect(sent).toHaveLength(0);
    expect(provider.getStatus('p1')).toBe('pending');
    clock.advance(SESSION_TTL_MS);
    expect(provider.getStatus('p1')).toBe('expired');
  });

  it('chaos roll 0 drops the webhook but the status API still tells the truth', async () => {
    const { provider, sent } = capture('chaos', [0]);
    provider.createSession('p1', 1000);
    provider.resolve('p1', 'success');
    await Promise.resolve();
    expect(sent).toHaveLength(0);
    expect(provider.getStatus('p1')).toBe('succeeded');
  });

  it('chaos roll 1 delivers the same event id twice', async () => {
    const { provider, sent } = capture('chaos', [0.25, 0.5]);
    provider.createSession('p1', 1000);
    provider.resolve('p1', 'success');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toBe(sent[1]!.body);
  });

  it('chaos roll 3 follows success with a stale "failed"', async () => {
    const { provider, sent } = capture('chaos', [0.75, 0.5]);
    provider.createSession('p1', 1000);
    provider.resolve('p1', 'success');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((s) => JSON.parse(s.body).type)).toEqual(['payment.succeeded', 'payment.failed']);
  });

  it('ignores a second resolve', async () => {
    const { provider, sent } = capture('none', []);
    provider.createSession('p1', 1000);
    provider.resolve('p1', 'success');
    provider.resolve('p1', 'fail');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
  });
});
