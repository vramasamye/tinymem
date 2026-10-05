/**
 * Dataset schema + loader tests: the golden fixtures are the benchmark's ground truth, so a
 * malformed or dangling reference must fail loudly at load time, never silently shrink the run.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { GOLDEN_DATASETS_DIR, loadDatasets, parseDataset } from './dataset';

function minimal(): Record<string, unknown> {
  return {
    schema_version: '1',
    id: 'minimal',
    title: 'minimal',
    description: 'minimal dataset',
    base_time: '2026-10-03T09:00:00.000Z',
    now: '2026-10-03T10:00:00.000Z',
    projects: [{ key: 'alpha', name: 'alpha' }],
    events: [
      {
        kind: 'conversation.message',
        project: 'alpha',
        offset_seconds: 10,
        role: 'user',
        content: 'We decided to use PostgreSQL.',
      },
    ],
    facts: [
      { key: 'fact-a', description: 'a fact', scenario: 'other', match: { content_contains: 'PostgreSQL' } },
    ],
    queries: [{ id: 'query-a', project: 'alpha', query: 'which database', expected: ['fact-a'] }],
  };
}

describe('parseDataset', () => {
  test('accepts a minimal valid dataset and applies query defaults', () => {
    const dataset = parseDataset(minimal());
    expect(dataset.id).toBe('minimal');
    expect(dataset.queries[0]!.max_tokens).toBe(800);
    expect(dataset.queries[0]!.kind).toBe('retrieval');
    expect(dataset.queries[0]!.forbidden).toEqual([]);
    expect(dataset.supersessions).toEqual([]);
  });

  test('rejects an unknown fact reference', () => {
    const raw = minimal();
    raw.queries = [{ id: 'query-a', project: 'alpha', query: 'q', expected: ['nope'] }];
    expect(() => parseDataset(raw)).toThrow(/unknown fact 'nope'/);
  });

  test('rejects an unknown project reference', () => {
    const raw = minimal();
    raw.queries = [{ id: 'query-a', project: 'ghost', query: 'q', expected: ['fact-a'] }];
    expect(() => parseDataset(raw)).toThrow(/unknown project 'ghost'/);
  });

  test('rejects duplicate fact keys and duplicate query ids', () => {
    const duplicateFacts = minimal();
    duplicateFacts.facts = [
      { key: 'fact-a', description: 'a', scenario: 'other', match: { content_contains: 'PostgreSQL' } },
      { key: 'fact-a', description: 'b', scenario: 'other', match: { content_contains: 'PostgreSQL' } },
    ];
    expect(() => parseDataset(duplicateFacts)).toThrow(/duplicate fact key/);

    const duplicateQueries = minimal();
    duplicateQueries.queries = [
      { id: 'query-a', project: 'alpha', query: 'q', expected: ['fact-a'] },
      { id: 'query-a', project: 'alpha', query: 'q', expected: ['fact-a'] },
    ];
    expect(() => parseDataset(duplicateQueries)).toThrow(/duplicate query id/);
  });

  test('rejects a matcher that cannot identify a memory', () => {
    const raw = minimal();
    raw.facts = [{ key: 'fact-a', description: 'a', scenario: 'other', match: { type: 'semantic' } }];
    expect(() => parseDataset(raw)).toThrow(/matcher needs/);
  });

  test('rejects an engine clock that is not after the event window', () => {
    const raw = minimal();
    raw.now = '2026-10-03T09:00:05.000Z';
    expect(() => parseDataset(raw)).toThrow(/must be after base_time|not before now/);
  });

  test('rejects an event that happens after the engine clock', () => {
    const raw = minimal();
    raw.events = [
      {
        kind: 'conversation.message',
        project: 'alpha',
        offset_seconds: 7200,
        role: 'user',
        content: 'late',
      },
    ];
    expect(() => parseDataset(raw)).toThrow(/not before now/);
  });

  test('rejects a supersession whose loser and winner use the same matcher', () => {
    const raw = minimal();
    const matcher = { type: 'episodic', content_equals: 'Version: Node 20' };
    raw.supersessions = [{ loser: matcher, winner: matcher, reason: 'self' }];
    expect(() => parseDataset(raw)).toThrow(/cannot supersede itself/);
  });

  test('accepts a supersession with distinct matchers', () => {
    const raw = minimal();
    raw.supersessions = [
      {
        loser: { content_equals: 'Version: Node 20' },
        winner: { content_equals: 'Version: Node 22' },
        reason: 'upgrade',
      },
    ];
    expect(() => parseDataset(raw)).not.toThrow();
  });

  test('accepts an explicit.remember event and defaults its session', () => {
    const raw = minimal();
    raw.events = [
      {
        kind: 'explicit.remember',
        project: 'alpha',
        offset_seconds: 30,
        content: 'Decision: port 8081 for the API gateway',
      },
    ];
    const dataset = parseDataset(raw);
    expect(dataset.events[0]).toEqual({
      kind: 'explicit.remember',
      project: 'alpha',
      session: 'sess-main',
      offset_seconds: 30,
      content: 'Decision: port 8081 for the API gateway',
    });
  });

  test('rejects an explicit.remember event with an unknown declared type', () => {
    const raw = minimal();
    raw.events = [
      { kind: 'explicit.remember', project: 'alpha', offset_seconds: 30, content: 'remember', type: 'bogus' },
    ];
    expect(() => parseDataset(raw)).toThrow();
  });

  test('accepts a consolidation_pass opt-in and defaults its actor', () => {
    const raw = minimal();
    raw.consolidation_pass = {};
    const dataset = parseDataset(raw);
    expect(dataset.consolidation_pass?.actor).toBe('bench:consolidation');
    expect(dataset.consolidation_pass?.config).toBeUndefined();
  });

  test('forwards consolidation_pass config through the package schema and rejects an out-of-range threshold', () => {
    const raw = minimal();
    raw.consolidation_pass = { config: { decay: { archiveThreshold: 0.01 } } };
    expect(parseDataset(raw).consolidation_pass?.config?.decay?.archiveThreshold).toBe(0.01);

    const bad = minimal();
    bad.consolidation_pass = { config: { nearDuplicate: { cosineThreshold: 0.1 } } };
    expect(() => parseDataset(bad)).toThrow(/cosineThreshold/);
  });

  test('accepts a disputed contradiction group with both sides and no authority', () => {
    const raw = minimal();
    raw.facts = [
      { key: 'fact-a', description: 'a', scenario: 'other', match: { content_contains: 'PostgreSQL' } },
      { key: 'fact-b', description: 'b', scenario: 'other', match: { content_contains: 'Postgres' } },
    ];
    raw.contradictions = [
      {
        id: 'tie',
        query: 'q',
        project: 'alpha',
        outcome: 'disputed',
        contradicted: ['fact-a', 'fact-b'],
      },
    ];
    expect(parseDataset(raw).contradictions[0]?.outcome).toBe('disputed');
  });

  test('rejects a resolved contradiction group without an authority fact', () => {
    const raw = minimal();
    raw.contradictions = [
      { id: 'group', query: 'q', project: 'alpha', contradicted: ['fact-a'] },
    ];
    expect(() => parseDataset(raw)).toThrow(/requires the authority fact key/);
  });

  test('rejects a disputed contradiction group that declares an authority', () => {
    const raw = minimal();
    raw.facts = [
      { key: 'fact-a', description: 'a', scenario: 'other', match: { content_contains: 'PostgreSQL' } },
      { key: 'fact-b', description: 'b', scenario: 'other', match: { content_contains: 'Postgres' } },
    ];
    raw.contradictions = [
      { id: 'tie', query: 'q', project: 'alpha', outcome: 'disputed', authority: 'fact-a', contradicted: ['fact-a', 'fact-b'] },
    ];
    expect(() => parseDataset(raw)).toThrow(/full tie/);
  });

  test('rejects a disputed contradiction group with a single side', () => {
    const raw = minimal();
    raw.contradictions = [
      { id: 'tie', query: 'q', project: 'alpha', outcome: 'disputed', contradicted: ['fact-a'] },
    ];
    expect(() => parseDataset(raw)).toThrow(/both sides of the tie/);
  });

  test('rejects a contradiction group whose authority is also a contradicted fact', () => {
    const raw = minimal();
    raw.facts = [
      { key: 'fact-a', description: 'a', scenario: 'other', match: { content_contains: 'PostgreSQL' } },
      { key: 'fact-b', description: 'b', scenario: 'other', match: { content_contains: 'Postgres' } },
    ];
    raw.contradictions = [
      { id: 'group', query: 'q', project: 'alpha', authority: 'fact-a', contradicted: ['fact-a', 'fact-b'] },
    ];
    expect(() => parseDataset(raw)).toThrow(/cannot also be a contradicted fact/);
  });

  test('rejects a contradiction group referencing an unknown authority fact', () => {
    const raw = minimal();
    raw.contradictions = [
      { id: 'group', query: 'q', project: 'alpha', authority: 'ghost', contradicted: ['fact-a'] },
    ];
    expect(() => parseDataset(raw)).toThrow(/unknown fact 'ghost'/);
  });
});

describe('golden datasets', () => {
  test('every committed dataset validates and the directory resolves from the package', () => {
    expect(GOLDEN_DATASETS_DIR).toBe(resolve(import.meta.dir, '..', '..', 'datasets', 'golden'));
  });

  test('all committed golden datasets load', async () => {
    const datasets = await loadDatasets(GOLDEN_DATASETS_DIR);
    expect(datasets.length).toBeGreaterThanOrEqual(5);
    const ids = datasets.map((dataset) => dataset.id);
    expect(ids).toEqual([...ids].sort());
    for (const dataset of datasets) {
      expect(dataset.facts.length).toBeGreaterThan(0);
      expect(dataset.queries.length).toBeGreaterThan(0);
    }
  });

  test('the backlog M11.1 scenario buckets are all covered', async () => {
    const datasets = await loadDatasets(GOLDEN_DATASETS_DIR);
    const scenarios = new Set(datasets.flatMap((dataset) => dataset.facts.map((fact) => fact.scenario)));
    const required = [
      'repeated',
      'contradictory',
      'outdated',
      'project-scoped',
      'cross-project',
      'procedural',
      'failure-solution',
    ] as const;
    for (const scenario of required) {
      expect(scenarios.has(scenario)).toBe(true);
    }
  });
});
