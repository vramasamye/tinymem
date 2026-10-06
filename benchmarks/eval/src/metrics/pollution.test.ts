/**
 * Pure pollution-audit tests — no storage, no engine. Pins all three detectors (stale, duplicate,
 * unresolved contradiction), their scope rules, and the offline cosine proxy's determinism.
 */

import { describe, expect, test } from 'bun:test';

import {
  computePollutionAudit,
  contentCosine,
  contentVector,
  type DeclaredContradictionView,
  type PollutionMemoryView,
} from './pollution';

const NOW = '2026-10-03T10:00:00.000Z';

function memory(partial: Partial<PollutionMemoryView> & { id: string }): PollutionMemoryView {
  return {
    type: 'semantic',
    content: `content of ${partial.id}`,
    project_id: 'project-a',
    status: 'active',
    access_count: 0,
    last_accessed_at: null,
    ...partial,
  };
}

function audit(input: {
  memories?: PollutionMemoryView[];
  surfaced?: string[];
  groups?: DeclaredContradictionView[];
  now?: string;
  citationWindowDays?: number;
}) {
  return computePollutionAudit({
    now: input.now ?? NOW,
    memories: input.memories ?? [],
    surfacedIds: input.surfaced ?? [],
    contradictionGroups: input.groups ?? [],
    ...(input.citationWindowDays === undefined ? {} : { citationWindowDays: input.citationWindowDays }),
  });
}

describe('stale detection (archived but cited in the window)', () => {
  test('an archived memory cited inside the 30-day window counts; the boundary is inclusive', () => {
    const within = memory({ id: 'stale', status: 'archived', last_accessed_at: '2026-09-15T10:00:00.000Z' });
    const edge = memory({ id: 'edge', status: 'archived', last_accessed_at: '2026-09-03T10:00:00.000Z' });
    const record = audit({ memories: [within, edge] });
    expect(record.stale_cited.count).toBe(2);
    expect(record.stale_cited.window_days).toBe(30);
  });

  test('active-cited, archived-never-cited and archived-cited-long-ago do not count', () => {
    const record = audit({
      memories: [
        memory({ id: 'active', status: 'active', last_accessed_at: '2026-10-01T00:00:00.000Z' }),
        memory({ id: 'uncited', status: 'archived' }),
        memory({ id: 'old', status: 'archived', last_accessed_at: '2025-01-01T00:00:00.000Z' }),
      ],
    });
    expect(record.stale_cited.count).toBe(0);
  });

  test('a citation in the future of the dataset clock never counts', () => {
    const record = audit({
      memories: [memory({ id: 'future', status: 'archived', last_accessed_at: '2026-11-01T00:00:00.000Z' })],
    });
    expect(record.stale_cited.count).toBe(0);
  });
});

describe('duplicate detection (surfaced, same type + scope, cosine ≥ 0.97)', () => {
  const nearA = memory({ id: 'a', type: 'procedural', content: 'Always run bun install before bun test in CI.' });
  const nearB = memory({ id: 'b', type: 'procedural', content: 'always run bun install before bun test in ci' });
  const similar = memory({ id: 'similar', type: 'procedural', content: 'Run the linter with bun run lint before every commit.' });
  const otherType = memory({ id: 'other-type', type: 'decision', content: 'Always run bun install before bun test in CI.' });
  const otherProject = memory({ id: 'other-scope', type: 'procedural', project_id: 'project-b', content: 'Always run bun install before bun test in CI.' });

  test('the case-only near-duplicate pair is cosine-identical and counts once, ordered by content', () => {
    const record = audit({ memories: [nearA, nearB, similar], surfaced: ['a', 'b', 'similar'] });
    expect(record.duplicates.count).toBe(1);
    expect(record.duplicates.pairs[0]).toMatchObject({ type: 'procedural', cosine: 1 });
    // The lowercase content sorts first — deterministic, diff-stable findings.
    expect(record.duplicates.pairs[0]!.a).toContain('always run');
    expect(record.duplicates.pairs[0]!.b).toContain('Always run');
  });

  test('scope rules mirror the M14 merge gate: different type or project never pairs', () => {
    const record = audit({ memories: [nearB, otherType, otherProject], surfaced: ['b', 'other-type', 'other-scope'] });
    expect(record.duplicates.count).toBe(0);
  });

  test('only memories that surfaced in retrieval are scanned', () => {
    const record = audit({ memories: [nearA, nearB], surfaced: ['a'] });
    expect(record.duplicates.count).toBe(0);
  });

  test('distinct wording stays below the 0.97 gate', () => {
    expect(contentCosine(contentVector(nearA.content), contentVector(similar.content))).toBeLessThan(0.97);
  });

  test('contentVector is deterministic and case-insensitive over alphanumeric runs', () => {
    expect([...contentVector('Hello, World!').entries()]).toEqual([...contentVector('hello world').entries()]);
  });
});

describe('unresolved-contradiction detection (declared sides left unmarked)', () => {
  test('a resolved group whose contradicted side stayed active counts; superseded does not', () => {
    const record = audit({
      memories: [
        memory({ id: 'loser-active', status: 'active' }),
        memory({ id: 'loser-superseded', status: 'superseded' }),
      ],
      groups: [
        { authority_id: 'w1', contradicted_ids: ['loser-active'], outcome: 'resolved' },
        { authority_id: 'w2', contradicted_ids: ['loser-superseded'], outcome: 'resolved' },
      ],
    });
    expect(record.unresolved_contradictions.count).toBe(1);
    expect(record.unresolved_contradictions.memories[0]).toMatchObject({
      status: 'active',
      expected_mark: 'superseded',
    });
  });

  test('a disputed group expects both sides disputed', () => {
    const record = audit({
      memories: [memory({ id: 'tie-a', status: 'disputed' }), memory({ id: 'tie-b', status: 'active' })],
      groups: [{ authority_id: null, contradicted_ids: ['tie-a', 'tie-b'], outcome: 'disputed' }],
    });
    expect(record.unresolved_contradictions.count).toBe(1);
    expect(record.unresolved_contradictions.memories[0]).toMatchObject({
      status: 'active',
      expected_mark: 'disputed',
    });
  });

  test('one memory in two groups counts once', () => {
    const record = audit({
      memories: [memory({ id: 'shared', status: 'active' })],
      groups: [
        { authority_id: 'w1', contradicted_ids: ['shared'], outcome: 'resolved' },
        { authority_id: null, contradicted_ids: ['shared'], outcome: 'disputed' },
      ],
    });
    expect(record.unresolved_contradictions.count).toBe(1);
  });

  test('a contradiction side missing from the corpus view fails loudly', () => {
    expect(() =>
      audit({ groups: [{ authority_id: 'x', contradicted_ids: ['ghost'], outcome: 'resolved' }] }),
    ).toThrow(/not in the corpus view/);
  });
});

describe('finding labels', () => {
  test('committed findings carry content prefixes, never uuids', () => {
    const long = 'x'.repeat(80);
    const record = audit({
      memories: [memory({ id: 'long', content: long, status: 'archived', last_accessed_at: NOW })],
    });
    expect(record.stale_cited.memories[0]!.label).toHaveLength(65); // 64 chars + ellipsis
    expect(record.stale_cited.memories[0]!.label.endsWith('…')).toBe(true);
  });
});
