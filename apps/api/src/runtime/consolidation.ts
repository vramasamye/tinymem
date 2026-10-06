/**
 * Daemon-side consolidation orchestration (M14 follow-up 1): the `consolidate` and `decay` job
 * handlers and the periodic scheduler that feeds them.
 *
 * `JOB_KINDS` has declared `consolidate` and `decay` since M1, but nothing enqueued or handled
 * them: an enqueued job would dead-letter with `JobKindNotImplemented`, and `onemem consolidate`
 * refused whenever a daemon owned the data dir. This module closes that gap by driving the same
 * idempotent {@link runConsolidation} entry the CLI uses.
 *
 * The job KIND is the contract (memory-model.md §8): `consolidate` runs all four passes
 * (contradiction → derivation → merge → decay); `decay` runs only the terminal decay/archive
 * pass. The payload carries the project and an optional audit actor, validated at the worker
 * boundary like every external input.
 *
 * Cache invalidation (retrieval.md §5): every mutating pass invalidates the retrieval result
 * cache for the project, exactly as the `extract` handler does — the daemon is the single writer,
 * so a stale cache would serve a superseded memory.
 */

import { createCodeMemoryScheduler, type SchedulerTimer } from '@onememory/codememory';
import type { Embedder, EmbeddingIndex, Store } from '@onememory/core';
import { runConsolidation, type ConsolidationReport, type ConsolidationStage } from '@onememory/consolidation';
import type { ModelRouter } from '@onememory/llm';

/** Default consolidation interval: hourly. Overridable via `daemon.consolidate_interval_ms`. */
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 3_600_000;

/** The `consolidate` job runs every pass; the `decay` job runs only the terminal one. */
export const DECAY_STAGES: readonly ConsolidationStage[] = ['decay'];

export interface ConsolidationRunInput {
  /** The project whose pool the pass runs over. */
  project_id: string;
  /** Restrict the run to a subset of passes (default: all four). */
  stages?: readonly ConsolidationStage[];
  /** Audit actor override (the calling surface); default `job:consolidate`. */
  actor?: string;
}

export interface ConsolidationStatus {
  last_ran_at: string | null;
  last_resolved: number;
  last_archived: number;
}

export interface ConsolidationOrchestrationOptions {
  store: Store;
  /** Optional vector channel: without it the derivation and merge passes skip with a warning. */
  vectors?: EmbeddingIndex;
  embedder?: Embedder | null;
  router: ModelRouter;
  /** Invalidate the retrieval result cache after a mutating pass (retrieval.md §5). */
  invalidateCache?: (projectId: string) => void;
  now?: () => Date;
}

export interface ConsolidationOrchestration {
  /** Run one consolidation pass over a project and return its report (the job handler's body). */
  run(input: ConsolidationRunInput): Promise<ConsolidationReport>;
  /** Last-pass summary (null until the first pass). */
  status(): ConsolidationStatus;
}

export function createConsolidationOrchestration(
  options: ConsolidationOrchestrationOptions,
): ConsolidationOrchestration {
  const now = options.now ?? (() => new Date());
  let status: ConsolidationStatus = { last_ran_at: null, last_resolved: 0, last_archived: 0 };

  return {
    async run(input: ConsolidationRunInput): Promise<ConsolidationReport> {
      const report = await runConsolidation({
        store: options.store,
        ...(options.vectors === undefined ? {} : { vectors: options.vectors }),
        ...(options.embedder === undefined || options.embedder === null ? {} : { embedder: options.embedder }),
        router: options.router,
        scope: { project_id: input.project_id },
        ...(input.stages === undefined ? {} : { stages: input.stages }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        now,
      });
      // The pass mutates memories (supersede/merge/archive/derive) — the cached result set is
      // stale the moment it returns. Coarser than needed only in that a no-op pass still clears.
      options.invalidateCache?.(input.project_id);
      status = {
        last_ran_at: report.ran_at,
        last_resolved: report.contradictions.resolved,
        last_archived: report.decay.archived,
      };
      return report;
    },
    status(): ConsolidationStatus {
      return status;
    },
  };
}

/** The scheduler shape the composition root arms alongside the drift-scan scheduler. */
export interface ConsolidationScheduler {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
  isRunning(): boolean;
  readonly interval_ms: number;
}

export interface ConsolidationSchedulerOptions {
  intervalMs: number;
  /** Enqueue one consolidation pass (the orchestration `tick`). Errors are reported, never thrown. */
  tick: () => Promise<void>;
  timer?: SchedulerTimer;
  onError?: (error: unknown) => void;
}

/**
 * A consolidation interval scheduler — the same tiny, injectable, unref-ed timer the drift-scan
 * scheduler uses (one implementation, two schedules). Ticks are chained, never overlapping.
 * `intervalMs <= 0` disables the schedule entirely (an explicit "off", not a hot loop).
 */
export function createConsolidationScheduler(
  options: ConsolidationSchedulerOptions,
): ConsolidationScheduler {
  const scheduler = createCodeMemoryScheduler({
    intervalMs: Math.max(1, options.intervalMs),
    tick: options.tick,
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    runOnStart: false,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return {
    get interval_ms(): number {
      return options.intervalMs;
    },
    start(): void {
      if (options.intervalMs <= 0) return; // disabled: never arm the timer
      scheduler.start();
    },
    stop: () => scheduler.stop(),
    runOnce: () => scheduler.runOnce(),
    isRunning: () => options.intervalMs > 0 && scheduler.isRunning(),
  };
}
