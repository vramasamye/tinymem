# Mission 4f: re-index + digest + scheduling (sixth M4 slice)

Branch: `mission/4f-reindex-digest` · Base: `5c20159` · ADR: `0008-code-memory-git-fingerprints.md`
(backlog M4.5 + M4.6; parity memo §5 Tier A item 2)

## Delivered scope

The loop ADR-0008's Phase-2 DoD was waiting for: drift marks memories `stale` (M4e) — this mission
makes sure they do not stay stale forever, and that the daemon does the work on its own:

- **Scheduling** (`scheduler.ts`): `createCodeMemoryScheduler({ intervalMs, tick, timer?,
  onError? })` — an injectable-timer interval pass. It runs an immediate pass on `start`, chains
  the next pass only after the current one settles (passes never overlap), reports tick errors
  through `onError` without stopping the loop, exposes `runOnce()`, and `stop()` awaits any
  in-flight pass. The default timer `unref()`s its handle, so a scheduled pass never keeps the
  process alive.
- **Orchestration** (`orchestration.ts`): `createCodeMemoryOrchestration({ store, codeMemory,
  jobs, extractor, classify, projectId, rootPath, ... })` — a pure function of injected ports (the
  same `Store`/`CodeMemoryStore`/`JobQueue`/`Extractor` the pipeline already uses), so the daemon
  and a direct-mode CLI call run the same code:
  - `tick()` resolves + registers the project root (`ensureRepository`, canonical root resolved
    the same way capture does) and enqueues exactly one `drift_scan` job per repository with a
    singleton key (`drift_scan:<project_id>:<repository_id>`) — overlapping ticks coalesce into
    `existing`, they do not pile up jobs.
  - `runDriftScan` (the `drift_scan` handler body): capture → `saveSnapshot` → apply drift through
    the M4e applier (`readCheckpointBasis` before detection, audited stale, compare-and-set
    checkpoint) → enqueue one chained `reindex` job per project. The chain fires even with zero
    drift, so a fresh project still gets its architecture digest. Errors are warnings, never
    throws — one repository's failed capture does not fail the job.
  - `runReindex` (the `reindex` handler body) delegates to the re-indexer and stamps the pass.
  - `parseDriftScanJobPayload` / `parseReindexJobPayload`: Zod validation at the job-queue
    boundary — an unparseable payload is an honest error, never a silently dropped job.
- **Minimal re-index** (`reindex.ts`): `createReindexer({ store, codeMemory, jobs, extractor,
  classify, redactText?, enqueueReEmbed?, ... })`. Per project:
  1. `detectDrift` (the same zero-token oracle) → only currently-`stale` memories with drifted
     refs. One unchanged file costs nothing: no read, no parse, no extraction.
  2. Symbols: one scoped `extractSymbolTable(root, { files })` pass over exactly the drifted
     paths → `saveSymbolTable` (unchanged files keep their rows via the rewrite guard). A failing
     symbol pass is a warning, not a blocker.
  3. Text: re-read each drifted path with the capture read discipline (repository-relative, no
     symlinks, 1 MiB default cap), redact it, and hand it to the SAME `Extractor` the `extract`
     job uses — wrapped as a synthetic `document.added` event (`code-events.ts`), never ingested,
     so no synthetic row pollutes the `events` table and the normal pipeline never re-processes
     it. The durable provenance of anything extracted is a real `sources` row (`kind: 'file'`)
     plus a `file:<path>` evidence locator — the FILE is the source of truth, not the event.
  4. Resolve each stale memory against its file's fresh candidates (classified by the injected
     classifier, the same one the extract job uses):
     - reproduces its own knowledge (same durable type, same content hash) → audited
       `stale → active` (`restored`, actor `job:reindex`, reason `code_reindexed`), refs
       re-recorded against the current blobs;
     - different knowledge of the same type → audited `Store.supersede` (the best candidate by
       importance, then confidence), the winner's ref tracked on the current blob so it keeps
       drifting later, the loser keeps its own code refs for the trail; a `winner-duplicate`
       supersede points the stale row at the existing current memory instead of inserting;
     - nothing reproducible → the memory honestly stays `stale`, reported `deferred` — never a
       silent un-stale; unreadable path → `gone` warning, still stale; unexpected error →
       `failed`, reported, never thrown.
     - `re_embed` (reason `backfill`) is enqueued for every refreshed/superseded memory when an
       embedder is registered — an idempotent upsert, so a memory that was never embedded (the
       embedder may be newly enabled) gains its vector.
  - **Architecture digest** (`digest.ts`, M4.6): `buildArchitectureDigest` composes the persisted
    symbol tables into one ≤300-token project summary — a header (project name, repository /
    module / file / symbol totals, language mix) and one line per top-level directory (module):
    its file count, its responsibilities (the declaration-kind mix, most frequent first), and
    its entry points (the most entry-like declared names), modules sorted most-substantial
    first. Deterministic (same code shape ⇒ same text ⇒ same content hash). Budget enforcement is
    line-level, never mid-line: the header is always kept, whole module lines are dropped from
    the least-substantial end until the estimate fits, and an honest `truncated` flag reports the
    drops. `estimateDigestTokens` ≈ chars/4. It persists through
    the normal insertion path as a `semantic`/`project_digest` memory with full provenance (a
    `sources` row + one `code_symbols:<repository ids>` evidence span), refreshed via audited
    supersede ONLY when the text changed, untouched when identical. `DEFAULT_DIGEST_BUDGET_TOKENS
    = 300`; the budget is an argument, so another surface can tighten it.
- **Wiring** (`apps/api`): `drift_scan` + `reindex` handlers registered in the composition root;
  the scheduler starts alongside the job worker (default `DEFAULT_DRIFT_SCAN_INTERVAL_MS` =
  300 000 ms, overridable via `OpenRuntimeOptions.driftScanIntervalMs` / `ServeOptions`, opt-out
  `codeMemoryScheduler: false`) and stops BEFORE the worker drains, so no new code-memory job is
  enqueued while storage closes. `OnememoryRuntime.code_memory` exposes the live state
  (`scheduler_running`, interval, project id, `status()`, `runDriftScan`, `runReindex`).
- **Doctor** (`apps/api/src/runtime/doctor.ts`): a `code-memory / drift` section — repositories,
  tracked refs, stale memories, digest presence, last fingerprint, last drift scan, scheduler
  state. `pass` when a repository is registered and the scheduler is armed; `warn` for
  no-project / no-repository / direct-mode (no scheduler); `fail` on a storage read failure. It
  is never `info`, so the report's informational count stays owned by the runtime-wiring group
  (`runtime.test.ts`'s `summary.info === 2` still holds).

## Semantics as implemented

- A re-index pass resolves memories at the FILE level: the file's fresh candidates are matched
  against the stale memory's own knowledge (content hash) and durable type. Symbol-level
  resolution (a symbol moving between files, a signature change that keeps the prose true) is
  deliberately NOT attempted — it is listed in the package README's remaining scope, not a
  placeholder in the code.
- Refresh requires a current readable worktree fingerprint for EVERY drifted path of the memory
  (freshness must be re-recordable); otherwise the memory is `deferred`, never half-refreshed.
- The supersede winner's `observed_at` is floored strictly after the loser's `valid_from` (the
  store's supersede rule), using the injectable clock.
- Extraction runs once per repository per pass (all drifted paths in one batch), not once per
  memory — the extractor sees the same batch shape the `extract` job produces.
- Zero-drift reindex still rebuilds the digest from persisted data (fingerprints + symbols, no
  file reads, no model calls); a project with no repository data skips the digest with a warning.
- The scheduler's first pass fires immediately on start (a daemon that just booted does not wait
  5 minutes to register the repository), then chains.

## Tests (35 new)

- `digest.test.ts` (6): determinism; the default 300-token budget; whole-line drops +
  `truncated` flag; a symbol-less repository still renders files + language mix; `moduleOfPath`;
  the token estimate.
- `scheduler.test.ts` (4): immediate + chained ticks (never overlapping); `runOnce`; a throwing
  tick is reported and the loop continues; idempotent start/stop.
- `code-events.test.ts` (5): schema-valid envelope; 8 000-char cap; **the real heuristic
  extractor extracts a decision candidate from the synthetic event, offline under the network
  guard**; `file:` evidence locator + excerpt bounds; `pathFromLocator` round-trip.
- `reindex.test.ts` (11, real embedded storage): only the drifted path is re-read/re-extracted
  (spy counters); reproduce → audited refresh + refs re-recorded; different knowledge → audited
  supersede with winner tracked; nothing reproducible → stays stale (`deferred`); degraded
  extractor / degraded symbols → warnings, never errors; unreadable path → `gone` + deferred;
  `re_embed` enqueued only with an embedder registered; digest created / unchanged / refreshed.
- `orchestration.fixture.test.ts` (2, real Git repository + real embedded storage, network
  guard): **the DoD loop** — scheduler pass registers + enqueues one job (second tick coalesces),
  one file edited + committed → only the referencing memory goes stale, checkpoint advances,
  chained reindex re-reads ONLY the drifted path, refreshes the memory, persists the digest with
  provenance; a failing extractor degrades to a warning.
- `apps/api/src/runtime/doctor-codememory.test.ts` (7): every status branch (no project, no
  repository, storage failure, armed scheduler = pass with the full detail line, direct-mode
  warn); in a real runtime the section is present, the summary counts every check, `info`
  stays 2, and a worker-opened runtime arms the scheduler and passes.

## Validation

- Focused: `bun test` in `packages/codememory` 86 pass / 1 skip / 0 fail (87 tests, 11 files);
  `bun test` in `apps/api` 74 pass / 0 fail; typecheck green in both.
- Full suite at the worktree root: **1090 pass / 22 skip / 0 fail, 1112 tests, 87 files**.
  Baseline re-measured at the base commit `5c20159` in a detached temp worktree:
  1055 pass / 22 skip / 0 fail, 1077 tests, 81 files → **+35 pass, +6 files, no regressions**.
- The 22 skips are the pre-existing Postgres-server integration scenarios (they need a live
  server leg; unchanged by this mission — no schema change, no migration, existing tables only).
- Offline invariant: every codememory test runs under `@onememory/security`'s network guard; the
  synthetic-event test proves the REAL heuristic extractor path needs zero network calls.
- No new third-party dependencies. `bun.lock` records two workspace edges: `@onememory/api` →
  `@onememory/codememory` (the runtime import) and `@onememory/codememory` devDep
  `@onememory/extraction` (the composition test only — the package's runtime code depends on the
  core `Extractor` port, not on the implementation).
- `main` has advanced past the base (`5c20159` → `25d419a`, mission 14a); the file sets are
  disjoint (`comm -12` is empty), so the merge is expected to be clean.

## Ownership

All touched files were inside the assigned list (`packages/codememory/**` including its
`package.json` + README, `apps/api/src/runtime/{composition,daemon,doctor,index}.ts`,
`apps/api/package.json`, `bun.lock`, this report). No root config, ADR, or
`docs/architecture/` file was modified.

## Out of scope / follow-ups

- CLI/MCP surface for manual passes (`onemem scan`-style commands or MCP tools calling
  `runtime.code_memory.runDriftScan/runReindex`) — the runtime handle exists, the commands do not.
- Retrieval-time injection of the digest (the parity memo's "what does this project look like"
  primer) is the retrieval mission's seam, not this one's.
- Symbol-level (`span_hash`) drift resolution; chunked/queued re-index batches for a
  whole-repository rewrite; a tokenizer-backed token estimate (the current one is chars/4).
- Server-mode (Docker Postgres) verification of the full loop — the embedded leg is covered by
  the fixtures above; the server scenarios remain skipped without a live server, as before.
