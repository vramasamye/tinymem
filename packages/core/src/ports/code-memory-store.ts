/**
 * Code-memory persistence port (ADR-0008): the only writer of `repositories`,
 * `file_fingerprints`, and `code_symbols`. Core declares the contract; `@onememory/storage`
 * implements it with the engine's only SQL; the M4 pipeline persists codememory snapshots and
 * symbol tables through it.
 *
 * Invariants implementations must keep:
 * - one repository row per (project_id, root_path);
 * - both tiers (`committed` and `worktree`) stored per path — the fingerprint primary key
 *   includes the tier for exactly this reason (ADR-0008 "two tiers recorded");
 * - a snapshot replaces the stored fingerprints it covers, EXCEPT (path, tier) entries that were
 *   unavailable in the new capture (conflict, unreadable, oversized, …): their last-known
 *   fingerprints are retained so drift resolution treats them as suspect, never silently fresh;
 * - symbol rows only ever exist for paths with a live worktree-tier fingerprint row (their
 *   `symbols_hash` anchor): when a snapshot deletes a path's worktree fingerprint, that path's
 *   symbol rows die with it — symbol tables never outlive their evidence;
 * - `last_ingested_commit` is never advanced here — that checkpoint moves only when changed
 *   knowledge is fully processed, which is the drift pipeline's job, not persistence's.
 */

import type {
  EnsureCodeRepository,
  FingerprintTier,
  RecordCodeRefs,
  SnapshotInput,
  SnapshotMetadata,
  SymbolTableSave,
} from '../schema/persistence';

/** One `repositories` row (the ADR-0008 fingerprint keys live here). */
export interface CodeRepositoryRecord {
  id: string;
  project_id: string;
  root_path: string;
  remote_url: string | null;
  /** HEAD at the last persisted snapshot (null when unborn or never captured). */
  head_commit: string | null;
  /** The ingestion checkpoint — advanced only by the drift pipeline, never by saveSnapshot. */
  last_ingested_commit: string | null;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One `file_fingerprints` row. */
export interface StoredFingerprint {
  repository_id: string;
  path: string;
  tier: FingerprintTier;
  blob_sha: string;
  /** Git file mode; null only for rows persisted before the column existed. */
  file_mode: string | null;
  /** HEAD under which this fingerprint was last observed (null when captured unborn). */
  last_seen_commit: string | null;
  /**
   * Hash of the symbol table for this file (null until a symbol save covers it, or when the
   * extraction could not read the file). Worktree-tier only: symbols are extracted from the
   * bytes the agent actually saw, so the committed tier never carries a symbols_hash.
   */
  symbols_hash: string | null;
  updated_at: string;
}

/** One `memory_code_refs` row: the worktree-tier evidence blob a memory rests on. */
export interface MemoryCodeRef {
  memory_id: string;
  repository_id: string;
  /** Repository-relative path the memory was extracted against. */
  path: string;
  /** Worktree-tier blob the memory's evidence was verified against. */
  blob_sha: string;
  created_at: string;
}

export interface SnapshotSaveResult {
  repository: CodeRepositoryRecord;
  /** Fingerprint rows whose stored values actually changed; already-current rows stay untouched. */
  rewritten: number;
  /** Fingerprint rows deleted because their path is gone from the capture and not unavailable. */
  deleted: number;
  /** Existing rows retained because their (path, tier) was unavailable in this capture. */
  retained_unavailable: number;
}

export interface CodeMemoryStore {
  /** Find or create the repository for (project_id, root_path); idempotent. */
  ensureRepository(input: EnsureCodeRepository): Promise<CodeRepositoryRecord>;
  getRepository(id: string): Promise<CodeRepositoryRecord | null>;
  listRepositories(project_id: string): Promise<CodeRepositoryRecord[]>;
  /**
   * Persist one captured snapshot atomically: upsert both tiers' fingerprints, delete rows for
   * gone paths (absent and not unavailable), and record snapshot metadata + head_commit. The
   * snapshot's root_path must match the repository row. Never advances last_ingested_commit.
   */
  saveSnapshot(repository_id: string, snapshot: SnapshotInput): Promise<SnapshotSaveResult>;
  /** Current stored fingerprints, optionally narrowed by tier and/or paths. */
  loadFingerprints(
    repository_id: string,
    filter?: { tier?: FingerprintTier; paths?: readonly string[] },
  ): Promise<StoredFingerprint[]>;
  /** Metadata of the latest persisted snapshot, or null when none was saved yet. */
  loadSnapshotMetadata(repository_id: string): Promise<SnapshotMetadata | null>;
  /**
   * Idempotent upsert of the code evidence ONE memory rests on within ONE repository. Refs are
   * worktree-tier by definition (see `RecordCodeRefsSchema`) — callers pass the worktree-tier
   * fingerprint the memory was extracted against. Re-recording a path updates its blob and
   * keeps the original `created_at`; recording never deletes rows, so pruning or re-pointing a
   * memory's ref set belongs to the drift pipeline, not persistence. Removal happens only via
   * the memory/repository FK cascades.
   */
  recordCodeRefs(input: RecordCodeRefs): Promise<MemoryCodeRef[]>;
  /** The refs recorded for one repository, optionally narrowed by paths (drift's read side). */
  listCodeRefs(
    repository_id: string,
    filter?: { paths?: readonly string[] },
  ): Promise<MemoryCodeRef[]>;
  /**
   * Persist one symbol-table extraction atomically (ADR-0008 "Symbol tables re-extract only
   * changed files"): for every covered file whose `symbols_hash` differs from the stored
   * worktree-tier fingerprint's `symbols_hash`, replace that file's `code_symbols` rows and
   * record the new hash on the fingerprint row. Covered files whose hash already matches are
   * left untouched (the conflict guard: unchanged rows are never rewritten). Files NOT covered
   * by the save are never touched — a scoped re-extraction save covers exactly the files it
   * extracted, and files the extraction could not read are simply not covered, so their
   * last-known rows stay retained-unavailable. Every covered path must have a live
   * worktree-tier fingerprint row: the pipeline shape is saveSnapshot FIRST, then
   * saveSymbolTable (the hash lives on the fingerprint row by schema design). Pruning rows
   * whose fingerprint anchor died is saveSnapshot's job, never this one's, and the ingestion
   * checkpoint is as untouchable here as everywhere else.
   */
  saveSymbolTable(repository_id: string, input: SymbolTableSave): Promise<SymbolTableSaveResult>;
  /** The persisted symbol rows of one repository, optionally narrowed by paths. */
  loadSymbols(
    repository_id: string,
    filter?: { paths?: readonly string[] },
  ): Promise<StoredSymbol[]>;
}

/** One `code_symbols` row. */
export interface StoredSymbol {
  repository_id: string;
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  /** 1-based inclusive line range of the span (nullable only for rows written without one). */
  line_start: number | null;
  line_end: number | null;
  /** SHA-256 of the symbol's normalized span; null only for rows written without one. */
  span_hash: string | null;
  updated_at: string;
}

export interface SymbolTableSaveResult {
  repository: CodeRepositoryRecord;
  /** Covered files whose stored symbol table was rewritten (their symbols_hash differed). */
  rewritten: number;
  /** Covered files skipped by the conflict guard: the stored symbols_hash already matched. */
  unchanged: number;
}
