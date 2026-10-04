# @onememory/codememory

The first M4 slice implements a local fingerprint foundation under ADR-0008. It uses system Git
through argument-safe subprocesses and hashes file bytes locally. It never calls a model, fetches
a remote, writes Git state, or returns source-file contents.

```ts
import { captureSnapshot, detectChanges } from '@onememory/codememory';

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

This package does not yet implement `DriftWatcher`, persist snapshots, update `memory_code_refs`,
mark memories stale, enqueue re-index work, parse symbols, or assemble a project digest. Those
are the next M4 slices, not placeholder implementations in this one.
