/**
 * Drift apply — the write side of ADR-0008's minimal re-index: turn a drift report into audited
 * `stale` transitions, ref retargets, and (only when everything was processed) an advanced
 * ingestion checkpoint. Orchestration only: every write goes through the `Store` and
 * `CodeMemoryStore` ports (this package contains no SQL), and nothing is ever deleted — stale
 * memories stay retrievable (`queryCurrent` returns active + stale).
 *
 * Per drifted memory:
 * - a ref WITH a `successor_path` is content that moved unchanged (drift resolves successors
 *   only from one-to-one exact blob matches), so its evidence is intact: the ref is retargeted
 *   and does not, by itself, stale the memory. Persistence re-verifies the move; a retarget it
 *   refuses leaves the ref drifted.
 * - any ref WITHOUT a (successfully applied) successor — content_changed, path_missing,
 *   capture_unavailable — marks the memory `stale`. Successor refs of that memory are still
 *   retargeted (the mixed case is stale AND retargeted).
 * - already-stale memories count as processed (re-applying a report is idempotent); superseded
 *   and archived memories are no longer current and cannot go stale, so they count as processed
 *   too; memories deleted since detection are skipped with a warning.
 *
 * The checkpoint of each repository advances to the head the report describes ONLY when every
 * drifted memory was processed; persistence's compare-and-set refuses the move if a newer
 * capture landed or the checkpoint moved concurrently. Re-indexing stale memories is a separate
 * later step.
 */

import type {
  CheckpointAdvanceOutcome,
  CodeMemoryStore,
  CodeRefRetargetOutcome,
  DriftedRef,
  DriftReport,
  MemoryStatus,
  Store,
} from '@onememory/core';

import { createDriftWatcher } from './drift';
import {
  ApplyDriftInputSchema,
  ApplyDriftReportInputSchema,
  type ApplyDriftInput,
  type ApplyDriftReportInput,
  type CheckpointBasis,
} from './schema';

/** The Store surface the applier needs (narrow on purpose: it reads and transitions, nothing else). */
export type DriftApplyStore = Pick<Store, 'getMemory' | 'updateMemoryStatus'>;

export interface DriftApplierDeps {
  store: DriftApplyStore;
  codeMemory: CodeMemoryStore;
}

/**
 * - `marked_stale`: an audited transition to `stale` was written;
 * - `already_stale`: the memory was stale already (idempotent re-apply);
 * - `not_current`: superseded or archived — no longer current, so staleness does not apply;
 * - `evidence_intact`: every drifted ref was a successfully retargeted exact move;
 * - `gone`: the memory no longer exists (skipped with a warning);
 * - `failed`: an unexpected error; the checkpoint is held back.
 */
export type DriftMemoryOutcome =
  | 'marked_stale'
  | 'already_stale'
  | 'not_current'
  | 'evidence_intact'
  | 'gone'
  | 'failed';

export interface AppliedRetarget {
  repository_id: string;
  from_path: string;
  to_path: string;
  outcome: CodeRefRetargetOutcome;
}

export interface AppliedDriftMemory {
  memory_id: string;
  outcome: DriftMemoryOutcome;
  /** Status observed before applying (null when the memory was gone). */
  status_before: MemoryStatus | null;
  /** Status after applying (null when the memory was gone). */
  status_after: MemoryStatus | null;
  retargets: AppliedRetarget[];
  /** The refs that justify staleness: every drifted ref not covered by an applied retarget. */
  drifted_refs: DriftedRef[];
  error?: string;
}

/**
 * Checkpoint step per repository: persistence's compare-and-set outcome, or
 * - `blocked`: some drifted memory was not processed, so the checkpoint was not attempted;
 * - `no_head`: the report describes no commit (unborn HEAD or a non-Git root).
 */
export type CheckpointStepOutcome = CheckpointAdvanceOutcome | 'blocked' | 'no_head';

export interface AppliedCheckpoint {
  repository_id: string;
  outcome: CheckpointStepOutcome;
  previous_commit: string | null;
  current_commit: string | null;
}

export interface DriftApplyResult {
  memories: AppliedDriftMemory[];
  checkpoints: AppliedCheckpoint[];
  /** True when every drifted memory was processed (the precondition for advancing checkpoints). */
  fully_processed: boolean;
  warnings: string[];
}

export interface DriftApplier {
  /**
   * Detect and apply in one step for a project: read each repository's checkpoint basis, run
   * drift detection over the persisted state, then apply the report. Persist the latest capture
   * with `saveSnapshot` before calling.
   */
  apply(input: ApplyDriftInput): Promise<DriftApplyResult>;
  /** Apply an already-computed report against the checkpoint basis read before detection. */
  applyReport(input: ApplyDriftReportInput): Promise<DriftApplyResult>;
}

const RETARGET_KEEPS_EVIDENCE: ReadonlySet<CodeRefRetargetOutcome> = new Set([
  'retargeted',
  'already_retargeted',
]);

const NOT_CURRENT: ReadonlySet<MemoryStatus> = new Set(['superseded', 'archived']);

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Read the checkpoint basis of every repository in a project (call BEFORE detecting drift). */
export async function readCheckpointBasis(
  codeMemory: CodeMemoryStore,
  projectId: string,
): Promise<CheckpointBasis[]> {
  return (await codeMemory.listRepositories(projectId)).map((repository) => ({
    repository_id: repository.id,
    head_commit: repository.head_commit,
    last_ingested_commit: repository.last_ingested_commit,
  }));
}

export function createDriftApplier(deps: DriftApplierDeps): DriftApplier {
  const { store, codeMemory } = deps;
  const watcher = createDriftWatcher(codeMemory);

  async function applyMemory(
    memoryId: string,
    refs: readonly DriftedRef[],
    actor: string,
    warnings: string[],
  ): Promise<AppliedDriftMemory> {
    const result: AppliedDriftMemory = {
      memory_id: memoryId,
      outcome: 'failed',
      status_before: null,
      status_after: null,
      retargets: [],
      drifted_refs: [],
    };
    const gone = (): AppliedDriftMemory => {
      warnings.push(`memory ${memoryId} no longer exists; its drift was skipped`);
      return { ...result, outcome: 'gone', status_after: null };
    };
    // After a failed write, decide from the memory's CURRENT state whether the failure was a
    // benign race (deleted, or concurrently marked stale) or a genuine error.
    const settle = async (error: unknown, staleStep: boolean): Promise<AppliedDriftMemory> => {
      const current = await store.getMemory(memoryId);
      if (current === null) return gone();
      if (staleStep && current.status === 'stale') {
        return { ...result, outcome: 'already_stale', status_after: 'stale' };
      }
      return { ...result, outcome: 'failed', status_after: current.status, error: describeError(error) };
    };

    const memory = await store.getMemory(memoryId);
    if (memory === null) return gone();
    result.status_before = memory.status;
    result.status_after = memory.status;

    for (const ref of refs) {
      if (ref.successor_path === undefined) {
        result.drifted_refs.push(ref);
        continue;
      }
      let outcome: CodeRefRetargetOutcome;
      try {
        outcome = (
          await codeMemory.retargetCodeRef({
            memory_id: memoryId,
            repository_id: ref.repository_id,
            from_path: ref.path,
            to_path: ref.successor_path,
          })
        ).outcome;
      } catch (error) {
        return settle(error, false);
      }
      result.retargets.push({
        repository_id: ref.repository_id,
        from_path: ref.path,
        to_path: ref.successor_path,
        outcome,
      });
      if (!RETARGET_KEEPS_EVIDENCE.has(outcome)) {
        warnings.push(
          `memory ${memoryId}: ref ${ref.path} was not retargeted to ${ref.successor_path} (${outcome}); treated as drifted`,
        );
        result.drifted_refs.push(ref);
      }
    }

    if (result.drifted_refs.length === 0) return { ...result, outcome: 'evidence_intact' };
    if (memory.status === 'stale') return { ...result, outcome: 'already_stale' };
    if (NOT_CURRENT.has(memory.status)) return { ...result, outcome: 'not_current' };

    try {
      const updated = await store.updateMemoryStatus(memoryId, 'stale', {
        actor,
        reason: 'code_drift',
        details: {
          drifted_refs: result.drifted_refs.map((ref) => ({
            repository_id: ref.repository_id,
            path: ref.path,
            reason: ref.reason,
            ...(ref.successor_path === undefined ? {} : { successor_path: ref.successor_path }),
          })),
        },
      });
      return { ...result, outcome: 'marked_stale', status_after: updated.status };
    } catch (error) {
      return settle(error, true);
    }
  }

  async function applyReport(rawInput: ApplyDriftReportInput): Promise<DriftApplyResult> {
    const input = ApplyDriftReportInputSchema.parse(rawInput);
    const warnings: string[] = [];
    const memories: AppliedDriftMemory[] = [];
    for (const drifted of input.report.drifted) {
      let applied: AppliedDriftMemory;
      try {
        applied = await applyMemory(drifted.memory_id, drifted.refs, input.actor, warnings);
      } catch (error) {
        // A read failed outright (e.g. storage unavailable): record it and hold the checkpoint.
        applied = {
          memory_id: drifted.memory_id,
          outcome: 'failed',
          status_before: null,
          status_after: null,
          retargets: [],
          drifted_refs: [],
          error: describeError(error),
        };
      }
      if (applied.outcome === 'failed') {
        warnings.push(`memory ${drifted.memory_id}: drift apply failed (${applied.error ?? 'unknown error'})`);
      }
      memories.push(applied);
    }

    const fullyProcessed = memories.every((memory) => memory.outcome !== 'failed');
    const checkpoints: AppliedCheckpoint[] = [];
    for (const basis of input.checkpoints) {
      const held = (outcome: CheckpointStepOutcome): AppliedCheckpoint => ({
        repository_id: basis.repository_id,
        outcome,
        previous_commit: basis.last_ingested_commit,
        current_commit: basis.last_ingested_commit,
      });
      if (!fullyProcessed) {
        checkpoints.push(held('blocked'));
        continue;
      }
      if (basis.head_commit === null) {
        checkpoints.push(held('no_head'));
        continue;
      }
      const advanced = await codeMemory.advanceCheckpoint({
        repository_id: basis.repository_id,
        expected_last_ingested_commit: basis.last_ingested_commit,
        to_commit: basis.head_commit,
      });
      if (advanced.outcome === 'head_mismatch' || advanced.outcome === 'expectation_mismatch') {
        warnings.push(
          `repository ${basis.repository_id}: checkpoint not advanced (${advanced.outcome}); re-run drift against the latest capture`,
        );
      }
      checkpoints.push({
        repository_id: basis.repository_id,
        outcome: advanced.outcome,
        previous_commit: advanced.previous_commit,
        current_commit: advanced.current_commit,
      });
    }

    return { memories, checkpoints, fully_processed: fullyProcessed, warnings };
  }

  return {
    apply: async (rawInput) => {
      const input = ApplyDriftInputSchema.parse(rawInput);
      const checkpoints = await readCheckpointBasis(codeMemory, input.project_id);
      const report: DriftReport = await watcher.detectDrift({ project_id: input.project_id });
      return applyReport({ report, checkpoints, actor: input.actor });
    },
    applyReport,
  };
}
