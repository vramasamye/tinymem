/**
 * Drift-watcher port (staleness triggers, memory-model.md §7): reports durable memories whose
 * evidence changed — linked code fingerprint changed, source document changed — so the pipeline
 * can mark them `stale` (audited) and queue re-validation. Implemented by `packages/codememory`
 * (M4) against `memory_code_refs` + `file_fingerprints`.
 */

export interface DriftedMemory {
  memory_id: string;
  /** Repo-relative paths whose current blob no longer matches the memory's evidence blob. */
  changed_paths: string[];
}

export interface DriftReport {
  drifted: DriftedMemory[];
}

export interface DriftWatcher {
  detectDrift(input: { project_id: string }): Promise<DriftReport>;
}
