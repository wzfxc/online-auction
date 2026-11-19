import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text,
  timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();

export const userRole = pgEnum('user_role', ['buyer', 'seller', 'moderator', 'finance']);
export const lotStatus = pgEnum('lot_status', [
  'draft', 'in_review', 'rejected', 'active', 'ended_unsold', 'awaiting_payment',
  'paid', 'shipped', 'completed', 'removed',
]);
export const itemCondition = pgEnum('item_condition', ['new', 'like_new', 'good', 'fair', 'poor']);
export const bidKind = pgEnum('bid_kind', ['manual', 'auto']);
export const accountType = pgEnum('account_type', [
  'user_available', 'user_hold', 'escrow', 'platform_fee', 'seller_payable', 'gateway',
]);
export const saleStatus = pgEnum('sale_status', [
  'awaiting_payment', 'paid', 'shipped', 'completed', 'defaulted', 'cancelled',
]);
export const paymentStatus = pgEnum('payment_status', ['pending', 'succeeded', 'failed', 'expired']);
export const photoStatus = pgEnum('photo_status', ['pending_upload', 'uploaded', 'processed']);

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('buyer'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const categories = pgTable('categories', {
  id: id(),
  slug: text('slug').notNull().unique(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en').notNull(),
  namePl: text('name_pl').notNull(),
});

export const cities = pgTable('cities', {
  id: id(),
  slug: text('slug').notNull().unique(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en').notNull(),
  namePl: text('name_pl').notNull(),
});

export const lots = pgTable('lots', {
  id: id(),
  sellerId: uuid('seller_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  description: text('description').notNull(),
  categoryId: uuid('category_id').notNull().references(() => categories.id),
  cityId: uuid('city_id').notNull().references(() => cities.id),
  condition: itemCondition('condition').notNull(),
  startPrice: money('start_price').notNull(),
  /** Hidden from every API, search document and socket event. */
  reservePrice: money('reserve_price'),
  buyNowPrice: money('buy_now_price'),
  durationDays: integer('duration_days').notNull(),
  status: lotStatus('status').notNull().default('draft'),
  currentPrice: money('current_price').notNull(),
  bidCount: integer('bid_count').notNull().default(0),
  leaderId: uuid('leader_id').references(() => users.id),
  /** Last allocated per-lot event sequence number (bids, status changes). */
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  endsAt: ts('ends_at'),
  moderatorId: uuid('moderator_id').references(() => users.id),
  reviewLeaseUntil: ts('review_lease_until'),
  rejectionReason: text('rejection_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  check('lots_prices', sql`${t.startPrice} > 0 and ${t.currentPrice} >= 0 and (${t.reservePrice} is null or ${t.reservePrice} >= ${t.startPrice}) and (${t.buyNowPrice} is null or ${t.buyNowPrice} >= ${t.startPrice})`),
  check('lots_duration', sql`${t.durationDays} between 1 and 10`),
  index('lots_active_ends_idx').on(t.status, t.endsAt),
  index('lots_seller_status_idx').on(t.sellerId, t.status),
  index('lots_review_queue_idx').on(t.status, t.reviewLeaseUntil, t.createdAt),
  index('lots_category_idx').on(t.categoryId, t.status),
]);

export const lotPhotos = pgTable('lot_photos', {
  id: id(),
  lotId: uuid('lot_id').notNull().references(() => lots.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  objectKey: text('object_key').notNull().unique(),
  previewKey: text('preview_key'),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  status: photoStatus('status').notNull().default('pending_upload'),
}, (t) => [
  uniqueIndex('lot_photos_lot_pos_uq').on(t.lotId, t.position),
  check('lot_photos_size', sql`${t.sizeBytes} between 1 and 10485760`),
  check('lot_photos_pos', sql`${t.position} between 0 and 9`),
]);

/** Lot history: who created, edited, approved, removed, bid (with auto flag). */
export const lotEvents = pgTable('lot_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  lotId: uuid('lot_id').notNull().references(() => lots.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('lot_events_lot_idx').on(t.lotId, t.id)]);

export const bids = pgTable('bids', {
  id: id(),
  lotId: uuid('lot_id').notNull().references(() => lots.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  /** Price the lot stood at after this bid was processed. */
  priceAfter: money('price_after').notNull(),
  /** Maximum the bidder authorised with this bid. */
  maxAmount: money('max_amount').notNull(),
  kind: bidKind('kind').notNull().default('manual'),
  /** Result for the bidder: leading or outbid_by_auto (rejections are never stored). */
  outcome: text('outcome').notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  uniqueIndex('bids_lot_seq_uq').on(t.lotId, t.seq),
  index('bids_user_idx').on(t.userId, t.createdAt),
  check('bids_amounts', sql`${t.priceAfter} > 0 and ${t.maxAmount} >= ${t.priceAfter}`),
]);

/** Current proxy maximum per bidder per lot; tie-break by earliest reached_seq. */
export const bidderMaxes = pgTable('bidder_maxes', {
  lotId: uuid('lot_id').notNull().references(() => lots.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  maxAmount: money('max_amount').notNull(),
  reachedAt: ts('reached_at').notNull(),
  reachedSeq: bigint('reached_seq', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.lotId, t.userId] }),
  index('bidder_maxes_rank_idx').on(t.lotId, t.maxAmount, t.reachedSeq),
]);

export const accounts = pgTable('accounts', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  type: accountType('type').notNull(),
  /** Denormalised sum of entries, maintained by trigger; reconciliation verifies it. */
  balance: money('balance').notNull().default(0),
}, (t) => [
  uniqueIndex('accounts_user_type_uq').on(t.userId, t.type).where(sql`${t.userId} is not null`),
  uniqueIndex('accounts_system_type_uq').on(t.type).where(sql`${t.userId} is null`),
  check('accounts_user_nonneg', sql`${t.type} not in ('user_available', 'user_hold') or ${t.balance} >= 0`),
  check('accounts_user_scope', sql`(${t.type} in ('user_available', 'user_hold', 'seller_payable')) = (${t.userId} is not null)`),
]);

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: id(),
  kind: text('kind').notNull(),
  lotId: uuid('lot_id').references(() => lots.id),
  /** Natural key making a business effect happen at most once. */
  effectKey: text('effect_key').unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('ledger_tx_created_idx').on(t.createdAt), index('ledger_tx_lot_idx').on(t.lotId)]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  txId: uuid('tx_id').notNull().references(() => ledgerTransactions.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  /** Signed kopecks: positive = credit to account, negative = debit. Sum per tx is zero. */
  amount: money('amount').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  index('ledger_entries_account_idx').on(t.accountId, t.id),
  index('ledger_entries_tx_idx').on(t.txId),
  index('ledger_entries_created_idx').on(t.createdAt),
  check('ledger_entries_nonzero', sql`${t.amount} <> 0`),
]);

/** Deposit currently held for a bidder on a lot (mirrors the user_hold ledger movements). */
export const deposits = pgTable('deposits', {
  lotId: uuid('lot_id').notNull().references(() => lots.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  amount: money('amount').notNull(),
  releasedAt: ts('released_at'),
}, (t) => [
  primaryKey({ columns: [t.lotId, t.userId] }),
  check('deposits_nonneg', sql`${t.amount} >= 0`),
]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  userId: uuid('user_id').notNull().references(() => users.id),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.scope, t.key] })]);

export const payments = pgTable('payments', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  amount: money('amount').notNull(),
  status: paymentStatus('status').notNull().default('pending'),
  createdAt: ts('created_at').notNull().defaultNow(),
  settledAt: ts('settled_at'),
}, (t) => [
  check('payments_amount', sql`${t.amount} > 0`),
  index('payments_pending_idx').on(t.status, t.createdAt),
  index('payments_user_idx').on(t.userId, t.createdAt),
]);

export const paymentWebhookEvents = pgTable('payment_webhook_events', {
  providerEventId: text('provider_event_id').primaryKey(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  type: text('type').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

/** One row per payment attempt for a won lot (winner first, then second-chance offers). */
export const sales = pgTable('sales', {
  id: id(),
  lotId: uuid('lot_id').notNull().references(() => lots.id),
  buyerId: uuid('buyer_id').notNull().references(() => users.id),
  attempt: integer('attempt').notNull(),
  price: money('price').notNull(),
  fee: money('fee').notNull().default(0),
  status: saleStatus('status').notNull().default('awaiting_payment'),
  payDueAt: ts('pay_due_at').notNull(),
  paidAt: ts('paid_at'),
  shippedAt: ts('shipped_at'),
  trackingNumber: text('tracking_number'),
  confirmedAt: ts('confirmed_at'),
  paidOutAt: ts('paid_out_at'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  uniqueIndex('sales_lot_attempt_uq').on(t.lotId, t.attempt),
  // One open offer per lot at a time (invariant 8).
  uniqueIndex('sales_one_open_per_lot_uq').on(t.lotId).where(sql`${t.status} = 'awaiting_payment'`),
  // At most one paid sale per lot.
  uniqueIndex('sales_one_live_per_lot_uq').on(t.lotId).where(sql`${t.status} in ('paid','shipped','completed')`),
  index('sales_due_idx').on(t.status, t.payDueAt),
  index('sales_buyer_idx').on(t.buyerId),
]);

export const favorites = pgTable('favorites', {
  userId: uuid('user_id').notNull().references(() => users.id),
  lotId: uuid('lot_id').notNull().references(() => lots.id, { onDelete: 'cascade' }),
  reminderSentAt: ts('reminder_sent_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.lotId] })]);

export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  dedupeKey: text('dedupe_key').unique(),
  readAt: ts('read_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)]);

export const emailOutbox = pgTable('email_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  dedupeKey: text('dedupe_key').unique(),
  lotId: uuid('lot_id').references(() => lots.id),
  kind: text('kind').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  sentAt: ts('sent_at'),
}, (t) => [
  index('email_outbox_unsent_idx').on(t.id).where(sql`${t.sentAt} is null`),
  index('email_outbox_rate_idx').on(t.userId, t.lotId, t.kind, t.createdAt),
]);

export const searchOutbox = pgTable('search_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  lotId: uuid('lot_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
}, (t) => [index('search_outbox_pending_idx').on(t.id).where(sql`${t.processedAt} is null`)]);

/** Set once per scheduled effect so repeated or parallel workers never do it twice. */
export const jobEffects = pgTable('job_effects', {
  key: text('key').primaryKey(),
  doneAt: ts('done_at').notNull().defaultNow(),
});
