/**
 * Pure token-efficiency tests — no storage, no engine. Pins the per-type budget compliance, the
 * oracle-gap arithmetic, and the recall-satisfied guard that keeps a miss from faking efficiency.
 */

import { describe, expect, test } from 'bun:test';

import { computeTokenEfficiency, type TokenEfficiencyQueryView } from './token-efficiency';

function view(partial: Partial<TokenEfficiencyQueryView> & { id: string }): TokenEfficiencyQueryView {
  return {
    query_type: 'decision',
    usedTokens: 20,
    budget: 100,
    oracleMinTokens: 10,
    allExpectedReturned: true,
    ...partial,
  };
}

describe('computeTokenEfficiency', () => {
  test('budget compliance is per type and overall', () => {
    const record = computeTokenEfficiency(
      [
        view({ id: 'ok-1', query_type: 'decision' }),
        view({ id: 'ok-2', query_type: 'procedural' }),
        view({ id: 'over', query_type: 'procedural', usedTokens: 101, budget: 100 }),
        view({ id: 'exact', query_type: 'procedural', usedTokens: 100, budget: 100 }),
      ],
      ['procedural', 'decision', 'failure'],
    );
    expect(record.budget_compliance).toBe(0.75);
    const procedural = record.by_type.find((entry) => entry.query_type === 'procedural')!;
    expect(procedural.budget_compliance).toBe(0.6667);
    const failure = record.by_type.find((entry) => entry.query_type === 'failure')!;
    // No typed failure queries: vacuous compliance, not a fake pass signal.
    expect(failure.queries).toBe(0);
    expect(failure.budget_compliance).toBe(1);
  });

  test('the oracle gap is used / oracle_min_tokens, mean and max', () => {
    const record = computeTokenEfficiency(
      [
        view({ id: 'q1', usedTokens: 20, oracleMinTokens: 10 }),
        view({ id: 'q2', usedTokens: 30, oracleMinTokens: 20 }),
      ],
      ['procedural', 'decision', 'failure'],
    );
    expect(record.oracle_gap_mean).toBe(1.75);
    expect(record.oracle_gap_max).toBe(2);
  });

  test('a recall miss is excluded from the satisfied-only gap (a miss must not fake efficiency)', () => {
    const record = computeTokenEfficiency(
      [
        view({ id: 'miss', usedTokens: 4, oracleMinTokens: 10, allExpectedReturned: false }),
        view({ id: 'hit', usedTokens: 20, oracleMinTokens: 10 }),
      ],
      ['procedural', 'decision', 'failure'],
    );
    // All-queries mean includes the deflated miss; the gated satisfied-only mean does not.
    expect(record.oracle_gap_mean).toBe(1.2);
    expect(record.oracle_gap_mean_when_satisfied).toBe(2);
  });

  test('a non-positive oracle fails loudly instead of dividing by zero', () => {
    expect(() =>
      computeTokenEfficiency([view({ id: 'bad', oracleMinTokens: 0 })], ['procedural', 'decision', 'failure']),
    ).toThrow(/non-positive oracle/);
  });

  test('an empty typed set is vacuously compliant and gapless', () => {
    const record = computeTokenEfficiency([], ['procedural', 'decision', 'failure']);
    expect(record.queries).toBe(0);
    expect(record.budget_compliance).toBe(1);
    expect(record.oracle_gap_mean).toBe(0);
    expect(record.oracle_gap_max).toBe(0);
    expect(record.oracle_gap_mean_when_satisfied).toBe(0);
  });
});
