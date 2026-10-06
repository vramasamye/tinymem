# Mission 14.5: project digest rollup

Branch: `mission/14e-digest-rollup` · Base: `ae24030` (main) · Closes backlog M14.5
(docs/backlog/issues.md §M14) · Builds on mission 14 (consolidation core) and mirrors the M4f
architecture-digest persistence pattern (docs/plan/mission-reports/mission-4f-reindex-digest.md).

## Scope delivered

A deterministic, zero-model **project digest pass** that rolls a project's top accepted
decisions, known failures, and current procedures into ONE token-bounded (default 750 tokens)
digest per project, and surfaces it through the existing `memory_project_context` MCP tool with
**no tool-surface changes** and **no migration**.

1. **Pure builder** — `buildProjectDigest` (`packages/consolidation/src/digest/rollup.ts`):
   identity line (always kept, clamped), optional project description, then three sections in
   priority order (decisions → failures → procedures) with a 5:3:2 allowance split. Unspent
   allowance rolls forward to the next section. Lines are packed whole (never cut mid-sentence),
   a section with no fitting line emits no header, and every line's cost reserves its joining
   newline, so `used ≤ budget` holds by construction. Same inputs produce byte-identical text and
   therefore the same content hash.
2. **Read-only entry** — `runProjectDigest`
   (`packages/consolidation/src/digest/run.ts`): reads through the same search-repo shortcuts
   the session-context assembly uses (`latestAcceptedDecisions`, `recentFailures`,
   `listCurrentMemories`; default caps 8 / 6 / 6), so the digest and `memory_project_context`
   agree on what "top" means. It never writes, and it returns `null` for an unknown project.
3. **Persisting pass** — `runDigest`: one `semantic` / `project_context` memory (tag
   `project_digest`) per project per invocation. Outcomes are `created`, `unchanged` (the content
   hash matches the current digest, so nothing is written), `refreshed` (the predecessor is closed
   through the Store's audited `supersede`, with reason `project_digest_refresh`), `skipped` (no
   project, or no sources yet), and `failed`. The pass never throws. `derived_from` edges link to
   every cited source, and provenance and evidence are unioned from those sources. The pass
   refuses to build a digest with empty evidence (AGENTS.md rule 8).
4. **Renderable record** — `digestRepo.updateProjectDigest`
   (`packages/storage/src/repositories/digest.ts`): an atomic jsonb merge into `projects.digest`
   that replaces only the owned key namespace `^(decision|failure|procedure)_[0-9]{2}$` and keeps
   foreign keys (manual summary, M4f architecture fields). It is Zod-validated at the boundary.
   The existing session-context renderer turns `decision_01` into `decision 1: …`, so the MCP
   tool shows the rollup as-is.
5. **Core contract** — `packages/core/src/types/digest.ts`: `PROJECT_DIGEST_KIND/SUBTYPE/TAG`,
   `DEFAULT_PROJECT_DIGEST_BUDGET_TOKENS = 750`, `ProjectDigestSectionsSchema`,
   `ProjectDigestEntriesSchema`, `PROJECT_DIGEST_ENTRY_KEY`, `projectDigestEntriesOf`
   (zero-padded keys, capped at 99 per section), and `ProjectDigestCandidate`.
6. **CLI** — `onemem digest [--project <id>] [--budget <tokens>] [--json]`
   (`apps/cli/src/commands/digest.ts`, registered in `bin.ts`). It runs in direct mode and
   refuses while a daemon holds the store, the same way `onemem consolidate` does. Human output
   prints the pass summary and the digest text exactly as stored.

## Acceptance criteria vs delivered

| AC | Delivered |
| --- | --- |
| Pure `runProjectDigest` producing a typed, budgeted digest | Yes, read-only and deterministic; the builder is pure |
| One digest row per project per invocation, audited supersession | Yes: `created` / `unchanged` / `refreshed`; the lifecycle test asserts exactly one current digest and the audit transition |
| Budget property-tested | Yes: a seeded 200-iteration property test (mirrors M2's packer suite) asserts `used ≤ budget`, whole-line packing, priority order, and determinism |
| Idempotent re-runs | Yes: the unchanged probe uses windowless `findDuplicate` on the content hash; edge and digest-column healing are idempotent |
| `onemem digest` CLI | Yes, with e2e coverage: create, unchanged, tighter-budget refresh, human mode, and refusal without a project |
| End-to-end MCP read-back | Yes: `digest.e2e.test.ts` seeds data, runs `runDigest`, and confirms `handleMemoryProjectContext` renders the rollup; the "digest not yet built" warning goes away |

## Design decisions

- **Digest as a memory plus a renderable column.** The memory row carries provenance, the
  supersession history, and `derived_from` edges. The `projects.digest` owned keys are what the
  existing tool renders. Splitting the work this way means no MCP, retrieval, or schema change.
- **Owned key namespace.** The merge only touches the keys the digest owns, so a manual
  `summary` and the M4f architecture fields survive every refresh.
- **The digest text includes the budget** in its identity line. A re-run at a different budget
  is therefore a changed digest, and that is honest: a different budget is a different rollup.
  If every line already fits both budgets, the texts can still match. The CLI test documents a
  real example where a 60-token budget leaves 3 short procedures unchanged.
- **Text-cycle gap is reported, not hidden.** If a fresh rollup matches an older, superseded
  digest's hash, the pass writes the new winner and returns a "superseded historical digest"
  warning. It never revives the historical row.

## Proposed ADR amendment (coordinator-owned; not edited by this mission)

The predecessor lookup for a *changed* digest uses `store.queryCurrent({ types: ['semantic'],
limit: 1000 })` and then a deterministic predicate (`isCurrentProjectDigest`). It is windowed
because the Store port has no tag or subtype filter. This is the same policy M4f uses for the
architecture digest. Proposed wording for the consolidation ADR (or an amendment to ADR-0010):

> Derived singleton memories (the architecture digest, the project digest) locate their current
> predecessor by a deterministic subtype+tag predicate. Until the Store port exposes a
> subtype/tag-filtered current-row query, that lookup is bounded by the port's maximum page
> (1000 current semantic rows per project). The unchanged case is always found, because it uses
> the windowless exact-dedupe probe. A changed digest whose predecessor falls outside the window
> creates a second current digest instead of superseding the first. Adding the filtered query to
> `Store` closes this gap and is a tracked core/storage follow-up.

## Validation

- `packages/consolidation`: 105 pass / 0 fail. 23 of those are new digest tests: rollup 12,
  run 10, e2e 1.
- `packages/core`: all tests pass, including the 4 new `types/digest.test.ts` tests.
- `packages/storage`: 36 pass / 33 skip / 0 fail on embedded PGlite. Against a throwaway
  `pgvector/pgvector:pg17` container (`ONEMEMORY_PG_URL` set) the result is **63 pass / 0 fail /
  0 skip**, including the 3 new server-profile digest repo scenarios. The container was removed
  afterwards.
- `apps/cli`: 52 pass / 0 fail, including the 3 new `digest-command.test.ts` tests.
- `apps/api`: 90 pass / 0 fail. `benchmarks/eval`: 91 pass / 0 fail.
- `tsc --noEmit` is clean for core, storage, consolidation, cli, mcp, and retrieval.
- Full repo `bun test --timeout=15000 --reporter=dots`: **1684 pass / 35 skip / 0 fail**
  (1719 tests across 137 files).

## Dependency and lockfile changes

- `packages/consolidation/package.json`: `@onememory/storage` moved from devDependencies to
  dependencies, because the pass now reads through `searchRepo` and writes through `digestRepo`
  at runtime. `@onememory/mcp` was added as a devDependency for the e2e read-back test only.
- `bun.lock` reflects those edges. It also adds the `@onememory/config` workspace dependency of
  `packages/mcp`. That dependency was already declared in `packages/mcp/package.json` at base,
  but the committed lockfile did not record it. `bun install` fixed the drift, and the change is
  committed here so the lockfile matches the manifests.

## Files changed

New:
- `packages/core/src/types/digest.ts`, `packages/core/src/types/digest.test.ts`
- `packages/storage/src/repositories/digest.ts`, `packages/storage/src/digest.test.ts`
- `packages/consolidation/src/digest/rollup.ts`, `run.ts`, `fixtures.ts`, `rollup.test.ts`,
  `run.test.ts`, `digest.e2e.test.ts`
- `apps/cli/src/commands/digest.ts`, `apps/cli/src/digest-command.test.ts`
- `docs/plan/mission-reports/mission-14e-digest-rollup.md`

Modified:
- `packages/core/src/index.ts` (exports the digest types)
- `packages/storage/src/index.ts` (exports `digestRepo`)
- `packages/consolidation/src/index.ts` (exports the digest module), `packages/consolidation/package.json`
- `apps/cli/src/bin.ts` (registers `digest` with `--budget`)
- `bun.lock`

## Coordinator follow-ups

1. Add the ADR amendment above (digest predecessor windowing policy).
2. Core/storage: add a subtype/tag-filtered current-row query to the `Store` port, then drop the
   windowed scan in both the project digest and the M4f architecture digest.
3. Scheduling: the pass is callable from the library and the CLI. Wiring it into the daemon or
   job scheduler after `runConsolidation` belongs to the coordinator or a later mission.
4. `onemem remember --type decision|failure` writes no decision or failure payload rows, so CLI-
   remembered decisions and failures do not reach `latestAcceptedDecisions` / `recentFailures`,
   and so they do not reach the digest either. Only pipeline-extracted ones do. The CLI e2e test
   uses procedures for this reason. Consider having `rememberMemory` write payload rows.
5. Update the backlog (M14.5 closed) and the Phase 3 status in `docs/plan/phased-plan.md`.
