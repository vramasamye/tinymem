# Mission 4c: code-memory drift (third M4 slice)

Branch: `mission/4c-codememory-drift` · Base: `dec90b3` · ADR: `0008-code-memory-git-fingerprints.md`

## Delivered scope

ADR-0008's zero-token freshness oracle now exists end to end:

- The `CodeMemoryStore` port (one code-memory persistence port, extended — not split) gained
  minimal ref APIs: `recordCodeRefs` (idempotent per-(memory, repository) upsert of worktree-tier
  evidence blobs) and `listCodeRefs` (repository-scoped, optional path filter). Zod inputs live in
  `core/src/schema/persistence.ts`; SQL stays in `storage/src/repositories/code-memory.ts`
  (one transaction per record, `NotFoundError` for missing memory/repository, chunked upserts,
  `created_at` kept on re-record); bound in `store.ts`, exported via the existing
  `codeMemoryRepo` namespace. No delete API: removal is the FK cascades' job, and re-pointing or
  pruning a memory's ref set belongs to the drift pipeline's retargeting step, not persistence.
- `saveSnapshot` now persists the capture's unreadable (path, tier) set into the
  `repositories.fingerprint` metadata, and `loadSnapshotMetadata` returns it (optional field —
  rows persisted before this slice parse without it). This is the honest storage-side source for
  drift's "retained-unavailable" suspicion; nothing is inferred client-side.
- `packages/codememory` implements the core `DriftWatcher` port (`createDriftWatcher(store)`,
  constructor injection, no SQL in the package): `detectDrift({ project_id })` is a pure read
  over PERSISTED state in the pipeline shape saveSnapshot → detectDrift. `packages/codememory`
  gained `@onememory/core` as a dependency (runtime) and `@onememory/storage` as a devDependency
  (test-only, for the real-storage end-to-end test — the same cross-package test pattern as
  `packages/security` and `packages/extraction`).

## Design decision: no `tier` column on `memory_code_refs` — worktree pinned in code

Refs record the **worktree-tier** blob a memory was extracted against (the bytes the agent
actually saw), by definition, in code:

- The as-built architecture (database-schema.md, synced at the base commit) documents
  `memory_code_refs` with no tier column and the normative drift query already pinned to
  `ff.tier = 'worktree'`; a tier column would contradict the just-synced doc and serve no reader.
- Nothing in any pipeline records committed-tier evidence. A defaulted `tier` column would be a
  write-only dimension; `RecordCodeRefsSchema` instead requires the caller to pass the
  worktree-tier fingerprint, and the port doc comments pin the invariant.
- If a later slice genuinely needs committed-tier refs, a preserving migration then (add
  `tier text NOT NULL DEFAULT 'worktree'` + widen the PK) is straightforward and gets its own
  review; no data exists today that would constrain it.

Consequence: **no migration in this slice** — `memory_code_refs` (migration 0000), its PK, and
its FK cascades are used exactly as landed.

## Drift semantics as implemented

For each repository of the project (via `listRepositories`) and each recorded ref:

1. **`content_changed`** — a current persisted worktree-tier fingerprint exists for the ref's
   path, the path was readable in the latest capture, and its blob differs from the ref's
   evidence blob. This is the normative query from database-schema.md, executed via the port.
2. **`capture_unavailable`** — the latest capture could not read the path (the metadata's
   `skipped` set): the stored fingerprint is a retained last-known value at best. It is reported
   as a suspect **even when the retained blob matches the ref exactly** — never silently fresh.
   Unavailable paths are also excluded from rename candidacy (a last-known value cannot prove
   where content moved) and never claim successors (an unreadable path may simply be unreadable).
3. **`path_missing`** — no current worktree-tier fingerprint row exists for the ref's path
   (deleted, excluded, or never captured; a repository with no persisted snapshot flags every
   ref this way).

**Rename mapping**: when a `path_missing` ref's exact blob is found at exactly one other current
readable worktree path — excluding the memory's own other ref paths — that successor is reported
alongside the stale path in `changed_paths` and as `successor_path` on the structured ref. This
mirrors `compareSnapshots`' conservative exact one-to-one pairing (same rule, derived from
persisted fingerprints): ambiguous matches (two vanished refs, or two candidate destinations,
sharing one blob) and **modified renames** (content changed during the move — the successor's
blob no longer equals the ref's) do not resolve; the stale path is reported alone rather than a
guess. Full successor resolution for modified renames needs the checkpoint diff / Git `-M`
evidence and belongs to the retargeting slice.

**Read-only contract**: `detectDrift` never advances `last_ingested_commit`, never touches memory
status, and writes nothing — the package tests inject a read-side double whose every WRITE
method throws, and the end-to-end test asserts the checkpoint stayed null and the memory stayed
`active` after drift ran.

**Report shape** (core port, minimally extended): `DriftedMemory { memory_id, changed_paths, refs }`
where each `DriftedRef` carries `repository_id`, `path`, `reason` (the three semantics above,
distinguishing retained-unavailable from missing as instructed), and optional `successor_path`.
`changed_paths` keeps the original contract (every stale ref path, plus resolved successors,
unique and sorted). One memory drifting in several repositories reports once with merged refs.

**Documented degradation**: snapshot metadata persisted before this slice carries
`skipped_count` but not the skipped set; for those rows drift compares retained blobs by value
until the repository's next `saveSnapshot` records the set (in the saveSnapshot → detectDrift
pipeline shape that gap cannot persist). The behavior is pinned by a test with this comment.

## Dependency reuse

No new third-party dependencies, no new Git argv, no SQL outside `packages/storage`. Drift reuses
the landed `CodeMemoryStore` port (M4b) for every read; rename pairing reuses codememory's own
conservative exact-match rule from `compareSnapshots`; suspicion reuses the capture's honest
`skipped` set that `saveSnapshot` already retained rows for. The deferred research items
(`git diff-files` event scan, staged `--cached` view, symlink M/T events, `-l` rename limit)
remain deferred: this slice deliberately compares persisted fingerprints instead of re-scanning,
so none of those argv contracts are exercised yet.

## Validation

- All three touched packages typecheck clean under strict TS (`bun run typecheck`):
  `core`, `storage`, `codememory`.
- Focused: `packages/codememory` suite 30 pass / 1 skip / 0 fail (31 tests — the skip is the
  expected Linux-only non-UTF-8 filename fixture on macOS); of those, 11 are the new drift tests
  (10 over a programmable read double with real Git/filesystem fixtures + 1 end-to-end over real
  `createEmbeddedDb` PGlite with real capture → saveSnapshot → recordCodeRefs → detectDrift and a
  network-guard assertion of zero calls).
- `packages/storage` embedded leg: 24 pass / 17 server-gated skips / 0 fail (41 tests), including
  the new `codeMemoryRefsScenario`.
- Server leg (Docker `pgvector/pgvector:pg17` on 127.0.0.1:55433, removed after the run):
  storage suite **39 pass / 0 fail** (441 assertions) with both legs enabled — the new scenario
  passes on real Postgres too.
- Full worktree suite: **910 pass / 19 skip / 0 fail** (929 tests, 70 files) against the
  898/18/0 baseline; the +1 skip is the new server-gated scenario running without `ONEMEMORY_PG_URL`.

## Explicitly not complete

Still pending in M4 (later slices, not placeholders here): audited stale-memory application
(detectDrift reports; the pipeline applies `stale` + `memory_events` audit), `memory_code_refs`
retargeting along resolved successors (and ref-set pruning, which is why no delete API was added),
minimal re-index jobs (`drift_scan`/`reindex` job kinds exist; nothing enqueues them yet),
checkpoint advancement (`last_ingested_commit` still never moves — nothing processes changed
knowledge end to end yet), symbol-level drift (`code_symbols`), architecture digests, and the
research-deferred event-scan argv contracts. The coordinator-owned `docs/architecture/` still
describes this table accurately (no tier column, worktree-pinned drift query); this mission links
to it rather than editing it.
