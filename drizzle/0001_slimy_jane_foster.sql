ALTER TABLE "agents" ADD COLUMN "metadata_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "metadata_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agents_metadata_backlog_idx" ON "agents" USING btree ("metadata_attempts","agent_id" DESC NULLS LAST) WHERE "agents"."metadata_resolved_at" is null;