ALTER TABLE "lot_photos" ADD COLUMN IF NOT EXISTS "sha256" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revoked_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revoked_tokens_expires_idx" ON "revoked_tokens" USING btree ("expires_at");
