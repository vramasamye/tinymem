CREATE TABLE "code_symbols" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"signature" text,
	"line_start" integer,
	"line_end" integer,
	"span_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"decision" text NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"participants" text[] DEFAULT '{}'::text[] NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "decisions_status_check" CHECK (status IN ('proposed','accepted','superseded','rejected'))
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_memory_id" uuid NOT NULL,
	"to_memory_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"project_id" uuid,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edges_from_to_relation_unique" UNIQUE("from_memory_id","to_memory_id","relation"),
	CONSTRAINT "edges_relation_check" CHECK (relation IN ('related_to','depends_on','caused_by','solved_by','decided_by','supersedes','contradicts','derived_from','belongs_to','used_by','modifies'))
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_kind_check" CHECK (kind IN ('tool','library','language','person','service','concept','project','file','other'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"runtime" text NOT NULL,
	"adapter_version" text NOT NULL,
	"project_id" uuid,
	"session_id" text,
	"agent_id" text,
	"user_id" uuid,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"redactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"process_error" text,
	"needs_review" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failures" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"problem" text NOT NULL,
	"context" text NOT NULL,
	"root_cause" text,
	"solution" text,
	"verification" text,
	"status" text DEFAULT 'open' NOT NULL,
	"signature_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "failures_status_check" CHECK (status IN ('open','mitigated','solved','verified'))
);
--> statement-breakpoint
CREATE TABLE "file_fingerprints" (
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"tier" text DEFAULT 'committed' NOT NULL,
	"last_seen_commit" text,
	"symbols_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_fingerprints_repository_id_path_pk" PRIMARY KEY("repository_id","path"),
	CONSTRAINT "file_fingerprints_tier_check" CHECK (tier IN ('committed','worktree'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK (status IN ('pending','running','done','failed','dead'))
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"title" text,
	"content" text NOT NULL,
	"content_summary" text,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"importance" real NOT NULL,
	"confidence" real NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by" uuid,
	"project_id" uuid,
	"user_id" uuid,
	"agent_id" text,
	"source_id" uuid NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extraction" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || content)) STORED,
	CONSTRAINT "memories_type_check" CHECK (type IN ('episodic','semantic','procedural','decision','failure','preference')),
	CONSTRAINT "memories_status_check" CHECK (status IN ('active','stale','superseded','disputed','archived')),
	CONSTRAINT "memories_importance_check" CHECK (importance BETWEEN 0 AND 1),
	CONSTRAINT "memories_confidence_check" CHECK (confidence BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "memory_code_refs" (
	"memory_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_code_refs_memory_id_repository_id_path_pk" PRIMARY KEY("memory_id","repository_id","path")
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"memory_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text DEFAULT 'context' NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entities_memory_id_entity_id_pk" PRIMARY KEY("memory_id","entity_id"),
	CONSTRAINT "memory_entities_role_check" CHECK (role IN ('subject','object','context'))
);
--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_vectors" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"embedding" vector(384)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"root_path" text,
	"git_remote" text,
	"description" text,
	"digest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"root_path" text NOT NULL,
	"remote_url" text,
	"head_commit" text,
	"last_ingested_commit" text,
	"fingerprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"agent_id" text,
	"runtime" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"summary" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"source" jsonb NOT NULL,
	"verification" jsonb NOT NULL,
	"path" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"success_rate" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_status_check" CHECK (status IN ('candidate','verified','promoted','deprecated'))
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"uri" text,
	"title" text,
	"content_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_kind_check" CHECK (kind IN ('conversation','document','git','terminal','file','web','api','explicit'))
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "working_memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"importance" real DEFAULT 0.3 NOT NULL,
	"confidence" real DEFAULT 0.4 NOT NULL,
	"source_id" uuid,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"promoted_memory_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_memory_kind_check" CHECK (kind IN ('task','hypothesis','current_file','current_error','temp_decision','open_question'))
);
--> statement-breakpoint
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_memory_id_memories_id_fk" FOREIGN KEY ("from_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_memory_id_memories_id_fk" FOREIGN KEY ("to_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_merged_into_entities_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failures" ADD CONSTRAINT "failures_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_fingerprints" ADD CONSTRAINT "file_fingerprints_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_code_refs" ADD CONSTRAINT "memory_code_refs_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_code_refs" ADD CONSTRAINT "memory_code_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD CONSTRAINT "memory_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_vectors" ADD CONSTRAINT "memory_vectors_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_memory" ADD CONSTRAINT "working_memory_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_memory" ADD CONSTRAINT "working_memory_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_memory" ADD CONSTRAINT "working_memory_promoted_memory_id_memories_id_fk" FOREIGN KEY ("promoted_memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_symbols_repo_path_idx" ON "code_symbols" USING btree ("repository_id","path");--> statement-breakpoint
CREATE INDEX "code_symbols_name_idx" ON "code_symbols" USING btree ("repository_id","name");--> statement-breakpoint
CREATE INDEX "edges_from_idx" ON "edges" USING btree ("from_memory_id");--> statement-breakpoint
CREATE INDEX "edges_to_idx" ON "edges" USING btree ("to_memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_scope_name_idx" ON "entities" USING btree (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),"normalized_name");--> statement-breakpoint
CREATE INDEX "events_project_time_idx" ON "events" USING btree ("project_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe_idx" ON "events" USING btree ("project_id","kind","content_hash");--> statement-breakpoint
CREATE INDEX "failures_signature_idx" ON "failures" USING btree ("signature_hash");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_singleton_idx" ON "jobs" USING btree ("kind",(payload->>'key')) WHERE status IN ('pending','running');--> statement-breakpoint
CREATE UNIQUE INDEX "memories_dedupe_idx" ON "memories" USING btree (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),"type","content_hash");--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("project_id","type","status");--> statement-breakpoint
CREATE INDEX "memories_current_idx" ON "memories" USING btree ("project_id","observed_at" DESC NULLS LAST) WHERE status IN ('active','stale') AND valid_until IS NULL;--> statement-breakpoint
CREATE INDEX "memories_temporal_idx" ON "memories" USING btree ("project_id","valid_from","valid_until");--> statement-breakpoint
CREATE INDEX "memories_supersede_idx" ON "memories" USING btree ("superseded_by") WHERE superseded_by IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memories_fts_idx" ON "memories" USING gin ("search_text");--> statement-breakpoint
CREATE INDEX "memory_code_refs_repo_idx" ON "memory_code_refs" USING btree ("repository_id","path");--> statement-breakpoint
CREATE INDEX "memory_entities_entity_idx" ON "memory_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "memory_events_memory_idx" ON "memory_events" USING btree ("memory_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_vectors_hnsw_idx" ON "memory_vectors" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "working_session_idx" ON "working_memory" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "working_expiry_idx" ON "working_memory" USING btree ("expires_at") WHERE promoted_memory_id IS NULL;