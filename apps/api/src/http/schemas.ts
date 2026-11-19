import { z } from 'zod';
import { ITEM_CONDITIONS, LOT_STATUSES } from '@auction/shared';

/**
 * Response shapes for OpenAPI. The generated client takes its types from these, so they must mirror
 * the DTO mappers in the services (the explicit mappers are what keeps the reserve price out of responses).
 */
const roleSchema = z.enum(['buyer', 'seller', 'moderator', 'finance']);
const kopecks = z.number().int();

export const userSchema = z.object({
  id: z.string().uuid(), email: z.string().email(), displayName: z.string(), role: roleSchema,
});

export const authResultSchema = z.object({ token: z.string(), expiresAt: z.string().datetime(), user: userSchema });

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(2).max(60),
  role: z.enum(['buyer', 'seller']).default('buyer'),
});

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

export const lotSchema = z.object({
  id: z.string().uuid(),
  sellerId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  categoryId: z.string().uuid(),
  cityId: z.string().uuid(),
  condition: z.enum(ITEM_CONDITIONS),
  startPrice: kopecks,
  buyNowPrice: kopecks.nullable(),
  durationDays: z.number().int(),
  status: z.enum(LOT_STATUSES),
  currentPrice: kopecks,
  bidCount: z.number().int(),
  endsAt: z.string().datetime().nullable(),
  reserveMet: z.boolean().nullable(),
  rejectionReason: z.string().nullable(),
});

/** Owner-only view: the single schema that carries the reserve price. */
export const ownLotSchema = lotSchema.extend({ reservePrice: kopecks.nullable() });

export const lotEventSchema = z.object({
  id: z.number().int(), type: z.string(), actorId: z.string().uuid().nullable(),
  payload: z.record(z.unknown()), createdAt: z.string().datetime(),
});

export const bidResultSchema = z.object({
  bidId: z.string().uuid(), lotId: z.string().uuid(), seq: z.number().int(),
  status: z.enum(['leading', 'outbid']), currentPrice: kopecks, yourMax: kopecks, minNextBid: kopecks,
});

export const buyNowResultSchema = z.object({
  lotId: z.string().uuid(), saleId: z.string().uuid(), price: kopecks, fee: kopecks, payDueAt: z.string().datetime(),
});

export const bidHistorySchema = z.object({
  items: z.array(z.object({
    seq: z.number().int(), bidder: z.string(), own: z.boolean(), priceAfter: kopecks,
    auto: z.boolean(), createdAt: z.string().datetime(),
  })),
  nextBeforeSeq: z.number().int().nullable(),
});

export const bidHistoryQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const balanceSchema = z.object({ available: kopecks, held: kopecks });

export const topUpRequestSchema = z.object({ amount: z.number().int().min(1000).max(100_000_000) });
export const topUpResponseSchema = z.object({ paymentId: z.string().uuid(), amount: kopecks, payUrl: z.string() });
