CREATE TYPE "public"."account_type" AS ENUM('user_available', 'user_hold', 'escrow', 'platform_fee', 'seller_payable', 'gateway');--> statement-breakpoint
CREATE TYPE "public"."bid_kind" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."item_condition" AS ENUM('new', 'like_new', 'good', 'fair', 'poor');--> statement-breakpoint
CREATE TYPE "public"."lot_status" AS ENUM('draft', 'in_review', 'rejected', 'active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."photo_status" AS ENUM('pending_upload', 'uploaded', 'processed');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('awaiting_payment', 'paid', 'shipped', 'completed', 'defaulted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('buyer', 'seller', 'moderator', 'finance');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"type" "account_type" NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "accounts_user_nonneg" CHECK ("accounts"."type" not in ('user_available', 'user_hold') or "accounts"."balance" >= 0),
	CONSTRAINT "accounts_user_scope" CHECK (("accounts"."type" in ('user_available', 'user_hold', 'seller_payable')) = ("accounts"."user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "bidder_maxes" (
	"lot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"max_amount" bigint NOT NULL,
	"reached_at" timestamp with time zone NOT NULL,
	"reached_seq" bigint NOT NULL,
	CONSTRAINT "bidder_maxes_lot_id_user_id_pk" PRIMARY KEY("lot_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"price_after" bigint NOT NULL,
	"max_amount" bigint NOT NULL,
	"kind" "bid_kind" DEFAULT 'manual' NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bids_amounts" CHECK ("bids"."price_after" > 0 and "bids"."max_amount" >= "bids"."price_after")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_uk" text NOT NULL,
	"name_en" text NOT NULL,
	"name_pl" text NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_uk" text NOT NULL,
	"name_en" text NOT NULL,
	"name_pl" text NOT NULL,
	CONSTRAINT "cities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"lot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "deposits_lot_id_user_id_pk" PRIMARY KEY("lot_id","user_id"),
	CONSTRAINT "deposits_nonneg" CHECK ("deposits"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text,
	"lot_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "email_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_lot_id_pk" PRIMARY KEY("user_id","lot_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_scope_key_pk" PRIMARY KEY("user_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "job_effects" (
	"key" text PRIMARY KEY NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_nonzero" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"lot_id" uuid,
	"effect_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_effect_key_unique" UNIQUE("effect_key")
);
--> statement-breakpoint
CREATE TABLE "lot_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lot_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"object_key" text NOT NULL,
	"preview_key" text,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" "photo_status" DEFAULT 'pending_upload' NOT NULL,
	CONSTRAINT "lot_photos_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "lot_photos_size" CHECK ("lot_photos"."size_bytes" between 1 and 10485760),
	CONSTRAINT "lot_photos_pos" CHECK ("lot_photos"."position" between 0 and 9)
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"condition" "item_condition" NOT NULL,
	"start_price" bigint NOT NULL,
	"reserve_price" bigint,
	"buy_now_price" bigint,
	"duration_days" integer NOT NULL,
	"status" "lot_status" DEFAULT 'draft' NOT NULL,
	"current_price" bigint NOT NULL,
	"bid_count" integer DEFAULT 0 NOT NULL,
	"leader_id" uuid,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"ends_at" timestamp with time zone,
	"moderator_id" uuid,
	"review_lease_until" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lots_prices" CHECK ("lots"."start_price" > 0 and "lots"."current_price" >= 0 and ("lots"."reserve_price" is null or "lots"."reserve_price" >= "lots"."start_price") and ("lots"."buy_now_price" is null or "lots"."buy_now_price" >= "lots"."start_price")),
	CONSTRAINT "lots_duration" CHECK ("lots"."duration_days" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"provider_event_id" text PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "payments_amount" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"price" bigint NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"status" "sale_status" DEFAULT 'awaiting_payment' NOT NULL,
	"pay_due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"tracking_number" text,
	"confirmed_at" timestamp with time zone,
	"paid_out_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'buyer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bidder_maxes" ADD CONSTRAINT "bidder_maxes_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bidder_maxes" ADD CONSTRAINT "bidder_maxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_events" ADD CONSTRAINT "lot_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_photos" ADD CONSTRAINT "lot_photos_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_type_uq" ON "accounts" USING btree ("user_id","type") WHERE "accounts"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_system_type_uq" ON "accounts" USING btree ("type") WHERE "accounts"."user_id" is null;--> statement-breakpoint
CREATE INDEX "bidder_maxes_rank_idx" ON "bidder_maxes" USING btree ("lot_id","max_amount","reached_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_lot_seq_uq" ON "bids" USING btree ("lot_id","seq");--> statement-breakpoint
CREATE INDEX "bids_user_idx" ON "bids" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_unsent_idx" ON "email_outbox" USING btree ("id") WHERE "email_outbox"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "email_outbox_rate_idx" ON "email_outbox" USING btree ("user_id","lot_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "ledger_entries_tx_idx" ON "ledger_entries" USING btree ("tx_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_tx_created_idx" ON "ledger_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_tx_lot_idx" ON "ledger_transactions" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "lot_events_lot_idx" ON "lot_events" USING btree ("lot_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lot_photos_lot_pos_uq" ON "lot_photos" USING btree ("lot_id","position");--> statement-breakpoint
CREATE INDEX "lots_active_ends_idx" ON "lots" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX "lots_seller_status_idx" ON "lots" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "lots_review_queue_idx" ON "lots" USING btree ("status","review_lease_until","created_at");--> statement-breakpoint
CREATE INDEX "lots_category_idx" ON "lots" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_pending_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_lot_attempt_uq" ON "sales" USING btree ("lot_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_one_open_per_lot_uq" ON "sales" USING btree ("lot_id") WHERE "sales"."status" = 'awaiting_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "sales_one_live_per_lot_uq" ON "sales" USING btree ("lot_id") WHERE "sales"."status" in ('paid','shipped','completed');--> statement-breakpoint
CREATE INDEX "sales_due_idx" ON "sales" USING btree ("status","pay_due_at");--> statement-breakpoint
CREATE INDEX "sales_buyer_idx" ON "sales" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "search_outbox_pending_idx" ON "search_outbox" USING btree ("id") WHERE "search_outbox"."processed_at" is null;