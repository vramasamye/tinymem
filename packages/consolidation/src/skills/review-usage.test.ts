/**
 * The review queue (`loadSkillForReview`) and the usage hook (M15 AC5) — the read-side
 * contracts: the review bundle's markdown is byte-identical to the bytes `promote` writes (the
 * canonical form holds end to end), unresolved source failures are REPORTED and folded into
 * the document, and the usage fold is read-only with its documented mention heuristic.
 */

import { describe, expect, test } from 'bun:test';

import type { MemoryEventRecord, MemoryRecord, SkillRecord, Store } from '@onememory/core';

import { FakeSkillStore, qualifiedPair, fixtureUuid } from './fixtures';
import { loadSkillForReview } from './review';
import { runSkillGeneration } from './run';
import { collectSkillUsage, mentionsSkill, usageSnapshotOf } from './usage';

const NOW = new Date('2026-03-06T09:00:00.000Z');

/** A minimal read-side Store: `getMemory` + `listMemoryEvents` over fixture maps. */
function fakeReadStore(options: {
  memories: Map<string, MemoryRecord>;
  events?: MemoryEventRecord[];
}): Pick<Store, 'getMemory' | 'listMemoryEvents'> {
  return {
    async getMemory(id: string) {
      return options.memories.get(id) ?? null;
    },
    async listMemoryEvents(id: string) {
      return options.events?.filter((event) => event.memory_id === id) ?? [];
    },
  };
}

/** Hydrated failure memories keyed by id — what the review path reads back through getMemory. */
function hydratedFailureMemories(): Map<string, MemoryRecord> {
  const memories = new Map<string, MemoryRecord>();
  for (const recurrence of qualifiedPair()) {
    memories.set(recurrence.memory.id, {
      ...recurrence.memory,
      payload: {
        problem: recurrence.problem,
        context: recurrence.context,
        ...(recurrence.root_cause === null ? {} : { root_cause: recurrence.root_cause }),
        ...(recurrence.solution === null ? {} : { solution: recurrence.solution }),
        ...(recurrence.verification === null ? {} : { verification: recurrence.verification }),
        status: 'solved',
        signature_hash: recurrence.signature_hash,
        first_seen_at: recurrence.first_seen_at,
        last_seen_at: recurrence.last_seen_at,
        occurrence_count: recurrence.occurrence_count,
      },
    });
  }
  return memories;
}

describe('loadSkillForReview', () => {
  async function generatedWorld(): Promise<{ skills: FakeSkillStore; record: SkillRecord; markdown: string }> {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    const report = await runSkillGeneration({ skills, now: () => NOW });
    const record = report.candidates.records[0]!;
    return { skills, record: (await skills.getSkill(record.skill_id))!, markdown: record.markdown };
  }

  test('unknown skill id → null (the caller reports not-found)', async () => {
    const skills = new FakeSkillStore();
    const bundle = await loadSkillForReview({ skills, store: fakeReadStore({ memories: new Map() }), skillId: fixtureUuid() });
    expect(bundle).toBeNull();
  });

  test('the rebuilt markdown is byte-identical to the generation-time artifact (canonical form)', async () => {
    const { skills, record, markdown } = await generatedWorld();
    const bundle = await loadSkillForReview({
      skills,
      store: fakeReadStore({ memories: hydratedFailureMemories() }),
      skillId: record.id,
    });
    expect(bundle).not.toBeNull();
    expect(bundle!.skill.id).toBe(record.id);
    expect(bundle!.failures).toHaveLength(2);
    expect(bundle!.unresolved_failure_ids).toEqual([]);
    expect(bundle!.markdown).toBe(markdown); // EXACT bytes — review prints what promote writes
  });

  test('a source failure that cannot be re-read is REPORTED, never silently skipped', async () => {
    const { skills, record } = await generatedWorld();
    const memories = hydratedFailureMemories();
    const doomed = [...memories.keys()][0]!;
    memories.delete(doomed); // e.g. purged between generation and review

    const bundle = await loadSkillForReview({
      skills,
      store: fakeReadStore({ memories }),
      skillId: record.id,
    });
    expect(bundle!.unresolved_failure_ids).toEqual([doomed]);
    expect(bundle!.failures).toHaveLength(1);
    expect(bundle!.markdown).toContain('could not be re-read');
    expect(bundle!.markdown).toContain('## Known failure modes');
    expect(bundle!.markdown).toContain('1 source failure could not be');
  });

  test('the audit trail rides the same memory_events read path as every memory', async () => {
    const { skills, record } = await generatedWorld();
    const audit: MemoryEventRecord[] = [
      {
        id: fixtureUuid(),
        memory_id: record.id,
        action: 'created',
        from_status: null,
        to_status: null,
        actor: 'job:skillify',
        details: { kind: 'skill', name: record.name },
        at: '2026-03-06T09:00:00.000Z',
      },
      {
        id: fixtureUuid(),
        memory_id: record.id,
        action: 'status_changed',
        from_status: null,
        to_status: null,
        actor: 'user:1',
        details: { kind: 'skill', from: 'candidate', to: 'verified' },
        at: '2026-03-06T10:00:00.000Z',
      },
    ];
    const bundle = await loadSkillForReview({
      skills,
      store: fakeReadStore({ memories: hydratedFailureMemories(), events: audit }),
      skillId: record.id,
    });
    expect(bundle!.audit).toHaveLength(2);
    expect(bundle!.audit[0]!.action).toBe('created');
    expect(bundle!.audit[1]!.actor).toBe('user:1');
  });
});

// ---------------------------------------------------------------------------
// The usage hook (AC5 — read side only)
// ---------------------------------------------------------------------------

describe('mentionsSkill', () => {
  const skill = { name: 'cloud-run-deploy-failed-with-oom', path: 'skills/cloud-run-deploy-failed-with-oom/SKILL.md' };

  test('a payload referencing the path or the name counts as a mention', () => {
    expect(
      mentionsSkill(skill, { id: '1', kind: 'conversation.message', session_id: 's1', occurred_at: '2026-03-06T09:00:00.000Z', payload: { content: 'followed skills/cloud-run-deploy-failed-with-oom/SKILL.md' } }),
    ).toBeTrue();
    expect(
      mentionsSkill(skill, { id: '2', kind: 'conversation.message', session_id: 's1', occurred_at: '2026-03-06T09:00:00.000Z', payload: { content: 'the cloud-run-deploy-failed-with-oom skill worked' } }),
    ).toBeTrue();
  });

  test('unrelated payloads never count; short names never substring-match prose', () => {
    expect(
      mentionsSkill(skill, { id: '3', kind: 'conversation.message', session_id: 's1', occurred_at: '2026-03-06T09:00:00.000Z', payload: { content: 'unrelated conversation' } }),
    ).toBeFalse();
    // A sub-6-char name is under the mention floor — only its PATH can match.
    expect(
      mentionsSkill({ name: 'oom', path: 'skills/oom/SKILL.md' }, { id: '4', kind: 'conversation.message', session_id: null, occurred_at: '2026-03-06T09:00:00.000Z', payload: { content: 'the oom error came back' } }),
    ).toBeFalse();
    expect(
      mentionsSkill({ name: 'oom', path: 'skills/oom/SKILL.md' }, { id: '5', kind: 'conversation.message', session_id: null, occurred_at: '2026-03-06T09:00:00.000Z', payload: { content: 'see skills/oom/SKILL.md' } }),
    ).toBeTrue();
  });
});

describe('usageSnapshotOf', () => {
  const skill: SkillRecord = {
    id: fixtureUuid(),
    name: 'cloud-run-deploy-failed-with-oom',
    description: 'Fix: OOM.',
    version: '1.0.0',
    status: 'verified',
    source: { failure_ids: [] },
    verification: { evidence: [], verified_at: '2026-03-06T09:00:00.000Z' },
    path: 'skills/cloud-run-deploy-failed-with-oom/SKILL.md',
    usage_count: 3,
    success_rate: 0.8,
    created_at: '2026-03-06T09:00:00.000Z',
    updated_at: '2026-03-06T09:00:00.000Z',
  };

  test('folds mentions, distinct sessions, and the most recent use — counters stay read-only', () => {
    const snapshot = usageSnapshotOf(skill, [
      { id: 'e1', kind: 'conversation.message', session_id: 'sess-a', occurred_at: '2026-03-07T09:00:00.000Z', payload: { content: 'used cloud-run-deploy-failed-with-oom' } },
      { id: 'e2', kind: 'conversation.message', session_id: 'sess-a', occurred_at: '2026-03-08T09:00:00.000Z', payload: { content: 'cloud-run-deploy-failed-with-oom again' } },
      { id: 'e3', kind: 'conversation.message', session_id: 'sess-b', occurred_at: '2026-03-09T09:00:00.000Z', payload: { content: 'followed skills/cloud-run-deploy-failed-with-oom/SKILL.md' } },
      { id: 'e4', kind: 'conversation.message', session_id: 'sess-c', occurred_at: '2026-03-10T09:00:00.000Z', payload: { content: 'unrelated' } },
    ]);
    expect(snapshot.mentions).toBe(3);
    expect(snapshot.sessions).toBe(2); // sess-a and sess-b
    expect(snapshot.last_used_at).toBe('2026-03-09T09:00:00.000Z');
    expect(snapshot.usage_count).toBe(3); // the row's own counter, untouched
    expect(snapshot.success_rate).toBe(0.8);
  });

  test('no mentions → a clean empty snapshot, never nulls in the counters', () => {
    const snapshot = usageSnapshotOf(skill, [
      { id: 'e4', kind: 'conversation.message', session_id: 'sess-c', occurred_at: '2026-03-10T09:00:00.000Z', payload: { content: 'unrelated' } },
    ]);
    expect(snapshot).toMatchObject({ mentions: 0, sessions: 0, last_used_at: null, usage_count: 3 });
  });
});

describe('collectSkillUsage', () => {
  test('reads the captured-session log once and folds every listed skill (read-only)', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    const report = await runSkillGeneration({ skills, now: () => NOW });
    skills.usageEvents = [
      { id: 'e1', kind: 'conversation.message', session_id: 'sess-a', occurred_at: '2026-03-07T09:00:00.000Z', payload: { content: 'used cloud-run-deploy-failed-with-oom today' } },
      { id: 'e2', kind: 'conversation.message', session_id: 'sess-b', occurred_at: '2026-03-08T09:00:00.000Z', payload: { content: 'unrelated' } },
    ];
    const snapshots = await collectSkillUsage({ skills });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.name).toBe('cloud-run-deploy-failed-with-oom');
    expect(snapshots[0]!.mentions).toBe(1);
    expect(snapshots[0]!).toMatchObject({ sessions: 1, last_used_at: '2026-03-07T09:00:00.000Z' });
    expect(snapshots[0]!.usage_count).toBe(0); // the write side is future work — never invented
    expect(report.candidates.created).toBe(1);
  });
});
