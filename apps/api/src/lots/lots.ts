import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  appendDescriptionSchema, canTransition, createLotSchema, LOT_STATUSES, rejectLotSchema, updateLotSchema,
  type LotActor, type LotStatus,
} from '@auction/shared';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { bidderMaxes, bids, categories, cities, deposits, favorites, lotEvents, lots, sales } from '../db/schema.js';
import { balanceOf, type Tx } from '../ledger/ledger.js';

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

export interface MyLotsResultDto {
  items: OwnLotDto[];
  countsByStatus: Record<LotStatus, number>;
  /** Sum of (price - fee) in escrow for paid or shipped sales of this seller awaiting buyer confirmation. */
  pendingPayout: number;
  /** Total balance credited to seller_payable (completed payouts + forfeited deposits). */
  paidOutTotal: number;
}

export interface CategoryDto {
  id: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  namePl: string;
}

export interface CityDto {
  id: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  namePl: string;
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
      await this.assertRefsExist(tx, v.categoryId, v.cityId);
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

  /** Before the first bid anything may change (even when active); once bid on, only appending to the description. */
  async update(user: Principal, lotId: string, raw: unknown): Promise<OwnLotDto> {
    return this.db.transaction(async (tx) => {
      const lot = await this.lockOwn(tx, user, lotId);
      if (lot.status === 'active' && lot.bidCount > 0) return this.appendDescription(tx, user, lot, raw);
      if (lot.status === 'active' && raw && typeof raw === 'object' && 'append' in raw && Object.keys(raw).length === 1) {
        return this.appendDescription(tx, user, lot, raw);
      }
      if (lot.status !== 'draft' && !(lot.status === 'active' && lot.bidCount === 0)) {
        throw Errors.conflict('LOT_NOT_EDITABLE', 'Lot cannot be edited in this status');
      }

      const p = updateLotSchema.safeParse(raw);
      if (!p.success) throw Errors.validation(p.error.issues);
      const merged = createLotSchema.safeParse({ ...lot, ...p.data });
      if (!merged.success) throw Errors.validation(merged.error.issues);
      await this.assertRefsExist(tx, merged.data.categoryId, merged.data.cityId);

      const now = this.clock.now();
      const patch = {
        ...p.data,
        ...(p.data.startPrice !== undefined ? { currentPrice: p.data.startPrice } : {}),
      };
      // Editing a published lot (no bids yet) sends it back to moderation; the end time is set again on approval.
      const republish = lot.status === 'active'
        ? { status: 'in_review' as const, endsAt: null, moderatorId: null, reviewLeaseUntil: null }
        : {};
      if (lot.status === 'active') this.assertTransition(lot.status, 'in_review', 'seller');
      const [row] = await tx.update(lots).set({ ...patch, ...republish, updatedAt: now }).where(eq(lots.id, lotId)).returning();
      await this.log(tx, lotId, user.id, 'updated', { fields: Object.keys(p.data) });
      if (lot.status === 'active') await this.log(tx, lotId, user.id, 'resubmitted_after_edit', { from: 'active' });
      return toOwnLotDto(row!);
    });
  }

  submit(user: Principal, lotId: string): Promise<OwnLotDto> {
    return this.ownerTransition(user, lotId, 'in_review', 'submitted');
  }

  /** Reopens a rejected or ended_unsold lot back to draft so the seller can revise and resubmit it. */
  reviseRejected(user: Principal, lotId: string): Promise<OwnLotDto> {
    return this.db.transaction(async (tx) => {
      const lot = await this.lockOwn(tx, user, lotId);
      this.assertTransition(lot.status, 'draft', 'seller');
      const now = this.clock.now();
      await tx.delete(bidderMaxes).where(eq(bidderMaxes.lotId, lotId));
      await tx.delete(bids).where(eq(bids.lotId, lotId));
      await tx.delete(deposits).where(and(eq(deposits.lotId, lotId), eq(deposits.amount, 0)));
      await tx.delete(sales).where(and(eq(sales.lotId, lotId), inArray(sales.status, ['defaulted', 'cancelled'])));
      await tx.update(favorites).set({ reminderSentAt: null }).where(eq(favorites.lotId, lotId));

      const [row] = await tx.update(lots).set({
        status: 'draft', currentPrice: lot.startPrice, bidCount: 0, leaderId: null,
        endsAt: null, rejectionReason: null, updatedAt: now,
      }).where(eq(lots.id, lotId)).returning();
      await this.log(tx, lotId, user.id, 'reopened', { from: lot.status });
      return toOwnLotDto(row!);
    });
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

  /** Seller's own lots with status breakdown and pending/completed payout totals. */
  async listMine(user: Principal, status?: LotStatus): Promise<MyLotsResultDto> {
    if (user.role !== 'seller') throw Errors.forbidden('Seller role required');
    const allRows = await this.db.select().from(lots)
      .where(eq(lots.sellerId, user.id))
      .orderBy(desc(lots.createdAt), desc(lots.id));

    const countsByStatus = Object.fromEntries(LOT_STATUSES.map((s) => [s, 0])) as Record<LotStatus, number>;
    for (const r of allRows) countsByStatus[r.status] = (countsByStatus[r.status] ?? 0) + 1;
    const filtered = status ? allRows.filter((r) => r.status === status) : allRows;

    const [pendingRow] = await this.db
      .select({ pending: sql<number>`coalesce(sum(${sales.price} - ${sales.fee}), 0)::bigint` })
      .from(sales)
      .innerJoin(lots, eq(lots.id, sales.lotId))
      .where(and(eq(lots.sellerId, user.id), inArray(sales.status, ['paid', 'shipped'])));

    const paidOutTotal = await this.db.transaction((tx) =>
      balanceOf(tx, { type: 'seller_payable', userId: user.id }));

    return {
      items: filtered.map(toOwnLotDto),
      countsByStatus,
      pendingPayout: Number(pendingRow?.pending ?? 0),
      paidOutTotal,
    };
  }

  /** Public lots where the user has placed at least one bid. */
  async listParticipating(user: Principal): Promise<LotDto[]> {
    if (user.role !== 'buyer' && user.role !== 'seller') throw Errors.forbidden('Role cannot bid');
    const lotIds = await this.db.selectDistinct({ lotId: bids.lotId }).from(bids).where(eq(bids.userId, user.id));
    if (lotIds.length === 0) return [];
    const rows = await this.db.select().from(lots)
      .where(and(
        inArray(lots.id, lotIds.map((l) => l.lotId)),
        inArray(lots.status, [...PUBLIC_STATUSES]),
      ))
      .orderBy(desc(lots.updatedAt), desc(lots.id));
    return rows.map((r) => toLotDto(r, user));
  }

  async listFavorites(user: Principal): Promise<LotDto[]> {
    if (user.role !== 'buyer' && user.role !== 'seller') throw Errors.forbidden('Role cannot use favorites');
    const rows = await this.db
      .select({ lot: lots })
      .from(favorites)
      .innerJoin(lots, eq(lots.id, favorites.lotId))
      .where(and(eq(favorites.userId, user.id), inArray(lots.status, [...PUBLIC_STATUSES])))
      .orderBy(desc(favorites.createdAt), desc(lots.id));
    return rows.map((r) => toLotDto(r.lot, user));
  }

  async addFavorite(user: Principal, lotId: string): Promise<{ lotId: string; favorited: boolean }> {
    if (user.role !== 'buyer' && user.role !== 'seller') throw Errors.forbidden('Role cannot use favorites');
    const [lot] = await this.db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot || !PUBLIC_STATUSES.includes(lot.status)) throw Errors.notFound('Lot');
    await this.db.insert(favorites).values({ userId: user.id, lotId, createdAt: this.clock.now() }).onConflictDoNothing();
    return { lotId, favorited: true };
  }

  async removeFavorite(user: Principal, lotId: string): Promise<{ lotId: string; favorited: boolean }> {
    if (user.role !== 'buyer' && user.role !== 'seller') throw Errors.forbidden('Role cannot use favorites');
    await this.db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.lotId, lotId)));
    return { lotId, favorited: false };
  }

  async listCategories(): Promise<CategoryDto[]> {
    const rows = await this.db.select().from(categories).orderBy(asc(categories.slug));
    return rows.map((c) => ({ id: c.id, slug: c.slug, nameUk: c.nameUk, nameEn: c.nameEn, namePl: c.namePl }));
  }

  async listCities(): Promise<CityDto[]> {
    const rows = await this.db.select().from(cities).orderBy(asc(cities.slug));
    return rows.map((c) => ({ id: c.id, slug: c.slug, nameUk: c.nameUk, nameEn: c.nameEn, namePl: c.namePl }));
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

  private async assertRefsExist(tx: Tx, categoryId: string, cityId: string): Promise<void> {
    const [cat] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
    if (!cat) throw Errors.validation([{ path: ['categoryId'], message: 'Unknown category' }]);
    const [city] = await tx.select({ id: cities.id }).from(cities).where(eq(cities.id, cityId));
    if (!city) throw Errors.validation([{ path: ['cityId'], message: 'Unknown city' }]);
  }

  private async log(tx: Tx, lotId: string, actorId: string, type: string, payload: object): Promise<void> {
    await tx.insert(lotEvents).values({ lotId, actorId, type, payload, createdAt: this.clock.now() });
  }
}
