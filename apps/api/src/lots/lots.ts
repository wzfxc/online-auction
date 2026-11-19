import { and, asc, eq } from 'drizzle-orm';
import {
  appendDescriptionSchema, canTransition, createLotSchema, rejectLotSchema, updateLotSchema,
  type LotActor, type LotStatus,
} from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { lotEvents, lots } from '../db/schema.js';
import type { Tx } from '../ledger/ledger.js';

export type LotRow = typeof lots.$inferSelect;
export type Role = 'buyer' | 'seller' | 'moderator' | 'finance';
export interface Principal {
  id: string;
  role: Role;
}

const DAY_MS = 86_400_000;

/** Public lot shape. Explicit mapper: reservePrice and moderation internals never leave the server (CLAUDE.md). */
export interface LotDto {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  categoryId: string;
  cityId: string;
  condition: LotRow['condition'];
  startPrice: number;
  buyNowPrice: number | null;
  durationDays: number;
  status: LotStatus;
  currentPrice: number;
  bidCount: number;
  endsAt: string | null;
  /** null when the lot has no reserve. */
  reserveMet: boolean | null;
  rejectionReason: string | null;
}

export function toLotDto(lot: LotRow, viewer: Principal | null): LotDto {
  const canSeeReason = viewer?.id === lot.sellerId || viewer?.role === 'moderator';
  return {
    id: lot.id,
    sellerId: lot.sellerId,
    title: lot.title,
    description: lot.description,
    categoryId: lot.categoryId,
    cityId: lot.cityId,
    condition: lot.condition,
    startPrice: lot.startPrice,
    buyNowPrice: lot.buyNowPrice,
    durationDays: lot.durationDays,
    status: lot.status,
    currentPrice: lot.currentPrice,
    bidCount: lot.bidCount,
    endsAt: lot.endsAt?.toISOString() ?? null,
    reserveMet: lot.reservePrice === null ? null : lot.bidCount > 0 && lot.currentPrice >= lot.reservePrice,
    rejectionReason: canSeeReason ? lot.rejectionReason : null,
  };
}

/** Seller view: the only DTO that carries the reserve price, and only to the owner. */
export interface OwnLotDto extends LotDto {
  reservePrice: number | null;
}
export function toOwnLotDto(lot: LotRow): OwnLotDto {
  return { ...toLotDto(lot, { id: lot.sellerId, role: 'seller' }), reservePrice: lot.reservePrice };
}

const PUBLIC_STATUSES: readonly LotStatus[] = [
  'active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed',
];

export class LotService {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async create(user: Principal, raw: unknown): Promise<OwnLotDto> {
    if (user.role !== 'seller') throw Errors.forbidden('Only sellers can create lots');
    const parsed = createLotSchema.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const v = parsed.data;
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(lots).values({
        sellerId: user.id, title: v.title, description: v.description, categoryId: v.categoryId,
        cityId: v.cityId, condition: v.condition, startPrice: v.startPrice,
        reservePrice: v.reservePrice ?? null, buyNowPrice: v.buyNowPrice ?? null,
        durationDays: v.durationDays, currentPrice: v.startPrice, createdAt: now, updatedAt: now,
      }).returning();
      await this.log(tx, row!.id, user.id, 'created', {});
      return toOwnLotDto(row!);
    });
  }

  /** Before the first bid anything may change; once published only appending to the description. */
  async update(user: Principal, lotId: string, raw: unknown): Promise<OwnLotDto> {
    return this.db.transaction(async (tx) => {
      const lot = await this.lockOwn(tx, user, lotId);
      if (lot.status === 'active') return this.appendDescription(tx, user, lot, raw);
      if (lot.status !== 'draft') throw Errors.conflict('LOT_NOT_EDITABLE', 'Lot cannot be edited in this status');

      const p = updateLotSchema.safeParse(raw);
      if (!p.success) throw Errors.validation(p.error.issues);
      const merged = createLotSchema.safeParse({ ...lot, ...p.data });
      if (!merged.success) throw Errors.validation(merged.error.issues);
      const patch = { ...p.data, ...(p.data.startPrice !== undefined ? { currentPrice: p.data.startPrice } : {}) };
      const [row] = await tx.update(lots).set({ ...patch, updatedAt: this.clock.now() }).where(eq(lots.id, lotId)).returning();
      await this.log(tx, lotId, user.id, 'updated', { fields: Object.keys(p.data) });
      return toOwnLotDto(row!);
    });
  }

  submit(user: Principal, lotId: string): Promise<OwnLotDto> {
    return this.ownerTransition(user, lotId, 'in_review', 'submitted');
  }

  reviseRejected(user: Principal, lotId: string): Promise<OwnLotDto> {
    return this.ownerTransition(user, lotId, 'draft', 'reopened');
  }

  approve(moderator: Principal, lotId: string): Promise<LotDto> {
    return this.moderate(moderator, lotId, 'active', 'approved', {}, (lot, now) => ({
      endsAt: new Date(now.getTime() + lot.durationDays * DAY_MS),
      currentPrice: lot.startPrice,
    }));
  }

  reject(moderator: Principal, lotId: string, raw: unknown): Promise<LotDto> {
    const r = rejectLotSchema.safeParse(raw);
    if (!r.success) return Promise.reject(Errors.validation(r.error.issues));
    const { reason } = r.data;
    return this.moderate(moderator, lotId, 'rejected', 'rejected', { reason }, () => ({ rejectionReason: reason }));
  }

  /** Public read: unapproved lots are visible only to their owner and moderators (invariant 14). */
  async get(viewer: Principal | null, lotId: string): Promise<LotDto> {
    const [lot] = await this.db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot) throw Errors.notFound('Lot');
    const privileged = viewer?.id === lot.sellerId || viewer?.role === 'moderator';
    if (!privileged && !PUBLIC_STATUSES.includes(lot.status)) throw Errors.notFound('Lot');
    return toLotDto(lot, viewer);
  }

  /** Lot history: seller and moderators only. */
  async history(viewer: Principal, lotId: string): Promise<(typeof lotEvents.$inferSelect)[]> {
    const [lot] = await this.db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot || (viewer.id !== lot.sellerId && viewer.role !== 'moderator')) throw Errors.notFound('Lot');
    return this.db.select().from(lotEvents).where(eq(lotEvents.lotId, lotId)).orderBy(asc(lotEvents.id));
  }

  private async appendDescription(tx: Tx, user: Principal, lot: LotRow, raw: unknown): Promise<OwnLotDto> {
    const a = appendDescriptionSchema.safeParse(raw);
    if (!a.success) {
      throw Errors.unprocessable('LOT_PUBLISHED', 'Once published only the description can be appended', a.error.issues);
    }
    const description = `${lot.description}\n\n${a.data.append}`;
    const [row] = await tx.update(lots).set({ description, updatedAt: this.clock.now() }).where(eq(lots.id, lot.id)).returning();
    await this.log(tx, lot.id, user.id, 'description_appended', { added: a.data.append });
    return toOwnLotDto(row!);
  }

  private async moderate(
    moderator: Principal, lotId: string, to: LotStatus, event: string, payload: object,
    extra: (lot: LotRow, now: Date) => Partial<typeof lots.$inferInsert>,
  ): Promise<LotDto> {
    if (moderator.role !== 'moderator') throw Errors.forbidden('Moderator role required');
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
      if (!lot) throw Errors.notFound('Lot');
      this.assertTransition(lot.status, to, 'moderator');
      // Another moderator's live lease blocks the decision (invariant 9); an expired one does not.
      if (lot.moderatorId !== null && lot.moderatorId !== moderator.id
        && lot.reviewLeaseUntil !== null && lot.reviewLeaseUntil.getTime() > now.getTime()) {
        throw Errors.conflict('LOT_CLAIMED', 'Lot is being reviewed by another moderator');
      }
      const [row] = await tx.update(lots)
        .set({ ...extra(lot, now), status: to, moderatorId: moderator.id, reviewLeaseUntil: null, updatedAt: now })
        .where(and(eq(lots.id, lotId), eq(lots.status, lot.status))).returning();
      await this.log(tx, lotId, moderator.id, event, payload);
      return toLotDto(row!, moderator);
    });
  }

  private async ownerTransition(user: Principal, lotId: string, to: LotStatus, event: string): Promise<OwnLotDto> {
    return this.db.transaction(async (tx) => {
      const lot = await this.lockOwn(tx, user, lotId);
      this.assertTransition(lot.status, to, 'seller');
      const [row] = await tx.update(lots).set({ status: to, updatedAt: this.clock.now() }).where(eq(lots.id, lotId)).returning();
      await this.log(tx, lotId, user.id, event, {});
      return toOwnLotDto(row!);
    });
  }

  /** Locks the row and checks ownership; foreign lots look non-existent (no id probing). */
  private async lockOwn(tx: Tx, user: Principal, lotId: string): Promise<LotRow> {
    const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
    if (!lot || lot.sellerId !== user.id) throw Errors.notFound('Lot');
    return lot;
  }

  private assertTransition(from: LotStatus, to: LotStatus, actor: LotActor): void {
    if (!canTransition(from, to, actor)) {
      throw Errors.conflict('INVALID_LOT_TRANSITION', `Cannot move lot from ${from} to ${to}`, { from, to });
    }
  }

  private async log(tx: Tx, lotId: string, actorId: string, type: string, payload: object): Promise<void> {
    await tx.insert(lotEvents).values({ lotId, actorId, type, payload, createdAt: this.clock.now() });
  }
}
