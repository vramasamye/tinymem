# Mission 14f: events compaction

Branch: `mission/14f-events-compaction` · Base: `ae24030` (main) · Closes backlog M14.6
(docs/backlog/issues.md §M14 item 6: "Events compaction (summarize → `sources`, purge raw payload
after retention window)"; docs/plan/phased-plan.md Phase 3 "M14.6 (events compaction) remain open
scope") · Feeds the architecture's retention policy (docs/architecture/database-schema.md §6
"Events table compaction: raw payloads older than N days (default 90) are summarized into
`sources` and purged — evidence spans survive, raw chatter doesn't. Configurable; 0 = keep
forever").

## Scope delivered

The M14.6 events-compaction pass, end to end: a storage migration (`memory_events_digest`), the
core `EventsCompactor` port, the SQL implementation, a pure planner + orchestrator in
`packages/consolidation`, and the `onemem compact` CLI command. The pass summarizes raw `events`
rows older than the **summary window** into one digest row each, and deletes raw rows older than
the **retention window** — only after their digest summary exists (the DELETE itself carries an
`EXISTS` guard inside the same transaction), and only when the pipeline finished the event cleanly.

### What "events compaction" compacts (the interpretation, stated plainly)

The mission brief said "a compaction pass over `memory_events`". The compacted table is the raw
**`events`** log — the append-only record of agent chatter whose `payload` jsonb is the "raw
payload" every source names: the backlog line, database-schema.md §6, and the AC details
(`kind`, `event_id`, raw payload) all identify it, and `memory_events` has none of those columns.
The **`memory_events` audit trail is NOT compacted** — ADR-0007 rule 6 makes it the append-only
audit of every state change ("any claim the engine makes is inspectable"), and
database-schema.md §6 leans on it as the record of every transition. Deleting audit rows would
contradict a standing ADR (AGENTS.md ground rule 1), so the audit trail stays append-only and the
digest table carries the AC-2 name `memory_events_digest` — the surviving lineage record of the
raw events. If audit-row compaction is ever truly wanted, it needs an ADR amendment first; the
proposed amendment below (and its `memory_events` clause) is the coordinator's to adopt or reject.

`sources` rows are also never touched — memory-model.md §6 makes them the durable anchors
"retained even if the raw event payload is compacted"; compaction preserves them as the stable
side of every provenance chain.

## The chosen summary-table strategy (AC 2 — "pick one and document")

**Decision: a new `memory_events_digest` table, one digest row per raw event, unique on
`event_id`** — not an extension of `sources`.

| | `memory_events_digest` (chosen) | extend `sources` (rejected) |
|---|---|---|
| `event:<id>` locator resolution | 1:1 — a purged event id resolves to exactly one digest row | no natural key; sources are per-session/per-document, one source covers many events |
| `sources` semantics | stays the stable provenance anchor memory-model.md §6 specifies | would conflate the durable anchor with the retention payload it is supposed to outlive |
| growth | bounded one-line summaries; the raw payload's byte size is the audit of what was removed | summaries would pile into a jsonb array on a row that must never be rewritten |
| idempotency | `UNIQUE(event_id)` + `ON CONFLICT DO NOTHING` — summarize-once is structural | no unique event key on sources to enforce it |
| naming | matches the AC-2 name and the `memory_events` family | would stretch `sources.kind`/`metadata` beyond the schema vocabulary |

Trade-off, documented: database-schema.md §6's normative intent sentence says "summarized into
`sources`" — the shipped strategy keeps the intent (evidence spans and source lineage survive;
raw chatter doesn't) but lands the summary in a dedicated FK-less table. The digest carries the
source linkage denormalized (`source_ids` — the distinct `sources` whose evidence spans, in
`memories.evidence` and `edges.evidence`, anchor the event), so the digest row answers "which
sources referenced this compacted event" without the raw row. **This is the docs/architecture
edit the coordinator needs to make** (see Follow-ups); the proposed ADR amendment below states it.

### The digest row (migration `0002_events_digest`, drizzle-kit generated)

`id`, `event_id` (UNIQUE), `kind`, `runtime`, `adapter_version`, `project_id`, `session_id`,
`agent_id`, `user_id`, `content_hash` (the events dedupe-key member, preserved verbatim),
`occurred_at`, `ingested_at`, `summary` (bounded one-liner), `payload_bytes` (the audit of what
was purged), `redactions_count` (ADR-0007: counts only — kind/location/length never content),
`source_ids uuid[]`, `created_at`. **FK-less by design, like `memory_events`**: the digest must
outlive the `events` row it summarizes — that is its entire purpose — so nothing may reference or
cascade into it, and nothing in the schema references `events` by FK, so purging breaks no FK.

## Design decisions

### Two windows, one invariant: summarize before purge

- **`summaryWindowDays`** (default 30, floor 1): events older than this get a digest row; the
  raw row stays (the digest is a preview, not a substitute) until retention.
- **`retentionWindowDays`** (default 90 — database-schema.md §6's normative N; **0 = keep
  forever**): events older than this get their raw row deleted — only if a digest exists and the
  pipeline finished cleanly. `0` disables purging entirely while the summarize tier still runs.
- The boundary schema enforces `summaryWindowDays ≤ retentionWindowDays` (unless retention is
  0): a purge fires only after its summary exists, so the summary can never arrive later than
  the purge.
- **Blocked events are never silently retained-or-purged**: a raw row the pipeline never
  consumed (`unprocessed`), flagged `needs_review`, or errored (`process_error`) is kept — the
  raw row is the pipeline's work order — and the report carries the reason and a count.

### The pure decision (AC 1)

`packages/consolidation/src/compaction/plan.ts` — no SQL, no clock reads: `compactionCutoffs`
derives both cutoffs from the injected clock; `classifyEvent` rules the per-event matrix
(`summarize` / `summarize_and_purge` / `purge` / `keep` + reason); `planBatch` counts every tier
and separates the blocked keeps. The brief named the entry `runEventsCompaction({now,
retentionWindow, summaryWindow})`; the executing entry (`runEventsCompaction`) takes the
injected clock as `now()` and the windows as `config.summaryWindowDays` /
`config.retentionWindowDays`, and its per-batch decision IS the pure planner — the same
classification is exported and unit-tested directly (the matrix, 14 tests).

### Execution: bounded, idempotent, one transaction per batch

The scan is a keyset pagination over `(occurred_at, id)` — every row is visited at most once per
pass (summarize-only rows stay put; the cursor still advances), bounded by `batchLimit`
(default 500) per transaction and `maxEventsPerRun` (default 5000) per run. A capped run reports
`truncated` honestly and the next pass resumes (idempotent re-entry). Each batch applies as ONE
transaction: digest insert (`ON CONFLICT (event_id) DO NOTHING` — a crashed pass re-runs cleanly)
then raw DELETE behind the `EXISTS` guard — the SQL itself refuses a summary-less purge, so the
"after the audit summary is written" ordering is structural, not caller discipline. Degradations
(blocked purges, capped plan detail, the per-run cap, a failed batch — which rolls back whole)
surface as report warnings, never silent; `dryRun` plans the identical batches and mutates
nothing.

### The summary line: reuse, not a new vocabulary

`digestSummaryLine` reuses extraction's `eventTextForMatching` over `storedEventToEnvelope` — a
digest reads exactly like the event line the pipeline already produces (`[user] …`,
`$ cmd → exit 0 …`, `commit sha: msg`), bounded to 400 chars. It is total: a row ingested by an
older schema version that fails envelope re-validation falls back to the bounded JSON of its
payload — a maintenance pass never loses an event's lineage over it.

## Files changed

| File | Change |
|---|---|
| `packages/core/src/types/retention.ts` | new — the M14.6 contract: `EventsCompactor` port, config schema + defaults (`EventsCompactionConfigSchema`, 30/90 windows, batch bounds), `NewEventDigestSchema` + `EventDigestRecord`, the typed plan + report documents |
| `packages/core/src/index.ts` | +1 export line for `./types/retention` |
| `packages/storage/migrations/0002_events_digest.sql` | new — drizzle-kit generated (journal entry + `0002_snapshot.json` in `meta/`) |
| `packages/storage/drizzle.config.ts` | schema now `['./src/schema/tables.ts', './src/retention/tables.ts']` — the retention tables join the one migration set |
| `packages/storage/src/retention/tables.ts` | new — the `memory_events_digest` drizzle definition (FK-less, `event_id` unique, scope index) |
| `packages/storage/src/retention/events-compaction.ts` | new — the port implementation: keyset scan, digest probe, evidence-span source linkage, one-transaction apply with the EXISTS purge guard, ceiling count, digest lookup |
| `packages/storage/src/retention/events-compaction.scenarios.ts` | new — the shared retention scenarios (both deployment profiles) |
| `packages/storage/src/retention/events-compaction.test.ts` | new — the embedded runner (5 scenarios) |
| `packages/storage/src/retention/events-compaction.server.test.ts` | new — the `ONEMEMORY_PG_URL`-gated Postgres runner (5 scenarios) |
| `packages/storage/src/drivers/types.ts` | `OnememoryStorage` gains `readonly compactor: EventsCompactor` |
| `packages/storage/src/drivers/embedded.ts` / `server.ts` | bind `createEventsCompactor(client)` alongside store/jobs/codeMemory/vectors |
| `packages/storage/src/index.ts` | exports `createEventsCompactor`, the `retentionRepo` namespace, the digest drizzle table |
| `packages/consolidation/src/compaction/plan.ts` | new — the pure decision (cutoffs, classify, batch plan) |
| `packages/consolidation/src/compaction/summary.ts` | new — the digest summary builder (extraction reuse, byte audit, digest row builder) |
| `packages/consolidation/src/compaction/run.ts` | new — `runEventsCompaction`: keyset scan, pure planning, one transaction per batch, honest warnings, dry-run |
| `packages/consolidation/src/compaction/plan.test.ts` | new — 14 unit tests (the classification matrix) |
| `packages/consolidation/src/compaction/summary.test.ts` | new — 8 unit tests (per-kind shapes, bound, fallback, verbatim columns) |
| `packages/consolidation/src/compaction/compaction.integration.test.ts` | new — 11 acceptance scenarios over real PGlite + the real port |
| `packages/consolidation/src/index.ts` | exports the compaction module |
| `apps/cli/src/commands/compact.ts` | new — `onemem compact` (backend resolution, daemon refusal, window validation, report printing) |
| `apps/cli/src/bin.ts` | import + command registration + the shared `windowDays` duration parser (consolidate registration style) |
| `apps/cli/src/compact-command.test.ts` | new — 8 end-to-end CLI tests through the real `main()` |
| `bun.lock` | pre-existing drift repair only (see below) — NOT a mission dependency change |

**`bun.lock` (documented per the mission brief):** the committed lockfile was missing the
`@onememory/config` workspace edge under `@onememory/mcp` even though `packages/mcp/package.json`
declares it; `bun install` in this worktree repaired the lockfile to match the committed
manifests. No new workspace package and no new dependency were added by this mission. Committed
separately as `a690007` — the same drift was already flagged as a recurring merge issue in the M9
cross-mission follow-ups (docs/backlog/issues.md).

## Acceptance criteria: delivered vs not

1. **Pure `runEventsCompaction` deciding summarize vs purge — DELIVERED.** The decision is the
   pure planner (`planBatch`/`classifyEvent`, exported, 14-test matrix); `runEventsCompaction`
   executes it with `now` injectable and the two windows in config. Naming note: the brief's
   `{now, retentionWindow, summaryWindow}` maps to `{now: () => Date, config:
   {summaryWindowDays, retentionWindowDays}}`.
2. **Storage migration + summarize-then-purge — DELIVERED.** `memory_events_digest` (per-event
   digest rows, `event_id` unique); raw rows are purged only after the summary is written
   (same-transaction EXISTS guard — verified by a dedicated scenario); the digested event's
   `kind` and `event_id` chain are preserved (digest columns + the `event:<id>` locator
   resolution test); no FK breakage (the digest is FK-less and nothing references `events`).
3. **Invariant test — DELIVERED.** `compaction.integration.test.ts` "the lineage invariant":
   after compaction every memory still resolves its `sources` link, every `event:<id>` evidence
   locator resolves (raw row or digest), summaries are well-formed, and the digest carries the
   anchoring source ids (memories + edges evidence, deduped).
4. **Idempotency test — DELIVERED.** Same file: a second run within the same windows plans
   zeros, applies zeros, and leaves the raw count and the digest count unchanged.
5. **CLI — DELIVERED.** `onemem compact [--dry-run] [--retention-window <dur>]
   [--summary-window <dur>]`: dry-run prints the typed plan (JSON document + human text) and
   mutates nothing; otherwise it executes the batched transactions. Durations are whole days
   with an optional `d` suffix; `--retention-window 0` = keep forever; an invalid window pair
   exits 1 with `invalid_request` and the schema's message.
6. **End-to-end test — DELIVERED.** The integration suite seeds a project with 39 raw events
   (24 old-clean, 6 mid, 3 unprocessed, 2 needs_review, 1 errored, 3 young) plus memories and
   an edge anchored on the old events, runs compaction, and asserts the tier counts, the
   remaining row count (15), the blocked keeps with reasons, and the digest well-formedness.
7. **Mission report — THIS DOCUMENT.** AC 1–6 all delivered; nothing descoped.

## Validation

- `packages/consolidation` compaction tests: **33 pass / 0 fail** (22 unit — planner matrix +
  summary shapes; 11 integration over real PGlite and the real `EventsCompactor`, migrated with
  the real 0002 migration).
- `packages/storage` retention suite: **5 pass / 0 fail embedded** (scan/keyset cursor, the
  one-transaction apply + EXISTS-guard refusal, the evidence-span source linkage, digest
  readback + `UNIQUE(event_id)`, Zod boundary) and **the same 5 pass / 0 fail against a real
  Postgres 16 + pgvector container** (`ONEMEMORY_PG_URL` → throwaway `pgvector/pgvector:pg16`,
  removed after the run).
- `apps/cli`: **8 pass / 0 fail** through the real `main()` dispatch (dry-run plan contract,
  executing run, human text both modes, keep-forever windows, window rejection, no-project
  refusal, duration parser).
- `bun test packages/consolidation packages/storage packages/core`: **227 pass / 35 skip /
  0 fail** (262 tests; the skips are the Postgres-gated scenarios, this environment has no
  `ONEMEMORY_PG_URL` by default).
- `bun test apps/cli apps/api benchmarks/eval`: **238 pass / 0 fail**.
- Full repo `bun test --timeout=15000 --reporter=dots`: **1697 pass / 37 skip / 0 fail**
  (1734 tests, 137 files, ~316s). The 37 skips = 32 pre-existing Postgres-gated scenarios + the
  5 new retention server scenarios (all 5 green against real Postgres in the matrix leg). This
  mission adds 51 tests (46 in the always-on suite + 5 Postgres-gated); the remaining 1688
  passing are the pre-mission baseline, unregressed.
- Storage suite with `ONEMEMORY_PG_URL` set (server leg of the ADR-0002 matrix): **67 pass /
  0 fail** — including the 5 new retention scenarios on the server profile.
- Typechecks (`tsc --noEmit`, strict): **19/19 clean** — core, storage, consolidation, cli,
  api, benchmarks/eval, adapters (claude, codex, cursor, pi, opencode), mcp, codememory,
  retrieval, extraction, security, config, embeddings, llm.

## Proposed ADR amendment (coordinator owns ADRs — not written, per the brief)

Amend **ADR-0007** (security & privacy — provenance is its audit backbone) with one new
numbered decision, so the retention windows and the digest stop being an undocumented deviation
from database-schema.md §6's "summarized into `sources`" phrasing:

> 7. **Raw event payloads compact after two windows; the audit trail never does.** The raw
> `events` log is the only table compaction may delete from. After `summaryWindowDays` (default
> 30) a raw event is summarized into one `memory_events_digest` row — unique on `event_id`,
> FK-less so it outlives the row it summarizes, carrying `kind`, `event_id`, `content_hash`,
> scope columns, timestamps, a ≤400-char payload summary, the purged payload's byte size, the
> redaction count (counts only, never content), and the distinct `source_ids` whose evidence
> spans anchor it. After `retentionWindowDays` (default 90, per database-schema.md §6; **0 =
> keep forever**) the raw row is deleted — only when its digest exists (enforced by an EXISTS
> guard in the same transaction) and only when the pipeline finished the event cleanly
> (processed, not `needs_review`, no `process_error`). `memory_events` remains append-only and
> `sources` rows are never deleted (memory-model.md §6: the durable anchors "retained even if
> the raw event payload is compacted"). Every `event:<id>` evidence locator stays resolvable
> through the digest after compaction; a blocked event's raw row is kept and reported, never
> silently purged.

## Remaining follow-ups (coordinator)

1. **docs/architecture edits (coordinator-owned, not made here):**
   - `database-schema.md` §6: the "Events table compaction" bullet says "summarized into
     `sources`" — amend to the shipped strategy (summarized into `memory_events_digest`;
     `sources` stay untouched anchors), and add the digest table to the §2 schema listing +
     the ERD.
   - `memory-model.md` §6: optionally note the digest as the post-compaction resolver for
     `event:<id>` evidence locators (the sources sentence stays true as written).
   - Wherever evidence-locator resolution is specified (event-memory-schemas.md), note the
     digest fallback once compaction has run.
   - Backlog: mark M14.6 completed (link this report).
2. **ADR-0007 amendment** — adopt (or reject) the proposed clause above; the windows and the
   digest table are otherwise an undocumented deviation from the architecture doc's phrasing.
3. **Daemon scheduling + REST route** [P1, same shape as M14's follow-up 1]: wire a
   `compact_events` job kind (`JOB_KINDS` in core — shared vocabulary, not touched here), a
   handler around `runEventsCompaction` in `apps/api`'s runtime, and a `/v1` route so `onemem
   compact` can run while a daemon owns the data dir (today it refuses, honestly). The pass is
   already bounded, idempotent and transaction-per-batch — scheduler-ready.
4. **Config wiring** [P3, M16 scope]: a `retention:` section in `onememory.config.yaml`
   (summary/retention windows) so deployments stop relying on the CLI flags/defaults.
5. **`apps/cli/src/index.ts` export** [one line, same as consolidate]: `export { runCompact,
   printCompaction, parseWindowDays, type CompactOptions } from './commands/compact';`.
6. **Ingest dedupe probe across compaction** [P3]: after a purge, a re-delivered identical event
   re-ingests fresh (the `events_dedupe_idx` row is gone) and re-runs extraction — memory-level
   dedupe keeps correctness, at the cost of reprocessing. Extending `ingestEvent`'s probe to
   `memory_events_digest` (same `(project_id, kind, content_hash)` key is preserved there) is a
   one-query change in `packages/storage/src/repositories/events.ts` — another lane, not touched.
7. **CLI `--json` plan entry detail** [P3, cosmetic]: the typed plan caps per-event detail at
   `planEntryLimit` (100, configurable through the library config, not the CLI flags) — raise it
   only if operators ask.

## The deliverable question, answered directly

**Does `onemem compact` preserve source lineage while honoring the retention window today?**

**Yes.** `sources` rows are never touched; every purged raw event leaves a `memory_events_digest`
row carrying its `kind`, `event_id`, `content_hash`, scope and timestamps plus a bounded summary
and the anchoring source ids — so memory → evidence span → sources stays fully resolvable, and
every `event:<id>` locator resolves through the digest after the raw row is gone. The purge only
fires strictly after the retention window (default 90 days; `0` = keep forever), only after the
summary is written (SQL-enforced in the same transaction), and never for events the pipeline has
not finished cleanly — those are kept and reported.
