CREATE TABLE IF NOT EXISTS "payment_stub_sessions" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"amount" bigint NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
