# Mission 4b: fingerprint persistence (second M4 slice)

Branch: `mission/4b-codememory-persistence` · Base: `2c2a24c` · ADR: `0008-code-memory-git-fingerprints.md`

## Delivered scope

ADR-0008's "two tiers recorded" requirement now has a durable home:

- Migration `0001_fingerprint_tier_pk` (drizzle-kit generated from the schema definitions — no
  hand-rolled DDL, no new dependencies):
  - `file_fingerprints` primary key `(repository_id, path)` → `(repository_id, tier, path)` so
    `committed` and `worktree` coexist per path;
  - a nullable `file_mode` column (rows persisted before it existed keep `null`, never a
    fabricated mode);
  - a unique `(project_id, root_path)` index on `repositories`.
  The migration is preserving in the strict sense: the old key's uniqueness implies the new
  key's, so no existing row can violate it; `file_mode` adds a nullable column; the unique index
  can only fail on duplicate repository registrations, and no writer of that table existed
  before this slice.
- A new core port `CodeMemoryStore` (`ports declare, storage implements`, SQL stays in storage):
  `ensureRepository`, `getRepository`, `listRepositories`, `saveSnapshot`, `loadFingerprints`,
  `loadSnapshotMetadata`, with Zod-validated inputs in `schema/persistence.ts`. The snapshot
  input is structurally compatible with a codememory `RepositorySnapshot`, so captures can be
  passed straight through (extra keys pass).
- The storage implementation `repositories/code-memory.ts`:
  - one transaction per `saveSnapshot`, with `FOR UPDATE` on the repository row;
  - a snapshot whose `root_path` does not match the repository is rejected at the boundary;
  - upserts both tiers with a conflict guard (`IS DISTINCT FROM`) so already-current rows are
    never rewritten — `rewritten` counts only rows whose values actually changed;
  - deletes rows for gone paths, EXCEPT `(path, tier)` entries unavailable in the new capture:
    their last-known fingerprints are retained so drift resolution sees them as suspect, never
    silently fresh;
  - records snapshot metadata (algorithm, exclusions, capture time, counts) in
    `repositories.fingerprint`; `root_path`/`head_commit` are read back from the live row so
    they cannot go stale;
  - never advances `last_ingested_commit`: the ingestion checkpoint moves only when changed
    knowledge is fully processed, which is the drift pipeline's exclusive right (ADR-0008).
- `OnememoryStorage.codeMemory` on both drivers (embedded PGlite and server Postgres), bound by
  `createCodeMemoryStore`, and a new integration scenario running on BOTH legs: dual-tier
  coexistence per path, retention of unavailable paths, deletion of gone paths, the no-op rewrite
  guard (identical resave rewrites nothing), checkpoint immobility, per-project root uniqueness,
  root-mismatch/unknown-repository/malformed-hash rejection, and FK cascade on repository
  removal.

## Validation

- All 15 workspace package typechecks (strict): clean.
- Embedded leg (PGlite): storage suite 23 pass, 0 fail, 16 server-gated skips (39 tests);
  migration 0001 applies on open and twice in the idempotency scenario.
- Server leg (Docker Postgres 17 + pgvector, temporary container, removed after the run):
  storage suite 37 pass, 0 fail (405 assertions) with both legs enabled, including the new
  code-memory scenario.
- Full-repository suite: 898 pass, 0 fail, 18 environment-gated skips (916 tests, 69 files).

## Explicitly not complete

This slice persists snapshots but nothing consumes them yet. Still pending in M4: `DriftWatcher`
wiring (the research-verified `git diff-files` event scan belongs there), audited stale-memory
application, rename retargeting of `memory_code_refs`, symbol parsing, minimal re-index jobs,
architecture digests, and M3b decision/failure enrichment. The coordinator-owned
`docs/architecture/database-schema.md` still documents the old single-tier key and needs a
coordinating-session update; this mission links to it rather than editing it.
