/**
 * The heuristic contradiction detector: same scope + same attribute template + differing scalar
 * values + overlapping validity = a value conflict (the "Version: Node 20" vs "Version: Node 22"
 * shape). Same template with equal values, different templates, different scopes, or disjoint
 * validity windows are NOT conflicts.
 */

import { describe, expect, test } from 'bun:test';

import { contradictionTemplate, contradictsHeuristically, numericValues, supersessionValidUntil, temporalOverlap } from './contradiction';
import { memoryFixture } from './testing';

const PROJECT = '00000000-0000-7000-8002-000000000001';
const OTHER_PROJECT = '00000000-0000-7000-8002-000000000002';

describe('contradictionTemplate', () => {
  test('replaces numeric values with a placeholder and normalizes case and whitespace', () => {
    expect(contradictionTemplate('Version: Node 22')).toBe('version: node <#>');
    expect(contradictionTemplate('version:   NODE 22')).toBe('version: node <#>');
    expect(contradictionTemplate('Version: Node 22 LTS')).toBe('version: node <#> lts');
  });

  test('collapses decimal and multi-part versions into one placeholder', () => {
    expect(contradictionTemplate('Runs PostgreSQL 16.2')).toBe('runs postgresql <#>');
    expect(contradictionTemplate('Runs PostgreSQL 16.2.1')).toBe('runs postgresql <#>');
  });

  test('leaves value-free statements unchanged apart from normalization', () => {
    expect(contradictionTemplate('Uses bun for tests')).toBe('uses bun for tests');
    expect(contradictionTemplate('Version: Node')).toBe('version: node');
  });
});

describe('numericValues', () => {
  test('extracts the scalar values in order', () => {
    expect(numericValues('Version: Node 22')).toEqual(['22']);
    expect(numericValues('Deploys to 3 regions on port 8080')).toEqual(['3', '8080']);
    expect(numericValues('Runs PostgreSQL 16.2.1')).toEqual(['16.2.1']);
    expect(numericValues('Uses bun for tests')).toEqual([]);
  });
});

describe('temporalOverlap', () => {
  test('two open windows overlap', () => {
    const a = memoryFixture({ valid_from: '2026-01-01T00:00:00.000Z' });
    const b = memoryFixture({ valid_from: '2026-06-01T00:00:00.000Z' });
    expect(temporalOverlap(a, b)).toBeTrue();
  });

  test('disjoint windows do not overlap (historical succession is not a conflict)', () => {
    const old = memoryFixture({
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: '2026-06-01T00:00:00.000Z',
    });
    const next = memoryFixture({ valid_from: '2026-06-01T00:00:00.000Z' });
    expect(temporalOverlap(old, next)).toBeFalse();
  });
});

describe('supersessionValidUntil', () => {
  test("closes the loser's window at the winner's observation when it falls inside the window", () => {
    // The Node 20 → 22 chain shape: the newer fact was observed inside the older fact's window.
    expect(supersessionValidUntil('2026-06-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z')).toBe(
      '2026-06-10T00:00:00.000Z',
    );
  });

  test("closes the loser's window at its own start when the winner predates it (zero-width: never valid)", () => {
    // An OLDER explicit user statement beating a newer inference: the wrong claim was never valid.
    expect(supersessionValidUntil('2026-04-01T00:00:00.000Z', '2026-09-26T00:00:00.000Z')).toBe(
      '2026-09-26T00:00:00.000Z',
    );
  });

  test('an equal-time winner (confidence decided, not time) also closes the loser zero-width', () => {
    expect(supersessionValidUntil('2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')).toBe(
      '2026-09-27T00:00:00.000Z',
    );
  });
});

describe('contradictsHeuristically', () => {
  test('the Node 20 vs Node 22 shape is a contradiction', () => {
    const node20 = memoryFixture({
      content: 'Version: Node 20',
      project_id: PROJECT,
      observed_at: '2026-01-10T00:00:00.000Z',
    });
    const node22 = memoryFixture({
      content: 'Version: Node 22',
      project_id: PROJECT,
      observed_at: '2026-06-10T00:00:00.000Z',
    });
    expect(contradictsHeuristically(node20, node22)).toBeTrue();
    expect(contradictsHeuristically(node22, node20)).toBeTrue();
  });

  test('different subjects with the same template shape are not contradictions', () => {
    const node = memoryFixture({ content: 'Version: Node 22', project_id: PROJECT });
    const postgres = memoryFixture({ content: 'Version: PostgreSQL 16', project_id: PROJECT });
    expect(contradictsHeuristically(node, postgres)).toBeFalse();
  });

  test('the same value restated is not a contradiction', () => {
    const a = memoryFixture({ content: 'Version: Node 22', project_id: PROJECT });
    const b = memoryFixture({ content: 'Version: Node 22', project_id: PROJECT });
    expect(contradictsHeuristically(a, b)).toBeFalse();
  });

  test('value-free restatements are not contradictions', () => {
    const a = memoryFixture({ content: 'Uses bun (commit abc)', project_id: PROJECT });
    const b = memoryFixture({ content: 'Uses bun (commit def)', project_id: PROJECT });
    expect(contradictsHeuristically(a, b)).toBeFalse();
  });

  test('different projects never contradict each other', () => {
    const a = memoryFixture({ content: 'Version: Node 20', project_id: PROJECT });
    const b = memoryFixture({ content: 'Version: Node 22', project_id: OTHER_PROJECT });
    expect(contradictsHeuristically(a, b)).toBeFalse();
  });

  test('user-scope and project-scope memories are different scopes', () => {
    const scoped = memoryFixture({ content: 'Version: Node 20', project_id: PROJECT });
    const global = memoryFixture({ content: 'Version: Node 22', project_id: null });
    expect(contradictsHeuristically(scoped, global)).toBeFalse();
  });

  test('evolving counts are value conflicts (the newer value supersedes)', () => {
    const a = memoryFixture({
      content: 'Recurring command: `bun test` (used 3 times)',
      project_id: PROJECT,
      observed_at: '2026-02-01T00:00:00.000Z',
    });
    const b = memoryFixture({
      content: 'Recurring command: `bun test` (used 5 times)',
      project_id: PROJECT,
      observed_at: '2026-05-01T00:00:00.000Z',
    });
    expect(contradictsHeuristically(a, b)).toBeTrue();
  });

  test('memories with disjoint validity windows never contradict', () => {
    const old = memoryFixture({
      content: 'Version: Node 20',
      project_id: PROJECT,
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: '2026-06-01T00:00:00.000Z',
    });
    const next = memoryFixture({
      content: 'Version: Node 22',
      project_id: PROJECT,
      valid_from: '2026-06-01T00:00:00.000Z',
    });
    expect(contradictsHeuristically(old, next)).toBeFalse();
  });

  test('cross-type value conflicts are detected (a decision vs an observation)', () => {
    const observation = memoryFixture({
      type: 'episodic',
      content: 'Version: Node 20',
      project_id: PROJECT,
      observed_at: '2026-03-01T00:00:00.000Z',
    });
    const decision = memoryFixture({
      type: 'decision',
      content: 'Version: Node 22',
      project_id: PROJECT,
      observed_at: '2026-02-01T00:00:00.000Z',
    });
    expect(contradictsHeuristically(observation, decision)).toBeTrue();
  });
});
