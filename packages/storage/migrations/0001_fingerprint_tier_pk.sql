ALTER TABLE "file_fingerprints" DROP CONSTRAINT "file_fingerprints_repository_id_path_pk";--> statement-breakpoint
ALTER TABLE "file_fingerprints" ADD CONSTRAINT "file_fingerprints_repository_id_tier_path_pk" PRIMARY KEY("repository_id","tier","path");--> statement-breakpoint
ALTER TABLE "file_fingerprints" ADD COLUMN "file_mode" text;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_project_root_idx" ON "repositories" USING btree ("project_id","root_path");