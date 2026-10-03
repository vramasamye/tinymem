/**
 * Stage 3 — temporal & status filtering, the HARD gate (retrieval.md §3). No stage after this
 * can resurrect a filtered memory: temporal correctness outranks score.
 *
 * Three resolutions, derived from the request + understanding:
 *   current    : `valid_from ≤ now < valid_until` AND status ∈ {active, stale} (the default;
 *                superseded/archived/disputed are invisible to "current" answers — the Node 20/22
 *                correctness guarantee)
 *   point      : window evaluated at `as_of`; superseded + archived included, disputed excluded
 *                (mirrors M1 queryAsOf / memory-model.md §5)
 *   overlap    : the memory's window intersects [from, until) — historical ranges ("in 2025") and
 *                full-history queries (`from` null = open past, `until` = now)
 *
 * `include` extends the status set; a disputed memory admitted via include is labeled with its
 * conflict downstream (never silently picked as truth).
 */

import { isValidAt, CURRENT_QUERY_STATUSES, PIT_EXCLUDED_STATUSES } from '@onememory/core';
import type { MemoryStatus } from '@onememory/core';

import type { TimeScope } from './understand';

export type TemporalResolution =
  | { kind: 'current'; at: string; mode: 'current' }
  | { kind: 'point'; at: string; mode: 'historical' }
  | { kind: 'overlap'; from: string | null; until: string | null; mode: 'historical' };

export interface TemporalPolicy {
  resolution: TemporalResolution;
  statuses: ReadonlySet<MemoryStatus>;
  /** True when disputed memories are allowed through (they must be labeled, never silent). */
  labelDisputed: boolean;
}

export interface TemporalRequestInput {
  as_of?: string;
  temporal_mode?: 'current' | 'historical';
  include?: Array<'stale' | 'superseded' | 'archived' | 'disputed'>;
}

const ALL_STATUSES: readonly MemoryStatus[] = ['active', 'stale', 'superseded', 'disputed', 'archived'];

/** The instant edge validity (and window bounds) are evaluated at. */
export function policyAt(policy: TemporalPolicy, now: string): string {
  const { resolution } = policy;
  if (resolution.kind === 'overlap') {
    return resolution.until ?? resolution.from ?? now;
  }
  return resolution.at;
}

/**
 * Resolve the temporal policy for one search:
 *   1. explicit `as_of` → point-in-time (user intent via API wins)
 *   2. `temporal_mode: 'historical'` or a `history` intent → historical: parsed range → overlap,
 *      else full history (open past until now)
 *   3. default → current
 */
export function resolveTemporalPolicy(
  request: TemporalRequestInput,
  understanding: { intent: string; time_scope?: TimeScope },
  now: string,
): TemporalPolicy {
  const include = new Set(request.include ?? []);

  if (request.as_of !== undefined) {
    return {
      resolution: { kind: 'point', at: request.as_of, mode: 'historical' },
      statuses: historicalStatuses(include),
      labelDisputed: include.has('disputed'),
    };
  }

  const historical = request.temporal_mode === 'historical' || understanding.intent === 'history';
  if (historical) {
    const scope = understanding.time_scope;
    if (scope !== undefined && (scope.from !== undefined || scope.until !== undefined)) {
      return {
        resolution: { kind: 'overlap', from: scope.from ?? null, until: scope.until ?? null, mode: 'historical' },
        statuses: historicalStatuses(include),
        labelDisputed: include.has('disputed'),
      };
    }
    // Full history: everything that had already started existing, all non-disputed statuses.
    return {
      resolution: { kind: 'overlap', from: null, until: now, mode: 'historical' },
      statuses: historicalStatuses(include),
      labelDisputed: include.has('disputed'),
    };
  }

  const statuses = new Set<MemoryStatus>(CURRENT_QUERY_STATUSES);
  for (const extra of include) statuses.add(extra);
  return {
    resolution: { kind: 'current', at: now, mode: 'current' },
    statuses,
    labelDisputed: include.has('disputed'),
  };
}

function historicalStatuses(include: ReadonlySet<string>): Set<MemoryStatus> {
  const statuses = new Set<MemoryStatus>(ALL_STATUSES);
  for (const excluded of PIT_EXCLUDED_STATUSES) {
    if (!include.has(excluded)) statuses.delete(excluded);
  }
  return statuses;
}

export interface TemporalCandidate {
  status: MemoryStatus;
  validFrom: string;
  validUntil?: string | null;
}

/**
 * The authoritative hard filter. Candidates are re-checked here even though the SQL prefilter in
 * storage applied the same policy — the in-process predicate is the one that can never be
 * bypassed (working-memory candidates, clock skew, future refactors).
 */
export function passesTemporalFilter(candidate: TemporalCandidate, policy: TemporalPolicy): boolean {
  if (!policy.statuses.has(candidate.status)) return false;
  const { resolution } = policy;
  if (resolution.kind === 'point' || resolution.kind === 'current') {
    return isValidAt(
      { status: candidate.status, valid_from: candidate.validFrom, valid_until: candidate.validUntil ?? null },
      resolution.at,
    );
  }
  // overlap: windows intersect [from, until)
  if (resolution.until !== null && !(Date.parse(candidate.validFrom) < Date.parse(resolution.until))) {
    return false;
  }
  if (
    resolution.from !== null &&
    candidate.validUntil != null &&
    !(Date.parse(candidate.validUntil) > Date.parse(resolution.from))
  ) {
    return false;
  }
  return true;
}
