/**
 * Pure metric math tests — no storage, no engine. These pin the arithmetic the gated harness
 * relies on, including the awkward cases (empty results, missing expected facts, cross-project
 * leakage) that the golden datasets do not happen to exercise.
 */

import { describe, expect, test } from 'bun:test';

import {
  computeConsolidationMetrics,
  computeContradictionMetrics,
  computePollutionMetrics,
  computeRetrievalMetrics,
  computeTemporalMetrics,
  computeTokenMetrics,
  temporalBucketFor,
  type QueryOutcome,
} from './metrics';
import type { CorpusMemory } from './runtime';

function memory(id: string, project_id: string | null, content = `content of ${id}`): CorpusMemory {
  return { id, type: 'semantic', subtype: null, content, project_id, observed_at: '2026-10-03T09:00:00.000Z' };
}

function outcome(partial: Partial<QueryOutcome> & { id: string }): QueryOutcome {
  return {
    kind: 'retrieval',
    projectKey: null,
    projectId: null,
    returnedIds: [],
    expectedIds: [],
    forbiddenIds: [],
    usedTokens: 0,
    budget: 800,
    packing: 'summary',
    warnings: [],
    ...partial,
  };
}

describe('computeRetrievalMetrics', () => {
  test('a top-ranked expected fact scores full recall and MRR, precision reflects the extra hit', () => {
    const metrics = computeRetrievalMetrics([
      outcome({ id: 'q1', expectedIds: ['a'], returnedIds: ['a', 'b'] }),
    ]);
    expect(metrics.queries).toBe(1);
    expect(metrics.precision_at_k).toBe(0.5);
    expect(metrics.recall_at_k).toBe(1);
    expect(metrics.mrr).toBe(1);
  });

  test('precision@k truncates at k while recall uses the full returned list', () => {
    const metrics = computeRetrievalMetrics(
      [outcome({ id: 'q1', expectedIds: ['e', 'e2'], returnedIds: ['x', 'y', 'z', 'w', 'e', 'e2'] })],
      5,
    );
    // top-5 is [x, y, z, w, e]: one of two expected facts, at rank 5.
    expect(metrics.precision_at_k).toBe(0.2);
    expect(metrics.recall_at_k).toBe(0.5);
    // The full list contains both, so recall over the whole response is perfect.
    expect(metrics.recall_full).toBe(1);
    expect(metrics.mrr).toBe(0.2);
  });

  test('missing results score zero rather than throwing', () => {
    const metrics = computeRetrievalMetrics([outcome({ id: 'q1', expectedIds: ['a'], returnedIds: [] })]);
    expect(metrics.precision_at_k).toBe(0);
    expect(metrics.recall_at_k).toBe(0);
    expect(metrics.mrr).toBe(0);
  });

  test('queries without expected facts are excluded from the aggregate', () => {
    const metrics = computeRetrievalMetrics([
      outcome({ id: 'q1', expectedIds: ['a'], returnedIds: ['a'] }),
      outcome({ id: 'q2', expectedIds: [], returnedIds: ['b'] }),
    ]);
    expect(metrics.queries).toBe(1);
    expect(metrics.precision_at_k).toBe(1);
  });
});

describe('computeTokenMetrics', () => {
  test('budget compliance is the fraction of responses within budget', () => {
    const metrics = computeTokenMetrics([
      outcome({ id: 'q1', usedTokens: 100, budget: 100 }),
      outcome({ id: 'q2', usedTokens: 101, budget: 100 }),
    ]);
    expect(metrics.budget_compliance).toBe(0.5);
    expect(metrics.max_used).toBe(101);
  });

  test('tokens per expected fact ignores queries with no expectation', () => {
    const metrics = computeTokenMetrics([
      outcome({ id: 'q1', usedTokens: 40, expectedIds: ['a', 'b'] }),
      outcome({ id: 'q2', usedTokens: 999, expectedIds: [] }),
    ]);
    expect(metrics.mean_tokens_per_expected).toBe(20);
  });
});

describe('computePollutionMetrics', () => {
  const corpus = new Map<string, CorpusMemory>([
    ['alpha-1', memory('alpha-1', 'project-a')],
    ['alpha-2', memory('alpha-2', 'project-a')],
    ['beta-1', memory('beta-1', 'project-b')],
    ['global-1', memory('global-1', null)],
  ]);

  test('cross-project top-1 and leakage are counted; global memories are not leaks', () => {
    const metrics = computePollutionMetrics(
      [
        outcome({
          id: 'good',
          projectId: 'project-a',
          returnedIds: ['alpha-1', 'global-1'],
        }),
        outcome({
          id: 'leaky',
          projectId: 'project-a',
          returnedIds: ['alpha-2', 'beta-1'],
        }),
      ],
      corpus,
    );
    expect(metrics.cross_project_top1_rate).toBe(0);
    expect(metrics.returned).toBe(4);
    expect(metrics.leaked).toBe(1);
    expect(metrics.cross_project_leakage_rate).toBe(0.25);
  });

  test('a wrong-project top-1 counts against the hard invariant', () => {
    const metrics = computePollutionMetrics(
      [outcome({ id: 'bad', projectId: 'project-a', returnedIds: ['beta-1', 'alpha-1'] })],
      corpus,
    );
    expect(metrics.cross_project_top1_rate).toBe(1);
  });

  test('declared distractors drive the irrelevant-leakage rate', () => {
    const metrics = computePollutionMetrics(
      [
        outcome({
          id: 'q1',
          projectId: 'project-a',
          returnedIds: ['alpha-1', 'beta-1'],
          forbiddenIds: ['beta-1'],
        }),
      ],
      corpus,
    );
    expect(metrics.irrelevant_leakage_rate).toBe(0.5);
  });

  test('contradiction probes are excluded from the gated pollution metrics', () => {
    const metrics = computePollutionMetrics(
      [
        outcome({
          id: 'contradiction-x',
          kind: 'contradiction',
          projectId: 'project-a',
          returnedIds: ['alpha-1', 'beta-1'],
          forbiddenIds: ['beta-1'],
        }),
      ],
      corpus,
    );
    expect(metrics.returned).toBe(0);
    expect(metrics.cross_project_top1_rate).toBe(0);
    expect(metrics.irrelevant_leakage_rate).toBe(0);
  });
});

describe('computeTemporalMetrics', () => {
  test('a probe is correct only when every expected fact is present and no forbidden one is', () => {
    const metrics = computeTemporalMetrics([
      outcome({
        id: 'current',
        kind: 'temporal',
        temporal_bucket: 'current',
        expectedIds: ['new'],
        forbiddenIds: ['old'],
        returnedIds: ['new'],
      }),
      outcome({
        id: 'pit',
        kind: 'temporal',
        temporal_bucket: 'point_in_time',
        expectedIds: ['old'],
        forbiddenIds: ['new'],
        returnedIds: ['old', 'new'],
      }),
    ]);
    expect(metrics.probes).toBe(2);
    expect(metrics.correct).toBe(1);
    expect(metrics.accuracy).toBe(0.5);
    expect(metrics.current).toEqual({ probes: 1, correct: 1 });
    expect(metrics.point_in_time).toEqual({ probes: 1, correct: 0 });
  });

  test('temporalBucketFor maps the request shape to the bucket', () => {
    expect(temporalBucketFor({ as_of: '2026-10-03T09:00:15.000Z' })).toBe('point_in_time');
    expect(temporalBucketFor({ temporal_mode: 'historical' })).toBe('history');
    expect(temporalBucketFor({})).toBe('current');
  });
});

describe('computeContradictionMetrics', () => {
  test('an unresolved contradiction (both sides returned) is a silent conflict', () => {
    const metrics = computeContradictionMetrics([
      outcome({
        id: 'contradiction-1',
        kind: 'contradiction',
        expectedIds: ['authority'],
        forbiddenIds: ['loser'],
        returnedIds: ['loser', 'authority'],
      }),
    ]);
    expect(metrics.groups).toBe(1);
    expect(metrics.resolved).toBe(0);
    expect(metrics.accuracy).toBe(0);
    expect(metrics.silent_conflicts).toBe(1);
    expect(metrics.authority_top1).toBe(0);
  });

  test('a resolved contradiction counts as accurate', () => {
    const metrics = computeContradictionMetrics([
      outcome({
        id: 'contradiction-1',
        kind: 'contradiction',
        expectedIds: ['authority'],
        forbiddenIds: ['loser'],
        returnedIds: ['authority'],
      }),
    ]);
    expect(metrics.accuracy).toBe(1);
    expect(metrics.authority_top1).toBe(1);
    expect(metrics.silent_conflicts).toBe(0);
  });
});

describe('computeConsolidationMetrics', () => {
  test('compression is 1 - distinct/observations, clamped', () => {
    const metrics = computeConsolidationMetrics([
      { id: 'exact', observations: 2, distinct: 1 },
      { id: 'paraphrase', observations: 2, distinct: 2 },
      { id: 'over', observations: 2, distinct: 5 },
    ]);
    expect(metrics.groups).toBe(3);
    expect(metrics.details[0]!.compression).toBe(0.5);
    expect(metrics.details[1]!.compression).toBe(0);
    expect(metrics.details[2]!.compression).toBe(0);
    expect(metrics.fully_consolidated).toBe(1);
    expect(metrics.quality).toBeCloseTo(0.1667, 3);
  });
});
