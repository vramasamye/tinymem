/**
 * Stage-3 unit tests — the temporal policy resolutions and the hard filter predicate. Pure.
 */

import { describe, expect, test } from 'bun:test';

import { passesTemporalFilter, resolveTemporalPolicy, policyAt } from './temporal';

const NOW = '2027-01-15T00:00:00.000Z';

const active = { status: 'active' as const, validFrom: '2024-01-01T00:00:00.000Z', validUntil: undefined };
const stale = { status: 'stale' as const, validFrom: '2024-01-01T00:00:00.000Z', validUntil: undefined };
const superseded = {
  status: 'superseded' as const,
  validFrom: '2024-01-15T00:00:00.000Z',
  validUntil: '2025-06-01T00:00:00.000Z',
};
const disputed = { status: 'disputed' as const, validFrom: '2024-01-01T00:00:00.000Z', validUntil: undefined };
const archived = { status: 'archived' as const, validFrom: '2024-01-01T00:00:00.000Z', validUntil: undefined };
const future = { status: 'active' as const, validFrom: '2028-01-01T00:00:00.000Z', validUntil: undefined };

describe('resolveTemporalPolicy', () => {
  test('default = current: {active, stale} only, disputed labeled only when included', () => {
    const policy = resolveTemporalPolicy({}, { intent: 'fact' }, NOW);
    expect(policy.resolution).toEqual({ kind: 'current', at: NOW, mode: 'current' });
    expect(policy.statuses.has('active')).toBe(true);
    expect(policy.statuses.has('stale')).toBe(true);
    expect(policy.statuses.has('superseded')).toBe(false);
    expect(policy.statuses.has('disputed')).toBe(false);
    expect(policy.labelDisputed).toBe(false);
  });

  test('include extends the current status set and flags disputed labeling', () => {
    const policy = resolveTemporalPolicy({ include: ['superseded', 'disputed'] }, { intent: 'fact' }, NOW);
    expect(policy.statuses.has('superseded')).toBe(true);
    expect(policy.statuses.has('disputed')).toBe(true);
    expect(policy.labelDisputed).toBe(true);
  });

  test('as_of wins over everything → point-in-time, superseded/archived included, disputed excluded', () => {
    const policy = resolveTemporalPolicy(
      { as_of: '2025-01-01T00:00:00.000Z', temporal_mode: 'current' },
      { intent: 'history', time_scope: { from: '2020-01-01T00:00:00.000Z', until: '2021-01-01T00:00:00.000Z', mode: 'historical' } },
      NOW,
    );
    expect(policy.resolution).toEqual({ kind: 'point', at: '2025-01-01T00:00:00.000Z', mode: 'historical' });
    expect(policy.statuses.has('superseded')).toBe(true);
    expect(policy.statuses.has('archived')).toBe(true);
    expect(policy.statuses.has('disputed')).toBe(false);
  });

  test('history intent without a range → full history (open past → now)', () => {
    const policy = resolveTemporalPolicy({}, { intent: 'history' }, NOW);
    expect(policy.resolution).toEqual({ kind: 'overlap', from: null, until: NOW, mode: 'historical' });
    expect(policy.statuses.has('superseded')).toBe(true);
  });

  test('historical mode with a parsed range → overlap window', () => {
    const policy = resolveTemporalPolicy(
      {},
      { intent: 'history', time_scope: { from: '2025-01-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z', mode: 'historical' } },
      NOW,
    );
    expect(policy.resolution).toEqual({
      kind: 'overlap',
      from: '2025-01-01T00:00:00.000Z',
      until: '2026-01-01T00:00:00.000Z',
      mode: 'historical',
    });
  });

  test('include: ["disputed"] re-admits disputed to point-in-time results (labeled)', () => {
    const policy = resolveTemporalPolicy(
      { as_of: '2025-01-01T00:00:00.000Z', include: ['disputed'] },
      { intent: 'fact' },
      NOW,
    );
    expect(policy.statuses.has('disputed')).toBe(true);
    expect(policy.labelDisputed).toBe(true);
  });

  test('policyAt resolves the edge-validity instant for every resolution kind', () => {
    expect(policyAt(resolveTemporalPolicy({}, { intent: 'fact' }, NOW), NOW)).toBe(NOW);
    expect(
      policyAt(resolveTemporalPolicy({ as_of: '2025-03-01T00:00:00.000Z' }, { intent: 'fact' }, NOW), NOW),
    ).toBe('2025-03-01T00:00:00.000Z');
    const overlap = resolveTemporalPolicy(
      {},
      { intent: 'history', time_scope: { mode: 'historical', from: '2025-01-01T00:00:00.000Z' } },
      NOW,
    );
    expect(policyAt(overlap, NOW)).toBe(NOW); // open-ended window → its far edge is now
  });
});

describe('passesTemporalFilter (the hard gate)', () => {
  const currentPolicy = resolveTemporalPolicy({}, { intent: 'fact' }, NOW);

  test('current: live statuses pass, everything else is invisible', () => {
    expect(passesTemporalFilter(active, currentPolicy)).toBe(true);
    expect(passesTemporalFilter(stale, currentPolicy)).toBe(true);
    expect(passesTemporalFilter(superseded, currentPolicy)).toBe(false);
    expect(passesTemporalFilter(disputed, currentPolicy)).toBe(false);
    expect(passesTemporalFilter(archived, currentPolicy)).toBe(false);
    expect(passesTemporalFilter(future, currentPolicy)).toBe(false);
  });

  test('current with include: superseded still requires an open window (no resurrection)', () => {
    const policy = resolveTemporalPolicy({ include: ['superseded'] }, { intent: 'fact' }, NOW);
    // Node 20's window closed at supersession — include alone cannot resurrect it.
    expect(passesTemporalFilter(superseded, policy)).toBe(false);
    const openSuperseded = { status: 'superseded' as const, validFrom: '2024-01-01T00:00:00.000Z', validUntil: undefined };
    expect(passesTemporalFilter(openSuperseded, policy)).toBe(true);
  });

  test('point-in-time: the Node 20/22 guarantee', () => {
    const at2025 = resolveTemporalPolicy({ as_of: '2025-01-01T00:00:00.000Z' }, { intent: 'fact' }, NOW);
    expect(passesTemporalFilter(superseded, at2025)).toBe(true); // Node 20 was true then
    const node22 = { status: 'active' as const, validFrom: '2025-06-01T00:00:00.000Z', validUntil: undefined };
    expect(passesTemporalFilter(node22, at2025)).toBe(false); // not yet valid
    expect(passesTemporalFilter(node22, currentPolicy)).toBe(true); // valid now
  });

  test('overlap: memories whose window merely intersects the range pass', () => {
    const in2025 = resolveTemporalPolicy(
      {},
      { intent: 'history', time_scope: { from: '2025-01-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z', mode: 'historical' } },
      NOW,
    );
    // Valid 2024-01-15 → 2025-06-01: overlaps 2025 ✓
    expect(passesTemporalFilter(superseded, in2025)).toBe(true);
    // Valid from 2025-06-01, still open: overlaps 2025 ✓
    const node22 = { status: 'active' as const, validFrom: '2025-06-01T00:00:00.000Z', validUntil: undefined };
    expect(passesTemporalFilter(node22, in2025)).toBe(true);
    // Ended before the range began ✗
    const tooEarly = {
      status: 'superseded' as const,
      validFrom: '2023-01-01T00:00:00.000Z',
      validUntil: '2024-06-01T00:00:00.000Z',
    };
    expect(passesTemporalFilter(tooEarly, in2025)).toBe(false);
    // Starts after the range ends ✗
    const tooLate = { status: 'active' as const, validFrom: '2026-06-01T00:00:00.000Z', validUntil: undefined };
    expect(passesTemporalFilter(tooLate, in2025)).toBe(false);
  });

  test('full history: anything already started, all non-disputed statuses', () => {
    const policy = resolveTemporalPolicy({}, { intent: 'history' }, NOW);
    expect(passesTemporalFilter(superseded, policy)).toBe(true);
    expect(passesTemporalFilter(archived, policy)).toBe(true);
    expect(passesTemporalFilter(future, policy)).toBe(false); // not yet started
    expect(passesTemporalFilter(disputed, policy)).toBe(false); // disputed excluded by default
  });
});
