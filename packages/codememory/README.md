# @onememory/codememory

The M4 slices implement the local fingerprint foundation and drift detection under ADR-0008. It
uses system Git through argument-safe subprocesses and hashes file bytes locally. It never calls
a model, fetches a remote, writes Git state, or returns source-file contents.

```ts
import { captureSnapshot, detectChanges, extractSymbolTable, createDriftWatcher } from '@onememory/codememory';

const baseline = await captureSnapshot('/absolute/project/root');
const report = await detectChanges(baseline);
// report.changes: added | modified | deleted | renamed | unavailable, separated by tier

const table = await extractSymbolTable('/absolute/project/root');
// table.files: one symbol table per source file; table.skipped: honest per-path skip reasons

// Only-changed re-extraction: re-extract exactly the drift-flagged paths.
const changed = [...new Set(driftReport.flatMap((memory) => memory.changed_paths))];
const update = await extractSymbolTable(root, { files: changed });
```

## Semantics

- `committed` is the **Git index** tier, as specified by ADR-0008, not an alias for HEAD. Staged
  edits affect it even before a commit. `head_commit` is separate metadata.
- `worktree` hashes raw local bytes with Git blob framing in a Git repo. Clean/smudge filters are
  not executed. Consequently CRLF/filter transformations can make this tier differ from the
  index even when Git's normalized diff is empty.
- Git SHA-1 and SHA-256 repositories are supported. Non-Git roots use plain SHA-256 content
  hashes and have no committed tier. Algorithms are recorded explicitly, never mixed.
- A checkpoint-to-HEAD diff supplies Git's modified-rename evidence. If that commit is missing
  (for example in a shallow clone), file hashes still detect changes. Exact, unambiguous moves can
  be matched without history; ambiguous identical files remain add/delete, not guessed renames.
- Snapshots never advance an ingestion checkpoint. Processing/acknowledging changed knowledge is
  a later orchestration step.

## Drift detection (zero-token oracle)

`createDriftWatcher(store)` implements the core `DriftWatcher` port over a `CodeMemoryStore` (M4c).
It is a pure read over PERSISTED state — the pipeline captures and persists a snapshot with
`saveSnapshot` first, then calls `detectDrift({ project_id })`:

- A ref drifted when the current persisted **worktree-tier** fingerprint blob differs from the
  blob the memory was extracted against (`content_changed`). Committed-tier differences never
  drift: refs record worktree-tier evidence, the bytes the agent actually saw.
- A ref whose path has no current worktree fingerprint (`path_missing`), or whose bytes the latest
  capture could not read (`capture_unavailable` — the snapshot metadata's unreadable set), is a
  suspect, never fresh — even when a retained last-known blob happens to match the ref exactly.
- When a ref's path disappeared but its exact blob is found at exactly one other current path,
  the successor is reported alongside the stale path (the same conservative one-to-one evidence
  `compareSnapshots` uses for exact moves). Ambiguous matches, modified renames, and unreadable
  captures never resolve — the stale path is reported rather than a guess.
- `detectDrift` writes nothing: applying `stale`, retargeting `memory_code_refs`, and advancing
  `last_ingested_commit` are the drift applier's job (below); re-indexing is a later step.

## Drift apply (the write side)

`createDriftApplier({ store, codeMemory })` turns drift into durable state through the `Store`
and `CodeMemoryStore` ports (M4e). Persist the latest capture with `saveSnapshot`, then:

```ts
const applier = createDriftApplier({ store: storage.store, codeMemory: storage.codeMemory });
const result = await applier.apply({ project_id }); // reads checkpoint basis, detects, applies
// or, with a report you already hold:
const basis = await readCheckpointBasis(storage.codeMemory, project_id); // BEFORE detecting
const report = await createDriftWatcher(storage.codeMemory).detectDrift({ project_id });
await applier.applyReport({ report, checkpoints: basis });
```

- A ref with a `successor_path` is an exact move (content unchanged), so its evidence is intact:
  the ref is retargeted (`retargetCodeRef`) and does not stale the memory. Persistence
  re-verifies the move — from_path has no worktree fingerprint, to_path has a readable worktree
  fingerprint with the ref's exact blob, and the memory has no ref at to_path yet. A refused
  retarget (`source_present`, `successor_mismatch`, `conflict`) leaves the ref drifted.
- Any other drifted ref (`content_changed`, `path_missing` without a successor,
  `capture_unavailable`) marks the memory `stale` through the audited `updateMemoryStatus`
  (actor `job:drift_scan` by default, reason `code_drift`, the drifted refs in the audit details).
  A mixed memory is stale AND has its successor refs retargeted.
- Already-stale memories are `already_stale` (including a concurrent transition that surfaces as
  `InvalidTransitionError`); superseded/archived memories are `not_current` (no longer current,
  so staleness does not apply); memories deleted since detection are `gone` with a warning. All
  of these count as processed. Unexpected errors are `failed` and reported, never thrown.
- Each repository's `last_ingested_commit` advances to the head the report describes ONLY when
  every drifted memory was processed. `advanceCheckpoint` is a transactional compare-and-set: it
  writes only when the target equals the repository's current persisted `head_commit` (so an old
  report can never move the checkpoint behind a newer capture) and the stored checkpoint equals
  the expected prior value. Re-applying is idempotent (`unchanged`). Repositories without a head
  commit (unborn, non-Git) report `no_head`.
- Nothing is deleted: stale memories stay retrievable (`queryCurrent` returns active + stale) and
  keep drifting on later passes until re-indexing (a later slice) refreshes them.

## The re-index loop (M4f): scheduler → drift_scan → reindex

`createCodeMemoryOrchestration({ store, codeMemory, jobs, extractor, classify, ... })` owns the
loop the M4 primitives were waiting for. It is a pure function of injected ports — the same
`Store`, `CodeMemoryStore`, `JobQueue`, and `Extractor` the pipeline already uses — so the daemon
and a direct-mode CLI call run the same code:

- **`tick()`** registers the project root (`ensureRepository`, resolving the canonical root the
  same way capture does) and enqueues exactly one `drift_scan` job per repository with a
  singleton key (`drift_scan:<repository_id>`), so overlapping ticks coalesce instead of piling
  up jobs. A repository whose scan is already queued or running is `existing`, not an error.
- **`runDriftScan`** (the `drift_scan` handler's body) captures a snapshot, persists it
  (`saveSnapshot`), applies drift through the M4e applier, and then enqueues one chained `reindex`
  job per repository when anything was applied — the handler never sleeps mid-job.
- **`runReindex`** (the `reindex` handler's body) is the minimal re-index below; it also persists
  or refreshes the architecture digest.
- **`status()`** reports the project id, the last drift scan, and the last re-index pass.

```ts
const orchestration = createCodeMemoryOrchestration({ store, codeMemory, jobs, extractor, classify, projectId, rootPath });
await orchestration.tick();                                    // enqueue drift_scan per repository
const scan = await orchestration.runDriftScan({ project_id });  // capture + apply + chain reindex
const pass = await orchestration.runReindex({ project_id });   // re-extract drifted paths + digest
```

The payloads crossing the job queue are Zod-validated at that boundary
(`parseDriftScanJobPayload`, `parseReindexJobPayload`) — an unparseable payload is an honest
error, never a silently dropped job.

### The scheduler

`createCodeMemoryScheduler({ intervalMs, tick, timer?, onError? })` turns a tick function into a
periodic pass with an injectable timer (`setTimeout`/`clearTimeout` by default, `.unref()`-ed so
a scheduled pass never keeps the process alive). It runs an immediate pass on `start`, chains the
next pass only after the current one settles (passes never overlap), reports tick errors through
`onError` without stopping the loop, exposes `runOnce()` for manual passes, and `stop()` awaits
any in-flight pass. The composition root starts it alongside the job worker (default interval
`DEFAULT_DRIFT_SCAN_INTERVAL_MS` = 5 minutes) and stops it first on shutdown so no new
code-memory job is enqueued while the worker drains.

### Minimal re-index (`createReindexer`)

Zero cost for unchanged files, real work only for drift:

1. **Detect** (`detectDrift`): only stale memories and their drifted paths. One unchanged file
   costs nothing — no read, no parse, no extraction.
2. **Symbols**: one scoped `extractSymbolTable(root, { files })` pass over exactly the drifted
   paths, persisted with `saveSymbolTable` (its rewrite guard keeps cosmetic-only files). A
   failing symbol pass is a warning, not a blocker: the text re-index below still runs.
3. **Text**: re-read each drifted path (same read discipline as capture — repository-relative,
   no symlinks, bounded reads), redact it, and hand it to the SAME `Extractor` the `extract` job
   uses, wrapped as a synthetic `document.added` event (`buildCodeDocumentEvent`): an in-memory
   envelope, never ingested, so no synthetic row pollutes the `events` table and the normal
   pipeline never re-processes it. The durable provenance of anything extracted is the real
   `sources` row the re-index creates plus a `file:<path>` evidence locator (`fileEvidence`) —
   the FILE is the source of truth, not the synthetic event.
4. **Resolve** each stale memory against its file's fresh candidates, classified by the injected
   classifier:
   - reproduces the memory's knowledge (same durable type, same content hash) → audited
     `stale → active` (`restored`), refs re-recorded against the current blobs, and `re_embed`
     enqueued when the content changed and an embedder is registered;
   - different knowledge of the same type → the fresh candidate supersedes it through the
     audited `Store.supersede` (actor `job:reindex`, reason `code_drift_reindex`), the winner's
     ref is tracked on the current blob, and the loser keeps its own code refs for the trail;
   - nothing reproducible → the memory honestly stays `stale` and is reported `deferred` — never
     a silent un-stale;
   - the path is unreadable → `gone` with a warning, the memory stays `stale`.
   - unexpected failure → `failed`, reported, never thrown.
5. **Digest**: build the architecture digest (below) and persist it through the normal insertion
   path — created, refreshed via supersede when the code shape changed, or left untouched when
   identical.

### The architecture digest (the ≤300-token project summary)

`buildArchitectureDigest` composes the persisted symbol tables into one compact, deterministic
project summary: grouped modules (top-level directories) → responsibilities (per-file symbol
names, responsibilities first to keep the "what is this" signal in budget) → entry points
(bins/servers/cli), plus a language mix and an honest `truncated` flag when the token budget
forced drops (responsibilities → entry points → modules, in that order). It is deterministic:
the same code shape yields the same text and the same content hash, so it persists through the
normal insertion path with full provenance (a `sources` row + `file:` evidence for the files it
summarizes) and is NOT refreshed unless the code shape actually changed. The budget is
`DEFAULT_DIGEST_TOKEN_BUDGET` = 300 tokens by default (`estimateDigestTokens` ≈ chars/4, the
same order of magnitude OpenAI reports for English text; the budget is an argument, so a
different surface can tighten it). `moduleOfPath` maps a repository-relative path to its module
label.

## Symbol extraction (tree-sitter, WASM, offline)

`extractSymbolTable(root)` parses the worktree's source files with tree-sitter through the
`web-tree-sitter` WASM runtime (dependency-verification §9 verdict: no OS native addon, no build
step at install — Bun blocks the grammar packages' `install` scripts, and an install performs no
compilation at all). The core runtime WASM resolves through `web-tree-sitter`'s exported
`web-tree-sitter.wasm` subpath; grammar bytes come from the installed `tree-sitter-*` packages'
prebuilt `.wasm` files via literal `require.resolve` calls, read with `fs` — nothing is fetched
at install or runtime, and the symbol tests pin this with the `@onememory/security` network guard.
Bun-from-source is the supported runtime; the extraction API also runs under Node LTS when
resolved against an installed `node_modules` (the literal asset references make that a
bundler-friendly packaging concern, not a silent failure).

Languages and declaration surfaces (the symbol vocabulary of ADR-0008):

- TypeScript / TSX / JavaScript: `function`, `class`, `method`, `interface`, `type`, `enum`,
  `module` (namespaces).
- Python: `function` (functions + methods), `class`.
- Go: `function` (functions + methods), `struct`, `interface`, `type` (type aliases/defs).
- Rust: `function` (free + associated + trait-default), `struct`, `enum`, `trait`, `impl`,
  `module`.

Per file the extractor reports `symbols` — `name`, `kind`, normalized `signature` (a canonical
single-space token rendering capped at 240 chars), `line_start`/`line_end`, and a `span_hash` —
plus `parse_errors` (tree-sitter ERROR node count; a tree with errors still yields its clean
declarations) and a `symbols_hash` over the ordered table. Two stability properties are pinned by
tests:

- **`span_hash` ignores comments and whitespace** (a SHA-256 over the span's normalized token
  stream): adding comments, editing a comment, reindenting, or switching CRLF/LF never moves a
  symbol's hash. Editing real tokens moves that symbol's hash and leaves every sibling untouched.
- **`symbols_hash` includes line positions** (a hash move is legitimate re-extraction evidence),
  so `saveSymbolTable`'s per-file rewrite guard (in storage) can distinguish cosmetic-only files
  from real edits — cosmetic-only files keep their persisted rows and `updated_at`.

Scope mode: `extractSymbolTable(root, { files })` re-extracts exactly the given paths (the
`detectChanges` / `detectDrift` flagged set), skipping every other file — the only-changed
primitive the drift pipeline needs. It parses bytes with the same read discipline as fingerprint
capture: paths are validated repository-relative, symlinks are not followed, and races between
stat and read are detected. Files outside the vocabulary skip with a structured reason, never a
silent omission: `excluded`, `conflict`, `symlink`, `submodule`, `binary`, `too_large`, `missing`,
`unreadable`, `unsupported_language`, `grammar_unavailable` (the runtime/grammar could not load),
or `outside_root`. Persistence (`code_symbols`, `file_fingerprints.symbols_hash`) lives behind
the `CodeMemoryStore` port in `@onememory/storage` — this package contains no SQL.

## Safety and completeness

The security package's built-in `.env`, key, and credential exclusions cannot be disabled.
Additional globs are additive. Git metadata, `.onememory`, dependencies, and generated build
directories are omitted. Git-ignored untracked files are not scanned.

Symlinks and submodules are not followed; conflict stages and unreadable/oversized files are
reported in `skipped`. Such paths produce `unavailable` changes rather than an empty "fresh"
report. Budget exhaustion fails the whole capture instead of silently truncating it. Non-UTF-8
Git filenames and unsafe repository-relative paths fail closed.

Git subprocesses disable configured fsmonitor helpers, external diff/textconv, inherited Git
directory overrides, lazy object fetches, and remote protocols. Diff invocations pin rename
detection and the submodule policy explicitly, so user configuration (`diff.renames`,
`diff.ignoreSubmodules`) cannot change results, and the stored baseline commit is preflighted
before the checkpoint diff, so shallow or rewritten histories degrade to content hashes with a
precise warning. The scanner is not a sandbox
against an adversary concurrently replacing the entire filesystem tree while it runs.

## Validation

```sh
bun test packages/codememory
cd packages/codememory && bun run typecheck
bun run bench
```

The unit and real-Git integration fixtures cover unusual filenames, staged/dirty edits, modified
renames, missing checkpoints, detached/unborn HEAD, SHA-256 repositories, conflicts, exclusions,
non-Git fallback, bounded reads, and filter/fsmonitor non-execution. The symbol fixtures cover
the six grammar vocabularies, comment/whitespace-insensitive span hashing, position-sensitive
table hashing, scoped re-extraction over a real embedded database (saveSnapshot → extract →
saveSymbolTable → detectChanges → scoped re-extract → rewrite guard), every skip reason, and the
offline invariant (zero network calls under the guard). The M4f fixtures pin the whole loop over
a real Git repository and real embedded storage — scheduler pass → drift scan (audited stale +
checkpoint advance) → chained re-index that re-reads ONLY the drifted path, refreshes the memory,
and persists the digest — plus the synthetic `document.added` bridge flowing through the REAL
heuristic extractor offline, and every re-index/scheduler/digest edge (supersede, deferred,
degraded extractor/symbols, unreadable path, `re_embed` gating, digest create/unchanged/refresh).

The pure comparison benchmark checks 1k/10k/100k exact renames; it reports local timings, not a
hardware-independent latency promise.

## Remaining M4 scope

Symbol-level drift comparison (matching extracted symbols against persisted ones beyond the
per-file rewrite guard) is a later slice, not a placeholder in this one. The re-index resolves
memories at the file-text level through the composed extraction pipeline; symbol-level
resolution (a symbol moved between files, a signature change that keeps the prose true) is not
attempted here. Large drift sets are re-indexed in one pass — chunked/queued batches for a
whole-repository rewrite are a later scaling concern, and the digest's token budget is a
heuristic estimate, not a tokenizer call.
