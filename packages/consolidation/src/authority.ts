/**
 * Contradiction-resolution authority (memory-model.md §9) — the single ordering used by both
 * contradiction resolution and near-duplicate keeper selection:
 *
 *   1. an explicit user statement beats agent inference;
 *   2. an explicit decision memory beats an observation;
 *   3. the newer `observed_at` wins within the same class;
 *   4. the higher confidence wins;
 *   5. a tie is reported as a tie — never resolved by picking silently (both `disputed`).
 */

import type { MemoryRecord } from '@onememory-ai/core';

import type { AuthorityRule } from './types';

/** The authority-relevant projection of a stored memory. */
export interface AuthorityView {
  /** `provenance.source.kind === 'explicit'` — a user statement, not agent inference. */
  explicit: boolean;
  /** `type === 'decision'` — an explicit decision memory beats an observation. */
  isDecision: boolean;
  observedAt: string;
  confidence: number;
  id: string;
}

export function authorityViewOf(memory: MemoryRecord): AuthorityView {
  return {
    explicit: memory.provenance.source.kind === 'explicit',
    isDecision: memory.type === 'decision',
    observedAt: memory.observed_at,
    confidence: memory.confidence,
    id: memory.id,
  };
}

export type AuthorityComparison =
  | { kind: 'winner'; winner: 'a' | 'b'; rule: Exclude<AuthorityRule, 'tie'> }
  | { kind: 'tie'; rule: 'tie' };

/**
 * Compare two authorities. The FIRST rule that discriminates decides; when all four levels
 * agree the result is a tie (the caller must mark both memories `disputed`).
 */
export function compareAuthority(a: AuthorityView, b: AuthorityView): AuthorityComparison {
  // 1. explicit user statement > agent inference.
  if (a.explicit !== b.explicit) {
    return { kind: 'winner', winner: a.explicit ? 'a' : 'b', rule: 'explicit' };
  }
  // 2. explicit decision memory > observation.
  if (a.isDecision !== b.isDecision) {
    return { kind: 'winner', winner: a.isDecision ? 'a' : 'b', rule: 'decision' };
  }
  // 3. newer observation wins within the same class.
  const aAt = Date.parse(a.observedAt);
  const bAt = Date.parse(b.observedAt);
  if (aAt !== bAt) {
    return { kind: 'winner', winner: aAt > bAt ? 'a' : 'b', rule: 'newer' };
  }
  // 4. higher confidence wins.
  if (a.confidence !== b.confidence) {
    return { kind: 'winner', winner: a.confidence > b.confidence ? 'a' : 'b', rule: 'confidence' };
  }
  // 5. A full tie is a tie: both `disputed` (the caller), never a silent pick.
  return { kind: 'tie', rule: 'tie' };
}

/**
 * Keeper ordering for near-duplicate MERGES: the same authority order, with one documented
 * difference — an exact tie falls through to a deterministic id comparison. A merge is not a
 * truth ruling (all members state the same fact), so a deterministic tie-break is honest there,
 * while contradiction resolution reports ties as `disputed`.
 */
export function mergeKeeperOrder(a: AuthorityView, b: AuthorityView): number {
  const comparison = compareAuthority(a, b);
  if (comparison.kind === 'winner') return comparison.winner === 'a' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The winner of a contradiction pair as a full view, or `null` for a tie. */
export function winnerOf(
  a: AuthorityView,
  b: AuthorityView,
): { winner: AuthorityView; loser: AuthorityView; rule: Exclude<AuthorityRule, 'tie'> } | null {
  const comparison = compareAuthority(a, b);
  if (comparison.kind === 'tie') return null;
  const winner = comparison.winner === 'a' ? a : b;
  const loser = comparison.winner === 'a' ? b : a;
  return { winner, loser, rule: comparison.rule };
}
