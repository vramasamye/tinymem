/**
 * `runSkillGeneration` — the M15 pass over the `SkillStore` port, pinned against an in-memory
 * fake (the SQL implementation is exercised end to end by the CLI suite). The lifecycle the
 * tests hold: created → unchanged (idempotent) → refreshed when new failures join → unchanged
 * once verified, plus the honest-tail guarantees (typed gate refusals, scan failures, pool
 * caps, per-group error isolation).
 */

import { describe, expect, test } from 'bun:test';

import type { FailureRecurrence } from '@onememory/core';

import { SIG_CONN, SIG_OOM, FakeSkillStore, failureRecurrence, qualifiedPair } from './fixtures';
import { observationOf } from './match';
import { SKILL_GENERATION_ACTOR, runSkillGeneration } from './run';

const NOW = new Date('2026-03-06T09:00:00.000Z');

describe('runSkillGeneration', () => {
  test('created: one candidate from a qualified group, with the canonical markdown attached', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    const report = await runSkillGeneration({ skills, now: () => NOW });

    expect(report.ran_at).toBe('2026-03-06T09:00:00.000Z');
    expect(report.actor).toBe(SKILL_GENERATION_ACTOR);
    expect(report.pool).toEqual({ failures: 2, truncated: false });
    expect(report.groups).toEqual({ considered: 1, qualified: 1, blocked: 0 });
    expect(report.candidates.created).toBe(1);
    expect(report.candidates.records).toHaveLength(1);

    const record = report.candidates.records[0]!;
    expect(record.name).toBe('cloud-run-deploy-failed-with-oom');
    expect(record.outcome).toBe('created');
    expect(record.entity).toBe('cloud-run');
    expect(record.path).toBe('skills/cloud-run-deploy-failed-with-oom/SKILL.md');
    expect(record.markdown.startsWith('---\nname: cloud-run-deploy-failed-with-oom\n')).toBeTrue();
    expect(record.markdown).toContain('## Known failure modes');

    // The row the pass wrote carries the capped evidence window and the candidate status.
    expect(skills.rows).toHaveLength(1);
    const row = skills.rows[0]!;
    expect(row.status).toBe('candidate');
    expect(row.source.failure_ids).toEqual([
      '00000000-0000-7000-8000-0000000000a1',
      '00000000-0000-7000-8000-0000000000a2',
    ]);
    expect(row.verification.verified_at).toBe('2026-03-05T09:00:00.000Z');
  });

  test('idempotent: a second run over unchanged failures reports unchanged, never a duplicate', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    await runSkillGeneration({ skills, now: () => NOW });
    const second = await runSkillGeneration({ skills, now: () => NOW });

    expect(second.candidates).toMatchObject({ created: 0, refreshed: 0, unchanged: 1 });
    expect(second.candidates.records[0]!.outcome).toBe('unchanged');
    expect(second.candidates.records[0]!.name).toBe('cloud-run-deploy-failed-with-oom');
    expect(skills.rows).toHaveLength(1); // no duplicate row, ever
    expect(skills.calls.filter((call) => call.method === 'insertSkill')).toHaveLength(1);
  });

  test('refreshed: a NEW solved occurrence of the same signature widens the candidate evidence', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    await runSkillGeneration({ skills, now: () => NOW });

    const third: FailureRecurrence = failureRecurrence({
      id: '00000000-0000-7000-8000-0000000000a3',
      problem: 'Cloud Run deploy failed with OOM once more.',
      signature: SIG_OOM,
      solution: 'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
      verification: 'third deploy passed.',
      entity: 'cloud-run',
      at: '2026-03-09T09:00:00.000Z',
    });
    skills.recurrences = [...qualifiedPair(), third];
    const refreshed = await runSkillGeneration({ skills, now: () => NOW });

    expect(refreshed.candidates.created).toBe(0);
    expect(refreshed.candidates.refreshed).toBe(1);
    expect(refreshed.candidates.records[0]!.outcome).toBe('refreshed');
    expect(refreshed.candidates.records[0]!.failure_ids).toContain('00000000-0000-7000-8000-0000000000a3');
    expect(skills.rows).toHaveLength(1); // the SAME candidate, its evidence widened
    expect(skills.rows[0]!.source.failure_ids).toHaveLength(3);
    const refreshCall = skills.calls.find((call) => call.method === 'refreshSkillEvidence')!;
    expect(refreshCall.args[2]).toMatchObject({ added_failure_ids: ['00000000-0000-7000-8000-0000000000a3'] });
  });

  test('unchanged (never duplicated, never refreshed) once the skill is verified or promoted', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    await runSkillGeneration({ skills, now: () => NOW });
    const skillId = skills.rows[0]!.id;
    await skills.updateSkillStatus(skillId, 'verified', { actor: 'user:1', at: '2026-03-06T10:00:00.000Z' });

    // The SAME failures recur again — the frozen artifact is reported, not re-derived.
    const again = await runSkillGeneration({ skills, now: () => NOW });
    expect(again.candidates.created).toBe(0);
    expect(again.candidates.refreshed).toBe(0);
    expect(again.candidates.unchanged).toBe(1);
    expect(again.candidates.records[0]!.name).toBe('cloud-run-deploy-failed-with-oom');
    expect(again.candidates.records[0]!.skill_id).toBe(skillId);
    expect(skills.rows).toHaveLength(1); // never a discriminated-name duplicate
    expect(skills.calls.some((call) => call.method === 'refreshSkillEvidence')).toBeFalse();

    // A NEW solved occurrence of a verified skill's signature is still just reported —
    // refreshing evidence is a candidate-stage operation (deprecation is explicit).
    skills.recurrences = [
      ...qualifiedPair(),
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000a4',
        problem: 'Cloud Run deploy failed with OOM after promotion.',
        signature: SIG_OOM,
        solution: 'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
        verification: 'deploy passed.',
        entity: 'cloud-run',
        at: '2026-03-20T09:00:00.000Z',
      }),
    ];
    const post = await runSkillGeneration({ skills, now: () => NOW });
    expect(post.candidates).toMatchObject({ created: 0, refreshed: 0, unchanged: 1 });
    expect(skills.rows).toHaveLength(1);
  });

  test('a DIFFERENT qualifying group whose slug collides takes the signature-discriminated name', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = [
      ...qualifiedPair(),
      // Same leading words (same slug base), different signature — qualifies on its own.
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000j1',
        problem: 'Cloud Run deploy failed with OOM in the staging project.',
        signature: 'sha256:oom-staging-build',
        solution: 'Raise the staging memory limit to 2 GiB.',
        verification: 'staging deploy passed.',
        entity: 'cloud-run',
        at: '2026-03-03T09:00:00.000Z',
      }),
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000j2',
        problem: 'Cloud Run deploy failed with OOM in the staging project again.',
        signature: 'sha256:oom-staging-build',
        solution: 'Raise the staging memory limit to 2 GiB.',
        verification: 'staging deploy passed.',
        entity: 'cloud-run',
        at: '2026-03-04T09:00:00.000Z',
      }),
    ];
    const report = await runSkillGeneration({ skills, now: () => NOW });

    expect(report.candidates.created).toBe(2);
    const names = report.candidates.records.map((record) => record.name).sort();
    expect(names).toEqual([
      'cloud-run-deploy-failed-with-oom',
      // base + the significant hash head (8 chars: "oom-stag" of "oom-staging-build")
      'cloud-run-deploy-failed-with-oom-oom-stag',
    ]);
    expect(skills.rows).toHaveLength(2);
    // And the discriminated candidate is itself stable across re-runs.
    const second = await runSkillGeneration({ skills, now: () => NOW });
    expect(second.candidates).toMatchObject({ created: 0, refreshed: 0, unchanged: 2 });
  });

  test('blocked groups are reported with typed reasons — never silently dropped', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = [
      ...qualifiedPair(),
      // one solved occurrence of another signature
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000c1',
        problem: 'Port 8080 already in use when starting the API.',
        signature: SIG_CONN,
        solution: 'Kill the stale listener.',
        verification: 'lsof shows no listener.',
        entity: 'api',
      }),
      // two solved occurrences, solved different ways
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000d1',
        problem: 'Postgres too many connections.',
        signature: 'sha256:conn-pool-leak',
        solution: 'Raise max_connections in postgresql.conf to 200.',
        verification: 'count(*) under the limit.',
        entity: 'postgres',
      }),
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000d2',
        problem: 'Postgres too many connections again.',
        signature: 'sha256:conn-pool-leak',
        solution: 'Close leaked pools by calling pool.end() after the suite.',
        verification: 'no connection errors.',
        entity: 'postgres',
      }),
      // two equivalent solutions, no proof
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000e1',
        problem: 'bun test flakes with EBUSY.',
        signature: 'sha256:flake-ebusy',
        solution: 'Add a retry loop around the setup directory removal.',
        entity: 'bun',
      }),
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000e2',
        problem: 'bun test flakes with EBUSY again.',
        signature: 'sha256:flake-ebusy',
        solution: 'Add a retry loop around the setup directory removal.',
        entity: 'bun',
      }),
    ];
    const report = await runSkillGeneration({ skills, now: () => NOW });

    expect(report.groups).toEqual({ considered: 4, qualified: 1, blocked: 3 });
    expect(report.candidates.created).toBe(1);
    const reasons = report.blocked.map((entry) => entry.reason).sort();
    expect(reasons).toEqual(['divergent_solutions', 'insufficient_solved_failures', 'no_verification_evidence']);
    // Each sample explains itself and counts its members.
    for (const entry of report.blocked) {
      expect(entry.detail.length).toBeGreaterThan(0);
      expect(entry.failures).toBeGreaterThanOrEqual(1);
      expect(entry.entity).toBeTruthy();
    }
    // The honest tail: one warning line per blocked reason.
    expect(report.warnings.some((line) => line.includes('blocked: insufficient_solved_failures'))).toBeTrue();
    expect(report.warnings.some((line) => line.includes('blocked: divergent_solutions'))).toBeTrue();
    expect(report.warnings.some((line) => line.includes('blocked: no_verification_evidence'))).toBeTrue();
  });

  test('a failed scan degrades to an honest empty report, never a throw', async () => {
    const skills = new FakeSkillStore();
    skills.failScan = new Error('pglite exploded');
    const report = await runSkillGeneration({ skills, now: () => NOW });
    expect(report.pool).toEqual({ failures: 0, truncated: false });
    expect(report.groups).toEqual({ considered: 0, qualified: 0, blocked: 0 });
    expect(report.candidates.records).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]!).toContain('failure recurrence scan failed');
    expect(report.warnings[0]!).toContain('pglite exploded');
  });

  test('a pool cap is REPORTED as a truncation warning, never silent', async () => {
    const skills = new FakeSkillStore();
    // Ten recurrences (five two-solved signatures) against the config floor of poolLimit 10.
    const pool = qualifiedPair();
    for (let index = 0; index < 4; index += 1) {
      const day = 10 + index;
      pool.push(
        failureRecurrence({
          problem: `Recurring failure ${index} first occurrence.`,
          signature: `sha256:cap-${index}`,
          solution: `Apply fix ${index}.`,
          verification: `verified ${index}.`,
          entity: `cap-entity-${index}`,
          at: `2026-03-${day}T09:00:00.000Z`,
        }),
        failureRecurrence({
          problem: `Recurring failure ${index} second occurrence.`,
          signature: `sha256:cap-${index}`,
          solution: `Apply fix ${index}.`,
          verification: `verified ${index}.`,
          entity: `cap-entity-${index}`,
          at: `2026-03-${day}T10:00:00.000Z`,
        }),
      );
    }
    skills.recurrences = pool;
    const report = await runSkillGeneration({ skills, now: () => NOW, config: { poolLimit: 10 } });
    expect(report.pool).toEqual({ failures: 10, truncated: true });
    expect(report.warnings.some((line) => line.includes('the pool cap'))).toBeTrue();
  });

  test('one group failing to write never aborts the pass — the next run retries it', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = [
      ...qualifiedPair(),
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000k1',
        problem: 'Cloud Run deploy failed with a quota error in staging.',
        signature: 'sha256:quota-staging',
        solution: 'Request a quota raise for the staging project.',
        verification: 'quota raise granted.',
        entity: 'cloud-run',
        at: '2026-03-03T09:00:00.000Z',
      }),
      failureRecurrence({
        id: '00000000-0000-7000-8000-0000000000k2',
        problem: 'Cloud Run deploy failed with a quota error in staging again.',
        signature: 'sha256:quota-staging',
        solution: 'Request a quota raise for the staging project.',
        verification: 'quota raise granted.',
        entity: 'cloud-run',
        at: '2026-03-04T09:00:00.000Z',
      }),
    ];
    skills.failNextInsert = new Error('disk full');
    const report = await runSkillGeneration({ skills, now: () => NOW });

    // The FIRST group in pool order is the one whose insert threw; the OTHER group's candidate
    // still landed. The failed group keeps its failures — the next run retries it.
    expect(report.candidates.created).toBe(1);
    expect(report.candidates.records[0]!.signature_hash).toBe('sha256:quota-staging');
    expect(report.candidates.records[0]!.name).toBe('cloud-run-deploy-failed-with-quota');
    expect(report.warnings.some((line) => line.includes('failed: disk full'))).toBeTrue();
    expect(report.warnings.some((line) => line.includes('sha256:oom-kill-on-deploy'))).toBeTrue();
    expect(skills.rows.map((row) => row.name)).toEqual(['cloud-run-deploy-failed-with-quota']);

    // The retry is idempotent: the failed group creates on the next run.
    const retried = await runSkillGeneration({ skills, now: () => NOW });
    expect(retried.candidates).toMatchObject({ created: 1, unchanged: 1 });
    expect(skills.rows.map((row) => row.name).sort()).toEqual([
      'cloud-run-deploy-failed-with-oom',
      'cloud-run-deploy-failed-with-quota',
    ]);
  });

  test('the actor and scope ride every report and mutation', async () => {
    const skills = new FakeSkillStore();
    skills.recurrences = qualifiedPair();
    const report = await runSkillGeneration({
      skills,
      scope: { project_id: '00000000-0000-7000-8002-000000000021' },
      actor: 'job:skillify-nightly',
      now: () => NOW,
    });
    expect(report.actor).toBe('job:skillify-nightly');
    expect(report.scope.project_id).toBe('00000000-0000-7000-8002-000000000021');
    const insert = skills.calls.find((call) => call.method === 'insertSkill')!;
    expect(insert.args[1]).toMatchObject({ actor: 'job:skillify-nightly' });
    // The candidate itself carries the group's scope.
    expect(skills.rows[0]!.project_id).toBe('00000000-0000-7000-8002-000000000021');
  });
});

// ---------------------------------------------------------------------------
// The observation projection the pass feeds the matcher (guards the seam)
// ---------------------------------------------------------------------------

describe('observationOf (the pool projection seam)', () => {
  test('projects every field the gate and the builder read', () => {
    const [recurrence] = qualifiedPair();
    const observation = observationOf(recurrence!);
    expect(observation.memory_id).toBe(recurrence!.memory.id);
    expect(observation.problem).toBe(recurrence!.problem);
    expect(observation.solution).toBe(recurrence!.solution);
    expect(observation.verification).toBe(recurrence!.verification);
    expect(observation.signature_hash).toBe(recurrence!.signature_hash);
    expect(observation.entities).toEqual(['cloud-run']);
    expect(observation.evidence).toBe(recurrence!.memory.provenance.evidence);
  });
});
