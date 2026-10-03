import { describe, expect, test } from 'bun:test';

import { isCurrentlyValid, isValidAt, CURRENT_QUERY_STATUSES } from './temporal';
import type { TemporalMemory } from './temporal';

function memory(overrides: Partial<TemporalMemory> = {}): TemporalMemory {
  return {
    status: 'active',
    valid_from: '2024-01-01T00:00:00.000Z',
    valid_until: null,
    ...overrides,
  };
}

describe('temporal semantics (memory-model.md §5)', () => {
  test('valid_from ≤ at < valid_until (half-open window)', () => {
    const m = memory({ valid_until: '2025-01-01T00:00:00.000Z' });
    expect(isValidAt(m, '2024-06-01T00:00:00.000Z')).toBe(true);
    expect(isValidAt(m, '2023-12-31T23:59:59.999Z')).toBe(false); // before window
    expect(isValidAt(m, '2025-01-01T00:00:00.000Z')).toBe(false); // valid_until is exclusive
  });

  test('NULL valid_until = open-ended validity', () => {
    const m = memory();
    expect(isValidAt(m, '2030-01-01T00:00:00.000Z')).toBe(true);
  });

  test('isCurrentlyValid requires a live status AND an open window', () => {
    const open = memory();
    expect(isCurrentlyValid(open, '2026-10-03T00:00:00.000Z')).toBe(true);
    expect(isCurrentlyValid(open, '2023-01-01T00:00:00.000Z')).toBe(false); // not yet valid

    const closed = memory({ valid_until: '2025-01-01T00:00:00.000Z' });
    expect(isCurrentlyValid(closed, '2026-10-03T00:00:00.000Z')).toBe(false);

    const superseded = memory({ status: 'superseded' });
    expect(isCurrentlyValid(superseded, '2026-10-03T00:00:00.000Z')).toBe(false);

    const stale = memory({ status: 'stale' });
    expect(isCurrentlyValid(stale, '2026-10-03T00:00:00.000Z')).toBe(true); // stale IS current queryable
  });

  test('point-in-time validity is a pure window predicate — superseded memories still valid at past t', () => {
    const node20 = memory({ status: 'superseded', valid_until: '2025-06-01T00:00:00.000Z' });
    expect(isValidAt(node20, '2025-01-01T00:00:00.000Z')).toBe(true);
    expect(isValidAt(node20, '2025-06-01T00:00:00.000Z')).toBe(false);
  });

  test('invalid timestamps throw (fail loudly, not silently)', () => {
    expect(() => isValidAt(memory(), 'not-a-date')).toThrow(TypeError);
  });

  test('the current query mode statuses are active and stale', () => {
    expect(CURRENT_QUERY_STATUSES).toEqual(['active', 'stale']);
  });
});
