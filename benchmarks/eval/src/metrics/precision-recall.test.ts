/**
 * Pure per-type precision/recall tests — no storage, no engine. Pins the arithmetic (including
 * the multi-run pooling the quality gate exercises with three real runs) and the awkward cases.
 */

import { describe, expect, test } from 'bun:test';

import { computePrecisionRecallByType, type TypedRetrievalOutcome } from './precision-recall';

function outcome(
  id: string,
  queryType: TypedRetrievalOutcome['query_type'],
  expectedIds: string[],
  returnedIds: string[],
): TypedRetrievalOutcome {
  return { id, query_type: queryType, expectedIds, returnedIds };
}

describe('computePrecisionRecallByType', () => {
  test('per-query precision truncates at k while recall uses the expected set', () => {
    const record = computePrecisionRecallByType(
      [
        [
          outcome('q1', 'decision', ['a'], ['a', 'b']),
          outcome('q2', 'decision', ['e', 'f'], ['x', 'y', 'z', 'w', 'e']),
        ],
      ],
      { k: 5 },
    );
    const decision = record.by_type.find((entry) => entry.query_type === 'decision')!;
    // q1: precision 1/2, recall 1; q2: top-5 misses f → precision 1/5, recall 1/2.
    expect(decision.precision_at_k.mean).toBe(0.35);
    expect(decision.recall_at_k.mean).toBe(0.75);
    expect(decision.queries_per_run).toBe(2);
    expect(decision.precision_at_k.samples).toBe(2);
  });

  test('pools observations across runs and requires identical query sets per run', () => {
    const run = [outcome('q1', 'procedural', ['a'], ['a'])];
    const pooled = computePrecisionRecallByType([run, run, run]);
    const procedural = pooled.by_type.find((entry) => entry.query_type === 'procedural')!;
    expect(pooled.runs).toBe(3);
    expect(procedural.queries_per_run).toBe(1);
    // 3 observations of 1.0: the point estimate is 1.0 with a degenerate (deterministic) interval.
    expect(procedural.precision_at_k.samples).toBe(3);
    expect(procedural.precision_at_k.mean).toBe(1);
    expect(procedural.precision_at_k.ci95_low).toBe(1);
    expect(procedural.precision_at_k.ci95_high).toBe(1);

    expect(() => computePrecisionRecallByType([[run[0]!], []])).toThrow(/same 'procedural' queries/);
  });

  test('the 95% interval tracks the query-sample spread and is clamped to [0, 1]', () => {
    const record = computePrecisionRecallByType([
      [
        outcome('q1', 'failure', ['a'], ['a']),
        outcome('q2', 'failure', ['a'], ['a', 'b', 'c']),
        outcome('q3', 'failure', ['a'], []),
      ],
    ]);
    const failure = record.by_type.find((entry) => entry.query_type === 'failure')!;
    // per-query precision: 1, 0.3333, 0 → mean 0.4444 with real spread.
    expect(failure.precision_at_k.mean).toBe(0.4444);
    expect(failure.precision_at_k.ci95_low).toBeLessThan(failure.precision_at_k.mean);
    expect(failure.precision_at_k.ci95_high).toBeGreaterThan(failure.precision_at_k.mean);
    expect(failure.precision_at_k.ci95_low).toBeGreaterThanOrEqual(0);
    expect(failure.precision_at_k.ci95_high).toBeLessThanOrEqual(1);
  });

  test('a query type with no typed queries reports zero samples, not a fake zero estimate', () => {
    const record = computePrecisionRecallByType([[outcome('q1', 'decision', ['a'], ['a'])]]);
    const procedural = record.by_type.find((entry) => entry.query_type === 'procedural')!;
    expect(procedural.queries_per_run).toBe(0);
    expect(procedural.precision_at_k.samples).toBe(0);
    expect(procedural.recall_at_k.samples).toBe(0);
  });

  test('empty top-k scores zero precision; an empty expected set scores recall 1 (vacuous)', () => {
    const record = computePrecisionRecallByType([
      [
        outcome('q1', 'decision', ['a'], []),
        outcome('q2', 'decision', [], ['x']),
      ],
    ]);
    const decision = record.by_type.find((entry) => entry.query_type === 'decision')!;
    // q1: nothing returned → precision 0; q2: one returned item, none expected → precision 0
    // (the item cannot be a hit). Schema guarantees typed queries always declare expectations,
    // so the vacuous shapes are only reachable here, in the unit tests.
    expect(decision.precision_at_k.mean).toBe(0);
    // q1: expected missing → recall 0; q2: no expectation → vacuous recall 1.
    expect(decision.recall_at_k.mean).toBe(0.5);
  });
});
