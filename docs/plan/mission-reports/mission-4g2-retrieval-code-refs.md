# Mission 4g2: surface code refs on the retrieval search response (close Phase 2)

Branch: `mission/4g2-retrieval-code-refs` · Base: `main` @ `91d2b89` · Goal: close the Phase 2
DoD blocker raised by M4g (finding F5; backlog issue 1 in the "raised by M4g" follow-ups):
**`MemorySearchResponse` did not surface the `memory_code_refs` the pipeline already persists —
no consumer of a search could receive the cited files.** This mission surfaces them, end to end:
the wire schema, the storage read, the engine hydration, the API boundary, and the flipped M4g
acceptance test.

**Verdict: the Phase 2 DoD line — "How does authentication work?" returns procedures with code
refs — is now FULLY demonstrated at the retrieval surface, and can be marked complete.** The
M4g acceptance test now asserts over the ACTUAL search result that the top procedure's three
refs arrive complete: the real `repoId`, the real capture `commitSha`, the real `path`, the real
captured worktree blob as `evidence`, and the symbol the procedure's own content names
(`verifyCredentials` / `createSession` / `requireAuth`). The "refs absent" assertion that pinned
the gap is replaced by these "refs present and correct" assertions.

## Delivered scope (4 code commits)

- **`packages/core/src/schema/search.ts`** — `CodeRefEntrySchema` (`{ repoId: UuidV7, commitSha:
  string, path: string, symbol?: string, evidence?: string }`, loose-object like the rest of the
  wire) plus a NON-optional `codeRefs: CodeRefEntry[]` on every `memories[]` item — empty when
  no refs are recorded, so clients always see the field. Malformed entries (non-uuid repoId,
  non-string commitSha, empty path/symbol/evidence) are rejected; the empty `commitSha` is the
  documented "no commit anchor" value, not a malformed one. Additive to the loose wire object;
  `memory.ts` untouched (refs are search-response evidence, not part of the canonical memory
  record — see follow-ups).
- **`packages/storage/src/repositories/code-memory.ts` + `src/index.ts`** —
  `listCodeRefsForMemories(db, ids)`: ONE batched query (a query-counting client in the tests
  pins the single round trip) returning every persisted ref of any number of memories, each
  hydrated with its commit anchor and the cited file's symbol names. The join pins the
  worktree tier exactly like the normative drift query (database-schema.md §4). `HydratedCodeRef`
  is exported from the package root for the engine's type-only use. No other read contract
  changed.
- **`packages/retrieval/src/code-refs.ts`, `engine.ts`, `config.ts`, `index.ts`** — pipeline
  stage 6.5: after scoring (and optional rerank) and BEFORE token packing, the engine loads the
  refs of every scored candidate in ONE batched read and attaches them to every returned item.
  `config.codeRefs.maxPerMemory` (default 5, config-overridable) is the refs budget.
- **`apps/api/src/runtime/procedures-acceptance.test.ts`** — the M4g acceptance test flipped
  from pinning the gap to proving the DoD (phase 3 now also persists the fixture's real symbol
  tables through the real tree-sitter pipeline; phase 4 asserts the refs). `apps/api/src/server/
  app.test.ts` — the REST-boundary fixture carries the now-required field.

## The chosen policies (deterministic, documented in code where they live)

- **commitSha** — the commit under which the cited worktree-tier blob was LAST OBSERVED
  (`file_fingerprints.last_seen_commit`, pinned to the ref's own blob: `CASE WHEN
  ff.blob_sha = mcr.blob_sha THEN ff.last_seen_commit END`). When the cited blob is no longer
  the current worktree content (drift-stale), the path's fingerprint row is gone, or the capture
  was unborn: the honest empty string — NEVER a borrowed commit from a newer capture's HEAD.
- **symbol** — the first symbol (document order: `line_start`, then name) within the cited file
  whose name appears in the memory's own content as a WHOLE word (identifier-boundary regex,
  case-sensitive — prose "Session" is not `session`, and `Credentials` never matches inside
  `verifyCredentials`). No content-named symbol → no symbol, never a guess.
- **evidence** — the persisted worktree-tier `blob_sha` the memory's evidence was verified
  against.
- **refs budget** — `maxPerMemory` real entries, ordered (repository, path); when a memory has
  more, ONE placeholder entry is appended — `path: '<N more refs>'`, the first omitted ref's
  `repoId`, `commitSha: ''` — instead of a silent mid-list truncation. Refs are structured
  metadata riding the response under their own budget; they are NOT counted inside
  `tokens.used` (the packed token budget measures the memory representations; see follow-ups).
- **ordering** — storage returns rows ordered `(memory_id, repository_id, path)`; grouping
  preserves it, so every memory's entries are deterministic.
- **degradation** — a failed hydration pushes one warning (`code ref hydration failed: …`) and
  every item still carries its (empty) field; a search never fails because of refs.

## Acceptance criteria — delivered vs not

1. **codeRefs non-optional-but-empty on every result** — delivered (core schema + engine attach;
   asserted in core schema tests, retrieval tests, and the acceptance test).
2. **CodeRefEntry Zod shape, malformed rejected** — delivered (schema + tests: bad uuid, non-string
   commitSha, empty path/symbol/evidence rejected; `''` commitSha accepted as the honest value).
3. **`listCodeRefsForMemories(ids)`, one batched query, both profiles** — delivered (single
   round trip pinned by a counting client; runs on PGlite and Postgres+pgvector — see matrix).
4. **hydrate after scoring, before token packing, deterministic over-budget policy, documented**
   — delivered (stage 6.5; cap + `<N more refs>` placeholder; policies documented in
   `code-refs.ts`, `config.ts`, the schema, and here).
5. **API search endpoint returns codeRefs through the same Zod** — delivered (`SearchResponseSchema`
   IS `MemorySearchResponseSchema`; the REST `respond()` validator enforces it; the app.test.ts
   fixture updated).
6. **M4g acceptance test asserts refs present and correct (path, commit, repoId, symbol)** —
   delivered (125 `expect()` calls, was 76; the prior "refs absent" + "blobs nowhere in the
   response" assertions replaced by "refs present" + "blobs ARE in the response").
7. **Postgres matrix** — delivered for the new SQL and the engine seam (below), with one honest
   boundary noted: the retrieval/API TEST SUITES open embedded PGlite directly by design and
   have no `ONEMEMORY_PG_URL` switch — the engine's hydration was verified against a real
   Postgres server profile through a one-off run (below), and the exact SQL the engine calls is
   pinned on BOTH profiles by the new dual-profile storage suite.
8. **Mission report** — this file.

## Tests (3 files: 1 new pair + 1 updated; 28 new tests)

- `packages/core/src/schema/memory.test.ts` — +2: codeRefs required-but-empty; malformed entries
  rejected (empty commitSha not).
- `packages/storage/src/code-refs.test.ts` — NEW, 12 scenarios registered twice (6 embedded
  always; 6 Postgres server when `ONEMEMORY_PG_URL`): one batched query (counting client, N+1
  guard), empty/unknown ids, deterministic order, commit-anchor branches (fresh → HEAD; drifted/
  fingerprint-less → `''`), symbol aggregation in document order, row shape round-trip.
- `packages/retrieval/src/code-refs.test.ts` — NEW, 12 tests: pure shaping (word-boundary/
  case-sensitive/document-order symbol attribution; regex-special names; cap + placeholder;
  empty rows; honest `''` commitSha) + engine integration on a real PGlite world (the deploy
  procedure's refs surface with repoId/commitSha/path/evidence; the content-named symbol; every
  item carries the field, empty for no-ref memories; failed hydration → warning + empty refs,
  search still answers; `maxPerMemory` config override).

## Validation

- Focused: `bun test packages/core packages/retrieval packages/storage apps/api` — **284 pass /
  28 skip / 0 fail** (312 tests, 31 files; the 28 skips are the pre-existing Postgres server
  legs, offline as designed).
- Full suite at the worktree root (`bun test --timeout=15000 --reporter=dots`): **1265 pass /
  30 skip / 0 fail, 1295 tests, 104 files** (~278 s).
- Baseline re-measured at the base commit `91d2b89` in a detached temp worktree under the same
  conditions: **1245 pass / 22 skip / 0 fail, 1267 tests, 102 files** — exactly this mission's
  +20 pass / +8 skip / +28 tests / +2 files more (the +8 skips are the new storage code-refs
  Postgres leg, skipped offline), zero regressions.
- Postgres matrix (AC 7): a disposable `pgvector/pgvector:pg17` container (localhost:5434) with
  `ONEMEMORY_PG_URL` — `bun test packages/storage` ran **57 pass / 0 fail** including the new
  `code-ref hydration (postgres server)` leg (all 6 scenarios; the json_agg /
  ORDER BY … NULLS LAST / CASE-pinned commit-anchor SQL runs identically on PGlite and real
  Postgres). A one-off engine-level run against the server profile confirmed the full
  hydration path (repoId, commitSha = capture HEAD, path, `gcloud` symbol, evidence blob)
  surfaces through `createRetrievalEngine` + `search`. The container was removed after the run.
  Honest limitation: `packages/retrieval` / `apps/api` suites themselves are embedded-profile
  suites with no server switch — extending them is a harness decision for the coordinator
  (storage already owns the dual-profile matrix).
- Typecheck: `bun run typecheck` green in all 14 packages (core, storage, retrieval, api, cli,
  mcp, codememory, config, consolidation, embeddings, extraction, llm, security, benchmarks/eval).
- No new dependencies, no network at runtime (tree-sitter WASM is local; the engine makes zero
  network calls — local-first invariant intact), no `any` at boundaries, no schema migration
  (the read joins existing tables only).

## Ownership notes (adjacent edits flagged)

All edited files were inside the assigned lane except two ADJACENT edits REQUIRED by the wire
change, both outside the coordinator-owned set: `apps/api/src/server/app.test.ts` (the REST
boundary fixture needed the now-required field — without it the boundary's own response
validation test fails) and `packages/storage/src/index.ts` (one type-only export line for the
hydration read model). No file under `docs/architecture/`, `docs/adr/`, or any root config was
touched.

## Known limitations / follow-ups (for the backlog)

- **NAMING DEVIATION — coordinator decision wanted:** the new wire fields are camelCase
  (`codeRefs`, `repoId`, `commitSha`) exactly as the mission spec dictated, but the established
  wire convention is snake_case (`event-memory-schemas.md` §6, persistence.ts's "exactly one
  naming convention" rule). If the coordinator wants snake_case, this is a one-rename wire change
  before any consumer depends on it — the sooner the call, the cheaper.
- **Docs to sync (coordinator-owned):** `docs/architecture/event-memory-schemas.md` §6 (the
  response contract) and `docs/architecture/retrieval.md` (the pipeline stages) should document
  the `codeRefs` field and stage 6.5; `docs/architecture/database-schema.md` §4 could note the
  hydration read. `docs/plan/phased-plan.md` Phase 2 DoD line can be marked complete (see
  verdict). The backlog "raised by M4g" item 1 can be closed.
- **refs are NOT inside `tokens.used`:** the packed token budget measures memory representations
  (retrieval.md §7); refs are capped structured metadata riding the response. If the coordinator
  wants refs counted inside the budget (or packed into the CLI/MCP prompt text), that is a
  packing-stage decision with its own benchmarks.
- **MCP + CLI display:** `memory_search`'s progressive-disclosure ID-index (ADR-0010 §3)
  deliberately projects a subset — it does not carry codeRefs, and `memory_get` returns the
  canonical `MemoryRecord`, which has no refs field. MCP/CLI consumers therefore still cannot
  SEE refs through their tool surfaces even though the engine response now carries them.
  Surfacing refs there (ID-index entries or `memory_get`/`onemem search` output) is a
  cross-surface decision the coordinator owns; the engine + REST surface are ready for it.
- **`symbol` attribution is content-match based** (deterministic and honest, but it only fires
  when the memory's content actually names the symbol). Memories whose content does not name
  their cited files' symbols surface the ref without a symbol — by design, never fabricated.
- **refs hydrate for the scored candidate set** (one query), then packing drops what it drops —
  dropped candidates' refs are discarded with them; the field is never partially filled.
