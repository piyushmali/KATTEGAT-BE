CREATE TABLE "agent_categories" (
	"agent_id" text NOT NULL,
	"category" text NOT NULL,
	"confidence" real NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"signals" text[] DEFAULT '{}' NOT NULL,
	"classifier_version" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_categories_agent_id_category_pk" PRIMARY KEY("agent_id","category")
);
--> statement-breakpoint
CREATE TABLE "agent_reputation" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"feedback_count" integer DEFAULT 0 NOT NULL,
	"client_count" integer DEFAULT 0 NOT NULL,
	"summary_value" bigint,
	"summary_decimals" integer,
	"source" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"agent_id" bigint NOT NULL,
	"owner_address" text NOT NULL,
	"wallet_address" text,
	"agent_uri" text,
	"name" text NOT NULL,
	"description" text,
	"protocol_tag" text DEFAULT 'unconfigured' NOT NULL,
	"trait_tags" text[] DEFAULT '{}' NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"raw_metadata" jsonb,
	"registered_at_block" bigint,
	"registered_at" timestamp with time zone,
	"source" text NOT NULL,
	"metadata_resolved_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_block" bigint DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_categories" ADD CONSTRAINT "agent_categories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reputation" ADD CONSTRAINT "agent_reputation_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_categories_category_idx" ON "agent_categories" USING btree ("category","confidence");--> statement-breakpoint
CREATE INDEX "agent_categories_primary_idx" ON "agent_categories" USING btree ("is_primary","category");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_chain_agent_idx" ON "agents" USING btree ("chain_id","agent_id");--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "agents_protocol_idx" ON "agents" USING btree ("protocol_tag");--> statement-breakpoint
CREATE INDEX "agents_registered_at_idx" ON "agents" USING btree ("registered_at");