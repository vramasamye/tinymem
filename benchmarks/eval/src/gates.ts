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

export interface AggregateMetrics {
  retrieval: RetrievalMetrics;
  tokens: TokenMetrics;
  pollution: PollutionMetrics;
  temporal: TemporalMetrics;
  contradiction: ContradictionMetrics;
  consolidation: ConsolidationMetrics;
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
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    thresholds,
    checks,
  };
}

function check(metric: string, actual: number, threshold: number, comparison: 'min' | 'max'): GateCheck {
  const passed = comparison === 'min' ? actual >= threshold : actual <= threshold;
  return { metric, actual, threshold, comparison, passed };
}
