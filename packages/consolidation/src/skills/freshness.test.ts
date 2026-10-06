/**
 * `runSkillFreshness` — the M15 decay pass, pinned against the in-memory fake (the SQL
 * implementation is exercised end to end by the CLI suite).
 *
 * The contract under test is the DECAY SIGNAL and its honesty edges, not any mutation: the pass
 * is read-only by design (ADR-0009 rule 4 — deprecation is explicit, and `verified → candidate`
 * is not a legal edge, so a served artifact never silently reverts to the review queue).
 *
 *   - a served skill whose cited signature still recurs is fresh;
 *   - a served skill whose cited signature stopped recurring is stale (reported, never flipped);
 *   - a skill whose cited failures can no longer be read is NOT called stale — it is reported
 *     with the unresolved ids, because "we cannot know" is not "decayed";
 *   - a truncated pool scan is warned about, never silently narrowing the answer;
 *   - only SERVED statuses (verified/promoted) are assessed — candidates are not yet artifacts.
 */

import { describe, expect, test } from 'bun:test';

import type { MemoryRecord, SkillStatus } from '@onememory/core';

import { SIG_OOM, FakeSkillStore, failureRecurrence, qualifiedPair } from './fixtures';
import { runSkillFreshness } from './freshness';

const NOW = new Date('2026-06-01T09:00:00.000Z');

/** A minimal Store stub: only `getMemory` is used by the pass. */
function storeWith(payloads: Record<string, { signature_hash: string } | null>) {
  return {
    async getMemory(id: string): Promise<MemoryRecord | null> {
      const payload = payloads[id];
      if (payload === undefined || payload === null) return null;
      return { id, payload } as unknown as MemoryRecord;
    },
  };
}

/** Seed one served skill citing the two canonical OOM failures. */
async function seedServedSkill(skills: FakeSkillStore, status: SkillStatus = 'verified') {
  skills.recurrences = qualifiedPair();
  await skills.insertSkill(
    {
      name: 'cloud-run-deploy-failed-with-oom',
      description: 'Fix: Cloud Run deploy failed with OOM.',
      source: {
        failure_ids: ['00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000a2'],
      },
      verification: {
        evidence: [
          { source_id: '00000000-0000-7000-8000-0000000000b1', kind: 'event', locator: 'x:1', excerpt: 'ok' },
        ],
        verified_at: '2026-03-06T09:00:00.000Z',
      },
      path: 'skills/cloud-run-deploy-failed-with-oom/SKILL.md',
    },
    { actor: 'system:generation' },
  );
  const skill = skills.rows[0]!;
  if (status !== 'candidate') {
    await skills.updateSkillStatus(skill.id, 'verified', { actor: 'user:1' });
    if (status === 'promoted') await skills.updateSkillStatus(skill.id, 'promoted', { actor: 'user:1' });
  }
  return skill;
}

const OOM_PAYLOADS = {
  '00000000-0000-7000-8000-0000000000a1': { signature_hash: SIG_OOM },
  '00000000-0000-7000-8000-0000000000a2': { signature_hash: SIG_OOM },
};

describe('runSkillFreshness', () => {
  test('fresh: the cited signature still recurs in the recent pool', async () => {
    const skills = new FakeSkillStore();
    const skill = await seedServedSkill(skills);
    skills.recurrences = qualifiedPair(); // the same signature is still current

    const report = await runSkillFreshness({ skills, store: storeWith(OOM_PAYLOADS), now: () => NOW });

    expect(report.ran_at).toBe('2026-06-01T09:00:00.000Z');
    expect(report.pool).toEqual({ failures: 2, truncated: false });
    expect(report.skills.assessed).toBe(1);
    expect(report.skills.stale).toBe(0);
    expect(report.skills.fresh).toBe(1);

    const record = report.skills.records[0]!;
    expect(record.skill_id).toBe(skill.id);
    expect(record.status).toBe('verified');
    expect(record.signatures).toEqual([SIG_OOM]); // deduped across the two cited failures
    expect(record.recurring_signatures).toEqual([SIG_OOM]);
    expect(record.stale).toBeFalse();
    expect(record.last_recurred_at).toBe('2026-03-05T09:00:00.000Z');
    expect(record.unresolved_failure_ids).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test('stale: the cited signature stopped recurring — reported, and NOTHING is mutated', async () => {
    const skills = new FakeSkillStore();
    const skill = await seedServedSkill(skills);
    // The pool now carries a DIFFERENT signature — the OOM problem stopped recurring.
    skills.recurrences = [
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000c1',
        problem: 'Something else entirely broke.',
        signature: 'sha256:other-signature',
        solution: 'A different fix.',
        verification: 'passed.',
        at: '2026-05-30T09:00:00.000Z',
      }),
    ];

    const before = skills.rows.map((row) => row.status);
    skills.calls.length = 0; // the seeding used updateSkillStatus; only the pass's calls count
    const report = await runSkillFreshness({ skills, store: storeWith(OOM_PAYLOADS), now: () => NOW });

    expect(report.skills.stale).toBe(1);
    expect(report.skills.fresh).toBe(0);
    const record = report.skills.records[0]!;
    expect(record.stale).toBeTrue();
    expect(record.recurring_signatures).toEqual([]);
    expect(record.last_recurred_at).toBeNull();

    // The pass is read-only: the row's status is untouched and no mutation was attempted.
    expect(skills.rows.map((row) => row.status)).toEqual(before);
    expect(skills.rows[0]!.status).toBe('verified');
    expect(skills.calls).toEqual([]);
  });

  test('unreadable evidence is NOT stale: it is reported with the unresolved ids and a warning', async () => {
    const skills = new FakeSkillStore();
    await seedServedSkill(skills);
    // Neither cited failure resolves any more (missing / superseded).
    const report = await runSkillFreshness({
      skills,
      store: storeWith({}),
      now: () => NOW,
    });

    const record = report.skills.records[0]!;
    expect(record.signatures).toEqual([]);
    expect(record.unresolved_failure_ids).toHaveLength(2);
    expect(record.stale).toBeFalse(); // "we cannot know" is not "decayed"
    expect(report.skills.stale).toBe(0);
    expect(report.warnings.some((warning) => warning.includes('could not be re-read'))).toBeTrue();
    expect(report.warnings.some((warning) => warning.includes('no resolvable signature'))).toBeTrue();
  });

  test('a partially unreadable skill is judged on what remains', async () => {
    const skills = new FakeSkillStore();
    await seedServedSkill(skills);
    // One failure still resolves to the OOM signature; the other is gone.
    const report = await runSkillFreshness({
      skills,
      store: storeWith({ '00000000-0000-7000-8000-0000000000a1': { signature_hash: SIG_OOM } }),
      now: () => NOW,
    });

    const record = report.skills.records[0]!;
    expect(record.signatures).toEqual([SIG_OOM]);
    expect(record.unresolved_failure_ids).toEqual(['00000000-0000-7000-8000-0000000000a2']);
    expect(record.stale).toBeFalse(); // the remaining signature still recurs
    expect(report.warnings.some((warning) => warning.includes('could not be re-read'))).toBeTrue();
  });

  test('only SERVED skills are assessed — a candidate is not yet an artifact', async () => {
    const skills = new FakeSkillStore();
    await seedServedSkill(skills, 'candidate');
    skills.recurrences = [];

    const report = await runSkillFreshness({ skills, store: storeWith(OOM_PAYLOADS), now: () => NOW });
    expect(report.skills.assessed).toBe(0);
    expect(report.skills.records).toEqual([]);
  });

  test('a promoted skill is assessed too (the served stage after usage proof)', async () => {
    const skills = new FakeSkillStore();
    await seedServedSkill(skills, 'promoted');
    skills.recurrences = [];

    const report = await runSkillFreshness({ skills, store: storeWith(OOM_PAYLOADS), now: () => NOW });
    expect(report.skills.assessed).toBe(1);
    expect(report.skills.records[0]!.status).toBe('promoted');
    expect(report.skills.records[0]!.stale).toBeTrue();
  });

  test('a truncated pool scan is warned about, never silent', async () => {
    const skills = new FakeSkillStore();
    await seedServedSkill(skills);
    // The fake ignores the limit, so a pool as large as the cap reads as truncated.
    skills.recurrences = Array.from({ length: 500 }, (_, index) =>
      failureRecurrence({
        id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        problem: `Noise ${index}`,
        signature: SIG_OOM,
        solution: 'same',
        verification: 'passed',
        at: '2026-05-30T09:00:00.000Z',
      }),
    );

    const report = await runSkillFreshness({ skills, store: storeWith(OOM_PAYLOADS), now: () => NOW });
    expect(report.pool.truncated).toBeTrue();
    expect(report.warnings.some((warning) => warning.includes('the cap'))).toBeTrue();
  });

  test('a scan failure is reported as a warning, never thrown', async () => {
    const skills = new FakeSkillStore();
    await seedServedSkill(skills);
    skills.failScan = new Error('pool unavailable');

    const report = await runSkillFreshness({ skills, store: storeWith(OOM_PAYLOADS), now: () => NOW });
    expect(report.pool.failures).toBe(0);
    expect(report.skills.assessed).toBe(0);
    expect(report.warnings[0]).toContain('pool unavailable');
  });
});
