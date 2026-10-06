/**
 * `onemem skills` end to end through the real CLI (M15 AC6): seed a project with recurring
 * failures (real failure memories with payload rows + entity bindings, through the storage port),
 * run the generation pass, walk the review flow — list → review → promote — and assert the
 * SKILL.md lands on the filesystem where a runtime-native loader finds it, the promotion is
 * audited through the memory_events path, and a second generation pass is idempotent.
 *
 * The blocked-gate branches (single occurrence, divergent solutions, missing verification) ride
 * the same run: the gate refusals are part of the contract, not fixtures for other suites.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@onememory/config';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory/storage';

import { jsonOf, runMain, type Captured } from './test-support';

async function cli(argv: string[]): Promise<Captured> {
  return runMain(argv);
}

let root: string;
/** The registered project id (set by the first test, shared by the whole suite). */
let projectId = '';

beforeAll(() => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-skills-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One failure memory with its payload row + entity binding — the extraction stage's output
 * shape (M3b signature + M3d payload), seeded through the real Store port. */
async function seedFailure(
  storage: OnememoryStorage,
  input: {
    projectId: string;
    sourceId: string;
    entityName: string;
    problem: string;
    context: string;
    rootCause?: string;
    solution?: string;
    verification?: string;
    status: 'open' | 'mitigated' | 'solved' | 'verified';
    signature: string;
    at: string;
  },
): Promise<string> {
  const write = await storage.store.insertMemory({
    type: 'failure',
    content: input.problem,
    title: input.problem.slice(0, 60),
    importance: 0.6,
    confidence: 0.7,
    observed_at: input.at,
    project_id: input.projectId,
    source_id: input.sourceId,
    evidence: [
      { source_id: input.sourceId, kind: 'message', locator: `session.jsonl:${input.at}`, excerpt: input.problem.slice(0, 80) },
    ],
    extraction: { method: 'heuristic', prompt_version: 'skills-e2e-v1' },
    tags: ['failure'],
    payload: {
      problem: input.problem,
      context: input.context,
      ...(input.rootCause === undefined ? {} : { root_cause: input.rootCause }),
      ...(input.solution === undefined ? {} : { solution: input.solution }),
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      status: input.status,
      signature_hash: input.signature,
      first_seen_at: input.at,
      last_seen_at: input.at,
      occurrence_count: 1,
    },
  });
  expect(write.outcome).toBe('inserted');
  const entity = await storage.store.findEntity({ project_id: input.projectId }, input.entityName.toLowerCase());
  const bound =
    entity === null
      ? await storage.store.createEntity({ project_id: input.projectId, kind: 'tool', name: input.entityName })
      : entity;
  await storage.store.bindMemoryEntities(write.memory.id, [{ entity_id: bound.id }]);
  return write.memory.id;
}

describe('onemem skills', () => {
  // Every CLI entry reopens the embedded DB (PGlite + vector extension ≈ 1s cold); this suite
  // walks eleven of them, so the 5s default would flake — name explicit budgets per test.
  test('recurring failures generate a candidate; review → promote lands the SKILL.md, audited; re-runs are idempotent', async () => {
    // --- the world: init, then failures through the real storage ----------------------
    const initialized = await cli(['init', '--preset', 'local', '--name', 'skills-demo', '--cwd', root, '--json']);
    expect(initialized.exitCode).toBe(0);
    projectId = jsonOf(initialized).project.id;

    const loaded = loadConfig({ cwd: root });
    const storage = await createEmbeddedDb(loaded.paths.data_dir, { migrate: false });
    try {
      const source = await storage.store.createSource({
        kind: 'conversation',
        uri: 'conversation/session/e2e',
        title: 'skills e2e session',
        project_id: projectId,
      });
      const AT = (day: number): string => `2026-03-${String(day).padStart(2, '0')}T09:00:00.000Z`;

      // QUALIFIED: 2 solved + verified occurrences of one signature, equivalent solutions.
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'cloud-run', signature: 'sig-oom',
        problem: 'Cloud Run deploy failed with OOM (exit 137) during the build step.',
        context: 'Cloud Run 2 GiB default memory limit, build step peak 2.3 GiB.',
        rootCause: 'The deploy step exceeds the 2 GiB memory limit during image build.',
        solution:
          'Raise the Cloud Run memory limit to 4 GiB in service.yaml and redeploy with ' +
          '`gcloud run deploy --region europe-west1`.',
        verification: 'gcloud run deploy exited 0; service reports 4 GiB and the deploy completes.',
        status: 'solved', at: AT(2),
      });
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'cloud-run', signature: 'sig-oom',
        problem: 'Cloud Run deploy failed with OOM (exit 137) during the build step again.',
        context: 'Cloud Run 2 GiB default memory limit, build step peak 2.3 GiB.',
        solution:
          'Raise the Cloud Run memory limit to 4 GiB in service.yaml, then redeploy with ' +
          '`gcloud run deploy --region europe-west1`.',
        verification: 'gcloud run deploy exited 0; the deploy completes under 4 GiB.',
        status: 'verified', at: AT(9),
      });
      // The same signature against a DIFFERENT entity: a separate group (insufficient alone).
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'worker-service', signature: 'sig-oom',
        problem: 'Cloud Run deploy failed with OOM (exit 137) during the worker-service build step.',
        context: 'Cloud Run 2 GiB default memory limit.',
        status: 'open', at: AT(10),
      });
      // BLOCKED (insufficient_solved_failures): a single solved occurrence of another signature.
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'cloud-run', signature: 'sig-port',
        problem: 'Port 8080 already in use when starting the API.',
        context: 'Local dev, macOS.',
        solution: 'Kill the stale process with lsof -ti:8080 and restart the API.',
        verification: 'lsof shows no listener; the API boots on 8080.',
        status: 'solved', at: AT(4),
      });
      // BLOCKED (divergent_solutions): two solved occurrences, different fixes.
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'postgres', signature: 'sig-conn',
        problem: 'Postgres says too many connections when running the test suite.',
        context: 'Server profile, Docker Postgres 17.',
        solution: 'Raise max_connections in postgresql.conf to 200 and restart the container.',
        verification: 'SELECT count(*) shows the suite under the limit.',
        status: 'solved', at: AT(5),
      });
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'postgres', signature: 'sig-conn',
        problem: 'Postgres says too many connections when running the test suite again.',
        context: 'Server profile, Docker Postgres 17.',
        solution: 'Close leaked pools in the test setup by calling pool.end() after the suite.',
        verification: 'The suite passes with no connection errors.',
        status: 'solved', at: AT(6),
      });
      // BLOCKED (no_verification_evidence): equivalent solutions, no proof recorded.
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'bun', signature: 'sig-flake',
        problem: 'bun test flakes with EBUSY when the suite runs twice.',
        context: 'Windows CI runner.',
        solution: 'Add a retry loop around the setup directory removal.',
        status: 'solved', at: AT(7),
      });
      await seedFailure(storage, {
        projectId, sourceId: source.id, entityName: 'bun', signature: 'sig-flake',
        problem: 'bun test flakes with EBUSY when the suite runs twice again.',
        context: 'Windows CI runner.',
        solution: 'Add a retry loop around the setup directory removal.',
        status: 'solved', at: AT(8),
      });
    } finally {
      await storage.close(); // one owner per data dir (ADR-0002) — the CLI opens it next
    }

    // --- generate: one candidate, three typed refusals ----------------------------------
    const generated = await cli(['skills', 'generate', '--cwd', root, '--json']);
    expect(generated.exitCode).toBe(0);
    const report = jsonOf(generated);
    expect(report.scope.project_id).toBe(projectId);
    expect(report.pool.failures).toBe(8);
    expect(report.groups.considered).toBe(5);
    expect(report.groups.qualified).toBe(1);
    expect(report.groups.blocked).toBe(4);
    expect(report.candidates.created).toBe(1);
    expect(report.candidates.records).toHaveLength(1);
    const candidate = report.candidates.records[0]!;
    expect(candidate.name).toBe('cloud-run-deploy-failed-with-oom');
    expect(candidate.path).toBe(`skills/${candidate.name}/SKILL.md`);
    expect(candidate.outcome).toBe('created');
    expect(candidate.failure_ids).toHaveLength(2);
    const blockedReasons = (report.blocked as Array<{ reason: string }>).map((entry) => entry.reason).sort();
    expect(blockedReasons).toEqual([
      'divergent_solutions',
      'insufficient_solved_failures',
      'insufficient_solved_failures',
      'no_verification_evidence',
    ]);

    // --- list: the review queue ----------------------------------------------------------
    const listed = await cli(['skills', 'list', '--cwd', root, '--json']);
    expect(listed.exitCode).toBe(0);
    const queue = jsonOf(listed);
    expect(queue.skills).toHaveLength(1);
    expect(queue.skills[0].status).toBe('candidate');
    expect(queue.skills[0].name).toBe(candidate.name);
    const skillId: string = queue.skills[0].id;

    // --- review: the read-only inspector prints the SKILL.md exactly as promote writes it --
    const reviewed = await cli(['skills', 'review', skillId, '--cwd', root, '--json']);
    expect(reviewed.exitCode).toBe(0);
    const bundle = jsonOf(reviewed);
    expect(bundle.skill.status).toBe('candidate');
    const markdown: string = bundle.markdown;
    expect(markdown).toContain('---\nname: cloud-run-deploy-failed-with-oom');
    expect(markdown).toContain('## When to use');
    expect(markdown).toContain('## Prerequisites');
    expect(markdown).toContain('## Procedure');
    expect(markdown).toContain('## Commands');
    expect(markdown).toContain('## Validation');
    expect(markdown).toContain('## Known failure modes');
    expect(markdown).toContain('```bash\ngcloud run deploy --region europe-west1\n```');
    expect(markdown).toContain('gcloud run deploy exited 0; the deploy completes under 4 GiB.');
    expect(bundle.audit).toHaveLength(1); // the audited 'created' row
    expect(bundle.audit[0].action).toBe('created');

    // The human mode prints the same artifact to the operator.
    const humanReview = await cli(['skills', 'review', skillId, '--cwd', root]);
    expect(humanReview.exitCode).toBe(0);
    expect(humanReview.out).toContain('## Known failure modes');
    expect(humanReview.out).toContain(`promote with: onemem skills promote ${skillId}`);

    // --- promote: candidate → verified, SKILL.md on disk, audited ------------------------
    const promoted = await cli([
      'skills', 'promote', skillId, '--cwd', root, '--json', '--note', 'recurring, verified twice',
    ]);
    expect(promoted.exitCode).toBe(0);
    const promotion = jsonOf(promoted);
    expect(promotion.skill.status).toBe('verified');
    const skillPath = join(root, 'skills', candidate.name, 'SKILL.md');
    expect(existsSync(skillPath)).toBeTrue();
    const written = readFileSync(skillPath, 'utf-8');
    expect(written).toBe(markdown); // canonical bytes — the same document review printed

    // The audit trail now carries the flip through the same memory_events path.
    const afterPromotion = await cli(['skills', 'review', skillId, '--cwd', root, '--json']);
    const audit = jsonOf(afterPromotion).audit as Array<{
      action: string;
      actor: string;
      details: Record<string, unknown>;
    }>;
    expect(audit).toHaveLength(2);
    const flip = audit.find((entry) => entry.action === 'status_changed')!;
    expect(flip.details['from']).toBe('candidate');
    expect(flip.details['to']).toBe('verified');
    expect(flip.details['note']).toBe('recurring, verified twice');
    expect(String(flip.actor)).toMatch(/^user:/);
    expect(String(flip.details['written_path'])).toContain(`skills/${candidate.name}/SKILL.md`);

    // The queue shows the verified status.
    const verifiedList = await cli(['skills', 'list', '--cwd', root, '--json']);
    expect(jsonOf(verifiedList).skills[0].status).toBe('verified');

    // --- idempotent: a second generate run leaves the promoted skill alone ----------------
    const regenerated = await cli(['skills', 'generate', '--cwd', root, '--json']);
    expect(regenerated.exitCode).toBe(0);
    const second = jsonOf(regenerated);
    expect(second.candidates.created).toBe(0);
    expect(second.candidates.refreshed).toBe(0);
    expect(second.candidates.unchanged).toBe(1);

    // Promoting again refuses honestly (the flip is candidate-only).
    const rePromote = await cli(['skills', 'promote', skillId, '--cwd', root, '--json']);
    expect(rePromote.exitCode).toBe(1);
    expect(jsonOf(rePromote).error.message).toContain('is verified, not candidate');
  }, 60_000);

  test('human mode prints the generation summary and the blocked-gate explanations', async () => {
    const human = await cli(['skills', 'generate', '--cwd', root]);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('skill generation for project');
    expect(human.out).toContain('candidates: 0 created, 0 refreshed, 1 unchanged');
    expect(human.err).toContain('blocked:');
    expect(human.err).toContain('divergent_solutions');

    const list = await cli(['skills', 'list', '--cwd', root]);
    expect(list.exitCode).toBe(0);
    expect(list.out).toContain('verified');
    expect(list.out).toContain(candidatePathOf());
    expect(list.out).toContain('no candidates waiting for review');
  }, 30_000);

  test('--usage folds the read-only usage hook over the captured-session log', async () => {
    // Seed one captured event that mentions the skill (the session-capture flow's raw log)…
    const loaded = loadConfig({ cwd: root });
    const storage = await createEmbeddedDb(loaded.paths.data_dir, { migrate: false });
    try {
      await storage.store.ingestEvent({
        id: '0192f3c0-0000-7000-8000-00000000aaaa',
        kind: 'conversation.message',
        occurred_at: '2026-03-20T10:00:00.000Z',
        ingested_at: '2026-03-20T10:00:01.000Z',
        source: { runtime: 'claude-code', adapter_version: '0.1.0' },
        scope: { project_id: projectId, session_id: 'sess-skills-e2e' },
        payload: {
          kind: 'conversation.message',
          role: 'assistant',
          content: 'followed skills/cloud-run-deploy-failed-with-oom/SKILL.md and the deploy passed',
        },
        content_hash: 'a'.repeat(64),
        redactions: [],
      });
    } finally {
      await storage.close();
    }
    const usage = await cli(['skills', 'list', '--cwd', root, '--json', '--usage']);
    expect(usage.exitCode).toBe(0);
    const snapshot = jsonOf(usage).skills[0].usage_snapshot;
    expect(snapshot.mentions).toBe(1);
    expect(snapshot.sessions).toBe(1);
    expect(snapshot.last_used_at).toBe('2026-03-20T10:00:00.000Z');
    expect(snapshot.usage_count).toBe(0); // the write side is future work — read-only today
  }, 30_000);

  test('refuses cleanly without an initialized project', async () => {
    const empty = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-skills-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(empty, { recursive: true });
    try {
      for (const argv of [
        ['skills', 'generate'],
        ['skills', 'list'],
        ['skills', 'review', '0192f3c0-0000-7000-8000-000000000001'],
        ['skills', 'promote', '0192f3c0-0000-7000-8000-000000000001'],
      ]) {
        const result = await cli([...argv, '--cwd', empty, '--json']);
        expect(result.exitCode).toBe(1);
        expect(jsonOf(result).error.message).toContain('init');
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

/** The promoted artifact's project-relative path (shared by two tests). */
function candidatePathOf(): string {
  return 'skills/cloud-run-deploy-failed-with-oom/SKILL.md';
}
