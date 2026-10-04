# Mission 4e: drift apply (fifth M4 slice)

Branch: `mission/4e-drift-apply` · Base: `2859037` · ADR: `0008-code-memory-git-fingerprints.md`

## Delivered scope

The write side of ADR-0008's minimal re-index — the Phase-2 DoD keystone ("change one file →
only memories referencing it are marked `stale`; unchanged files cost zero re-index tokens;
rename moves references via git rename detection"):

- **Port extensions** (`CodeMemoryStore`, no new port; Zod inputs in
  `core/src/schema/persistence.ts`; SQL in `storage/src/repositories/code-memory.ts`):
  - `retargetCodeRef({ memory_id, repository_id, from_path, to_path })` →
    `{ outcome, ref }`, one transaction, scoped to one memory/repository/from-path. Outcomes:
    `retargeted`, `already_retargeted` (idempotent re-apply), `conflict` (the memory already has
    a ref at to_path — nothing merged), `source_present` (from_path still has a worktree
    fingerprint — not a move), `successor_mismatch` (to_path missing, unreadable in the latest
    capture, or holding a different blob). Only `retargeted` writes; the ref keeps its blob and
    `created_at`. NotFoundError for an unknown memory, repository, or when neither ref row
    exists; ValidationError for from == to or unsafe paths.
  - `advanceCheckpoint({ repository_id, expected_last_ingested_commit, to_commit })` →
    `{ outcome, previous_commit, current_commit, repository }`, a `FOR UPDATE` compare-and-set
    and the only writer of `last_ingested_commit`. Checks in order: already at to_commit →
    `unchanged`; to_commit ≠ current persisted `head_commit` → `head_mismatch`; stored value ≠
    expected → `expectation_mismatch`; otherwise `advanced`. Never backwards: the target must
    be the latest persisted capture's head, so an older report can never move the checkpoint
    behind a newer capture. NotFoundError for an unknown repository.
- **Pipeline** (`packages/codememory/src/apply-drift.ts`, exported from `index.ts`):
  `createDriftApplier({ store, codeMemory })` → `{ apply({ project_id, actor? }),
  applyReport({ report, checkpoints, actor? }) }`, plus `readCheckpointBasis(codeMemory,
  project_id)`. `apply` reads the checkpoint basis (head + checkpoint per repository) BEFORE
  detecting, runs `createDriftWatcher`, then applies. Inputs are Zod-validated
  (`ApplyDriftInputSchema`, `ApplyDriftReportInputSchema`, `DriftReportSchema`,
  `CheckpointBasisSchema`). The `store` dependency is `Pick<Store, 'getMemory' |
  'updateMemoryStatus'>`.
- **Wiring**: `createCodeMemoryStore` in `packages/storage/src/store.ts` binds the two new
  methods (see "Ownership" below).

## Semantics as implemented

Validated against `drift.ts` + `drift.test.ts` before coding: `successor_path` is set only for
`path_missing` refs whose exact blob is found at exactly one other readable current path, the
memory's own other ref paths excluded. That matches the contract given to this mission; no
correction was needed.

Per drifted memory (read first; `null` → `gone`):

1. Each ref with a `successor_path` is retargeted. `retargeted`/`already_retargeted` keep the
   evidence; any other outcome leaves the ref drifted (with a warning) — persistence re-verifies
   the move against the persisted worktree tier rather than trusting the report.
2. Refs with no successor (`content_changed`, `path_missing`, `capture_unavailable`) plus refused
   retargets are the memory's `drifted_refs`.
3. No drifted refs → `evidence_intact` (status untouched, no audit row). Otherwise by status:
   `stale` → `already_stale`; `superseded`/`archived` → `not_current` (not current knowledge,
   and the transition machine has no edge to stale); `active`/`disputed` → audited
   `updateMemoryStatus(id, 'stale', { actor, reason: 'code_drift', details: { drifted_refs } })`
   → `marked_stale`. Default actor `job:drift_scan`.
4. A failed write is settled by re-reading the memory: deleted → `gone` (warning);
   concurrently stale during the stale step (the `InvalidTransitionError` race) →
   `already_stale`; anything else → `failed` with the error message. Errors are reported, not
   thrown.

Checkpoint: `fully_processed` is true when no memory is `failed` (`gone`, `already_stale`,
`not_current`, `evidence_intact`, `marked_stale` all count as processed). Only then does each
basis repository call `advanceCheckpoint(expected = basis.last_ingested_commit, to =
basis.head_commit)`; otherwise every repository reports `blocked`. A null head (unborn/non-Git)
reports `no_head` and is never advanced. Refused compare-and-sets are warned. Repositories with no
drift advance too — zero drift means the capture is fully processed.

Idempotency: re-applying the same report yields `already_stale` / `already_retargeted` /
checkpoint `unchanged`, with no new audit rows. Stale memories stay in `queryCurrent` and keep
being reported by later passes (they are `already_stale` until re-indexing refreshes them).

Decision beyond the contract (flagged): superseded/archived memories count as processed
(`not_current`) instead of being forced through the transition machine; their successor refs are
still retargeted.

## Tests

- `apply-drift.test.ts` (10, port doubles): content change → audited stale + checkpoint;
  exact move → retarget only; mixed; refused retarget → stale; already-stale / superseded /
  archived / disputed; `InvalidTransitionError` race → already_stale; gone (before and during
  apply) → skipped with warnings, checkpoint still advances; unexpected failure → `blocked`
  checkpoints and zero `advanceCheckpoint` calls; `no_head` and `head_mismatch`; Zod boundary.
- `apply-drift.fixture.test.ts` (4, real Git fixture + embedded storage, under the network
  guard): **the DoD test** — four memories over three files, edit+commit ONE file → only the two
  memories referencing it go stale, the others keep status and audit count, refs unchanged,
  checkpoint advances baseline → new head, stale memories still in `queryCurrent`; exact `git mv`
  → ref retargeted, memory active, no audit row, next detect reports nothing; mixed edit+move →
  stale AND retargeted, then the same report re-applied is idempotent and a fresh pass is a
  no-op; a capture saved between detection and apply → `head_mismatch`, checkpoint held, next
  pass advances straight to the newest head.
- Storage scenario `codeMemoryDriftApplyScenario` (both legs): record refs → drifting capture →
  stale + retarget + checkpoint advanced → second apply no-op; every retarget refusal outcome
  (incl. a retained-unavailable successor with the exact blob); NotFound/Validation boundaries;
  `head_mismatch` (backwards), `expectation_mismatch`, forward advance.

## Validation

- Focused: `bun test src/apply-drift` (codememory) 14 pass / 0 fail; storage embedded suite
  17 pass / 0 fail.
- Typecheck: every package with a `typecheck` script passes (codememory, config, core,
  embeddings, extraction, llm, mcp, retrieval, security, storage, adapters/claude,
  adapters/codex, apps/api, apps/cli).
- Full suite at the worktree root: **1014 pass / 21 skip / 0 fail, 1035 tests, 77 files**
  (baseline 999 / 20 / 0, 1019 tests, 75 files: +14 codememory tests, +1 embedded scenario,
  +1 skipped server scenario, +2 files).
- Server leg: temporary `pgvector/pgvector:pg17` on `127.0.0.1:55433`,
  `bun test src/integration/server.test.ts` → 17 pass / 0 fail; container removed.
- No new dependencies; `bun.lock` unchanged; no migration (existing columns only).

## Ownership

One file outside the assigned list was modified: `packages/storage/src/store.ts` (+2 lines
binding `retargetCodeRef` and `advanceCheckpoint` in `createCodeMemoryStore`). The port
extension cannot compile without it, since that factory structurally implements
`CodeMemoryStore`. No other out-of-ownership file was touched.

## Out of scope

- Re-index orchestration (re-extraction / re-embedding of stale memories, `reindex`/`re_embed`
  jobs, `stale → active` re-verification).
- Symbol-level (`span_hash`) drift; architecture-digest rebuilds; `onemem check`/doctor surface.
- Scheduling drift as a `drift_scan` job, and CLI/MCP exposure of the applier.
- Pruning or re-recording ref sets beyond exact-move retargeting.
