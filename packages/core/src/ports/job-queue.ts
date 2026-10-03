/**
 * The `JobQueue` port — the async pipeline's work queue (ADR-0002: own `jobs` table + worker loop;
 * stages 3–9 and 12–14 of memory-model.md §8 run through it). The API/CLI never awaits these.
 */

import type { EnqueueJobInput } from '../schema/persistence';

import type { EnqueueJobResult, JobRecord } from './records';

export interface JobQueue {
  /**
   * Enqueue a job. Idempotent on (kind, payload.key) while a pending/running instance exists
   * (jobs_singleton_idx): returns the existing job with outcome 'existing'.
   */
  enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult>;
  /**
   * Claim up to `limit` ready jobs (status=pending AND run_at ≤ now, or a lease that expired)
   * under a (claimant, lease) lock. SKIP LOCKED semantics: concurrent claimers never share a job.
   */
  claim(input: { claimant: string; limit?: number; leaseSeconds?: number; now?: string }): Promise<JobRecord[]>;
  complete(jobId: string): Promise<void>;
  /**
   * Record a failure: retry with exponential backoff, or dead-letter at max_attempts.
   * `options.now` is an injectable clock (ISO) for deterministic tests; defaults to the JS clock.
   */
  fail(jobId: string, error: string, options?: { now?: string }): Promise<JobRecord>;
  getJob(jobId: string): Promise<JobRecord | null>;
}
