import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { canTransition, rejectLotSchema, REVIEW_LEASE_MINUTES } from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { bidderMaxes, bids, deposits, emailOutbox, lotEvents, lots, notifications } from '../db/schema.js';
import { releaseDeposit } from '../ledger/wallet.js';
import type { LotDto, Principal } from '../lots/lots.js';
import { toLotDto } from '../lots/lots.js';

const MINUTE_MS = 60_000;

export interface ReviewQueueItemDto {
  id: string;
  title: string;
  categoryId: string;
  startPrice: number;
  submittedAt: string;
  claimed: boolean;
  claimedByMe: boolean;
  leaseUntil: string | null;
}

/**
 * Review queue with leases. Claiming is `FOR UPDATE SKIP LOCKED`, so two moderators asking at once
 * never get the same lot; an unfinished lease expires by the server clock and the lot is claimable again.
 * Moderators never touch money directly: removal releases deposits through the same ledger code as closing.
 */
export class ModerationService {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** Gives the moderator a lot to review: their own live lease first, otherwise the oldest free one. */
  async claimNext(moderator: Principal): Promise<LotDto | null> {
    this.assertModerator(moderator);
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [own] = await tx.select().from(lots)
        .where(and(eq(lots.status, 'in_review'), eq(lots.moderatorId, moderator.id),
          sql`${lots.reviewLeaseUntil} > ${now}`))
        .orderBy(asc(lots.createdAt)).limit(1);
      if (own) return toLotDto(own, moderator);

      const [free] = await tx.select().from(lots)
        .where(and(eq(lots.status, 'in_review'),
          sql`(${lots.reviewLeaseUntil} is null or ${lots.reviewLeaseUntil} <= ${now})`))
        .orderBy(asc(lots.createdAt)).limit(1).for('update', { skipLocked: true });
      if (!free) return null;

      const leaseUntil = new Date(now.getTime() + REVIEW_LEASE_MINUTES * MINUTE_MS);
      const [row] = await tx.update(lots)
        .set({ moderatorId: moderator.id, reviewLeaseUntil: leaseUntil, updatedAt: now })
        .where(eq(lots.id, free.id)).returning();
      await tx.insert(lotEvents).values({
        lotId: free.id, actorId: moderator.id, type: 'review_claimed', createdAt: now,
        payload: { leaseUntil: leaseUntil.toISOString() },
      });
      return toLotDto(row!, moderator);
    });
  }

  /**
   * The review queue, oldest first, so a moderator can choose a lot. `claimedByMe` / `claimed` reflect live leases
   * only (an expired lease counts as free). Reserve prices are not part of the item.
   */
  async listQueue(moderator: Principal, limit = 50): Promise<ReviewQueueItemDto[]> {
    this.assertModerator(moderator);
    const now = this.clock.now();
    const rows = await this.db.select({
      id: lots.id, title: lots.title, categoryId: lots.categoryId, startPrice: lots.startPrice,
      createdAt: lots.createdAt, updatedAt: lots.updatedAt, moderatorId: lots.moderatorId,
      leaseUntil: lots.reviewLeaseUntil,
    }).from(lots).where(eq(lots.status, 'in_review')).orderBy(asc(lots.createdAt), asc(lots.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => {
      const live = r.leaseUntil !== null && r.leaseUntil.getTime() > now.getTime();
      return {
        id: r.id, title: r.title, categoryId: r.categoryId, startPrice: r.startPrice,
        submittedAt: r.updatedAt.toISOString(),
        claimed: live, claimedByMe: live && r.moderatorId === moderator.id,
        leaseUntil: live ? r.leaseUntil!.toISOString() : null,
      };
    });
  }

  /** Takes one specific lot from the queue (by id). Same lease rules as `claimNext`; a foreign live lease → 409. */
  async claimById(moderator: Principal, lotId: string): Promise<LotDto> {
    this.assertModerator(moderator);
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
      if (!lot || lot.status !== 'in_review') throw Errors.notFound('Lot in review');
      const live = lot.reviewLeaseUntil !== null && lot.reviewLeaseUntil.getTime() > now.getTime();
      if (live && lot.moderatorId !== moderator.id) {
        throw Errors.conflict('LOT_CLAIMED', 'Lot is being reviewed by another moderator');
      }
      const leaseUntil = new Date(now.getTime() + REVIEW_LEASE_MINUTES * MINUTE_MS);
      const [row] = await tx.update(lots)
        .set({ moderatorId: moderator.id, reviewLeaseUntil: leaseUntil, updatedAt: now })
        .where(eq(lots.id, lotId)).returning();
      await tx.insert(lotEvents).values({
        lotId, actorId: moderator.id, type: 'review_claimed', createdAt: now,
        payload: { leaseUntil: leaseUntil.toISOString(), byId: true },
      });
      return toLotDto(row!, moderator);
    });
  }

  /** Returns abandoned lots to the queue (clears the stale claim). Safe to run from any number of workers. */
  async releaseExpiredLeases(): Promise<number> {
    const now = this.clock.now();
    const expired = await this.db.select({ id: lots.id }).from(lots)
      .where(and(eq(lots.status, 'in_review'), isNotNull(lots.reviewLeaseUntil), lte(lots.reviewLeaseUntil, now)))
      .orderBy(asc(lots.reviewLeaseUntil)).limit(100);
    let released = 0;
    for (const { id } of expired) {
      released += await this.db.transaction(async (tx) => {
        const [lot] = await tx.select().from(lots).where(eq(lots.id, id)).for('update', { skipLocked: true });
        // Re-check under the lock: the moderator may have decided or renewed in the meantime.
        if (!lot || lot.status !== 'in_review' || lot.reviewLeaseUntil === null
          || lot.reviewLeaseUntil.getTime() > now.getTime()) return 0;
        await tx.update(lots).set({ moderatorId: null, reviewLeaseUntil: null, updatedAt: now }).where(eq(lots.id, id));
        await tx.insert(lotEvents).values({
          lotId: id, actorId: null, type: 'review_lease_expired', createdAt: now,
          payload: { moderatorId: lot.moderatorId },
        });
        return 1;
      });
    }
    return released;
  }

  /**
   * Takes a published lot down: bids are annulled (proxy maxima dropped so nobody can be offered the lot
   * later), every deposit is released in this same transaction, and affected bidders are recorded for notices.
   */
  async removeLot(moderator: Principal, lotId: string, raw: unknown): Promise<LotDto> {
    this.assertModerator(moderator);
    const parsed = rejectLotSchema.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
      if (!lot) throw Errors.notFound('Lot');
      if (!canTransition(lot.status, 'removed', 'moderator')) {
        throw Errors.conflict('INVALID_LOT_TRANSITION', `Cannot move lot from ${lot.status} to removed`, { from: lot.status, to: 'removed' });
      }
      const held = await tx.select({ userId: deposits.userId }).from(deposits)
        .where(and(eq(deposits.lotId, lotId), sql`${deposits.amount} > 0`)).orderBy(asc(deposits.userId));
      for (const { userId } of held) await releaseDeposit(tx, userId, lotId, now);
      await tx.delete(bidderMaxes).where(eq(bidderMaxes.lotId, lotId));

      const bidderRows = await tx.selectDistinct({ userId: bids.userId }).from(bids).where(eq(bids.lotId, lotId));
      const participants = [...new Set([...held.map((h) => h.userId), ...bidderRows.map((b) => b.userId)])];
      for (const userId of participants) {
        const key = `lot_removed:${lotId}:${userId}`;
        await tx.insert(notifications).values({
          userId, type: 'lot_removed', createdAt: now, dedupeKey: key,
          payload: { lotId, lotTitle: lot.title, reason: parsed.data.reason },
        }).onConflictDoNothing();
        await tx.insert(emailOutbox).values({
          userId, lotId, kind: 'lot_removed', createdAt: now, dedupeKey: key,
          subject: `Лот «${lot.title}» знято модератором`,
          body: `Лот «${lot.title}» було знято з торгів. Причина: ${parsed.data.reason}. Ваш залог розблоковано.`,
        }).onConflictDoNothing();
      }

      const seq = lot.lastSeq + 1;
      const [row] = await tx.update(lots)
        .set({ status: 'removed', leaderId: null, lastSeq: seq, moderatorId: moderator.id, reviewLeaseUntil: null, updatedAt: now })
        .where(and(eq(lots.id, lotId), eq(lots.status, 'active'))).returning();
      await tx.insert(lotEvents).values({
        lotId, actorId: moderator.id, type: 'removed', createdAt: now,
        payload: { seq, reason: parsed.data.reason, notifyUserIds: held.map((h) => h.userId) },
      });
      return toLotDto(row!, moderator);
    });
  }

  private assertModerator(user: Principal): void {
    if (user.role !== 'moderator') throw Errors.forbidden('Moderator role required');
  }
}
