CREATE TABLE "agent_sessions" (
	"public_key" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"spend_limit_wei" text NOT NULL,
	"spend_period" text NOT NULL,
	"allowed_calls" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_tx_hash" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_tx_hash" text,
	"chain_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_idx" ON "agent_sessions" USING btree ("agent_id","granted_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_live_idx" ON "agent_sessions" USING btree ("expires_at") WHERE "agent_sessions"."revoked_at" is null;