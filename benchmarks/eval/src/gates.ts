/**
 * CI regression gates (backlog M11.2: "CI thresholds; results committed").
 *
 * Thresholds are derived from the committed baseline run with documented headroom (see
 * `benchmarks/results/baseline.md`). Every metric the engine supports end-to-end is gated,
 * including the two M14 metrics flipped on post-merge:
 *
 *   gated: temporal accuracy, retrieval precision@k / recall@k, token-budget compliance,
 *          pollution (cross-project top-1 + declared-distractor leakage),
 *          contradiction accuracy (M14 automatic authority resolution),
 *          consolidation quality (M14 consolidation lifecycle)
 *
 * The two M14 gates are derived from the measured post-M14 offline baseline, whose ceilings are
 * honest but bounded (documented in the mission report):
 *   - contradiction_accuracy 0.8333 (5/6): the attribute-template heuristic misses the dataset's
 *     cross-phrasing pair (M14 follow-up: LLM conflict detector). A single-group regression drops
 *     the metric to 4/6 = 0.6667, well below the 0.8 gate.
 *   - consolidation_quality 0.3333: the offline default wires no embedder, so the vector-gated
 *     passes (episodic→semantic derivation, near-duplicate merge) skip with recorded warnings and
 *     only ingest-time exact dedupe collapses repeats.
 */

import type {
  ConsolidationMetrics,
  ContradictionMetrics,
  PollutionMetrics,
  RetrievalMetrics,
  TemporalMetrics,
  TokenMetrics,
} from './metrics';
import type { PrecisionRecallByType, QualityQueryType } from './metrics/precision-recall';
import type { TokenEfficiencyRecord } from './metrics/token-efficiency';
import type { PollutionAuditRecord } from './metrics/pollution';

export interface AggregateMetrics {
  retrieval: RetrievalMetrics;
  tokens: TokenMetrics;
  pollution: PollutionMetrics;
  temporal: TemporalMetrics;
  contradiction: ContradictionMetrics;
  consolidation: ConsolidationMetrics;
  /** M11b-quality: per-query-type precision/recall (procedural / decision / failure). */
  precision_recall_by_type: PrecisionRecallByType;
  /** M11b-quality: per-query-type budget compliance + the token-oracle gap. */
  token_efficiency: TokenEfficiencyRecord;
  /** M11b-quality: stale / duplicate / unresolved-contradiction counts. */
  pollution_audit: PollutionAuditRecord;
}

export interface GateThresholds {
  /** Minimum. */
  temporal_accuracy: number;
  /** Minimum. */
  retrieval_precision_at_k: number;
  /** Minimum. */
  retrieval_recall_at_k: number;
  /** Minimum (the packer's hard invariant: `used ≤ budget` for every response). */
  token_budget_compliance: number;
  /** Maximum. */
  cross_project_top1_rate: number;
  /** Maximum. */
  irrelevant_leakage_rate: number;
  /** Minimum (post-M14 baseline 0.8333 = 5/6 groups; the miss is the cross-phrasing detector gap). */
  contradiction_accuracy: number;
  /** Minimum (post-M14 offline baseline 0.3333 — vector-gated passes skip without an embedder). */
  consolidation_quality: number;
  /** M11b-quality — minimum per-type precision@k (lexical + graph default baseline). */
  retrieval_precision_procedural: number;
  retrieval_precision_decision: number;
  retrieval_precision_failure: number;
  /** M11b-quality — minimum per-type recall@k. */
  retrieval_recall_procedural: number;
  retrieval_recall_decision: number;
  retrieval_recall_failure: number;
  /** M11b-quality — minimum per-type `used ≤ budget` compliance (correctness invariant). */
  token_budget_compliance_procedural: number;
  token_budget_compliance_decision: number;
  token_budget_compliance_failure: number;
  /**
   * M11b-quality — maximum mean `used / oracle_min_tokens` over recall-satisfied typed queries
   * (the room-to-compress signal; 1.0 = exactly the golden answer at its tightest packing).
   */
  token_oracle_gap_mean: number;
  /** M11b-quality — maximum archived-but-recently-cited memories (count). */
  stale_cited_memories: number;
  /** M11b-quality — maximum ≥0.97-cosine pairs that surfaced in retrieval (count). */
  duplicate_surfaced_pairs: number;
  /** M11b-quality — maximum declared-contradiction sides left neither superseded nor disputed. */
  unresolved_contradicted_memories: number;
}

/**
 * Baselines + headroom are recorded in `benchmarks/results/baseline.md`. Headroom is one metric
 * step below the measured value (0.05 for rates) so a real regression fails the gate while
 * ordinary fixture-safe noise does not.
 */
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  // Correctness invariants: a single miss is a real regression, so no headroom is given.
  temporal_accuracy: 1.0,
  token_budget_compliance: 1.0,
  cross_project_top1_rate: 0.0,
  // Baseline 0.7963 (lexical + graph default, `benchmarks/results/baseline.md`): one step below
  // with ~0.10 headroom.
  retrieval_precision_at_k: 0.7,
  // Baseline 1.0 → ~0.10 headroom.
  retrieval_recall_at_k: 0.9,
  // Baseline 0.1111 → ~0.09 headroom.
  irrelevant_leakage_rate: 0.2,
  // Baseline 0.8333 (5/6 groups; the cross-phrasing pair is the documented detector gap): one
  // step below. Any single passing group regressing drops the metric to 0.6667 and fails.
  contradiction_accuracy: 0.8,
  // Baseline 0.3333 (exact-dedupe ceiling offline): one step below.
  consolidation_quality: 0.3,
  // M11b-quality thresholds are derived from the first measured baseline
  // (`benchmarks/results/*.{date}.json`, schema + headroom in `benchmarks/results/README.md`).
  // Per-type precision carries one honest step of headroom below the measured value
  // (procedural 0.69, decision 1.0, failure 0.4444 — failure queries structurally co-surface
  // sibling failures and the failing commands' recurring procedurals, which is the engine's
  // intended known-failures surface, not a fixture defect); per-type recall is measured 1.0 and
  // gated at 0.9 so any single query losing its expected fact fails. The three per-type budget
  // gates are correctness invariants like the aggregate one (packer construction guarantees
  // `used ≤ budget`, so 1.0).
  retrieval_precision_procedural: 0.6,
  retrieval_precision_decision: 0.9,
  retrieval_precision_failure: 0.4,
  retrieval_recall_procedural: 0.9,
  retrieval_recall_decision: 0.9,
  retrieval_recall_failure: 0.9,
  token_budget_compliance_procedural: 1.0,
  token_budget_compliance_decision: 1.0,
  token_budget_compliance_failure: 1.0,
  // Measured first-baseline mean gap over recall-satisfied typed queries (2.1418; decision
  // queries sit near the oracle at 1.0267, procedural/failure carry the co-surfaced siblings at
  // 2.76/2.97) + one step of headroom.
  token_oracle_gap_mean: 2.5,
  // Count gates: the pollution fixtures demonstrate detection, so each ceiling is the measured
  // fixture count (a lower count is an improvement, a higher one is a regression).
  stale_cited_memories: 1,
  duplicate_surfaced_pairs: 1,
  unresolved_contradicted_memories: 1,
};

export interface GateCheck {
  metric: string;
  actual: number;
  threshold: number;
  comparison: 'min' | 'max';
  passed: boolean;
}

export interface GateEvaluation {
  passed: boolean;
  thresholds: GateThresholds;
  checks: GateCheck[];
}

export function evaluateGates(
  metrics: AggregateMetrics,
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): GateEvaluation {
  const checks: GateCheck[] = [
    check('temporal_accuracy', metrics.temporal.accuracy, thresholds.temporal_accuracy, 'min'),
    check(
      'retrieval_precision_at_k',
      metrics.retrieval.precision_at_k,
      thresholds.retrieval_precision_at_k,
      'min',
    ),
    check('retrieval_recall_at_k', metrics.retrieval.recall_at_k, thresholds.retrieval_recall_at_k, 'min'),
    check(
      'token_budget_compliance',
      metrics.tokens.budget_compliance,
      thresholds.token_budget_compliance,
      'min',
    ),
    check(
      'cross_project_top1_rate',
      metrics.pollution.cross_project_top1_rate,
      thresholds.cross_project_top1_rate,
      'max',
    ),
    check(
      'irrelevant_leakage_rate',
      metrics.pollution.irrelevant_leakage_rate,
      thresholds.irrelevant_leakage_rate,
      'max',
    ),
    check(
      'contradiction_accuracy',
      metrics.contradiction.accuracy,
      thresholds.contradiction_accuracy,
      'min',
    ),
    check(
      'consolidation_quality',
      metrics.consolidation.quality,
      thresholds.consolidation_quality,
      'min',
    ),
    ...perTypeChecks(metrics.precision_recall_by_type.by_type, (record) => [
      [
        'retrieval_precision',
        record.precision_at_k.mean,
        thresholds[`retrieval_precision_${record.query_type}`],
        'min',
      ],
      [
        'retrieval_recall',
        record.recall_at_k.mean,
        thresholds[`retrieval_recall_${record.query_type}`],
        'min',
      ],
    ]),
    ...perTypeChecks(metrics.token_efficiency.by_type, (record) => [
      [
        'token_budget_compliance',
        record.budget_compliance,
        thresholds[`token_budget_compliance_${record.query_type}`],
        'min',
      ],
    ]),
    check(
      'token_oracle_gap_mean',
      metrics.token_efficiency.oracle_gap_mean_when_satisfied,
      thresholds.token_oracle_gap_mean,
      'max',
    ),
    check(
      'stale_cited_memories',
      metrics.pollution_audit.stale_cited.count,
      thresholds.stale_cited_memories,
      'max',
    ),
    check(
      'duplicate_surfaced_pairs',
      metrics.pollution_audit.duplicates.count,
      thresholds.duplicate_surfaced_pairs,
      'max',
    ),
    check(
      'unresolved_contradicted_memories',
      metrics.pollution_audit.unresolved_contradictions.count,
      thresholds.unresolved_contradicted_memories,
      'max',
    ),
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    thresholds,
    checks,
  };
}

/**
 * Expand one metric family across the three M11b query types. `entries` returns the family's
 * (suffix, actual, threshold, comparison) tuples for one per-type record; every tuple becomes
 * one check named `<family>_<type>`, so the gate report stays one line per threshold.
 */
function perTypeChecks<T extends { query_type: QualityQueryType }>(
  byType: ReadonlyArray<T>,
  entries: (
    record: T,
  ) => ReadonlyArray<[suffix: string, actual: number, threshold: number, comparison: 'min' | 'max']>,
): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const record of byType) {
    for (const [suffix, actual, threshold, comparison] of entries(record)) {
      checks.push(
        check(`${suffix}_${record.query_type}`, actual, threshold, comparison),
      );
    }
  }
  return checks;
}

function check(metric: string, actual: number, threshold: number, comparison: 'min' | 'max'): GateCheck {
  const passed = comparison === 'min' ? actual >= threshold : actual <= threshold;
  return { metric, actual, threshold, comparison, passed };
}
