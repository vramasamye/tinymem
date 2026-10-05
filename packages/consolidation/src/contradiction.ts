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
 * (`valid_until` = winner's observed_at, `superseded_by` = winner) and the pair is linked with a
 * `contradicts` edge (what retrieval's conflict labels read). A full tie marks BOTH memories
 * `disputed` — never resolved by picking silently (M14 rule).
 */

import type { MemoryRecord, Store } from '@onememory/core';

import { winnerOf, authorityViewOf } from './authority';
import type { ContradictionRecord, ContradictionSkip } from './types';

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

/** Stable unordered pair key. */
export function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
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
    const key = `${memory.project_id ?? '∅'}|${memory.user_id ?? '∅'}|${contradictionTemplate(memory.content)}`;
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
    // Supersession closes the loser at the winner's observation. A window that would invert
    // (the loser became valid after the winner was observed) is skipped, not forced.
    if (Date.parse(loserRecord.valid_from) >= Date.parse(winner.observedAt)) {
      skipped.push({
        a_id: a.id,
        b_id: b.id,
        reason: `winner observed at ${winner.observedAt} but loser valid from ${loserRecord.valid_from} (inverted window)`,
      });
      continue;
    }
    try {
      await store.updateMemoryStatus(loserRecord.id, 'superseded', {
        actor: options.actor,
        reason: `contradiction resolved by authority (${rule})`,
        valid_until: winner.observedAt,
        superseded_by_id: winnerRecord.id,
        details: { contradiction: true, template: pair.template, rule, counterpart: winnerRecord.id },
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
