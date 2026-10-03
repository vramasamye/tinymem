/**
 * Internal work queue (`jobs` table + claim/lease semantics, ADR-0002). Stages 3–9 and 12–14 of
 * the lifecycle pipeline run through this; the API/CLI never awaits them.
 *
 * - `enqueue` is idempotent on (kind, payload.key) while a pending/running instance exists
 *   (jobs_singleton_idx);
 * - `claim` uses FOR UPDATE SKIP LOCKED with a (claimant, locked_at) lease, and reclaims jobs
 *   whose lease expired (crash recovery);
 * - `fail` retries with exponential backoff until max_attempts, then dead-letters (`status=dead`).
 */

import { EnqueueJobSchema, uuidv7 } from '@onememory/core';
import type { EnqueueJobInput, EnqueueJobResult, JobRecord } from '@onememory/core';

import type { Database } from '../drivers/client';
import { isUniqueViolation } from '../drivers/client';

import { mapJobRow } from './row-mappers';
import { parseInput } from './util';

const DEFAULT_MAX_ATTEMPTS = 3;

export interface ClaimJobsOptions {
  claimant: string;
  limit?: number;
  leaseSeconds?: number;
  /** Injectable clock (ISO) for deterministic tests; defaults to the JS clock. */
  now?: string;
}

export async function enqueueJob(db: Database, rawInput: EnqueueJobInput): Promise<EnqueueJobResult> {
  const input = parseInput(EnqueueJobSchema, rawInput, 'enqueueJob');
  const payload: Record<string, unknown> = { ...(input.payload ?? {}), key: input.key };

  const pending = await db.query(
    `SELECT * FROM jobs
      WHERE kind = $1 AND payload->>'key' = $2 AND status IN ('pending','running')
      LIMIT 1`,
    [input.kind, input.key],
  );
  const existing = pending.rows[0];
  if (existing) return { outcome: 'existing', job: mapJobRow(existing) };

  try {
    const result = await db.query(
      `INSERT INTO jobs (id, kind, payload, status, run_at, max_attempts)
         VALUES ($1::uuid, $2, $3::jsonb, 'pending', $4::timestamptz, $5)
         RETURNING *`,
      [
        uuidv7(),
        input.kind,
        JSON.stringify(payload),
        input.run_at ?? new Date().toISOString(),
        input.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      ],
    );
    return { outcome: 'enqueued', job: mapJobRow(result.rows[0]!) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.query(
        `SELECT * FROM jobs
          WHERE kind = $1 AND payload->>'key' = $2 AND status IN ('pending','running')
          LIMIT 1`,
        [input.kind, input.key],
      );
      const winner = raced.rows[0];
      if (winner) return { outcome: 'existing', job: mapJobRow(winner) };
    }
    throw error;
  }
}

export async function claimJobs(
  db: Database,
  options: ClaimJobsOptions,
): Promise<JobRecord[]> {
  const limit = options.limit ?? 10;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const now = options.now ?? new Date().toISOString();
  const result = await db.query(
    `UPDATE jobs
        SET status = 'running', locked_by = $1, locked_at = $2::timestamptz, updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
          WHERE (status = 'pending' AND run_at <= $2::timestamptz)
             OR (status = 'running' AND locked_at <= $2::timestamptz - ($3::text || ' seconds')::interval)
          ORDER BY run_at ASC
          LIMIT $4
          FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [options.claimant, now, String(leaseSeconds), limit],
  );
  return result.rows.map(mapJobRow);
}

export async function completeJob(db: Database, jobId: string): Promise<void> {
  const result = await db.query(
    `UPDATE jobs
        SET status = 'done', locked_by = NULL, locked_at = NULL, updated_at = now()
      WHERE id = $1::uuid`,
    [jobId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`completeJob: job ${jobId} not found`);
  }
}

export interface FailJobOptions {
  /** Backoff base; retry delay = base * 2^(attempt-1) seconds. */
  backoffBaseSeconds?: number;
  /** Injectable clock (ISO) for deterministic tests. */
  now?: string;
}

export async function failJob(
  db: Database,
  jobId: string,
  error: string,
  options: FailJobOptions = {},
): Promise<JobRecord> {
  const base = options.backoffBaseSeconds ?? 2;
  const now = options.now ?? new Date().toISOString();
  const current = await getJob(db, jobId);
  if (!current) throw new Error(`failJob: job ${jobId} not found`);

  const attempts = current.attempts + 1;
  if (attempts >= current.max_attempts) {
    const result = await db.query(
      `UPDATE jobs
          SET status = 'dead', attempts = $2, last_error = $3,
              locked_by = NULL, locked_at = NULL, updated_at = now()
        WHERE id = $1::uuid
        RETURNING *`,
      [jobId, attempts, error],
    );
    return mapJobRow(result.rows[0]!);
  }
  const runAt = new Date(new Date(now).getTime() + base * 2 ** (attempts - 1) * 1000).toISOString();
  const result = await db.query(
    `UPDATE jobs
        SET status = 'pending', attempts = $2, last_error = $3, run_at = $4::timestamptz,
            locked_by = NULL, locked_at = NULL, updated_at = now()
      WHERE id = $1::uuid
      RETURNING *`,
    [jobId, attempts, error, runAt],
  );
  return mapJobRow(result.rows[0]!);
}

export async function getJob(db: Database, jobId: string): Promise<JobRecord | null> {
  const result = await db.query('SELECT * FROM jobs WHERE id = $1::uuid', [jobId]);
  const row = result.rows[0];
  return row ? mapJobRow(row) : null;
}
