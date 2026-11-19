import { z } from 'zod';

export const LOT_STATUSES = [
  'draft', 'in_review', 'rejected', 'active', 'ended_unsold', 'awaiting_payment',
  'paid', 'shipped', 'completed', 'removed',
] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export const ITEM_CONDITIONS = ['new', 'like_new', 'good', 'fair', 'poor'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export type LotActor = 'seller' | 'moderator' | 'buyer' | 'system';

export interface LotTransition {
  from: LotStatus;
  to: LotStatus;
  actor: LotActor;
}

/** Single source of truth for the lot status table (who may move a lot from where to where). */
export const LOT_TRANSITIONS: readonly LotTransition[] = [
  { from: 'draft', to: 'in_review', actor: 'seller' },
  { from: 'in_review', to: 'active', actor: 'moderator' },
  { from: 'in_review', to: 'rejected', actor: 'moderator' },
  { from: 'rejected', to: 'draft', actor: 'seller' },
  { from: 'active', to: 'removed', actor: 'moderator' },
  { from: 'active', to: 'ended_unsold', actor: 'system' },
  { from: 'active', to: 'awaiting_payment', actor: 'system' },
  { from: 'awaiting_payment', to: 'paid', actor: 'system' },
  { from: 'awaiting_payment', to: 'ended_unsold', actor: 'system' },
  { from: 'paid', to: 'shipped', actor: 'seller' },
  { from: 'shipped', to: 'completed', actor: 'buyer' },
  { from: 'shipped', to: 'completed', actor: 'system' },
];

export function canTransition(from: LotStatus, to: LotStatus, actor: LotActor): boolean {
  return LOT_TRANSITIONS.some((t) => t.from === from && t.to === to && t.actor === actor);
}

export const MAX_PHOTOS = 10;
export const MIN_DURATION_DAYS = 1;
export const MAX_DURATION_DAYS = 10;

const kopecks = z.number().int().safe().positive();

export const lotFieldsSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(1).max(5000),
  categoryId: z.string().uuid(),
  cityId: z.string().uuid(),
  condition: z.enum(ITEM_CONDITIONS),
  startPrice: kopecks,
  reservePrice: kopecks.nullable().optional(),
  buyNowPrice: kopecks.nullable().optional(),
  durationDays: z.number().int().min(MIN_DURATION_DAYS).max(MAX_DURATION_DAYS),
});

function pricesConsistent(v: { startPrice?: number; reservePrice?: number | null; buyNowPrice?: number | null }): boolean {
  if (v.startPrice === undefined) return true;
  if (v.reservePrice != null && v.reservePrice < v.startPrice) return false;
  if (v.buyNowPrice != null && v.buyNowPrice < v.startPrice) return false;
  return true;
}
const PRICE_MSG = 'reserve and buy-now prices must not be below the start price';

export const createLotSchema = lotFieldsSchema.refine(pricesConsistent, { message: PRICE_MSG, path: ['startPrice'] });
export type CreateLotInput = z.infer<typeof createLotSchema>;

/** Before the first bid a seller may change anything. */
export const updateLotSchema = lotFieldsSchema.partial();
export type UpdateLotInput = z.infer<typeof updateLotSchema>;

/** After the first bid only appending to the description is allowed. */
export const appendDescriptionSchema = z.object({ append: z.string().trim().min(1).max(2000) });
export type AppendDescriptionInput = z.infer<typeof appendDescriptionSchema>;

export const rejectLotSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

/** A moderator who takes a lot from the queue holds it this long before it returns to the queue. */
export const REVIEW_LEASE_MINUTES = 15;
