-- Required by gin_trgm_ops below. drizzle-kit generates the indexes but has no way to know
-- their operator class comes from an extension, so this line is added by hand and must stay.
--
-- pg_trgm is a trusted extension from Postgres 13 onward, so the database owner can install it
-- without superuser. On a managed host that refuses it, enable it from the provider's dashboard
-- and re-run; the two statements below are then idempotent enough to retry.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "agents_name_trgm_idx" ON "agents" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agents_description_trgm_idx" ON "agents" USING gin ("description" gin_trgm_ops);
