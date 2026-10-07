# Mission 17: Scope & identity wiring

Branch: `mission/17-scope-identity` · Base: `91cfc88` (main, the M18 merge) · Closes the M17 row
of Phase 7 Wave B (docs/plan/phased-plan.md) · Decision records amended by the coordinating
session at merge: ADR-0004 (scope admission) and ADR-0010 (per-runtime identity, cwd→project).

## Scope delivered

Wave B's wording ("user-level memories answer from any project; a nested cwd resolves to its
project; each runtime identifies itself in the audit trail") described three wirings. Two of them
were missing entirely and the third was wired wrong at the retrieval layer — project-scoped
searches were *soft*-scoped, so **another project's memories could rank into an answer**. All
three land here, one bounded commit each.

### Wire A — per-runtime MCP identity (`823d849`)

The daemon serves one `OnememoryMcpContext` for every client, so every write was stamped with the
default `onememory-mcp` identity: the audit trail could not say *which* agent remembered.

- **Identity rides the URL.** Each runtime's scaffolded entry now targets
  `http://<host>:<port>/mcp?agent=<runtime-id>` (`RUNTIME_AGENT_IDS`: `onemem-claude-code`,
  `onemem-codex`, `onemem-cursor`, `onemem-pi`, `onemem-opencode`; `daemonMcpUrl(daemon, agent)`).
  Per-request identity needs no per-client env var and no protocol change — the parameter is
  read from `requestInfo` per request, and a shallow context clone carries `config.agentId` plus
  actor `agent:<id>` for that request only (the shared context stays untouched).
- **Fail closed on a malformed id.** `?agent=<junk>` gets a `400` JSON error rather than silently
  writing under the default identity (`AGENT_PARAM_PATTERN`; the guard wraps both gated and plain
  handlers). Absent the parameter, `onememory-mcp` stands, so already-wired clients keep working.
- **Doctor knows the per-runtime URL.** `RuntimeCheckContext.expectedUrl` became
  `expectedUrlOf(runtime)`, so the check compares against the runtime's own identity URL instead
  of one shared string; `onemem init`'s wiring step derives the same value from one helper.

### Wire B — cwd→project resolution (`2cc13ae`)

A client launch from a nested directory (or from a subdirectory of a monorepo) resolved to no
project, so writes landed project-less and searches ran unscoped.

- **Storage primitive.** `findProjectByPath(db, path)` — deepest registered root containing the
  path wins, containment is segment-precise (`/a/bc` never matches the root `/a/b`), a project
  with a NULL root never matches, and no match is an honest `null`, never a guess. Registered on
  the `Store` port (the MCP context and CLI both read through it).
- **MCP chain**: explicit `project_id` argument → configured `projectId` → workspace-hint lookup
  (`CLAUDE_PROJECT_DIR`). `resolveProjectId` is now async; its five call sites await it.
- **CLI chain**: `resolveProjectIdForCwd(loaded, override, store, cwd)` — `--project` → direct-mode
  path lookup → init pointer → an actionable error. `digest` and `export` now open the runtime
  *before* resolving the project (the store is what answers the lookup).

### Wire C — scope admission: the leak (`1c8a7b2`)

The retrieval engine's candidate filter never set a project at all: `w_proj` scored
same-project 1.0 vs cross-project 0.7, but every project's rows entered candidate generation.
The explain snapshot pinned the leak in the decomposition as the factor `cross-project memory`
(a row from the fixture's *other* project ranking into a project-scoped answer).

- **Storage union.** `CandidateFilter.projectOrUser` emits
  `(m.project_id = $p OR (m.project_id IS NULL AND m.user_id = $u))` — the project's rows PLUS the
  caller's user-level rows, nothing else. Mutually exclusive with `projectId`; both present throws
  (the planner fails closed rather than picking a scope).
- **Engine.** With `project_id` present and a `resolveUserId` resolver injected, the union applies;
  without a resolver the scope is hard project-only. The project-match signal stays a *ranker*
  inside the admitted set; unscoped requests (no `project_id` — reachable only when no project is
  registered) keep the any-project semantics the wire contract documents.
- **Injection.** `apps/api` composition and the MCP context both pass a resolver backed by the
  same cached local user (`sourcesRepo.ensureLocalUser`, one lookup per process). A resolver
  failure degrades to project-only scope — a search never fails because identity lookup did.

## Acceptance criteria vs delivered

| AC (Wave B DoD) | Delivered |
| --- | --- |
| Durable writes can carry user scope | Already wired (M5 `scope: 'user'` + `localUser` stamping on the durable create path); M17 added the *read* side that made it useful — Wire C |
| User-level memories answer from any project | Yes: engine test proves a user-level preference answers from inside a project search, and that the same search never returns another project's row (also proven for the no-resolver case: hard project scope) |
| A nested cwd resolves to its project | Yes: `findProjectByPath` tests (deepest-root-wins, sibling/prefix negatives, NULL root, unknown path → null); MCP context tests (workspace hint admitted, never over an explicit project); CLI `resolve.test.ts` (chain order + error) |
| Each runtime identifies itself in the audit trail | Yes for the scaffolded (daemon/embedded) path: per-runtime URLs in the wire step, `agent_id` stamped per request, `400` on malformed ids, doctor expectations per runtime. Residual for hand-written server-profile stdio entries — backlog |

## Design decisions

- **Hard admission, soft ranking.** Admission and ranking are different jobs: the candidate set is
  what may *exist* in an answer, `w_proj` is only how it *orders*. M17 moved scope to admission and
  left the scoring table untouched — one leak closed, zero weight changes.
- **The union is the only sanctioned cross-project admission.** A user-level row is admitted
  because it is the caller's, not because it scored well. Nothing else crosses project borders in
  a scoped search.
- **Degrade to project-only, never to an error.** No caller identity and no resolver both land on
  hard project scope: the invariant that matters (no cross-project leaks) holds in every path,
  while the user-level arm is an enrichment that may be absent.
- **Identity in the URL, not in client env.** A query parameter is visible in the scaffold (an
  operator can read what a runtime will claim), needs no per-client configuration step, and is
  verified by `onemem doctor` against the runtime's own value. The `ONEMEMORY_MCP_AGENT_ID` env
  path stays supported for hand-written entries.
- **cwd resolution is total and honest.** Deepest registered root wins; segment-precise; unknown
  path → no project. A guess here would attribute memory to the wrong project, which is worse than
  attributing it to none.
- **The explain snapshot was updated, not deleted.** The diff *is* the evidence: the old
  expectation carried the other project's row with its `cross-project memory` factor; the new one
  cannot. A reviewer can read the closure in one hunk.
- **A near-duplicate collapse is not a scope signal.** The first cut of the Wire C test used a
  user-level "tabs" preference that collided with the fixture's project-level one — the engine's
  ≥0.97 near-duplicate stage correctly collapsed them (retrieval.md §1 Stage 4), which would have
  made the test pass for the wrong reason. The test's user-level memory is now topically distinct,
  so only the scope union can answer it.

## Validation

- `packages/storage`: `projects.test.ts` (new, 6 tests: deepest root wins, sibling/prefix
  negatives, NULL root, unknown path), `search-page.test.ts` (new project-or-user scope
  scenarios), and the mutual-exclusivity guard. Dual-profile harness (PGlite always; Postgres
  when `ONEMEMORY_PG_URL` is set).
- `packages/retrieval`: `engine.test.ts` 22 pass / 0 fail, including the new scope-admission test
  and the updated explain snapshot.
- `packages/mcp`: `http.test.ts` 8 pass (per-request agent id, default identity, `400` on
  malformed), `context.test.ts` 5 pass (workspace-hint resolution chain), handlers suite 58 pass
  standalone.
- `apps/api`: `runtime-scaffolds.test.ts` 13 pass (per-runtime expectations, doctor checks).
- `apps/cli`: `resolve.test.ts` (new, 6 tests), `init-wiring.test.ts` 29 pass (per-runtime URLs),
  and the digest/export command suites after the reordering.
- `tsc --noEmit` clean for retrieval, storage, core, mcp, api.
- Full repo `bun test`: **2089 pass / 56 skip / 1 fail** (2145 tests across 187 files), up from
  2073 pass / 51 skip / 0 fail (2124 tests) on main — the 21 new tests of this mission (+16 pass,
  +5 Postgres-profile skips). The single failure was a `beforeEach/afterEach` **hook timeout** in
  `packages/mcp/src/handlers.test.ts` under full-suite parallel load (PGlite contention); the same
  file passes standalone (58 pass / 0 fail) and was re-run to confirm the flake. No assertion in
  this mission's code failed.

## Files changed

New:
- `packages/storage/src/projects.test.ts`, `apps/cli/src/resolve.test.ts`
- `docs/plan/mission-reports/mission-17-scope-identity.md` (this report)

Modified:
- `packages/storage/src/repositories/projects.ts` (`findProjectByPath`), `store.ts`,
  `repositories/search.ts` (+`search-page.test.ts`), `packages/core/src/ports/store.ts` (port)
- `packages/retrieval/src/engine.ts` (+`engine.test.ts`, updated `__snapshots__/engine.test.ts.snap`)
- `packages/mcp/src/http.ts` (+test), `context.ts` (+test), `handlers.ts`
- `apps/api/src/runtime/runtime-scaffolds.ts` (+test), `doctor.ts`, `index.ts`, `composition.ts`
- `apps/cli/src/commands/wire-runtimes.ts` (+`init-wiring.test.ts`), `resolve.ts`,
  `commands/digest.ts`, `commands/export.ts`
- `docs/adr/0004-retrieval.md`, `docs/adr/0010-mcp-protocol-adapters.md` (amendments),
  `docs/architecture/retrieval.md` (Stage 2 scope admission + `w_proj` row), `docs/plan/phased-plan.md`
  (Wave B DoD + status), `docs/backlog/issues.md` (M17 follow-ups)

## Commits

- `823d849` feat: per-runtime MCP identity rides the daemon URL as `?agent=`
- `2cc13ae` feat: resolve nested cwds to their project (`findProjectByPath`)
- `1c8a7b2` feat: admit the caller's user level into project-scoped search (M17 scope union)
- docs commits follow this report (ADR amendments + this report + plan/backlog sync).

## Coordinator follow-ups

1. Entity-name resolution does not know the scope union (`listScopeEntities` covers the project or
   global scope only, so an entity bound solely to a user-level row resolves as not-found from
   inside a project search). Documented in `docs/architecture/retrieval.md` §1 Stage 2 and recorded
   in the backlog with the shape of the fix.
2. Server-profile clients: `init` scaffolds no MCP entry there, so a hand-written stdio entry keeps
   the default identity unless the operator sets `ONEMEMORY_MCP_AGENT_ID`. Recorded in the backlog.
3. M16 (npm publish prep) is the last Wave B item: dry-run first, and **ask the user before the
   real publish**.
