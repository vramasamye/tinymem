CREATE TABLE "memory_events_digest" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"runtime" text NOT NULL,
	"adapter_version" text NOT NULL,
	"project_id" uuid,
	"session_id" text,
	"agent_id" text,
	"user_id" uuid,
	"content_hash" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"payload_bytes" integer NOT NULL,
	"redactions_count" integer DEFAULT 0 NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_events_digest_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE INDEX "memory_events_digest_scope_idx" ON "memory_events_digest" USING btree ("project_id","occurred_at" DESC NULLS LAST);