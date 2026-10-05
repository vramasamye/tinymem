/**
 * CI regression gates (backlog M11.2: "CI thresholds; results committed").
 *
 * Thresholds are derived from the committed baseline run with documented headroom (see
 * `benchmarks/results/baseline.md`). The gated set is exactly the metrics the engine already
 * supports end-to-end:
 *
 *   gated   : temporal accuracy, retrieval precision@k / recall@k, token-budget compliance,
 *             pollution (cross-project top-1 + declared-distractor leakage)
 *   reported: contradiction accuracy, consolidation quality
 *
 * Contradiction accuracy and consolidation quality are measured and published but NOT gated: both
 * depend on M14 (automatic contradiction resolution + consolidation), which runs in a sibling
 * worktree this wave. The coordinator flips those two gates on after M14 merges (see the mission
 * report).
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
  /** Reported only (M14). */
  contradiction: ContradictionMetrics;
  /** Reported only (M14). */
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
  /** Metrics measured and published but deliberately not gated (M14 dependencies). */
  reported_only: {
    contradiction_accuracy: number;
    consolidation_quality: number;
  };
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
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    thresholds,
    checks,
    reported_only: {
      contradiction_accuracy: metrics.contradiction.accuracy,
      consolidation_quality: metrics.consolidation.quality,
    },
  };
}

function check(metric: string, actual: number, threshold: number, comparison: 'min' | 'max'): GateCheck {
  const passed = comparison === 'min' ? actual >= threshold : actual <= threshold;
  return { metric, actual, threshold, comparison, passed };
}
