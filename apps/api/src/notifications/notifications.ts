import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { ENDING_REMINDER_MINUTES, OUTBID_EMAIL_INTERVAL_MINUTES } from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { emailOutbox, favorites, lots, notifications, users } from '../db/schema.js';
import type { Tx } from '../ledger/ledger.js';

const MINUTE_MS = 60_000;
const EMAIL_BATCH = 50;
const REMINDER_BATCH = 200;
const MAX_PAGE = 100;

export interface NotificationDto {
  id: string;
  type: string;
  payload: unknown;
  read: boolean;
  createdAt: string;
}

/** Transport for outgoing mail. The real one is an SMTP stub; tests substitute their own. */
export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

export interface OutbidNotice {
  userId: string;
  lotId: string;
  lotTitle: string;
  seq: number;
  currentPrice: number;
}

/**
 * Called inside the bid transaction (which holds the lot row lock), so the 15-minute check below cannot race
 * with another outbid of the same user on the same lot. The in-app notice is always written; the email only
 * when none was queued for this (user, lot) in the last 15 minutes. Payloads never carry the reserve price.
 */
export async function notifyOutbid(tx: Tx, now: Date, n: OutbidNotice): Promise<void> {
  await tx.insert(notifications).values({
    userId: n.userId, type: 'outbid', createdAt: now,
    payload: { lotId: n.lotId, lotTitle: n.lotTitle, currentPrice: n.currentPrice },
    dedupeKey: `outbid:${n.lotId}:${n.seq}:${n.userId}`,
  }).onConflictDoNothing();

  const since = new Date(now.getTime() - OUTBID_EMAIL_INTERVAL_MINUTES * MINUTE_MS);
  const [recent] = await tx.select({ id: emailOutbox.id }).from(emailOutbox)
    .where(and(eq(emailOutbox.userId, n.userId), eq(emailOutbox.lotId, n.lotId),
      eq(emailOutbox.kind, 'outbid'), gt(emailOutbox.createdAt, since)))
    .limit(1);
  if (recent) return;
  await tx.insert(emailOutbox).values({
    userId: n.userId, lotId: n.lotId, kind: 'outbid', createdAt: now,
    subject: `Вашу ставку перебито: ${n.lotTitle}`,
    body: `На лот «${n.lotTitle}» зроблено вищу ставку. Поточна ціна: ${(n.currentPrice / 100).toFixed(2)} ₴.`,
    dedupeKey: `outbid:${n.lotId}:${n.seq}:${n.userId}`,
  }).onConflictDoNothing();
}

export class NotificationService {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly sender: EmailSender) {}

  /** The user's own notices, newest first. Scoped by user id in SQL, so nobody reads another user's inbox. */
  async list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationDto[]> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), MAX_PAGE);
    const where = opts.unreadOnly
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
      : eq(notifications.userId, userId);
    const rows = await this.db.select().from(notifications).where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit);
    return rows.map((r) => ({
      id: r.id, type: r.type, payload: r.payload, read: r.readAt !== null, createdAt: r.createdAt.toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.n ?? 0;
  }

  /** Marks the given notices (or all, when `ids` is omitted) as read; foreign ids are silently ignored. */
  async markRead(userId: string, ids?: string[]): Promise<number> {
    const base = and(eq(notifications.userId, userId), isNull(notifications.readAt));
    const where = ids ? and(base, inArray(notifications.id, ids)) : base;
    const rows = await this.db.update(notifications).set({ readAt: this.clock.now() }).where(where)
      .returning({ id: notifications.id });
    return rows.length;
  }

  /**
   * One reminder per (user, favourite lot) when the lot ends within the hour. The compare-and-set on
   * `reminder_sent_at` makes parallel workers and repeated runs produce exactly one notice and one email.
   */
  async sendEndingReminders(): Promise<number> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + ENDING_REMINDER_MINUTES * MINUTE_MS);
    const due = await this.db.select({ userId: favorites.userId, lotId: favorites.lotId }).from(favorites)
      .innerJoin(lots, eq(lots.id, favorites.lotId))
      .where(and(isNull(favorites.reminderSentAt), eq(lots.status, 'active'), gt(lots.endsAt, now), lte(lots.endsAt, horizon)))
      .orderBy(asc(lots.endsAt)).limit(REMINDER_BATCH);

    let sent = 0;
    for (const { userId, lotId } of due) {
      sent += await this.db.transaction(async (tx) => {
        const claimed = await tx.update(favorites).set({ reminderSentAt: now })
          .where(and(eq(favorites.userId, userId), eq(favorites.lotId, lotId), isNull(favorites.reminderSentAt)))
          .returning({ lotId: favorites.lotId });
        if (claimed.length === 0) return 0;
        const [lot] = await tx.select({ title: lots.title, endsAt: lots.endsAt, currentPrice: lots.currentPrice })
          .from(lots).where(eq(lots.id, lotId));
        if (!lot?.endsAt) return 0;
        const key = `reminder:${lotId}:${userId}`;
        await tx.insert(notifications).values({
          userId, type: 'ending_soon', createdAt: now, dedupeKey: key,
          payload: { lotId, lotTitle: lot.title, endsAt: lot.endsAt.toISOString(), currentPrice: lot.currentPrice },
        }).onConflictDoNothing();
        await tx.insert(emailOutbox).values({
          userId, lotId, kind: 'reminder', createdAt: now, dedupeKey: key,
          subject: `Лот «${lot.title}» скоро завершується`,
          body: `До завершення лота «${lot.title}» залишилось менш як ${ENDING_REMINDER_MINUTES} хв.`,
        }).onConflictDoNothing();
        return 1;
      });
    }
    return sent;
  }

  /**
   * Delivers queued mail. Rows are claimed with SKIP LOCKED, so several workers never send the same letter;
   * a failed send leaves the row unsent for the next pass.
   */
  async drainEmails(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const batch = await tx.select({ id: emailOutbox.id, subject: emailOutbox.subject, body: emailOutbox.body, to: users.email })
        .from(emailOutbox).innerJoin(users, eq(users.id, emailOutbox.userId))
        .where(isNull(emailOutbox.sentAt)).orderBy(asc(emailOutbox.id)).limit(EMAIL_BATCH)
        .for('update', { of: emailOutbox, skipLocked: true });
      const delivered: number[] = [];
      for (const mail of batch) {
        try {
          await this.sender.send(mail.to, mail.subject, mail.body);
          delivered.push(mail.id);
        } catch {
          // Transport failure: keep the row unsent; it is retried on the next drain.
        }
      }
      if (delivered.length > 0) {
        await tx.update(emailOutbox).set({ sentAt: this.clock.now() }).where(inArray(emailOutbox.id, delivered));
      }
      return delivered.length;
    });
  }
}
