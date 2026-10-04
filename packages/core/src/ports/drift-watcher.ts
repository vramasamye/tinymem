/**
 * Drift-watcher port (staleness triggers, memory-model.md §7): reports durable memories whose
 * evidence changed — linked code fingerprint changed, source document changed — so the pipeline
 * can mark them `stale` (audited) and queue re-validation. Implemented by `packages/codememory`
 * (M4c) against `memory_code_refs` + `file_fingerprints`.
 *
 * Detection is a pure read over PERSISTED state (ADR-0008: drift is a hash comparison, not a
 * model call). The pipeline captures and persists the latest snapshot (`saveSnapshot`) first;
 * `detectDrift` then compares every recorded ref blob against the current persisted
 * worktree-tier fingerprint. `detectDrift` never writes. The write side is codememory's drift
 * applier (M4e): refs with a `successor_path` are retargeted (exact moves keep their evidence),
 * memories with any other drifted ref go `stale` (audited), and `last_ingested_commit` advances
 * via `CodeMemoryStore.advanceCheckpoint` only once every drifted memory was processed.
 * Re-indexing stale memories is a later step.
 */

/** Why one recorded ref is reported as changed or suspect — never silently fresh. */
export type DriftReason =
  /** A current worktree-tier fingerprint exists and its blob differs from the ref's evidence blob. */
  | 'content_changed'
  /** No current worktree-tier fingerprint exists for the ref's path (deleted, excluded, never captured). */
  | 'path_missing'
  /**
   * The latest capture could not read the path (conflict, unreadable, oversized): the stored
   * fingerprint is a retained last-known value at best, which can never certify freshness.
   */
  | 'capture_unavailable';

/** One drifted `memory_code_refs` row. */
export interface DriftedRef {
  repository_id: string;
  /** The ref's recorded path — where the memory's evidence was taken from. */
  path: string;
  reason: DriftReason;
  /**
   * The ref's content found at a new path. Resolved only by an unambiguous one-to-one exact
   * blob match against current worktree fingerprints (codememory's conservative rename
   * evidence); absent whenever the move cannot be proven without guessing. Modified renames
   * (content changed during the move) and unavailable captures never resolve here.
   */
  successor_path?: string;
}

export interface DriftedMemory {
  memory_id: string;
  /**
   * Repo-relative paths whose current blob no longer matches the memory's evidence blob:
   * every stale ref path plus any resolved successor paths (reported alongside, so consumers
   * can retarget without guessing which side is which — `refs` carries the pairing).
   */
  changed_paths: string[];
  /** Per-ref detail: why each path is listed, and where its content moved when that is provable. */
  refs: DriftedRef[];
}

export interface DriftReport {
  drifted: DriftedMemory[];
}

export interface DriftWatcher {
  detectDrift(input: { project_id: string }): Promise<DriftReport>;
}
