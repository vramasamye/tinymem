/**
 * The authority-ordering matrix (memory-model.md §9, the M14 mission scope): explicit > decision
 * > newer > confidence, and a full tie that must NEVER be resolved by picking silently.
 */

import { describe, expect, test } from 'bun:test';

import { authorityViewOf, compareAuthority, mergeKeeperOrder } from './authority';
import type { AuthorityView } from './authority';
import { memoryFixture } from './testing';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-06-01T00:00:00.000Z';
const T2 = '2026-09-01T00:00:00.000Z';

function view(overrides: Partial<AuthorityView>): AuthorityView {
  return {
    explicit: false,
    isDecision: false,
    observedAt: T1,
    confidence: 0.7,
    id: '00000000-0000-7000-8000-000000000001',
    ...overrides,
  };
}

describe('authorityViewOf', () => {
  test('explicit user statements are recognized from the source kind', () => {
    expect(authorityViewOf(memoryFixture({ source_kind: 'explicit', content: 'Use Node 22' })).explicit).toBeTrue();
    expect(authorityViewOf(memoryFixture({ source_kind: 'conversation', content: 'Use Node 22' })).explicit).toBeFalse();
  });

  test('decision memories are recognized from the memory type', () => {
    expect(authorityViewOf(memoryFixture({ type: 'decision', content: 'Use bun' })).isDecision).toBeTrue();
    expect(authorityViewOf(memoryFixture({ type: 'episodic', content: 'ran bun' })).isDecision).toBeFalse();
  });
});

describe('compareAuthority — the ordering matrix', () => {
  test('an explicit user statement beats every non-explicit memory, even a newer decision', () => {
    const olderExplicit = view({ explicit: true, observedAt: T0, confidence: 0.5 });
    const newerDecision = view({ isDecision: true, observedAt: T2, confidence: 0.95 });
    expect(compareAuthority(olderExplicit, newerDecision)).toEqual({ kind: 'winner', winner: 'a', rule: 'explicit' });
    expect(compareAuthority(newerDecision, olderExplicit)).toEqual({ kind: 'winner', winner: 'b', rule: 'explicit' });
  });

  test('when both are explicit, a decision memory beats an observation', () => {
    const explicitDecision = view({ explicit: true, isDecision: true, observedAt: T0 });
    const explicitObservation = view({ explicit: true, observedAt: T2, confidence: 0.95 });
    expect(compareAuthority(explicitDecision, explicitObservation)).toEqual({
      kind: 'winner',
      winner: 'a',
      rule: 'decision',
    });
  });

  test('a decision beats an observation even when the observation is newer and more confident', () => {
    const decision = view({ isDecision: true, observedAt: T0, confidence: 0.5 });
    const observation = view({ observedAt: T2, confidence: 0.95 });
    expect(compareAuthority(decision, observation)).toEqual({ kind: 'winner', winner: 'a', rule: 'decision' });
    expect(compareAuthority(observation, decision)).toEqual({ kind: 'winner', winner: 'b', rule: 'decision' });
  });

  test('within the same class, the newer observation wins over higher confidence', () => {
    const older = view({ observedAt: T0, confidence: 0.95 });
    const newer = view({ observedAt: T2, confidence: 0.5 });
    expect(compareAuthority(older, newer)).toEqual({ kind: 'winner', winner: 'b', rule: 'newer' });
    expect(compareAuthority(newer, older)).toEqual({ kind: 'winner', winner: 'a', rule: 'newer' });
  });

  test('an identical observed_at falls through to confidence', () => {
    const low = view({ observedAt: T1, confidence: 0.4 });
    const high = view({ observedAt: T1, confidence: 0.9 });
    expect(compareAuthority(low, high)).toEqual({ kind: 'winner', winner: 'b', rule: 'confidence' });
    expect(compareAuthority(high, low)).toEqual({ kind: 'winner', winner: 'a', rule: 'confidence' });
  });

  test('a full tie is reported as a tie, never resolved by id or silently', () => {
    const a = view({ id: '00000000-0000-7000-8000-00000000000a' });
    const b = view({ id: '00000000-0000-7000-8000-00000000000b' });
    expect(compareAuthority(a, b)).toEqual({ kind: 'tie', rule: 'tie' });
    expect(compareAuthority(b, a)).toEqual({ kind: 'tie', rule: 'tie' });
  });

  test('both-explicit non-decision ties fall to newer, then confidence, then tie', () => {
    const bothExplicit = view({ explicit: true });
    expect(compareAuthority({ ...bothExplicit, observedAt: T0 }, { ...bothExplicit, observedAt: T2 })).toEqual({
      kind: 'winner',
      winner: 'b',
      rule: 'newer',
    });
    expect(compareAuthority(bothExplicit, { ...bothExplicit })).toEqual({ kind: 'tie', rule: 'tie' });
  });
});

describe('mergeKeeperOrder — the keeper pick among near-duplicates', () => {
  test('follows the same authority order (negative = first argument keeps)', () => {
    const explicit = view({ explicit: true, observedAt: T0 });
    const inferred = view({ observedAt: T2 });
    expect(mergeKeeperOrder(explicit, inferred)).toBeLessThan(0);
    expect(mergeKeeperOrder(inferred, explicit)).toBeGreaterThan(0);
  });

  test('an exact tie is broken deterministically by id (a merge is not a truth ruling)', () => {
    const a = view({ id: '00000000-0000-7000-8000-00000000000a' });
    const b = view({ id: '00000000-0000-7000-8000-00000000000b' });
    expect(mergeKeeperOrder(a, b)).toBeLessThan(0);
    expect(mergeKeeperOrder(b, a)).toBeGreaterThan(0);
  });

  test('is usable as an Array.sort comparator over a whole cluster (keeper first)', () => {
    const old = view({ observedAt: T0, id: '00000000-0000-7000-8000-000000000001' });
    const fresh = view({ observedAt: T2, id: '00000000-0000-7000-8000-000000000002' });
    const explicit = view({ explicit: true, observedAt: T1, id: '00000000-0000-7000-8000-000000000003' });
    expect([old, fresh, explicit].sort(mergeKeeperOrder)[0]).toBe(explicit);
  });
});
