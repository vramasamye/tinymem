# Mission 3d: decision/failure payload persistence (STORE wiring)

Branch: `mission/3d-payload-persistence` · Base: `a103665` (main) · Closes the STORE-stage
deferral in `docs/plan/mission-reports/mission-3b-decision-failure.md` ("`decisions`/`failures`
payload rows are not written yet") · Extends
`docs/plan/mission-reports/mission-3c-tool-incidents.md`

## Scope delivered

The typed payloads the extraction stage already computes now reach the `decisions` / `failures`
tables and come back on the memory read paths. Nothing is re-derived from prose at STORE time:
every value is a field the extractor (or the engine's own signature computation) observed.

- **STORE contract** (`packages/core/src/schema/persistence.ts`): `NewMemory` gained an optional
  `payload`, validated by `NewMemoryPayloadSchema` (union of the two store projections) and
  type-keyed by a `superRefine`: a `decision` memory may carry only a decision payload, a `failure`
  memory only a failure payload, every other type carries none. Absent `payload` = no payload row,
  so every existing caller is unaffected. `SupersedeInputSchema` inherits the same contract through
  `NewMemorySchema`.
- **Store projections** (`packages/core/src/schema/memory.ts`): `DecisionStorePayloadSchema` =
  the wire `DecisionPayloadSchema` minus its `evidence` echo (the `decisions` table has no evidence
  column — evidence is the owning memory's provenance, re-attached on read);
  `FailureStorePayloadSchema` = the wire schema with `signature_hash` **required** (the
  `failures.signature_hash` column is `NOT NULL`). `DecisionPayload.rationale` and
  `FailurePayload.signature_hash` became honest-optional on the wire: unknown rationale is absent,
  and a pre-M3d record may legitimately have no fingerprint.
- **Atomic write** (`packages/storage/src/repositories/payloads.ts`, `memories.ts`): the payload row
  is inserted on the caller's transaction, after the `memories` row and before the creation audit
  row — memory + payload + audit commit or roll back together.
- **Read hydration** (`payloads.ts`, `row-mappers.ts`): `getMemory`, `queryCurrent`, `queryAsOf`,
  `historyOf` (and `insertMemory`/`supersede` results) hydrate payloads with **one batched query per
  type** (`= ANY($1::uuid[])`), never per memory.
- **Extraction → STORE mapping** (`packages/extraction/src/enrichment/store-payload.ts`, wired in
  `handlers/extract.ts`): one mapping shared by the heuristic and LLM paths, driven by the
  candidate's cited normalized events.

## Model / input mapping

Decision payload (from `candidate.decision_payload`):

| Column | Value |
|---|---|
| `title` | `candidate.title?.trim()` or, when empty, the decision text |
| `decision` | `decision_payload.decision` |
| `alternatives` | `decision_payload.alternatives` (verbatim) |
| `rationale` | `decision_payload.rationale` **when the extractor captured one**; otherwise `NULL` |
| `participants` | `[]` — neither extractor path observes participant identity, so none is invented |
| `decided_at` | the memory's `observed_at` |
| `status` | `'proposed'` — the memory lifecycle (`memories.status`) is a different axis; promotion is consolidation work |

Failure payload (only when the candidate carries a `failure_signature` **and** a cited event
reproduces that engine-computed hash; otherwise no payload row is written rather than a fabricated
one):

| Column | Value |
|---|---|
| `problem` | the cited incident's `label` |
| `context` | JSON text of the observed fingerprint inputs: `type`, `normalized_message`, `origin`, plus `error_origin` / `tool` / `command` / `detail` only when the event actually carried them |
| `root_cause` | never set — neither path establishes one |
| `solution`, `verification` | only from a **cited, correlated** success (see below); otherwise absent |
| `status` | `'open'` with no recovery; `'verified'` for a same-command exit-0 retry or a same-framework green rerun; `'mitigated'` for a same-tool successful result (tool name alone is not proof the failing operation was repaired) |
| `signature_hash` | `candidate.failure_signature.hash`, stored exactly as the engine computed it |
| `first_seen_at`, `last_seen_at` | the failure event's `occurred_at` — the only observed time for the incident |
| `occurrence_count` | `1` (see cuts) |

**Recovery correlation** (`recoveryFor`, deliberately stricter than "something later succeeded"):
strictly later `occurred_at`, **same session**, and then one of — the same command text exits 0
(or the failing error's own context names that exact command), or the same test framework reruns
green, or the same named tool result flips `ok: false → true`. Everything else leaves the failure
`open`.

## Transaction, dedupe and read semantics

1. **Dedupe before insert** is unchanged: same-scope `(project, user, type, content_hash)` probe
   first.
2. **The 23505 race fallback became `ON CONFLICT … DO NOTHING RETURNING id`.** A 23505 aborts a real
   PostgreSQL transaction, so the old catch-and-re-probe could not work inside one; `DO NOTHING`
   keeps the transaction usable, and zero returned rows triggers the same re-probe that reports the
   winner as `duplicate`. A conflict winner that somehow disappears is a hard error, never a silent
   insert.
3. **Duplicates never rewrite a payload** — a retry with different rationale/evidence returns the
   stored row byte-for-byte, appends no audit row. **Legacy duplicates are not backfilled** from a
   later retry's different evidence.
4. **Payload failure rolls back the whole write**: the integration scenario writes a memory whose
   payload title contains `\u0000` (a DB-level error that arrives *after* the `memories` INSERT) and
   asserts the memory row **and** its audit row are gone on both profiles.
5. Supersede keeps its semantics: winner insert (with payload) + loser close in one transaction,
   `winner-duplicate` short-circuits and changes nothing, and PIT/history return each version's own
   payload.
6. `search.ts` was **not** touched: search-result rows still come back without `payload` (see cuts).

## Defect found and fixed: server-profile transactions never opened

The cross-profile rollback assertion above failed on real PostgreSQL: the memory row survived a
rejected payload insert. Root cause was not the payload work but the driver —
`ServerDatabase.transaction` (commit `cc9c1aa`, the original storage commit) called
`work(txDatabase)` **directly**, bypassing `ServerClientDatabase.transaction`, so `BEGIN` /
`COMMIT` / `ROLLBACK` were never issued on the server profile: every repository "transaction" on
the canonical deployment ran in autocommit, and a mid-write failure left a partial write behind
(supersession, purge, purge+audit, insert+audit — all multi-statement writes).

Fix (its own commit, `packages/storage/src/drivers/server.ts`): delegate to
`txDatabase.transaction(work)`, which runs the same BEGIN/COMMIT/ROLLBACK and nested-SAVEPOINT
protocol as the embedded driver. Verified by the rejected-payload probe (memory rows: 1 → 0) and
by the whole suite: the fix is also what makes the `ON CONFLICT … DO NOTHING` race path correct
rather than accidental, and no existing test regressed.

## Files changed

| File | Change |
|---|---|
| `packages/storage/src/drivers/server.ts` | **fix**: server transactions run inside BEGIN/COMMIT/ROLLBACK (separate commit) |
| `packages/core/src/schema/memory.ts` | optional `rationale`; `DecisionStorePayloadSchema`; optional wire `signature_hash`; `FailureStorePayloadSchema` |
| `packages/core/src/schema/persistence.ts` | `NewMemoryPayloadSchema`; `NewMemorySchema.payload` + type-keying `superRefine` |
| `packages/core/src/schema/persistence-payload.test.ts` | new — accept/reject matrix for both store schemas and `SupersedeInputSchema` |
| `packages/storage/src/repositories/payloads.ts` | new — `insertPayload` (same tx) and batched `payloadsForMemories` |
| `packages/storage/src/repositories/memories.ts` | `ON CONFLICT … DO NOTHING` dedupe, payload insert, hydrated read paths |
| `packages/storage/src/repositories/row-mappers.ts` | optional `payload` argument on `mapMemoryRow` |
| `packages/storage/src/integration/scenarios.ts` | new cross-profile scenario: atomic write + rollback, batched reads on all four read paths, `signature_hash` SQL query, supersede winner payload, winner-duplicate no-op, no legacy backfill, race (sequential on embedded / concurrent on server) |
| `packages/extraction/src/events.ts` | `NormalizedCommand.output_digest` (the factual proof a passing command carries) |
| `packages/extraction/src/enrichment/store-payload.ts` | new — candidate + cited events → store payload |
| `packages/extraction/src/enrichment/store-payload.test.ts` | new — golden verified, test verified, tool mitigated, uncited/different-args stays open, hash mismatch → no payload |
| `packages/extraction/src/handlers/extract.ts` | normalizes the batch once and passes `storePayloadFor(...)` into `insertMemory` |
| `packages/extraction/src/events.test.ts` | expectation updated for the new normalized field |
| `apps/api/src/runtime/payload-persistence.test.ts` | new — real INGEST → EXTRACT → STORE → read acceptance for heuristic **and** fake-LLM extractors |

No new dependency (`bun.lock` untouched). No migration: the `decisions`/`failures` tables already
existed; this mission changes which rows are written and read.

## Validation

- Storage integration suite, embedded (PGlite) **and** server (Postgres 17 + pgvector, throwaway
  container at `127.0.0.1:55441`): **45 pass / 0 fail** (`/tmp/onemem-m3d-server2.log`). The new
  payload scenario is the regression test for the driver fix.
- `packages/extraction`: **135 pass / 0 fail** (M3c baseline 132; +3).
- `apps/api`: **66 pass / 0 fail** (baseline 64; +2 acceptance cases).
- Full suite at the worktree root: **1034 pass / 22 skip / 0 fail** (1056 tests, 80 files,
  `/tmp/onemem-m3d-full3.log`). Base was 1025 pass / 21 skip / 0 fail (1046 tests, 77 files): +9
  passes, +1 skip (the environment-gated server-profile leg of the new scenario), +3 files.
- Typechecks (`tsc --noEmit`, strict) — core, config, embeddings, extraction, llm, mcp, retrieval,
  security, storage, codememory, adapters/claude, adapters/codex, apps/api, apps/cli: **14/14
  clean** (`/tmp/onemem-m3d-typechecks2.log`).
- Acceptance evidence (`apps/api/src/runtime/payload-persistence.test.ts`, both extractor paths over
  the same ingested transcript): an `INGEST → EXTRACT → STORE` run yields
  `decision.payload = { decision: 'Drizzle', alternatives: [{option:'Prisma'},
  {option:'Kysely', why_rejected:'the team already knows Drizzle'}],
  rationale: 'Drizzle generates plain SQL migrations', participants: [], status: 'proposed' }` with
  `payload.evidence === provenance.evidence`, and
  `failure.payload = { problem, context: {type:'TEST_FAILURE',
  normalized_message:'bun: saves rows | reads rows', origin:'test', tool:'bun'}, solution:
  'Successful bun test rerun', verification: 'bun: 5 passed, 0 failed', signature_hash:
  '74062a795a33e048', first_seen_at === last_seen_at === '2026-10-03T09:00:05.000Z',
  occurrence_count: 1 }`, with `root_cause` absent. Every returned record validates as
  `MemoryRecordSchema`, and re-running the extract job inserts 0.

## Explicitly out of scope / follow-ups

1. **No recurrence counting.** A repeated failure signature inserts a new memory (its content
   differs) with `occurrence_count: 1`; matching an existing row and bumping the counter is
   consolidation work (M14), not STORE. Consequently `first_seen_at === last_seen_at` for every row
   written here.
2. **No backfill of legacy duplicates.** A pre-M3d memory retried with a payload keeps its
   payload-less row; the retry does not rewrite it.
3. **Retrieval search results are not hydrated** (`packages/storage/src/repositories/search.ts`
   still maps rows without payloads) — that file belongs to the retrieval mission. `memory_search`
   snippets return no `payload`; `memory_get` and the list/query/PIT/history paths do.
4. **Embedded driver concurrency limit (pre-existing, not fixed).** `EmbeddedDatabase` tracks
   nesting depth on the instance, so two overlapping root transactions on one PGlite handle are
   unsupported; the race case is therefore sequential on embedded and `Promise.all` on server. Only
   one process may own a PGlite data dir anyway (risk D1).
5. **Tool recovery is `mitigated`, not `verified`.** Same-tool-name success is recorded as observed
   mitigation; `call_id` correlation that would prove the failing call was repaired is still
   deferred (M3c follow-up 2).
6. **`context` is a JSON string in the existing `text` column.** The signature inputs live there as
   canonical structured JSON; a dedicated `jsonb` column would be a schema change of the payload
   table, not needed for this wiring.
7. **No skill payload.** `skills` is not memory-keyed, so `NewMemory.payload` covers decisions and
   failures only.
8. **Coordinator-owned architecture docs were synchronized after merge** (missions do not edit
   `docs/architecture/`): `event-memory-schemas.md` now records STORE persistence, hydrated memory
   reads versus search results, optional `rationale`/wire `signature_hash`, and provenance-backed
   decision evidence; `memory-model.md` reflects the actual `decisions` columns and atomic payload
   writes.
