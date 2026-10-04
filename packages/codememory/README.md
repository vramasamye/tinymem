# @onememory/codememory

The M4 slices implement the local fingerprint foundation and drift detection under ADR-0008. It
uses system Git through argument-safe subprocesses and hashes file bytes locally. It never calls
a model, fetches a remote, writes Git state, or returns source-file contents.

```ts
import { captureSnapshot, detectChanges, createDriftWatcher } from '@onememory/codememory';

const baseline = await captureSnapshot('/absolute/project/root');
const report = await detectChanges(baseline);
// report.changes: added | modified | deleted | renamed | unavailable, separated by tier
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
- `detectDrift` writes nothing: applying `stale`, retargeting `memory_code_refs`, re-indexing, and
  advancing `last_ingested_commit` are the pipeline's later steps.

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
non-Git fallback, bounded reads, and filter/fsmonitor non-execution.
The pure comparison benchmark checks 1k/10k/100k exact renames; it reports local timings, not a
hardware-independent latency promise.

## Remaining M4 scope

This package does not yet persist snapshots itself (the `CodeMemoryStore` port in
`@onememory/storage` does), mark memories stale, retarget `memory_code_refs`, enqueue re-index
work, advance the ingestion checkpoint, parse symbols, or assemble a project digest. Those are
the next M4 slices, not placeholder implementations in this one.
