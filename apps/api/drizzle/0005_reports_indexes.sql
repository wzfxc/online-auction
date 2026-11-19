CREATE INDEX IF NOT EXISTS "sales_created_status_idx" ON "sales" USING btree ("created_at","status");
