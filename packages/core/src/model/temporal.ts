/**
 * Temporal semantics (memory-model.md §5): two independent time axes per memory.
 *
 * - Fact time: `valid_from` / `valid_until` (`observed_at` anchors when it became true).
 * - System time: `created_at` / `updated_at` — never used for validity decisions.
 *
 * Query modes (database-schema.md §4):
 *   current  : valid_from ≤ now < valid_until AND status IN (active, stale)
 *   as-of t  : valid_from ≤ t < valid_until — includes superseded, pipeline policy excludes disputed
 */

import type { MemoryStatus } from './types';

export interface TemporalMemory {
  status: MemoryStatus;
  valid_from: string;
  valid_until?: string | null;
}

function toTime(at: Date | string): number {
  if (at instanceof Date) return at.getTime();
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) throw new TypeError(`temporal: invalid timestamp ${JSON.stringify(at)}`);
  return parsed;
}

/** Pure fact-validity window predicate: `valid_from ≤ at < valid_until` (NULL until = open). */
export function isValidAt(memory: TemporalMemory, at: Date | string): boolean {
  const t = toTime(at);
  if (toTime(memory.valid_from) > t) return false;
  if (memory.valid_until != null && toTime(memory.valid_until) <= t) return false;
  return true;
}

/**
 * "Currently valid" (current query mode): fact-validity window AND a live status.
 * `superseded` (valid_until closed by supersession) and `archived`/`disputed` fail here by design.
 */
export function isCurrentlyValid(memory: TemporalMemory, at: Date | string = new Date()): boolean {
  return isValidAt(memory, at) && (memory.status === 'active' || memory.status === 'stale');
}

/** Statuses returned by the current query mode. */
export const CURRENT_QUERY_STATUSES: readonly MemoryStatus[] = ['active', 'stale'];

/** Statuses excluded from point-in-time queries (memory-model.md §5: disputed excluded). */
export const PIT_EXCLUDED_STATUSES: readonly MemoryStatus[] = ['disputed'];
