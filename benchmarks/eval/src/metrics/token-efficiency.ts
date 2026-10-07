/**
 * M11b-quality: token efficiency per query type (phased-plan Phase 5 row M11b;
 * `docs/architecture/retrieval.md` §7, AGENTS.md rule 7).
 *
 * Two measurements:
 *
 * 1. **Budget compliance** — the packer's hard invariant `used ≤ budget`, asserted per query
 *    type (procedural / decision / failure), not only in the aggregate. The packer enforces it
 *    by construction (`packResults` throws on a violated budget), so this gate is a correctness
 *    invariant at 1.0.
 *
 * 2. **Oracle gap** — `used / oracle_min_tokens`, the room there is to compress. The oracle is
 *    the token cost of the packer's MOST COMPACT representation of exactly the golden answer
 *    set: `Σ estimateTokens(deriveLabel(title, content))` over the expected facts — the same
 *    estimator (`@onememory-ai/core`) and label derivation (`@onememory-ai/retrieval`) the engine's
 *    titles-only overflow line uses. A gap of 1.0 means the response was exactly the golden
 *    answer at its tightest packing; every point above is extra memories or richer
 *    representations. The gated value is the mean over queries whose expected facts ALL
 *    surfaced — a recall miss would otherwise fake efficiency (fewer tokens, wrong answer).
 *
 * The per-query values are computed by the harness (they need the engine's estimator over the
 * golden facts); this module stays pure math over those views, in the M11a `metrics.ts` style.
 */

import type { QualityQueryType } from './precision-recall';

/** One typed query's token view — built by the harness from the response + the golden facts. */
export interface TokenEfficiencyQueryView {
  id: string;
  query_type: QualityQueryType;
  usedTokens: number;
  budget: number;
  oracleMinTokens: number;
  /** True when every expected fact surfaced in the response (the gap is meaningful). */
  allExpectedReturned: boolean;
}

export interface TokenEfficiencyByType {
  query_type: QualityQueryType;
  queries: number;
  /** Fraction of typed queries with `used ≤ budget`. */
  budget_compliance: number;
  /** Mean `used / oracle_min_tokens` over the typed queries. */
  oracle_gap: number;
  /** Mean gap over recall-satisfied typed queries only (the honest compressibility signal). */
  oracle_gap_when_satisfied: number;
}

export interface TokenEfficiencyRecord {
  queries: number;
  /** Fraction of ALL typed queries with `used ≤ budget` (the per-type split is below). */
  budget_compliance: number;
  by_type: TokenEfficiencyByType[];
  /** Mean gap over all typed queries (diagnostic; recall misses can deflate it). */
  oracle_gap_mean: number;
  oracle_gap_max: number;
  /** The gated value: mean gap over recall-satisfied queries only. */
  oracle_gap_mean_when_satisfied: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function gapOf(query: TokenEfficiencyQueryView): number {
  if (query.oracleMinTokens <= 0) {
    throw new Error(`token-efficiency: query '${query.id}' has a non-positive oracle`);
  }
  return query.usedTokens / query.oracleMinTokens;
}

export function computeTokenEfficiency(
  queries: readonly TokenEfficiencyQueryView[],
  types: readonly QualityQueryType[],
): TokenEfficiencyRecord {
  const compliant = queries.filter((query) => query.usedTokens <= query.budget).length;
  const satisfied = queries.filter((query) => query.allExpectedReturned);
  const byType: TokenEfficiencyByType[] = types.map((queryType) => {
    const typed = queries.filter((query) => query.query_type === queryType);
    const typedCompliant = typed.filter((query) => query.usedTokens <= query.budget).length;
    const typedSatisfied = typed.filter((query) => query.allExpectedReturned);
    return {
      query_type: queryType,
      queries: typed.length,
      budget_compliance: typed.length === 0 ? 1 : round(typedCompliant / typed.length),
      oracle_gap: round(mean(typed.map(gapOf))),
      oracle_gap_when_satisfied: round(mean(typedSatisfied.map(gapOf))),
    };
  });
  return {
    queries: queries.length,
    budget_compliance: queries.length === 0 ? 1 : round(compliant / queries.length),
    by_type: byType,
    oracle_gap_mean: round(mean(queries.map(gapOf))),
    oracle_gap_max: queries.length === 0 ? 0 : round(Math.max(...queries.map(gapOf))),
    oracle_gap_mean_when_satisfied: round(mean(satisfied.map(gapOf))),
  };
}
