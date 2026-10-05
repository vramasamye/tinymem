# Mission 14a: session-end working-memory lifecycle

Branch: `mission/14a-session-sweep` · Base: `5c20159` (main) · Closes the Phase-2 definition-of-done
gap in `docs/plan/phased-plan.md` ("Session lifecycle: session end sweeps working memory with
promotion filter") and parity memo §5 Tier A item 1
(`docs/research/supermemory-parity-status-2026-10-05.md` §3 row 22: "wire the existing
`sweepWorking` primitive to session end").

## Scope delivered

A session end observed through the ingest pipeline now runs the documented session-end lifecycle
pass (memory-model.md §10) for that session. Adapters already emit `session.start` / `session.end`
and storage already exposed every primitive (`createSession`, `listWorking`, `insertMemory`,
`markWorkingPromoted`, `sweepWorking`) — this mission is the missing orchestration, composed
entirely from existing Store port APIs (no `packages/**` changes, no migration, no new dependency).

1. **Record the end** — the `sessions` row is upserted with `ended_at` (and the end summary when
   the event carried one) through `Store.createSession`, the existing upsert.
2. **Promotion** — working rows for the ended session that pass a deterministic, testable filter
   become durable **episodic** memories through `Store.insertMemory` — the audited create path
   (the repository writes the `created` audit row in the same transaction) — with provenance
   carried **verbatim** from the working row: its `source_id`, its evidence spans, its
   importance/confidence, and its `created_at` as `observed_at`/`valid_from`. Each promoted row is
   then marked via `Store.markWorkingPromoted`. Nothing is re-derived or invented (AGENTS.md rule 8:
   a working row without source + evidence is never promoted).
3. **Sweep** — expired unpromoted rows are purged via `Store.sweepWorking`; promoted rows survive
   by the purge predicate (`promoted_memory_id IS NULL`, database-schema.md §2).

## Design decisions

### The promotion filter (deterministic, documented in `session-lifecycle.ts`)

A working row is promoted iff **all** of:

| # | Gate | Why |
|---|---|---|
| 1 | `promoted_memory_id IS NULL` | idempotency guard — never promote twice |
| 2 | `source_id` is present | a durable memory's `source_id` is mandatory; the pass never invents an anchor from elsewhere |
| 3 | `evidence` has ≥ 1 span | the durable provenance invariant (ADR-0003 rule 4), checked before the write instead of letting `insertMemory` throw |
| 4 | `importance ≥ 0.5` | the documented session-end threshold (memory-model.md §10) |

memory-model.md §10 specifies "importance ≥ 0.5 **OR explicitly flagged by user/agent**"; working
rows carry no flag field, so the flag arm is explicitly not implemented (follow-up 3). **Confidence
is deliberately not gated**: §10 specifies no confidence threshold for working-memory promotion
(the §6 0.7 threshold is the preference-candidate rule), and the row default (0.4, set by
`insertWorking`) is simply carried to the durable memory.

**Promoted type is `episodic` for every working kind.** A working row is a single session
observation: semantic memories are never created from single observations (ADR-0003 rule 7), and a
decision candidate without alternatives + rationale "remains an episodic note" (memory-model.md §9)
— so `task`, `hypothesis`, `current_file`, `current_error`, `temp_decision` and `open_question` all
promote as episodic notes carrying their session provenance. Tags `['promoted', 'working:<kind>']`
and `extraction.prompt_version = 'session-sweep-v1'` (the `EXPLICIT_PROMPT_VERSION` precedent: the
label says what ran — no model runs in this pass; the local-first invariant holds).

### Trigger point: inline in the ingest path

`ingestEvents` (`memory-service.ts`) collects `session.end` observations for events that were
**stored or duplicate** (deduped by session id — one pass per distinct session per batch), then —
after enqueueing the normalize job — runs one `runSessionEndLifecycle` pass per session. The pass
runs inline rather than as a job: the job-queue vocabulary (`JOB_KINDS` in `@onememory/core`) has
no session-sweep kind, the pass is DB-only and bounded by the session's working rows. A
`session.end` without `scope.session_id` warns ("no session-end lifecycle pass can run") and runs
nothing. The pass summary rides the existing `warnings` channel of `IngestResult` — the only field
that can carry it without a type change (`types.ts` and the OpenAPI schemas are
coordinator-owned):

```
session-end lifecycle for session <id>: promoted N (inserted X, linked_existing Y),
skipped S (promotion filter), failed F, expired_purged P
```

### Idempotency mechanism

Reprocessing the same session end — a duplicate end event, or a *different* end event for the same
session — never duplicates promotions and never purges promoted rows:

1. **Duplicates deliberately re-trigger the pass** (a stored *or* duplicate `session.end` is an
   observation). This heals a crash between "event stored" and "pass ran", and picks up working
   rows the async extraction pipeline inserted after an earlier end was observed.
2. **Already-promoted rows are skipped** by filter gate 1 (`listWorking` returns them; the pass
   never re-promotes).
3. **Exact-content collapse**: if a durable memory with the same `(project, type, content_hash)`
   already exists (a crash between `insertMemory` and `markWorkingPromoted`, or a concurrent pass),
   `insertMemory` returns `outcome: 'duplicate'` with `memory` holding the existing row — the
   working row is then linked onto that memory, so no second durable memory is ever created.
4. **The sweep's predicate** (`expires_at ≤ now AND promoted_memory_id IS NULL`) structurally
   preserves promoted rows, including promoted-but-expired ones.

Per-row promotion failures are caught and recorded (`failed`, bounded `failures`, surfaced in the
summary line) so one bad row cannot block the rest of the session's promotions; structural failures
(session upsert, working list, sweep) propagate — a client retry re-runs the idempotent pass.

## Files changed

| File | Change |
|---|---|
| `apps/api/src/runtime/session-lifecycle.ts` | **new** — the lifecycle pass: `promotionDecision` (the deterministic filter), `runSessionEndLifecycle` (record end → promote via audited `insertMemory` → link via `markWorkingPromoted` → sweep via `sweepWorking`), `PROMOTION_IMPORTANCE_THRESHOLD`, `SESSION_SWEEP_PROMPT_VERSION` |
| `apps/api/src/runtime/memory-service.ts` | ingest wiring (≈50 lines): collect `session.end` observations in the loop, warn on missing session id, run one pass per distinct session after the normalize-job enqueue |
| `apps/api/src/runtime/session-lifecycle.test.ts` | **new** — 9 tests / 80 assertions (below) |

Commits: `7076bcb` (test, red), `7c12069` (feat, green), this report.

## Validation

All against real embedded storage (PGlite in a temp dir, `openRuntime`, worker off so the async
extraction pipeline stays parked while the synchronous pass is exercised deterministically).

- New file `session-lifecycle.test.ts`: **9 pass / 0 fail** —
  the filter (threshold boundary ≥ 0.5; no provenance / below threshold / already promoted rejected);
  ingest → promotion (one durable episodic memory with carried source/evidence/scores/observed_at,
  `created` audit row, filtered rows left working); idempotency (duplicate event + second end
  event → one memory, same link, promoted row survives every sweep); sweep (expired unpromoted
  purged, promoted-expired survives); sessionless end (warns, runs nothing); two ends in one batch
  (one pass each); direct pass (session row recorded, `started_at` preserved by the upsert, exact
  content linked onto the existing durable memory) and skip-reason breakdown.
- `apps/api` package: **76 pass / 0 fail** (baseline 67; +9).
- Full suite at the worktree root: **1064 pass / 22 skip / 0 fail** (1086 tests, 82 files, ~221 s).
  Baseline at base `5c20159` was 1055 pass / 22 skip / 0 fail: **+9 pass, nothing regressed**. The
  22 skips are the Postgres-gated storage legs (need `ONEMEMORY_PG_URL`) and the env-gated local
  embeddings run — skipped by design; no new skips.
- `bun run typecheck` (`tsc --noEmit`, strict) in `apps/api`: **clean**.

## Explicitly out of scope / follow-ups for the coordinator

1. **Async-extraction lag (the honest sequencing edge).** Working rows are created by the async
   `extract` job; if the daemon has not yet processed a session's earlier events when its end is
   ingested, those rows miss this pass and are picked up only by a later re-run (duplicate end
   event or a later end for that session). The structural fix — triggering the pass from the
   extract handler when it processes a `session.end` group, or a `session_sweep` job kind — lives
   in `packages/extraction` / `packages/core`, outside this mission's file ownership.
2. **`createSession` upsert can wipe the recorded end (pre-existing storage semantic).** The upsert
   sets `ended_at`/`summary`/`stats` unconditionally from `EXCLUDED`, so a later `createSession`
   call without them (the extract handler's per-batch upsert, when working candidates for an
   already-ended session arrive) nulls the recorded `ended_at`. Promotions are unaffected
   (`working_memory` rows are not touched by that upsert). Fix belongs in `packages/storage`
   (coalesce `ended_at` to the max); likewise, no `getSession`/`listSessions` read port exists, so
   the pass returns the upserted row rather than re-reading it.
3. **The "explicitly flagged by user/agent" arm of the §10 filter** needs a flag field on
   `working_memory` (schema + migration, coordinator-owned).
4. **`IngestResult` has no dedicated lifecycle field** — the summary rides `warnings`; a proper
   field means touching `types.ts` + the OpenAPI schemas + `IngestResponseSchema`.
5. **`user_id`/`agent_id` are not carried** onto promoted memories (working rows hold neither and
   there is no session read port); promoted memories are project-scoped via the ingest endpoint's
   authoritative project.
6. **The sweep is global** (`sweepWorking` takes no session filter — by design in storage): each
   pass purges expired unpromoted rows across all sessions. Rows of an ended session whose TTL has
   not expired yet are purged by the *next* session-end observation anywhere; a scheduled decay/
   sweep job remains M14 backlog ("decay/archive scheduler").
7. **The pass does not update `sessions.stats`** with promotion counts (no writer reads it today);
   the audit trail + `warnings` summary are the surfaces.

## Coordinator review amendments (2026-10-05)

Post-review (standards + spec, two independent reviewers) fixes applied on the branch before
merge (`54f635a`):

- promoted token estimates reuse `estimateTokens` from `@onememory/retrieval` (the sibling
  durable-write path's estimator) instead of a local `content.length / 4`;
- `SessionEndLifecycleResult.skipped_total` is computed by the pass, so callers cannot undercount
  by omitting a skip reason;
- the unused injectable-clock option was removed (no caller, no test) and the ingest warning now
  labels `expired_purged` as the global TTL sweep it is;
- storage follow-up 2 was resolved by the coordinator after merge (`4460cd3`): `createSession`
  coalesces `ended_at`/`summary` newest-non-null-wins on conflict — a later explicit end
  overwrites (not max(), as suggested below: newest non-null is the auditable rule), a start-only
  upsert never erases.

Follow-ups 1, 3–7 are recorded in `docs/backlog/issues.md` under "raised by M14a".
