/**
 * Code-memory orchestration (M4f): the job execution the M4 primitives were waiting for. The
 * daemon's worker loop executes `normalize`/`extract`/`re_embed`; this module supplies the two
 * code-memory handlers and the periodic pass that feeds them:
 *
 * - `tick()` — the scheduler's pass: ensure the registered project's repository exists, then
 *   enqueue one `drift_scan` per registered repository (singleton-keyed, so a slow scan never
 *   piles up duplicates);
 * - `runDriftScan({ project_id, repository_id? })` — capture + persist the snapshot for the
 *   targeted repositories (the zero-token hash pass), apply drift through the M4e applier
 *   (audited `stale` marking + exact-move retarget + checkpoint compare-and-set), then chain a
 *   `reindex` job;
 * - `runReindex({ project_id })` — the minimal re-index + architecture digest (see `reindex.ts`).
 *
 * Nothing here throws out of a scheduled pass: capture failures, an unavailable Git probe, and
 * apply errors are recorded as warnings on the result. Degraded is a state, not an error.
 */

import type { CodeMemoryStore, Extractor, JobQueue, Store } from '@onememory/core';
import { z } from 'zod';

import { createDriftApplier, type DriftApplyResult } from './apply-drift';
import { captureSnapshot, resolveRepositoryRoot } from './fingerprints';
import { describeError } from './internal';
import {
  createReindexer,
  type ReindexClassifier,
  type ReindexInput,
  type ReindexResult,
} from './reindex';
import type {
  FingerprintOptions,
  RepositorySnapshot,
  SkippedSymbolFile,
  SymbolTable,
} from './schema';

/** The subset of the fingerprint options the orchestration forwards to capture. */
export interface CodeMemoryOrchestrationOptions {
  store: Store;
  codeMemory: CodeMemoryStore;
  jobs: JobQueue;
  extractor: Extractor;
  classify: ReindexClassifier;
  /** Registered project (null when the daemon has none — the scheduler then does nothing). */
  projectId: string | null;
  /** Registered project root, used to register a repository on first contact. */
  rootPath: string | null;
  /** Additional exclusion globs for capture (config `security.exclude_globs`). */
  exclusionGlobs?: readonly string[];
  /** Redact re-read text before extraction (secrets never enter memory). */
  redactText?: (text: string) => string;
  enqueueReEmbed?: boolean;
  maxFileBytes?: number;
  digestBudgetTokens?: number;
  now?: () => Date;
  onWarning?: (message: string) => void;
  /** Test seams. */
  capture?: (root: string, options?: FingerprintOptions) => Promise<RepositorySnapshot>;
  resolveRoot?: (root: string) => Promise<string>;
  extractSymbols?: (root: string, options: { files: string[]; max_file_bytes?: number }) => Promise<SymbolTable>;
  readText?: (root: string, path: string, maxBytes: number) => Promise<{ source: string } | SkippedSymbolFile>;
}

export interface DriftScanRepositoryResult {
  repository_id: string;
  root_path: string;
  captured: boolean;
  head_commit: string | null;
  files: number;
  skipped: number;
  warnings: string[];
  error?: string;
}

export interface DriftScanInput {
  project_id: string;
  /** Scope the capture to one repository (the per-repository job); omit to scan them all. */
  repository_id?: string;
}

export interface DriftScanResult {
  project_id: string;
  repositories: DriftScanRepositoryResult[];
  applied: DriftApplyResult | null;
  reindex_enqueued: boolean;
  warnings: string[];
}

export interface SchedulePassResult {
  project_id: string | null;
  repositories: number;
  enqueued: number;
  existing: number;
  warnings: string[];
}

/** The `drift_scan` job payload (validated at the worker boundary, like every external input). */
export const DriftScanJobPayloadSchema = z.strictObject({
  project_id: z.uuid(),
  repository_id: z.uuid().optional(),
});

/** The `reindex` job payload. */
export const ReindexJobPayloadSchema = z.strictObject({
  project_id: z.uuid(),
});

/** Parse a `drift_scan` job payload into {@link DriftScanInput} (throws on malformed input). */
export function parseDriftScanJobPayload(payload: Record<string, unknown>): DriftScanInput {
  const parsed = DriftScanJobPayloadSchema.parse(payload);
  return {
    project_id: parsed.project_id,
    ...(parsed.repository_id === undefined ? {} : { repository_id: parsed.repository_id }),
  };
}

/** Parse a `reindex` job payload into {@link ReindexInput} (throws on malformed input). */
export function parseReindexJobPayload(payload: Record<string, unknown>): ReindexInput {
  return { project_id: ReindexJobPayloadSchema.parse(payload).project_id };
}

export interface CodeMemoryOrchestrationStatus {
  project_id: string | null;
  last_drift_scan_at: string | null;
  last_reindex_at: string | null;
}

export interface CodeMemoryOrchestration {
  tick(): Promise<SchedulePassResult>;
  runDriftScan(input: DriftScanInput): Promise<DriftScanResult>;
  runReindex(input: ReindexInput): Promise<ReindexResult>;
  status(): CodeMemoryOrchestrationStatus;
}

export function createCodeMemoryOrchestration(
  options: CodeMemoryOrchestrationOptions,
): CodeMemoryOrchestration {
  const now = options.now ?? (() => new Date());
  const capture = options.capture ?? captureSnapshot;
  const resolveRoot = options.resolveRoot ?? resolveRepositoryRoot;
  const warn = (message: string): void => options.onWarning?.(message);
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;

  const reindexer = createReindexer({
    store: options.store,
    codeMemory: options.codeMemory,
    jobs: options.jobs,
    extractor: options.extractor,
    classify: options.classify,
    ...(options.redactText === undefined ? {} : { redactText: options.redactText }),
    ...(options.enqueueReEmbed === undefined ? {} : { enqueueReEmbed: options.enqueueReEmbed }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.digestBudgetTokens === undefined ? {} : { digestBudgetTokens: options.digestBudgetTokens }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.extractSymbols === undefined ? {} : { extractSymbols: options.extractSymbols }),
    ...(options.readText === undefined ? {} : { readText: options.readText }),
  });

  let lastDriftScanAt: string | null = null;
  let lastReindexAt: string | null = null;

  /** Register the project's root repository (idempotent), returning its record when possible. */
  async function ensureRootRepository(projectId: string): Promise<string[]> {
    const warnings: string[] = [];
    if (options.rootPath !== null) {
      try {
        const canonical = await resolveRoot(options.rootPath);
        await options.codeMemory.ensureRepository({ project_id: projectId, root_path: canonical });
      } catch (error) {
        warnings.push(`repository registration failed for ${options.rootPath}: ${describeError(error)}`);
      }
    }
    const repositories = await options.codeMemory.listRepositories(projectId);
    if (repositories.length === 0) {
      warnings.push(
        'no code repository is registered for this project; code memory stays inactive until a root exists',
      );
    }
    for (const warning of warnings) warn(warning);
    return repositories.map((repository) => repository.id);
  }

  return {
    async tick(): Promise<SchedulePassResult> {
      const result: SchedulePassResult = {
        project_id: options.projectId,
        repositories: 0,
        enqueued: 0,
        existing: 0,
        warnings: [],
      };
      if (options.projectId === null) return result;
      const projectId = options.projectId;
      try {
        const repositoryIds = await ensureRootRepository(projectId);
        result.repositories = repositoryIds.length;
        for (const repositoryId of repositoryIds) {
          const enqueued = await options.jobs.enqueue({
            kind: 'drift_scan',
            key: `drift_scan:${projectId}:${repositoryId}`,
            payload: { project_id: projectId, repository_id: repositoryId },
          });
          if (enqueued.outcome === 'enqueued') result.enqueued += 1;
          else result.existing += 1;
        }
      } catch (error) {
        result.warnings.push(`schedule pass failed: ${describeError(error)}`);
        warn(`code-memory schedule pass failed: ${describeError(error)}`);
      }
      return result;
    },

    async runDriftScan(input: DriftScanInput): Promise<DriftScanResult> {
      const result: DriftScanResult = {
        project_id: input.project_id,
        repositories: [],
        applied: null,
        reindex_enqueued: false,
        warnings: [],
      };
      const repositories = await options.codeMemory.listRepositories(input.project_id);
      const targets =
        input.repository_id === undefined
          ? repositories
          : repositories.filter((repository) => repository.id === input.repository_id);
      if (targets.length === 0) {
        result.warnings.push('no registered repository matched the drift scan request');
      }

      const exclusionGlobs = [...(options.exclusionGlobs ?? [])];
      for (const repository of targets) {
        const entry: DriftScanRepositoryResult = {
          repository_id: repository.id,
          root_path: repository.root_path,
          captured: false,
          head_commit: repository.head_commit,
          files: 0,
          skipped: 0,
          warnings: [],
        };
        try {
          const snapshot = await capture(repository.root_path, {
            exclusion_globs: exclusionGlobs,
            max_file_bytes: maxFileBytes,
          });
          const saved = await options.codeMemory.saveSnapshot(repository.id, snapshot);
          entry.captured = true;
          entry.head_commit = saved.repository.head_commit;
          entry.files = snapshot.files.length;
          entry.skipped = snapshot.skipped.length;
          entry.warnings = [...snapshot.warnings];
        } catch (error) {
          entry.error = describeError(error);
          result.warnings.push(`capture failed for repository ${repository.id}: ${entry.error}`);
        }
        result.repositories.push(entry);
      }

      // Apply drift for the whole project (idempotent; the applier reads the checkpoint basis and
      // detects against the just-persisted snapshots). Errors are reported, never thrown.
      try {
        const applier = createDriftApplier({ store: options.store, codeMemory: options.codeMemory });
        result.applied = await applier.apply({ project_id: input.project_id, actor: 'job:drift_scan' });
        result.warnings.push(...result.applied.warnings);
      } catch (error) {
        result.warnings.push(`drift apply failed: ${describeError(error)}`);
      }

      // Chain the re-index pass (singleton-keyed): refreshes stale memories and rebuilds the
      // architecture digest. Enqueued even without drift so the digest exists on a fresh project.
      try {
        const enqueued = await options.jobs.enqueue({
          kind: 'reindex',
          key: `reindex:${input.project_id}`,
          payload: { project_id: input.project_id },
        });
        result.reindex_enqueued = enqueued.outcome === 'enqueued';
      } catch (error) {
        result.warnings.push(`reindex enqueue failed: ${describeError(error)}`);
      }

      lastDriftScanAt = now().toISOString();
      return result;
    },

    async runReindex(input: ReindexInput): Promise<ReindexResult> {
      const result = await reindexer.reindex(input);
      lastReindexAt = now().toISOString();
      return result;
    },

    status(): CodeMemoryOrchestrationStatus {
      return {
        project_id: options.projectId,
        last_drift_scan_at: lastDriftScanAt,
        last_reindex_at: lastReindexAt,
      };
    },
  };
}
