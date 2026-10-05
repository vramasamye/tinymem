/**
 * Pure metric math (backlog M11.2). Every function takes plain data — no storage, no engine — so
 * the arithmetic is unit-testable and the harness stays a thin orchestration layer.
 *
 * Metric definitions are derived from the architecture docs, because the originating "spec §25"
 * is not present as a file in this repository (see the mission report):
 *   - precision/recall@k, MRR        — retrieval quality (ADR-0004; retrieval.md §1)
 *   - tokens per answer              — retrieval.md §7 / ADR-0004 point 5 (budget packer)
 *   - pollution                      — ADR-0004 consequence "pollution"; memory-model.md §2/§8
 *   - temporal accuracy              — memory-model.md §4–§5, retrieval.md §3
 *   - contradiction accuracy         — memory-model.md §9 authority order (M14)
 *   - consolidation quality          — memory-model.md §9 episodic→semantic / near-dup merge (M14)
 */

import type { CorpusMemory } from './runtime';

export type QueryKind = 'retrieval' | 'temporal' | 'pollution' | 'contradiction';

/** One query's raw outcome, before any aggregation. */
export interface QueryOutcome {
  id: string;
  kind: QueryKind;
  /** Dataset project key (null for unscoped queries). */
  projectKey: string | null;
  /** Resolved project uuid (null for unscoped queries). */
  projectId: string | null;
  returnedIds: readonly string[];
  expectedIds: readonly string[];
  forbiddenIds: readonly string[];
  usedTokens: number;
  budget: number;
  packing: string;
  warnings: readonly string[];
  /** Which temporal resolution a probe used (only meaningful for `kind: 'temporal'`). */
  temporal_bucket?: TemporalBucket;
}

export interface RetrievalMetrics {
  queries: number;
  k: number;
  precision_at_k: number;
  recall_at_k: number;
  precision_full: number;
  recall_full: number;
  mrr: number;
}

export interface TokenMetrics {
  queries: number;
  /** 1.0 when every response respected `used ≤ budget` (the packer's hard invariant). */
  budget_compliance: number;
  mean_used: number;
  max_used: number;
  p95_used: number;
  /** Mean tokens spent per expected fact (a density proxy). */
  mean_tokens_per_expected: number;
}

export interface PollutionMetrics {
  /** Project-scoped queries whose best-ranked result belongs to another project (0 tolerated). */
  cross_project_top1_rate: number;
  /** Fraction of returned memories that belong to another (non-null) project. */
  cross_project_leakage_rate: number;
  /** Mean fraction of declared distractor facts that leaked into results. */
  irrelevant_leakage_rate: number;
  returned: number;
  leaked: number;
}

export interface TemporalMetrics {
  probes: number;
  correct: number;
  accuracy: number;
  current: { probes: number; correct: number };
  point_in_time: { probes: number; correct: number };
  history: { probes: number; correct: number };
}

export interface ContradictionMetrics {
  groups: number;
  /** Groups where the authority fact was returned and no contradicted fact was. */
  resolved: number;
  accuracy: number;
  /** Groups where the authority fact ranked first (diagnostic). */
  authority_top1: number;
  /** Groups where both sides were returned with no resolution signal — the dangerous state. */
  silent_conflicts: number;
}

export interface ConsolidationMetrics {
  groups: number;
  /** Mean of `1 - distinct_memories / observations`, clamped to [0, 1]. */
  quality: number;
  fully_consolidated: number;
  details: Array<{ id: string; observations: number; distinct: number; compression: number }>;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function computeRetrievalMetrics(
  outcomes: readonly QueryOutcome[],
  k = 5,
): RetrievalMetrics {
  const queries = outcomes.filter((outcome) => outcome.kind === 'retrieval' && outcome.expectedIds.length > 0);
  const precisionAtK: number[] = [];
  const recallAtK: number[] = [];
  const precisionFull: number[] = [];
  const recallFull: number[] = [];
  const reciprocalRanks: number[] = [];

  for (const outcome of queries) {
    const expected = new Set(outcome.expectedIds);
    const returned = outcome.returnedIds;
    const topK = returned.slice(0, k);

    const hitsTopK = topK.filter((id) => expected.has(id)).length;
    precisionAtK.push(topK.length === 0 ? 0 : hitsTopK / topK.length);
    recallAtK.push(hitsTopK / expected.size);

    const hitsFull = returned.filter((id) => expected.has(id)).length;
    precisionFull.push(returned.length === 0 ? 0 : hitsFull / returned.length);
    recallFull.push(hitsFull / expected.size);

    const firstHit = returned.findIndex((id) => expected.has(id));
    reciprocalRanks.push(firstHit === -1 ? 0 : 1 / (firstHit + 1));
  }

  return {
    queries: queries.length,
    k,
    precision_at_k: round(mean(precisionAtK)),
    recall_at_k: round(mean(recallAtK)),
    precision_full: round(mean(precisionFull)),
    recall_full: round(mean(recallFull)),
    mrr: round(mean(reciprocalRanks)),
  };
}

export function computeTokenMetrics(outcomes: readonly QueryOutcome[]): TokenMetrics {
  const used = outcomes.map((outcome) => outcome.usedTokens);
  const compliant = outcomes.filter((outcome) => outcome.usedTokens <= outcome.budget).length;
  const perExpected = outcomes
    .filter((outcome) => outcome.expectedIds.length > 0)
    .map((outcome) => outcome.usedTokens / outcome.expectedIds.length);

  return {
    queries: outcomes.length,
    budget_compliance: outcomes.length === 0 ? 1 : round(compliant / outcomes.length),
    mean_used: round(mean(used), 2),
    max_used: used.length === 0 ? 0 : Math.max(...used),
    p95_used: round(percentile(used, 0.95), 2),
    mean_tokens_per_expected: round(mean(perExpected), 2),
  };
}

export function computePollutionMetrics(
  outcomes: readonly QueryOutcome[],
  corpusById: ReadonlyMap<string, CorpusMemory>,
): PollutionMetrics {
  // Contradiction probes are excluded: unresolved contradictions are M14's domain (reported, not
  // gated) and would otherwise mask a genuine retrieval regression in the pollution gate.
  const scoped = outcomes.filter(
    (outcome) => outcome.projectId !== null && outcome.kind !== 'contradiction',
  );
  let returnedTotal = 0;
  let leakedTotal = 0;
  let top1Leaks = 0;
  const irrelevant: number[] = [];

  for (const outcome of scoped) {
    returnedTotal += outcome.returnedIds.length;
    const first = outcome.returnedIds[0];
    if (first !== undefined) {
      const memory = corpusById.get(first);
      if (memory !== undefined && memory.project_id !== null && memory.project_id !== outcome.projectId) {
        top1Leaks += 1;
      }
    }
    for (const id of outcome.returnedIds) {
      const memory = corpusById.get(id);
      if (memory !== undefined && memory.project_id !== null && memory.project_id !== outcome.projectId) {
        leakedTotal += 1;
      }
    }
    if (outcome.forbiddenIds.length > 0) {
      const forbidden = new Set(outcome.forbiddenIds);
      const hits = outcome.returnedIds.filter((id) => forbidden.has(id)).length;
      irrelevant.push(outcome.returnedIds.length === 0 ? 0 : hits / outcome.returnedIds.length);
    }
  }

  return {
    cross_project_top1_rate: scoped.length === 0 ? 0 : round(top1Leaks / scoped.length),
    cross_project_leakage_rate: returnedTotal === 0 ? 0 : round(leakedTotal / returnedTotal),
    irrelevant_leakage_rate: round(mean(irrelevant)),
    returned: returnedTotal,
    leaked: leakedTotal,
  };
}

/** Which temporal resolution a probe used (derived from the request shape). */
export type TemporalBucket = 'current' | 'point_in_time' | 'history';

export function temporalBucketFor(request: { as_of?: string; temporal_mode?: string }): TemporalBucket {
  if (request.as_of !== undefined) return 'point_in_time';
  if (request.temporal_mode === 'historical') return 'history';
  return 'current';
}

function satisfies(outcome: QueryOutcome): boolean {
  const returned = new Set(outcome.returnedIds);
  const allExpected = outcome.expectedIds.every((id) => returned.has(id));
  const noForbidden = outcome.forbiddenIds.every((id) => !returned.has(id));
  return allExpected && noForbidden;
}

export function computeTemporalMetrics(outcomes: readonly QueryOutcome[]): TemporalMetrics {
  const probes = outcomes.filter((outcome) => outcome.kind === 'temporal');
  const buckets: Record<TemporalBucket, { probes: number; correct: number }> = {
    current: { probes: 0, correct: 0 },
    point_in_time: { probes: 0, correct: 0 },
    history: { probes: 0, correct: 0 },
  };
  let correct = 0;
  for (const outcome of probes) {
    const bucket = outcome.temporal_bucket ?? 'current';
    buckets[bucket].probes += 1;
    if (satisfies(outcome)) {
      correct += 1;
      buckets[bucket].correct += 1;
    }
  }
  return {
    probes: probes.length,
    correct,
    accuracy: probes.length === 0 ? 1 : round(correct / probes.length),
    current: buckets.current,
    point_in_time: buckets.point_in_time,
    history: buckets.history,
  };
}

export function computeContradictionMetrics(outcomes: readonly QueryOutcome[]): ContradictionMetrics {
  const groups = outcomes.filter((outcome) => outcome.kind === 'contradiction');
  let resolved = 0;
  let top1 = 0;
  let silent = 0;
  for (const outcome of groups) {
    const returned = new Set(outcome.returnedIds);
    const authorityPresent = outcome.expectedIds.every((id) => returned.has(id));
    const noContradicted = outcome.forbiddenIds.every((id) => !returned.has(id));
    if (authorityPresent && noContradicted) resolved += 1;
    const first = outcome.returnedIds[0];
    if (first !== undefined && outcome.expectedIds.includes(first)) top1 += 1;
    // Both sides surfaced with no resolution: the engine returned an authority and a contradicted
    // memory together (pre-M14 the only possible state).
    const contradictedPresent = outcome.forbiddenIds.some((id) => returned.has(id));
    if (authorityPresent && contradictedPresent) silent += 1;
  }
  return {
    groups: groups.length,
    resolved,
    accuracy: groups.length === 0 ? 1 : round(resolved / groups.length),
    authority_top1: top1,
    silent_conflicts: silent,
  };
}

/**
 * Consolidation quality: how well repeated observations of one concept collapsed. Pre-M14 the
 * only mechanism is exact content-hash dedupe (memory-model.md §8 stage 6), so paraphrases stay
 * separate; the metric is reported, not gated, until M14 ships episodic→semantic derivation.
 */
export function computeConsolidationMetrics(
  groups: ReadonlyArray<{ id: string; observations: number; distinct: number }>,
): ConsolidationMetrics {
  const details = groups.map((group) => ({
    id: group.id,
    observations: group.observations,
    distinct: group.distinct,
    compression: round(Math.max(0, Math.min(1, 1 - group.distinct / group.observations))),
  }));
  const fully = details.filter((detail) => detail.distinct <= 1).length;
  return {
    groups: groups.length,
    quality: round(mean(details.map((detail) => detail.compression))),
    fully_consolidated: fully,
    details,
  };
}
