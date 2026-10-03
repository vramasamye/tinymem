/**
 * The jobs worker loop (ADR-0002: own jobs table + worker loop — no queue dependency).
 *
 * - polls `jobs` ready (status=pending AND run_at ≤ now), claims under a lease
 *   (locked_by/locked_at), executes via a handler registry, retries with exponential backoff,
 *   dead-letters at max_attempts;
 * - idempotent by design (jobs_singleton_idx makes enqueue safe to repeat);
 * - graceful shutdown: `stop()` stops claiming and finishes the in-flight pass; a crashed worker's
 *   jobs are reclaimed once their lease expires;
 * - honest by design: a kind with no registered handler throws `JobKindNotImplemented` — the job
 *   is recorded as failed (never silently marked done).
 */

import type { JobKind, JobRecord } from '@onememory/core';

import type { Database } from '../drivers/client';

import * as jobsRepo from '../repositories/jobs';

export class JobKindNotImplemented extends Error {
  constructor(public readonly kind: string) {
    super(`no handler registered for job kind '${kind}'`);
    this.name = 'JobKindNotImplemented';
  }
}

export interface JobContext {
  job: JobRecord;
  db: Database;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface HandlerRegistry {
  get(kind: string): JobHandler;
}

/**
 * A registry that throws `JobKindNotImplemented` for unregistered kinds — unimplemented pipeline
 * stages stay enqueue-only and fail loudly rather than fake success.
 */
export function createHandlerRegistry(
  handlers: Partial<Record<JobKind, JobHandler>>,
): HandlerRegistry {
  return {
    get(kind: string): JobHandler {
      const handler = (handlers as Record<string, JobHandler | undefined>)[kind];
      if (!handler) throw new JobKindNotImplemented(kind);
      return handler;
    },
  };
}

export interface JobWorkerOptions {
  db: Database;
  registry: HandlerRegistry;
  /** Worker identity recorded in locked_by (default `worker-<pid>`). */
  claimant?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  leaseSeconds?: number;
  backoffBaseSeconds?: number;
  /** Error sink (defaults to console.error); never throws out of the loop. */
  onError?: (error: unknown, job?: JobRecord) => void;
}

export interface JobWorker {
  /** Begin polling in the background. Idempotent. */
  start(): void;
  /** Graceful shutdown: stop claiming, finish the in-flight pass. */
  stop(): Promise<void>;
  /** One claim+execute pass (the deterministic mode used by tests). Returns jobs attempted. */
  runOnce(): Promise<number>;
  isRunning(): boolean;
}

export function createJobWorker(options: JobWorkerOptions): JobWorker {
  const claimant = options.claimant ?? `worker-${process.pid}`;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const batchSize = options.batchSize ?? 10;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const backoffBaseSeconds = options.backoffBaseSeconds ?? 2;
  const onError =
    options.onError ??
    ((error: unknown, job?: JobRecord) => {
      console.error(
        `onememory: job ${job?.kind ?? '?'} ${job?.id ?? ''} failed:`,
        error instanceof Error ? error.message : error,
      );
    });

  let running = false;
  let stopping = false;
  let loopPromise: Promise<void> | null = null;

  async function executePass(): Promise<number> {
    const now = new Date().toISOString();
    const claimed = await jobsRepo.claimJobs(options.db, {
      claimant,
      limit: batchSize,
      leaseSeconds,
      now,
    });
    for (const job of claimed) {
      try {
        const handler = options.registry.get(job.kind);
        await handler({ job, db: options.db });
        await jobsRepo.completeJob(options.db, job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(error, job);
        await jobsRepo.failJob(options.db, job.id, message, { backoffBaseSeconds });
      }
    }
    return claimed.length;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      stopping = false;
      loopPromise = (async () => {
        while (!stopping) {
          try {
            const attempted = await executePass();
            if (attempted === 0) await sleep(pollIntervalMs);
          } catch (error) {
            onError(error);
            await sleep(pollIntervalMs);
          }
        }
      })();
    },
    async stop(): Promise<void> {
      stopping = true;
      if (loopPromise) await loopPromise;
      loopPromise = null;
      running = false;
      stopping = false;
    },
    runOnce(): Promise<number> {
      return executePass();
    },
    isRunning(): boolean {
      return running;
    },
  };
}
