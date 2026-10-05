/**
 * Gate logic tests. The CI gate itself is `harness.test.ts` (it runs the real harness); this file
 * pins the comparison semantics and proves a breached threshold actually fails, without needing a
 * live engine.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_GATE_THRESHOLDS, evaluateGates, type AggregateMetrics } from './gates';

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
    ...overrides,
  };
}

describe('evaluateGates', () => {
  test('passes a baseline-shaped report', () => {
    const evaluation = evaluateGates(metrics());
    expect(evaluation.passed).toBe(true);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.checks).toHaveLength(8);
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
});
