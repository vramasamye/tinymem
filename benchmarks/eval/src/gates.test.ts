/**
 * Gate logic tests. The CI gate itself is `harness.test.ts` (it runs the real harness); this file
 * pins the comparison semantics and proves a breached threshold actually fails, without needing a
 * live engine.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_GATE_THRESHOLDS, evaluateGates, type AggregateMetrics } from './gates';
import type { PrecisionRecallByType } from './metrics/precision-recall';
import type { TokenEfficiencyRecord } from './metrics/token-efficiency';
import type { PollutionAuditRecord } from './metrics/pollution';

function precisionRecallByType(
  overrides: Partial<PrecisionRecallByType> = {},
): PrecisionRecallByType {
  return {
    runs: 1,
    k: 5,
    by_type: (['procedural', 'decision', 'failure'] as const).map((query_type) => ({
      query_type,
      queries_per_run: 5,
      precision_at_k: { mean: 0.9, ci95_low: 0.7, ci95_high: 1, samples: 5 },
      recall_at_k: { mean: 1, ci95_low: 1, ci95_high: 1, samples: 5 },
    })),
    ...overrides,
  };
}

function tokenEfficiency(overrides: Partial<TokenEfficiencyRecord> = {}): TokenEfficiencyRecord {
  return {
    queries: 13,
    budget_compliance: 1,
    by_type: (['procedural', 'decision', 'failure'] as const).map((query_type) => ({
      query_type,
      queries: 5,
      budget_compliance: 1,
      oracle_gap: 2,
      oracle_gap_when_satisfied: 2,
    })),
    oracle_gap_mean: 2,
    oracle_gap_max: 3,
    oracle_gap_mean_when_satisfied: 2,
    ...overrides,
  };
}

function pollutionAudit(overrides: Partial<PollutionAuditRecord> = {}): PollutionAuditRecord {
  return {
    stale_cited: { window_days: 30, count: 1, memories: [] },
    duplicates: { cosine_threshold: 0.97, count: 1, pairs: [] },
    unresolved_contradictions: { count: 1, memories: [] },
    ...overrides,
  };
}

function metrics(overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
  return {
    retrieval: {
      queries: 9,
      k: 5,
      precision_at_k: 0.8,
      recall_at_k: 1,
      precision_full: 0.8,
      recall_full: 1,
      mrr: 0.83,
    },
    tokens: {
      queries: 23,
      budget_compliance: 1,
      mean_used: 22,
      max_used: 54,
      p95_used: 54,
      mean_tokens_per_expected: 20,
    },
    pollution: {
      cross_project_top1_rate: 0,
      cross_project_leakage_rate: 0.06,
      irrelevant_leakage_rate: 0.11,
      returned: 31,
      leaked: 2,
    },
    temporal: {
      probes: 5,
      correct: 5,
      accuracy: 1,
      current: { probes: 1, correct: 1 },
      point_in_time: { probes: 3, correct: 3 },
      history: { probes: 1, correct: 1 },
    },
    // Post-M14 baseline shape: 5/6 groups resolved (the miss is the cross-phrasing detector gap)
    // and the offline consolidation ceiling.
    contradiction: {
      groups: 6,
      resolved: 5,
      accuracy: 0.8333,
      authority_top1: 3,
      silent_conflicts: 1,
    },
    consolidation: {
      groups: 3,
      quality: 0.3333,
      fully_consolidated: 2,
      details: [],
    },
    // M11b-quality first-baseline shape: per-type precision/recall at the measured values, the
    // oracle gap at its measured ceiling, and the three pollution counts at their fixture values.
    precision_recall_by_type: precisionRecallByType(),
    token_efficiency: tokenEfficiency(),
    pollution_audit: pollutionAudit(),
    ...overrides,
  };
}

describe('evaluateGates', () => {
  test('passes a baseline-shaped report', () => {
    const evaluation = evaluateGates(metrics());
    expect(evaluation.passed).toBe(true);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    // 8 original gates + 13 M11b-quality gates (6 per-type precision/recall, 3 per-type budget
    // compliance, 1 oracle gap, 3 pollution counts).
    expect(evaluation.checks).toHaveLength(21);
  });

  test('fails when temporal accuracy drops below its threshold', () => {
    const evaluation = evaluateGates(
      metrics({ temporal: { ...metrics().temporal, accuracy: 0.8 } }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.metric === 'temporal_accuracy')?.passed).toBe(false);
  });

  test('fails when retrieval precision drops below its threshold', () => {
    const evaluation = evaluateGates(
      metrics({ retrieval: { ...metrics().retrieval, precision_at_k: 0.5 } }),
    );
    expect(evaluation.passed).toBe(false);
  });

  test('fails when the token budget is exceeded', () => {
    const evaluation = evaluateGates(
      metrics({ tokens: { ...metrics().tokens, budget_compliance: 0.9 } }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.metric === 'token_budget_compliance')?.passed).toBe(
      false,
    );
  });

  test('fails when a wrong-project result ranks first', () => {
    const evaluation = evaluateGates(
      metrics({ pollution: { ...metrics().pollution, cross_project_top1_rate: 0.1 } }),
    );
    expect(evaluation.passed).toBe(false);
  });

  test('fails when declared distractors leak past the ceiling', () => {
    const evaluation = evaluateGates(
      metrics({ pollution: { ...metrics().pollution, irrelevant_leakage_rate: 0.5 } }),
    );
    expect(evaluation.passed).toBe(false);
  });

  test('fails when contradiction accuracy drops below its threshold', () => {
    const evaluation = evaluateGates(
      metrics({ contradiction: { ...metrics().contradiction, accuracy: 0.6667 } }),
    );
    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.checks.find((check) => check.metric === 'contradiction_accuracy')?.passed,
    ).toBe(false);
  });

  test('fails when consolidation quality drops below its threshold', () => {
    const evaluation = evaluateGates(
      metrics({ consolidation: { ...metrics().consolidation, quality: 0.1667 } }),
    );
    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.checks.find((check) => check.metric === 'consolidation_quality')?.passed,
    ).toBe(false);
  });

  test('exposes the thresholds it enforced', () => {
    expect(evaluateGates(metrics()).thresholds).toEqual(DEFAULT_GATE_THRESHOLDS);
  });

  test('fails when one query type drops below its per-type precision threshold', () => {
    const byType = precisionRecallByType().by_type.map((record) =>
      record.query_type === 'failure'
        ? { ...record, precision_at_k: { ...record.precision_at_k, mean: 0.2 } }
        : record,
    );
    const evaluation = evaluateGates(
      metrics({ precision_recall_by_type: { ...precisionRecallByType(), by_type: byType } }),
    );
    expect(evaluation.passed).toBe(false);
    const failed = evaluation.checks.find((check) => check.metric === 'retrieval_precision_failure');
    expect(failed?.passed).toBe(false);
    // The other types still pass — the gate is per-type, so a single regression is attributable.
    expect(evaluation.checks.find((check) => check.metric === 'retrieval_precision_decision')?.passed).toBe(
      true,
    );
  });

  test('fails when one query type drops below its per-type recall threshold', () => {
    const byType = precisionRecallByType().by_type.map((record) =>
      record.query_type === 'procedural'
        ? { ...record, recall_at_k: { ...record.recall_at_k, mean: 0.6 } }
        : record,
    );
    const evaluation = evaluateGates(
      metrics({ precision_recall_by_type: { ...precisionRecallByType(), by_type: byType } }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.metric === 'retrieval_recall_procedural')?.passed).toBe(
      false,
    );
  });

  test('fails when a typed query exceeds its token budget', () => {
    const byType = tokenEfficiency().by_type.map((record) =>
      record.query_type === 'decision' ? { ...record, budget_compliance: 0.5 } : record,
    );
    const evaluation = evaluateGates(
      metrics({ token_efficiency: { ...tokenEfficiency(), by_type: byType } }),
    );
    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.checks.find((check) => check.metric === 'token_budget_compliance_decision')?.passed,
    ).toBe(false);
  });

  test('fails when the oracle gap grows past the room-to-compress ceiling', () => {
    const evaluation = evaluateGates(
      metrics({
        token_efficiency: tokenEfficiency({ oracle_gap_mean_when_satisfied: 6, oracle_gap_mean: 6 }),
      }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.metric === 'token_oracle_gap_mean')?.passed).toBe(false);
  });

  test('fails when the stale-cited pollution count exceeds the ceiling', () => {
    const evaluation = evaluateGates(
      metrics({ pollution_audit: pollutionAudit({ stale_cited: { window_days: 30, count: 2, memories: [] } }) }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.metric === 'stale_cited_memories')?.passed).toBe(false);
  });

  test('fails when a new duplicate pair surfaces in retrieval', () => {
    const evaluation = evaluateGates(
      metrics({ pollution_audit: pollutionAudit({ duplicates: { cosine_threshold: 0.97, count: 2, pairs: [] } }) }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.metric === 'duplicate_surfaced_pairs')?.passed).toBe(false);
  });

  test('fails when another declared contradiction stays unresolved', () => {
    const evaluation = evaluateGates(
      metrics({
        pollution_audit: pollutionAudit({ unresolved_contradictions: { count: 2, memories: [] } }),
      }),
    );
    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.checks.find((check) => check.metric === 'unresolved_contradicted_memories')?.passed,
    ).toBe(false);
  });
});
