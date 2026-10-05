/**
 * Contradiction detection (memory-model.md §5 step 1 and §9) — the deterministic, zero-model
 * baseline. The LLM `conflict` operation of the model router can refine recall later; it is
 * never a correctness prerequisite (memory-model.md §1.6).
 *
 * The heuristic's claim shape: two memories instantiate the SAME attribute template (the
 * statement with its scalar values blanked out — "version: node <#>") but carry DIFFERENT
 * scalar values, in the same scope, with overlapping validity. That is exactly the
 * "Version: Node 20" vs "Version: Node 22" family: same attribute, incompatible value.
 * Different templates ("Version: Node 22" vs "Version: PostgreSQL 16"), equal values, value-free
 * restatements, different scopes, or disjoint validity windows are not contradictions.
 *
 * Resolution (the pass below): authority order explicit > decision > newer > confidence. The
 * winner supersedes the loser through the audited status-transition supersession fields
 * (`superseded_by` = winner, `valid_until` per {@link supersessionValidUntil}) and the pair is
 * linked with a `contradicts` edge (what retrieval's conflict labels read). A full tie marks
 * BOTH memories `disputed` — never resolved by picking silently (M14 rule).
 *
 * The resolution invariant (review finding): after the pass processes a detected pair, exactly
 * one row is current (the winner closed the loser via audited supersession) OR both are
 * `disputed` on a full authority tie. A detected pair is NEVER left silently unresolved: no
 * cross-field temporal shape (loser `valid_from` vs winner `observed_at`) can skip the
 * arbitration — the winner is recomputed from the authority fields alone, and the only temporal
 * choice left is WHERE the loser's window closes ({@link supersessionValidUntil}).
 */

import type { MemoryRecord, Store } from '@onememory/core';

import { winnerOf, authorityViewOf } from './authority';
import { scopeKeyOf } from './cluster';
import type { ContradictionRecord, ContradictionSkip } from './types';
import { errorMessage } from './util';

/** Blank every scalar (digits, incl. decimal/multi-part versions) and normalize the statement. */
export function contradictionTemplate(content: string): string {
  return content
    .toLowerCase()
    .replace(/\d+(?:\.\d+)*/g, '<#>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The scalar values a statement claims, in order ("Version: Node 22" → ["22"]). */
export function numericValues(content: string): string[] {
  return content.match(/\d+(?:\.\d+)*/g) ?? [];
}

function sameScope(a: MemoryRecord, b: MemoryRecord): boolean {
  return (a.project_id ?? null) === (b.project_id ?? null) && (a.user_id ?? null) === (b.user_id ?? null);
}

/** Do the two validity windows [valid_from, valid_until) intersect? */
export function temporalOverlap(a: MemoryRecord, b: MemoryRecord): boolean {
  const aFrom = Date.parse(a.valid_from);
  const bFrom = Date.parse(b.valid_from);
  const aUntil = a.valid_until === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.valid_until);
  const bUntil = b.valid_until === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.valid_until);
  return aFrom < bUntil && bFrom < aUntil;
}

/**
 * The heuristic contradiction predicate. Pure and deterministic: same scope, same template,
 * differing scalar values, overlapping validity.
 */
export function contradictsHeuristically(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.id === b.id) return false;
  if (!sameScope(a, b)) return false;
  if (!temporalOverlap(a, b)) return false;
  if (contradictionTemplate(a.content) !== contradictionTemplate(b.content)) return false;
  const valuesOfA = numericValues(a.content);
  const valuesOfB = numericValues(b.content);
  if (valuesOfA.length === 0 && valuesOfB.length === 0) return false;
  if (valuesOfA.length !== valuesOfB.length) return true;
  return valuesOfA.some((value, index) => value !== valuesOfB[index]);
}

/**
 * The detector seam: pair → verdict. The default is {@link contradictsHeuristically}; a later
 * LLM-backed detector (router operation `conflict`) can replace it without touching the passes.
 */
export type ContradictionDetector = (a: MemoryRecord, b: MemoryRecord) => boolean;

/**
 * WHERE a resolved loser's validity window closes — the only temporal choice the pass makes
 * (the winner itself is decided by the authority fields alone, never by window shapes):
 *
 * - at the winner's observation, when that moment falls inside the loser's window — the
 *   point-in-time handoff (queryAsOf answers with the loser before it, the winner after; the
 *   Node 20 → 22 → 24 chain works this way);
 * - at the loser's own `valid_from` otherwise (an older authority — an explicit user statement,
 *   a decision, an equal-time higher-confidence row — predates the loser's window opening):
 *   the window becomes zero-width (`valid_until === valid_from`), so no point-in-time view ever
 *   shows the losing claim. It was never valid.
 */
export function supersessionValidUntil(winnerObservedAt: string, loserValidFrom: string): string {
  return Date.parse(winnerObservedAt) > Date.parse(loserValidFrom) ? winnerObservedAt : loserValidFrom;
}

// ---------------------------------------------------------------------------
// The contradiction pass
// ---------------------------------------------------------------------------

export interface ContradictionPassResult {
  records: ContradictionRecord[];
  skipped: ContradictionSkip[];
  warnings: string[];
}

/**
 * Detect and resolve contradictions across the ACTIVE pool. Pairs are template-grouped, ordered
 * oldest-first so the Node 20 → 22 → 24 chain builds linearly (20 closed into 22, 22 into 24),
 * and each resolution updates the live pool (a closed loser exits further pairs).
 *
 * The pass needs NO embeddings — the offline default still resolves contradictions.
 */
export async function runContradictionPass(
  store: Store,
  pool: readonly MemoryRecord[],
  options: {
    actor: string;
    detector?: ContradictionDetector;
  },
): Promise<ContradictionPassResult> {
  const detector = options.detector ?? contradictsHeuristically;
  const records: ContradictionRecord[] = [];
  const skipped: ContradictionSkip[] = [];
  const warnings: string[] = [];

  // 1. Candidate pairs: same scope + same template + differing values + overlapping validity.
  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of pool) {
    const key = `${scopeKeyOf(memory)}|${contradictionTemplate(memory.content)}`;
    const group = groups.get(key);
    if (group) group.push(memory);
    else groups.set(key, [memory]);
  }
  interface Pair {
    a: MemoryRecord;
    b: MemoryRecord;
    template: string;
  }
  const pairs: Pair[] = [];
  for (const [template, group] of groups) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (detector(group[i]!, group[j]!)) pairs.push({ a: group[i]!, b: group[j]!, template });
      }
    }
  }
  // Oldest-first pair order (by the older member, then the newer): the chain builds linearly.
  pairs.sort((x, y) => {
    const olderX = x.a.observed_at <= x.b.observed_at ? x.a : x.b;
    const olderY = y.a.observed_at <= y.b.observed_at ? y.a : y.b;
    const byOlder = olderX.observed_at.localeCompare(olderY.observed_at);
    if (byOlder !== 0) return byOlder;
    return x.a.observed_at.localeCompare(y.a.observed_at);
  });

  // 2. Resolve each pair; the live set keeps mutations visible to later pairs.
  const active = new Map(pool.map((memory) => [memory.id, memory]));
  for (const pair of pairs) {
    const a = active.get(pair.a.id);
    const b = active.get(pair.b.id);
    if (a === undefined || b === undefined) continue; // an earlier pair closed or disputed one
    const outcome = winnerOf(authorityViewOf(a), authorityViewOf(b));
    if (outcome === null) {
      // Full authority tie: both `disputed`, linked by a `contradicts` edge, nothing picked.
      try {
        await store.updateMemoryStatus(a.id, 'disputed', {
          actor: options.actor,
          reason: 'unresolved contradiction: equal authority (explicit > decision > newer > confidence all tied)',
          details: { contradiction: true, counterpart: b.id, template: pair.template },
        });
        await store.updateMemoryStatus(b.id, 'disputed', {
          actor: options.actor,
          reason: 'unresolved contradiction: equal authority (explicit > decision > newer > confidence all tied)',
          details: { contradiction: true, counterpart: a.id, template: pair.template },
        });
        await store.addEdge({
          from_memory_id: olderOf(a, b).id,
          to_memory_id: newerOf(a, b).id,
          relation: 'contradicts',
          project_id: a.project_id ?? undefined,
        });
        records.push({ a_id: a.id, b_id: b.id, template: pair.template, outcome: 'disputed', rule: 'tie' });
        active.delete(a.id);
        active.delete(b.id);
      } catch (error) {
        skipped.push({ a_id: a.id, b_id: b.id, reason: errorMessage(error) });
      }
      continue;
    }

    const { winner, loser, rule } = outcome;
    const winnerRecord = winner.id === a.id ? a : b;
    const loserRecord = winner.id === a.id ? b : a;
    // The loser's window closes at the winner's observation when that falls inside it, else at
    // its own start (zero-width — the losing claim was never valid). Either way exactly one row
    // stays current; a detected pair is never skipped for a temporal shape: an older explicit
    // statement or decision still beats a newer inference, and an equal-time pair falls to
    // confidence.
    const validUntil = supersessionValidUntil(winner.observedAt, loserRecord.valid_from);
    const window: 'closed-at-winner-observation' | 'zero-width-never-valid' =
      validUntil === winner.observedAt ? 'closed-at-winner-observation' : 'zero-width-never-valid';
    try {
      await store.updateMemoryStatus(loserRecord.id, 'superseded', {
        actor: options.actor,
        reason: `contradiction resolved by authority (${rule})`,
        valid_until: validUntil,
        superseded_by_id: winnerRecord.id,
        details: { contradiction: true, template: pair.template, rule, counterpart: winnerRecord.id, window },
      });
      await store.addEdge({
        from_memory_id: loserRecord.id,
        to_memory_id: winnerRecord.id,
        relation: 'contradicts',
        project_id: a.project_id ?? undefined,
      });
      records.push({
        a_id: a.id,
        b_id: b.id,
        template: pair.template,
        outcome: 'superseded',
        winner_id: winnerRecord.id,
        rule,
      });
      active.delete(loserRecord.id);
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidTransitionError') {
        skipped.push({ a_id: a.id, b_id: b.id, reason: `illegal transition ${loserRecord.status} → superseded` });
        continue;
      }
      skipped.push({ a_id: a.id, b_id: b.id, reason: errorMessage(error) });
    }
  }

  return { records, skipped, warnings };
}

function olderOf(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
  return a.observed_at <= b.observed_at ? a : b;
}

function newerOf(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
  return a.observed_at <= b.observed_at ? b : a;
}
