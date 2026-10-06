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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('freshness reports the served skill as fresh — read-only, the row never flips', async () => {
    // Rides the world the first test built (init → seed → generate → promote): the verified
    // skill's cited signature is still in the current failure pool, so it is FRESH.
    const report = await cli(['skills', 'freshness', '--cwd', root, '--json']);
    expect(report.exitCode).toBe(0);
    const json = jsonOf(report);
    expect(json.scope.project_id).toBe(projectId);
    expect(json.pool.failures).toBe(8);
    expect(json.skills.assessed).toBe(1);
    expect(json.skills.fresh).toBe(1);
    expect(json.skills.stale).toBe(0);
    expect(json.warnings).toEqual([]);
    const record = json.skills.records[0];
    expect(record.status).toBe('verified');
    expect(record.signatures).toEqual(['sig-oom']); // deduped across the two cited failures
    expect(record.recurring_signatures).toEqual(['sig-oom']);
    expect(record.stale).toBeFalse();
    expect(record.last_recurred_at).toBe('2026-03-10T09:00:00.000Z'); // newest pool row of the signature
    expect(record.unresolved_failure_ids).toEqual([]);

    // Human mode explains the same answer.
    const human = await cli(['skills', 'freshness', '--cwd', root]);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('skill freshness: 1 served (1 fresh, 0 stale)');
    expect(human.out).toContain('fresh  cloud-run-deploy-failed-with-oom (verified)');

    // The report mutated nothing.
    const listed = await cli(['skills', 'list', '--cwd', root, '--json']);
    expect(jsonOf(listed).skills[0].status).toBe('verified');
  }, 60_000);

  test('deprecate is the explicit, audited retire — reason required, terminal, refuses cleanly', async () => {
    const listed = await cli(['skills', 'list', '--cwd', root, '--json']);
    const skillId = jsonOf(listed).skills[0].id;

    // A retire without a reason is refused (deprecated is terminal — the reason is audited).
    const noNote = await cli(['skills', 'deprecate', skillId, '--cwd', root, '--json']);
    expect(noNote.exitCode).toBe(1);
    expect(jsonOf(noNote).error.message).toContain('--note');

    // An unknown id refuses cleanly, like review/promote do.
    const unknown = await cli([
      'skills', 'deprecate', '0192f3c0-0000-7000-8000-0000000000ff',
      '--note', 'decay', '--cwd', root, '--json',
    ]);
    expect(unknown.exitCode).toBe(1);
    expect(jsonOf(unknown).error.message).toContain('not found');

    // The explicit flip, in human mode (the audit rides the same memory_events path; the
    // operator-facing answer — including "the artifact is yours, not silently deleted" — is
    // what this run pins). verified → deprecated is a legal SKILL_TRANSITIONS edge.
    const deprecated = await cli([
      'skills', 'deprecate', skillId,
      '--note', 'the OOM signature stopped recurring (skills freshness)',
      '--cwd', root,
    ]);
    expect(deprecated.exitCode).toBe(0);
    expect(deprecated.out).toContain('deprecated cloud-run-deploy-failed-with-oom → deprecated');
    expect(deprecated.out).toContain('reason:    the OOM signature stopped recurring (skills freshness)');
    expect(deprecated.out).toContain('artifact:  skills/cloud-run-deploy-failed-with-oom/SKILL.md on disk is NOT deleted');
    expect(existsSync(join(root, 'skills', 'cloud-run-deploy-failed-with-oom', 'SKILL.md'))).toBeTrue();

    // Deprecation is explicit, never silent removal: the queue still shows the row.
    const after = await cli(['skills', 'list', '--cwd', root, '--json']);
    expect(jsonOf(after).skills[0].status).toBe('deprecated');

    // Deprecated is terminal — a second retire refuses.
    const again = await cli(['skills', 'deprecate', skillId, '--note', 'again', '--cwd', root, '--json']);
    expect(again.exitCode).toBe(1);
    expect(jsonOf(again).error.message).toContain('terminal');

    // The decay pass assesses only SERVED stages — a deprecated row is no longer assessed.
    const fresh = await cli(['skills', 'freshness', '--cwd', root, '--json']);
    expect(jsonOf(fresh).skills.assessed).toBe(0);
  }, 60_000);

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
        ['skills', 'freshness'],
        ['skills', 'deprecate', '0192f3c0-0000-7000-8000-000000000001', '--note', 'decay'],
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

describe('onemem skills promote — the configurable write surface (M15 follow-up 3)', () => {
  let surfaceRoot: string;
  const AT = (day: number): string => `2026-04-${String(day).padStart(2, '0')}T09:00:00.000Z`;

  beforeAll(() => {
    surfaceRoot = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-skills-surface-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(surfaceRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(surfaceRoot, { recursive: true, force: true });
  });

  test('--runtime writes into the runtime canonical root; skills.dir sets the default; bad flags refuse', async () => {
    const initialized = await cli(['init', '--preset', 'local', '--name', 'surface-demo', '--cwd', surfaceRoot, '--json']);
    expect(initialized.exitCode).toBe(0);
    const surfaceProjectId: string = jsonOf(initialized).project.id;

    // Two qualified groups (two signatures × 2 solved+verified) → two promotable candidates.
    const loaded = loadConfig({ cwd: surfaceRoot });
    const storage = await createEmbeddedDb(loaded.paths.data_dir, { migrate: false });
    try {
      const source = await storage.store.createSource({
        kind: 'conversation',
        uri: 'conversation/session/surface',
        title: 'surface session',
        project_id: surfaceProjectId,
      });
      const seed = (input: Parameters<typeof seedFailure>[1]) => seedFailure(storage, input);
      await seed({
        projectId: surfaceProjectId, sourceId: source.id, entityName: 'cloud-run', signature: 'sig-oom',
        problem: 'Cloud Run deploy failed with OOM during the build step.',
        context: 'Cloud Run 2 GiB default memory limit.',
        solution: 'Raise the memory limit to 4 GiB in service.yaml and redeploy.',
        verification: 'gcloud run deploy exited 0.', status: 'solved', at: AT(2),
      });
      await seed({
        projectId: surfaceProjectId, sourceId: source.id, entityName: 'cloud-run', signature: 'sig-oom',
        problem: 'Cloud Run deploy failed with OOM during the build step again.',
        context: 'Cloud Run 2 GiB default memory limit.',
        solution: 'Raise the memory limit to 4 GiB in service.yaml, then redeploy.',
        verification: 'gcloud run deploy exited 0 under 4 GiB.', status: 'verified', at: AT(9),
      });
      await seed({
        projectId: surfaceProjectId, sourceId: source.id, entityName: 'postgres', signature: 'sig-conn',
        problem: 'Postgres reports too many connections when running the suite.',
        context: 'Server profile, Docker Postgres 17.',
        solution: 'Raise max_connections to 200 and restart the container.',
        verification: 'The suite runs under the limit.', status: 'solved', at: AT(5),
      });
      await seed({
        projectId: surfaceProjectId, sourceId: source.id, entityName: 'postgres', signature: 'sig-conn',
        problem: 'Postgres reports too many connections when running the suite again.',
        context: 'Server profile, Docker Postgres 17.',
        solution: 'Raise max_connections to 200, then restart the container.',
        verification: 'The suite passes with no connection errors.', status: 'verified', at: AT(6),
      });
    } finally {
      await storage.close(); // one owner per data dir (ADR-0002) — the CLI opens it next
    }

    expect((await cli(['skills', 'generate', '--cwd', surfaceRoot, '--json'])).exitCode).toBe(0);
    const queue = (jsonOf(await cli(['skills', 'list', '--cwd', surfaceRoot, '--json'])).skills as Array<{
      id: string;
      name: string;
      status: string;
    }>);
    expect(queue).toHaveLength(2);
    const oom = queue.find((entry) => entry.name.includes('oom'))!;
    const conn = queue.find((entry) => entry.name.includes('postgres'))!;
    expect(oom.status).toBe('candidate');

    // --- --runtime: the file lands in that runtime's own skills root ---------------------
    const promoted = await cli(['skills', 'promote', oom.id, '--cwd', surfaceRoot, '--runtime', 'cursor', '--json']);
    expect(promoted.exitCode).toBe(0);
    const document = jsonOf(promoted);
    expect(document.skills_root_source).toBe('runtime-flag');
    const cursorPath = join(surfaceRoot, '.cursor', 'skills', oom.name, 'SKILL.md');
    expect(document.written_path).toBe(cursorPath);
    expect(existsSync(cursorPath)).toBeTrue();
    expect(readFileSync(cursorPath, 'utf-8')).toContain(`name: ${oom.name}`);
    // NOT in the plain default location — the runtime root was chosen.
    expect(existsSync(join(surfaceRoot, 'skills', oom.name, 'SKILL.md'))).toBeFalse();

    // The audit records how the directory was chosen.
    const reviewed = await cli(['skills', 'review', oom.id, '--cwd', surfaceRoot, '--json']);
    const flip = (jsonOf(reviewed).audit as Array<{ action: string; details: Record<string, unknown> }>).find(
      (entry) => entry.action === 'status_changed',
    )!;
    expect(flip.details['skills_root_source']).toBe('runtime-flag');
    expect(flip.details['skills_root']).toBe(join(surfaceRoot, '.cursor', 'skills'));

    // --- skills.dir in the config sets the default --------------------------------------
    const configPath = loaded.paths.config_path;
    expect(configPath).not.toBeNull();
    const yaml = readFileSync(configPath!, 'utf-8');
    expect(yaml).toContain('skills: {}');
    writeFileSync(configPath!, yaml.replace(/^skills: \{\}$/m, 'skills:\n  dir: .opencode/skills'), 'utf-8');

    const promoted2 = await cli(['skills', 'promote', conn.id, '--cwd', surfaceRoot, '--json']);
    expect(promoted2.exitCode).toBe(0);
    const document2 = jsonOf(promoted2);
    expect(document2.skills_root_source).toBe('config');
    const opencodePath = join(surfaceRoot, '.opencode', 'skills', conn.name, 'SKILL.md');
    expect(document2.written_path).toBe(opencodePath);
    expect(existsSync(opencodePath)).toBeTrue();

    // --- the flag refusals (both fail before storage opens) -----------------------------
    const both = await cli(['skills', 'promote', oom.id, '--cwd', surfaceRoot, '--dir', '/tmp/x', '--runtime', 'cursor', '--json']);
    expect(both.exitCode).toBe(1);
    expect(jsonOf(both).error.message).toContain('not both');

    const unknownRuntime = await cli(['skills', 'promote', oom.id, '--cwd', surfaceRoot, '--runtime', 'claude', '--json']);
    expect(unknownRuntime.exitCode).toBe(1);
    expect(jsonOf(unknownRuntime).error.message).toContain('unknown runtime');
    expect(jsonOf(unknownRuntime).error.message).toContain('claude-code');
  }, 120_000);
});
