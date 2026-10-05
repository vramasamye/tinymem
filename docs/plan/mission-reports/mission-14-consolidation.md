# Mission 14: consolidation core

Branch: `mission/14-consolidation` · Base: `5c20159` (main) · Closes backlog M14.1–M14.4
(docs/backlog/issues.md §M14) · Feeds the Phase 3 DoD (docs/plan/phased-plan.md: "Node 20→22→24
scenario answers current vs. historical correctly; contradictions become `disputed` or supersede
with authority rules; repeated facts consolidate to one semantic memory") · Context:
docs/research/supermemory-parity-status-2026-10-05.md §3 row 3, §5 Tier A item 1 (the "dreaming"
equivalent — consolidation decoupled from ingest).

## Scope delivered

The new workspace package `@onememory/consolidation` — the CONSOLIDATE / DECAY lifecycle stages
(memory-model.md §8 stages 12–14) as one callable library entry over the existing `Store` port —
plus the `onemem consolidate` CLI command. **No new migration** (the schema already had every
status, edge relation, and audit action this mission needs; verified against
`packages/storage/migrations/0000_naive_colossus.sql`), and no edits outside the mission's files
(see "Files changed").

1. **Near-duplicate merge (M14.2)** — same scope, same type, cosine ≥ 0.97 → one survivor. Candidate
   lookup drives the existing vector search channel (`EmbeddingIndex.search`, KNN over the stored
   vectors) with the pool's re-embedded contents — no new SQL, no vector-table scans.
2. **Contradiction detection + authority resolution (M14.3)** — a deterministic, zero-model
   detector plus the authority pass: explicit > decision > newer > confidence; a full tie marks
   both memories `disputed` (never a silent pick); the winner supersedes the loser through the
   audited supersession fields (`valid_until` + `superseded_by`) and the pair is linked with a
   `contradicts` edge.
3. **Episodic → semantic derivation (M14.1)** — ≥ 3 active episodic memories, same project +
   primary entity, no contradictions among them → one semantic memory with `derived_from` edges to
   every source; LLM merge optional via the router's `consolidate` operation, templated offline
   fallback otherwise (tested; zero network by default).
4. **Decay / archive (M14.4)** — the prominence formula with the per-type half-life table shared
   with retrieval; below threshold → audited `archived`. Archive, never delete.

Library entry: `runConsolidation(options)` (`packages/consolidation/src/run.ts`) — pass the
`Store`, optionally the vector index, an embedder, and the model router; everything degrades with
explicit warnings (no embedder/index/model-or-dim mismatch → merge + derivation skip;
contradiction resolution and decay always run — they need no model and no vectors).

CLI: `onemem consolidate` (`apps/cli/src/commands/consolidate.ts`, registered in `bin.ts`) — the
same backend-resolution pattern as every other command, with one deliberate difference (below).

## Design decisions

### Authority order and ties

`compareAuthority` (pure, `src/authority.ts`) applies memory-model.md §9 in order: explicit user
statement (`provenance.source.kind === 'explicit'`) > explicit decision memory (`type ===
'decision'`) > newer `observed_at` > higher confidence. The FIRST discriminating rule decides and
is recorded on the audit row (`details.rule`); a full tie returns a tie — the caller marks both
memories `disputed`, never resolving by id or silently. One documented difference: **merge keeper
selection** (`mergeKeeperOrder`) reuses the same order but breaks an exact tie by id — a merge is
not a truth ruling (all members state the same fact), so a deterministic pick is honest there.

### Contradiction detection (the heuristic's claim shape)

Two memories contradict when they instantiate the SAME attribute template — the statement with
its scalar values blanked and normalized (`'Version: Node 22'` → `'version: node <#>'`) — but carry
DIFFERENT scalar values, in the same scope, with overlapping validity windows. This is exactly the
Node 20/22/24 family. It deliberately also treats evolving counts ("used 3 times" vs "used 5
times") as value conflicts — the newer value supersedes, which is the temporal behavior the model
wants. Not contradictions: different templates (`Version: Node 22` vs `Version: PostgreSQL 16`),
equal values, value-free restatements, different scopes, disjoint validity windows (historical
succession). The detector is a seam (`ContradictionDetector`); the LLM `conflict` router operation
can replace it for recall later — never a correctness prerequisite (memory-model.md §1.6).

Resolution runs pairs oldest-first so the Node 20 → 22 → 24 chain builds linearly (20 closed into
22 at 22's `observed_at`, 22 into 24). The resolution invariant (post-review): after the pass
processes a detected pair, exactly ONE row is current (the winner closed the loser through
audited supersession) or both are `disputed` on a full authority tie — a detected pair is never
silently left unresolved, and no cross-field temporal shape can skip the arbitration: the winner
is recomputed from the authority fields alone (an older explicit statement or decision still beats
a newer, more confident inference; an equal-time pair falls to confidence). The only temporal
choice left is WHERE the loser's window closes (`supersessionValidUntil`): at the winner's
observation when that moment falls inside the loser's window (the point-in-time handoff —
`queryAsOf` answers with the loser before it, the winner after), else at the loser's own
`valid_from` — a zero-width window (`valid_until === valid_from`) that no `queryAsOf` timestamp
ever matches: the losing claim was never valid. The audit row records which semantics closed the
loser (`details.window`). Every mutation is `store.updateMemoryStatus` (the audited transition
path the Store port documents for supersession flows — `valid_until`/`superseded_by_id` ride
along), plus one `contradicts` edge per pair, which is what retrieval's conflict labels read
(`searchRepo.contradictionNeighbors`).

### How a merge is expressed over the Store port (the important decision)

The exact-dedupe invariant — `(scope, type, content_hash)` unique — means a merge product that
restates the keeper's content IS the keeper's row (and the supersession primitive correctly
refuses to close a loser against an identical existing winner: `winner-duplicate` changes nothing).
There is also no evidence-append primitive on the port. So the SURVIVOR is the highest-authority
source row itself: every other member is closed into it (`superseded` + `valid_until` at merge time
+ `superseded_by` → the keeper — a merge absorbs a row; unlike a contradiction, the fact did not
change at the winner's observation), and the full evidence union of the cluster is recorded
verbatim on the keeper's `merged` audit event (`details.merged_from` +
`details.evidence_union`/`evidence_union_count`). Nothing is deleted: every absorbed row remains
individually queryable with its own evidence, and `historyOf` walks the chain. Repeated runs are
idempotent and self-healing (absorbed rows leave the active pool; a crash between mutations is
re-derived from the live pool; a keeper-vs-new-arrival pair re-merges with the newest statement
winning, consistent with the authority order).

Two post-review merge rules:

- **Pairwise keeper gating.** Every absorbed member must be ≥ the cosine threshold (default 0.97)
  to the KEEPER it closes into — a transitive A–B–C chain (A–B and B–C at 0.98, A–C at 0.92) does
  not qualify: B closes into keeper A, C stays active, skipped with an explicit pairwise reason.
  The gate reads `cosineComponents.pairCosine`, which records only the pairs the vector channel
  actually certified at the threshold — an absent key is "not certified", which is exactly what
  keeps a transitive chain from smuggling a distant member past the gate.
- **Arbitration before absorption.** A cluster that still contains a detector-flagged
  contradictory pair is refused outright (explicit warning, both rows left untouched) — normally
  unreachable because the contradiction pass runs first and resolves every detected pair, but a
  skipped resolution (a store error) must never turn into a silent absorption. One shared
  `ContradictionDetector` threads through the contradiction pass, the merge refusal guard, and
  the derivation cluster check so all three agree on what a conflict is.

### Episodic → semantic derivation

- **Grouping**: same scope + primary entity. A bound entity (earliest binding first — the read
  paths expose no binding roles) or, for unbound rows — the common extracted case, since
  extraction (M3) does not yet persist entity bindings — the first tech mention of the content
  (`extractTechMentions` from `@onememory/extraction`, exported for exactly this kind of reuse),
  resolved through the registry (`findEntity`) so bound and unbound rows of the same entity
  coalesce. The subject entity is created (`kind: 'other'` — consolidation cannot infer a kind)
  and bound to the derived memory (`role: 'subject'`) only at derivation time — no writes for
  memories that do not derive.
- **Clustering**: connected components by cosine ≥ `minClusterCosine` (default 0.75 — related, but
  below the 0.97 near-duplicate tier) within the group, via the same
  vector channel; components need ≥ `minClusterSize` (3 — a floor the config boundary now
  enforces, post-review) members and any contradiction among ANY
  pair disqualifies the whole cluster (skipped with a reason — never resolved by dropping
  members, which would resolve the conflict implicitly). Near-identical episodes (cosine ≥ 0.97)
  are a legitimate derivation cluster too: derivation runs BEFORE the merge (below), so three
  near-identical rows corroborate into one semantic memory first and the merge collapses the
  duplicates afterwards — the cluster members stay (keeper active, absorbed rows in history).
- **The derived memory** (`type: 'semantic'`, `subtype: 'semantic.derived'`): the representative
  member's content verbatim offline (the least-fabrication statement — an LLM produces the true
  generalization when configured, per memory-model.md §1.6 "LLM improves quality; local AI is
  never a correctness prerequisite"; the representative is the most central member — highest
  cosine sum — with ties broken by the real authority facts the source view carries from the
  record: explicit > decision > newer > confidence, then id), evidence = the union of every
  member's spans (deduped by
  source+locator+excerpt, capped at 24), provenance anchored on the representative's source,
  corroboration scores (`importance` +0.05 / `confidence` +0.1 over the strongest member, capped
  at 0.95), observed at the newest member, valid since the oldest, tags `['consolidated']`,
  extraction `{ method, prompt_version, adapter: 'consolidation' }`. `derived_from` edges to every
  source (idempotent, `ON CONFLICT DO NOTHING`); sources stay active (they are the evidence).
  The type change means the verbatim content cannot collide with the episodic rows (the dedupe
  key includes type). Idempotency: members of an existing `derived_from` edge are out of the pool;
  a crash between insert and edges is healed by the dedupe probe (the existing semantic row is
  reused and only the edges are completed).

### Decay

`prominence = effectiveImportance^0.5 × confidence × 0.5^(ageDays/halfLifeDays[type]) ×
(1 + log(1 + access_count))` — the memory-model §7 formula, with the SAME per-type half-life table
retrieval scores with (`DEFAULT_HALF_LIFE_DAYS` from `@onememory/core`: episodic 30d,
decision/failure 400d/180d…) so decay and ranking age a memory identically. The access
factor is ≥ 1 — reinforcement only ever raises prominence. Decisions and procedures with
verification evidence (`provenance.verified_at`) are decay-resistant via an importance floor
(default 0.6). Below `archiveThreshold` (default 0.05) → `store.updateMemoryStatus(id,
'archived', …)` with the full prominence decomposition in the audit details — an audited
transition, never a delete. Absorbed/superseded/disputed rows are out of the active pool by then;
their vectors are intentionally left in place (retrieval filters by status at fetch; history
stays searchable).

### Pass order and pool bounding

Contradiction → derivation → merge → decay (the post-review order; it was
merge → contradiction → derivation). Contradictions resolve FIRST — a merge must never absorb a
conflicting claim (the pair reaches dispute or authority resolution instead; the merge pass
itself also refuses a cluster that still contains a flagged pair, defense in depth), and a
derived cluster must be contradiction-free. Derivation runs BEFORE the merge: near-identical
episodes are corroborating observations — they feed the semantic memory first (`derived_from`
edges to every source), then the merge collapses the duplicates, so three near-identical rows
become ONE semantic memory instead of one keeper and no corroboration (the pre-review order
starved derivation of exactly those rows). Decay last. Each pass re-reads the live pool
(mutations from earlier passes remove members; derivation leaves its sources in the pool). The
pool is the newest `poolLimit` (default 200, max 1000 per the Store port) active memories;
`report.pool.truncated` says when the read cap was hit. Absorbed/merged/archived rows shrink the
window so later runs reach deeper, but a quiet window does not march backwards by itself — a
paginated enumeration primitive is a store-port follow-up (below).

### The CLI command and daemon mode

`onemem consolidate` resolves like every other command (loadConfig → daemon-lock probe → project
id). One deliberate difference: a LIVE daemon owns the embedded data dir (ADR-0002), and the REST
API exposes no consolidation endpoint — so the command refuses (`BackendError`, code `conflict`,
exit 1) with guidance instead of opening a second owner or racing the daemon's caches.
Direct mode opens the composition root without the job worker (like every direct-mode command)
and runs `runConsolidation` over the runtime's store, vector index, embedder, and model router.
The runtime's `null` embedder is the honest local default: the vector-dependent passes degrade
with warnings; contradictions and decay still run — verified end to end through the real CLI.

## Files changed

| File | Change |
|---|---|
| `packages/consolidation/package.json` | new — `@onememory/consolidation` (deps: core, extraction, llm, retrieval, zod; dev: storage) |
| `packages/consolidation/tsconfig.json` | new — extends the base config |
| `packages/consolidation/src/index.ts` | new — the package surface |
| `packages/consolidation/src/types.ts` | new — Zod-validated config input + resolved config + the run-report types |
| `packages/consolidation/src/authority.ts` | new — the authority ordering (pure) + merge keeper order |
| `packages/consolidation/src/cluster.ts` | new (post-review) — the shared clustering primitives: `pairKey`, `scopeKeyOf`, `cosineComponents` |
| `packages/consolidation/src/util.ts` | new (post-review) — the shared `errorMessage` |
| `packages/consolidation/src/contradiction.ts` | new — template/numeric-value heuristic, temporal overlap, the resolution pass, `supersessionValidUntil` |
| `packages/consolidation/src/merge.ts` | new — the near-duplicate merge pass (pairwise keeper gating, arbitration-refusal guard) |
| `packages/consolidation/src/derive.ts` | new — derivation builders (pure, authority-carrying source views) + the LLM/template merge + the derivation pass |
| `packages/consolidation/src/decay.ts` | new — the prominence formula (pure) + the archive pass |
| `packages/consolidation/src/run.ts` | new — `runConsolidation(options)`: pool, vector-channel guard, pass order (contradiction → derivation → merge → decay), report |
| `packages/consolidation/src/types.ts` | new — Zod-validated config input (floors enforced at the boundary) + resolved config + the run-report types |
| `packages/consolidation/src/testing.ts` | new — test doubles (table embedder, in-process index, fake router) + `MemoryRecord` fixture; exported as `./testing` |
| `packages/consolidation/src/authority.test.ts` | new — the full authority-ordering matrix (12 tests) |
| `packages/consolidation/src/cluster.test.ts` | new (post-review) — pair/scope keys + the certified-pairs-only property (5 tests) |
| `packages/consolidation/src/contradiction.test.ts` | new — template/values/overlap/scope predicate matrix + `supersessionValidUntil` (18 tests) |
| `packages/consolidation/src/decay.test.ts` | new — the formula, half-lives, access factor, resistance floor, thresholds (14 tests) |
| `packages/consolidation/src/derive.test.ts` | new — representative/union/scores/temporals, the templated merge, the LLM tier + fallback (16 tests) |
| `packages/consolidation/src/types.test.ts` | new (post-review) — the config floor rejections + defaults (5 tests) |
| `packages/consolidation/src/consolidation.integration.test.ts` | new — the Phase 3 DoD scenario over real PGlite + the real vector index (12 tests, incl. the five post-review regressions) |
| `apps/cli/src/commands/consolidate.ts` | new — the command (backend resolution, daemon refusal, report printing) |
| `apps/cli/src/bin.ts` | registration of `consolidate` only (import + command block, matching existing style) |
| `apps/cli/src/test-support.ts` | new (post-review) — the shared CLI test harness (`Captured`, `runMain`, `jsonOf`) |
| `apps/cli/src/consolidate-command.test.ts` | new — 3 end-to-end CLI tests (imports the shared harness) |
| `apps/cli/package.json` | + `@onememory/consolidation` workspace dependency |
| `bun.lock` | regenerated by `bun install` for the new workspace package |

No migration. No edits to `packages/{core,storage,retrieval,extraction,llm,embeddings,mcp,codememory,config,security}`,
`packages/adapters`, `apps/api`, existing tests, `docs/architecture`, `docs/adr`, `docs/backlog`,
or the root configs.

## Validation

- `packages/consolidation`: **82 pass / 0 fail** (70 unit + 12 integration scenarios over a
  real PGlite store and the real `EmbeddingIndex`, embedded profile; the vector fixture table
  controls every pairwise cosine, the store paths are the real ones). `tsc --noEmit` clean.
- `apps/cli`: **35 pass / 0 fail** (4 files; the 3 consolidate tests go through the real
  `main()` dispatch and the real embedded pipeline: remember two version facts → consolidate →
  inspect shows the older superseded + audited with `details.rule = 'newer'`, the newer active,
  warnings honest in both output modes). `tsc --noEmit` clean.
- Full suite at the worktree root (post-review state): **1140 pass / 22 skip / 0 fail**
  (1162 tests, 89 files, ~254s). The 22 skips are the pre-existing Postgres-gated storage
  scenarios (no `ONEMEMORY_PG_URL` in this environment — expected). The mission adds 85 tests
  (65 + 20 post-review); the remaining 1055 passing tests are the pre-mission baseline,
  unregressed.
- Storage integration suite against a throwaway Postgres 17 + pgvector container
  (`pgvector/pgvector:pg17`, `127.0.0.1:55441`): **45 pass / 0 fail** — the port-level
  supersession/transition/edge/insert behavior the passes drive is green on the server profile
  too (the consolidation package itself contains no SQL and no driver-specific code).
- Typechecks (`tsc --noEmit`, strict) across core, config, embeddings, extraction, llm, mcp,
  retrieval, security, storage, codememory, consolidation, apps/api, apps/cli,
  adapters/claude, adapters/codex: **15/15 clean**.

The acceptance scenario (`consolidation.integration.test.ts`) exercises the Phase 3 DoD anchor
end to end: the Node 20 → 22 → 24 chain resolves by authority (`historyOf` returns
[20, 22, 24] oldest-first; `queryAsOf` at mid-July answers Node 22; current answers see Node 24
only; every transition audited with `details.rule`); the authority tie becomes `disputed`
(excluded from `queryCurrent`, still stored, audited, `contradicts`-linked); the contradictory
Bun pair with IDENTICAL embeddings (cosine 1.0) is arbitrated by authority, never merged;
three near-duplicate phrasings corroborate into one semantic memory (derived_from to every
source, members retained) BEFORE the merge collapses them into their newest survivor with a
`merged` audit row carrying the evidence union; three corroborated docker observations derive
one semantic memory with the Docker entity bound as subject; the older-explicit and
equal-time-confidence pairs resolve with zero-width never-valid windows (exactly one row
current, no point-in-time view ever shows the loser); the pairwise-gated A–B–C cluster absorbs
B but not C (0.92 to the keeper); decay archives the faded note (audited, with the prominence
decomposition) while the old decision survives via the floor; a second run reports zeros
(idempotent); a no-embedder run still resolves a fresh contradiction with an explicit degradation
warning; and a contradictory cluster handed straight to the merge pass is refused with both rows
left untouched.

## Review follow-ups applied

The coordinator's independent review (post-merge) found two P1 and three P2 behavioral defects
plus code-quality items; all are fixed on this branch in focused commits
(`9e0018a`..`fffe336`), test-first:

1. **P1 — authority winners never stay silently unresolved** (`9e0018a`): the inverted-window
   skip is gone; every detected pair is arbitrated; `supersessionValidUntil` (zero-width windows
   for older-authority winners) with `details.window` on the audit row.
2. **P1 — merge no longer pre-empts arbitration** (`0c57d3a`): contradiction resolution runs
   first; the merge pass refuses detector-flagged clusters (defense in depth); one shared
   detector threads through all three passes.
3. **P2 — pairwise merge threshold** (`751c454`): keeper-gated absorption (certified cosine to
   the keeper only; transitive chains cannot merge a below-threshold member).
4. **P2 — merge no longer starves derivation** (`0c57d3a`): derivation runs before the merge —
   near-identical episodes corroborate into the semantic memory first, then the duplicates
   collapse (members retained).
5. **P2 — config floors enforced at the boundary** (`e644da3`): `MIN_NEAR_DUPLICATE_COSINE`
   (0.9) and `MIN_DERIVATION_CLUSTER_SIZE` (3) with clear messages; defaults unchanged (0.97/3).
6. **Quality — dedupe of the clustering shape, `pairKey`, `errorMessage`; renames**
   (`f24c47e`): `cluster.ts` (`pairKey`, `scopeKeyOf`, `cosineComponents`) + `util.ts`
   (`errorMessage`); `membersExceptKeeper` and `FALLBACK_HALF_LIFE_DAYS` renamed.
7. **Quality — authority facts carried in derivation source views** (`3f79f42`): explicit-kind
   sources win representative ties.
8. **Quality — the CLI test harness** (`fffe336`): `apps/cli/src/test-support.ts` owns
   `Captured`/`runMain`/`jsonOf`; the consolidate test imports it. The two older copies
   (`cli.test.ts`, `doctor-summary.test.ts`) belong to earlier missions and stay untouched per
   the one-mission-one-file rule — one import line each for the coordinator.

## Explicitly out of scope / follow-ups

1. **Evidence-append primitive on the Store port** — the merge records the evidence union on the
   `merged` audit event because no port method can append evidence spans to a surviving memory
   row. If the port grows one (`updateMemoryEvidence`-style), the merge can materialize the union
   on the survivor's row; the audit record stays either way. Coordinator decision (needs a core
   port change; missions may not edit `packages/core`).
2. **Daemon-side scheduling + REST endpoint** — job kinds `consolidate` and `decay` already exist
   in `JOB_KINDS`, but no handlers are registered in `apps/api`'s runtime (normalize/extract/
   re_embed are), and `/v1` exposes no consolidate route — so `onemem consolidate` refuses while
   a daemon owns the data dir. Wiring a `consolidate`/`decay` job handler around
   `runConsolidation` (round-based, per project + user scope) and a `/v1/projects/{id}/consolidate`
   route is the coordinator follow-up named in the mission brief.
3. **User-level-only passes need a `MemoryQuery` null-scope probe** — `queryCurrent` cannot
   express `project_id IS NULL` (the schema's `optionalUuid` has no null), so `runConsolidation`
   scopes by project id or runs every scope. A store-port extension would let the scheduler run
   user-scope passes explicitly.
4. **Paginated pool enumeration** — passes see the newest ≤ 1000 active memories
   (`MemoryQuery.limit` max); a cursor/offset primitive beyond that would let scheduled runs
   sweep large projects without waiting for the active window to shrink.
5. **LLM-backed contradiction detection** — the heuristic covers the same-attribute/
   different-value family; the router's `conflict` operation (already in `MODEL_OPERATIONS`) can
   back a smarter `ContradictionDetector` for cross-phrasing conflicts ("we use bun" vs "we use
   jest") without touching the passes (the seam is exported).
6. **Config wiring** — thresholds live in `runConsolidation` options with documented defaults; a
   `consolidation:`/`decay:` section in `onememory.config.yaml` (packages/config, M16's scope)
   was not added — no config edits were allowed from this mission.
7. **Backlog M14.5/M14.6** (project digest rollups, working-memory promotion sweep, events
   compaction) were not in this mission's scope (the mission brief named M14.1–M14.4).
8. **`apps/cli/src/index.ts` export** — every command is re-exported from the CLI's public
   surface except `consolidate`: the mission brief scoped the registration to `bin.ts` (the
   public-surface file is shared with parallel missions adding commands). One-line coordinator
   follow-up: `export { runConsolidate, printConsolidation, type ConsolidateOptions } from
   './commands/consolidate';`.
9. **Extraction-side entity bindings** — extracted memories still store no entity bindings (M3's
   known gap); the derivation pass resolves mentions through the registry instead, so clusters
   form either way, but bound memories group by entity id while unbound ones group by resolved
   mention. Backfilling bindings at STORE is extraction's seam, not consolidation's.
10. **Search-result payload hydration and recurrence counting** — unchanged from their existing
    follow-up lists (M3d follow-ups 1/3); failure `occurrence_count` stays the STORE-stage 1
    unless the merge pass grows signature-hash awareness (M15's recurrence matching).
