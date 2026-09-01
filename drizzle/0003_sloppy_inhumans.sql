CREATE TABLE "agent_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"job_id" bigint NOT NULL,
	"client_address" text NOT NULL,
	"provider_address" text NOT NULL,
	"evaluator_address" text NOT NULL,
	"budget_raw" numeric(78, 0) NOT NULL,
	"status" integer NOT NULL,
	"description" text NOT NULL,
	"expired_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"deliverable_hash" text,
	"deliverable_url" text,
	"agent_id" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_chain_job_idx" ON "agent_jobs" USING btree ("chain_id","job_id");--> statement-breakpoint
CREATE INDEX "agent_jobs_agent_idx" ON "agent_jobs" USING btree ("agent_id","job_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_jobs_provider_idx" ON "agent_jobs" USING btree ("provider_address");--> statement-breakpoint
CREATE INDEX "agent_jobs_pending_idx" ON "agent_jobs" USING btree ("chain_id","job_id") WHERE "agent_jobs"."status" < 3;