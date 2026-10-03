import { describe, expect, test } from 'bun:test';

import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  actionFor,
  assertTransition,
  canTransition,
  creationAudit,
  transition,
} from './status-machine';
import type { MemoryStatus } from './types';

const ALL_STATUSES: MemoryStatus[] = ['active', 'stale', 'superseded', 'disputed', 'archived'];

describe('status transition machine (memory-model.md §4)', () => {
  test('every allowed transition passes and produces an audit record', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
        const result = transition({
          memoryId: '0192f3c0-0000-7000-8000-000000000001',
          from,
          to,
          actor: 'job:decay',
          reason: 'unit test',
          at: '2026-10-03T00:00:00.000Z',
        });
        expect(result.from).toBe(from);
        expect(result.to).toBe(to);
        const audit = result.audit;
        expect(audit.memory_id).toBe('0192f3c0-0000-7000-8000-000000000001');
        expect(audit.action).toBe(result.action);
        expect(audit.from_status).toBe(from);
        expect(audit.to_status).toBe(to);
        expect(audit.actor).toBe('job:decay');
        expect(audit.at).toBe('2026-10-03T00:00:00.000Z');
        expect(audit.details.reason).toBe('unit test');
      }
    }
  });

  test('every non-listed transition is rejected (one-directional except the documented exceptions)', () => {
    const rejected: Array<[MemoryStatus, MemoryStatus]> = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) {
          expect(canTransition(from, to)).toBe(false);
          rejected.push([from, to]);
          continue;
        }
        if (ALLOWED_TRANSITIONS[from].includes(to)) continue;
        expect(canTransition(from, to)).toBe(false);
        rejected.push([from, to]);
      }
    }
    // sanity: the machine is not degenerate — some transitions ARE rejected
    expect(rejected.length).toBeGreaterThan(0);
    // the documented exceptions exist:
    expect(canTransition('stale', 'active')).toBe(true); // re-verified
    expect(canTransition('archived', 'active')).toBe(true); // manual restore
    expect(canTransition('disputed', 'active')).toBe(true); // resolution
    expect(canTransition('disputed', 'superseded')).toBe(true); // resolution
    expect(canTransition('disputed', 'stale')).toBe(true); // disputed → * per the rules text
    // and the protected invariants:
    expect(canTransition('superseded', 'active')).toBe(false); // history is never un-done
    expect(canTransition('active', 'active')).toBe(false); // no self transitions
  });

  test('assertTransition throws InvalidTransitionError carrying from/to', () => {
    expect(() => assertTransition('superseded', 'active')).toThrow(InvalidTransitionError);
    try {
      assertTransition('superseded', 'active');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const e = error as InvalidTransitionError;
      expect(e.from).toBe('superseded');
      expect(e.to).toBe('active');
      expect(e.message).toContain('superseded');
      expect(e.message).toContain('active');
    }
  });

  test('audit actions map onto the memory_events action vocabulary', () => {
    expect(actionFor(null, 'active')).toBe('created');
    expect(actionFor('active', null)).toBe('purged');
    expect(actionFor('active', 'archived')).toBe('archived');
    expect(actionFor('stale', 'archived')).toBe('archived');
    expect(actionFor('archived', 'active')).toBe('restored');
    expect(actionFor('stale', 'active')).toBe('restored');
    expect(actionFor('active', 'superseded')).toBe('status_changed');
    expect(actionFor('active', 'stale')).toBe('status_changed');
    expect(actionFor('disputed', 'superseded')).toBe('status_changed');
  });

  test('transition details merge caller details with the reason', () => {
    const result = transition({
      memoryId: '0192f3c0-0000-7000-8000-000000000002',
      from: 'active',
      to: 'superseded',
      actor: 'job:consolidate',
      details: { winner_id: 'w', reason: 'authoritative reason wins' },
      reason: 'newer fact wins',
    });
    expect(result.audit.details.winner_id).toBe('w');
    // explicit details.reason wins over the shorthand
    expect(result.audit.details.reason).toBe('authoritative reason wins');
  });

  test('creationAudit produces the created audit row', () => {
    const audit = creationAudit('0192f3c0-0000-7000-8000-000000000003', 'active', 'system');
    expect(audit.action).toBe('created');
    expect(audit.from_status).toBeNull();
    expect(audit.to_status).toBe('active');
    expect(audit.actor).toBe('system');
    expect(audit.details).toEqual({});
    expect(Number.isNaN(Date.parse(audit.at))).toBe(false);
  });

  test('the decay sweep edge exists for every live state (archived reachable from any state)', () => {
    for (const from of ['active', 'stale', 'superseded', 'disputed'] as MemoryStatus[]) {
      expect(canTransition(from, 'archived')).toBe(true);
    }
  });
});
