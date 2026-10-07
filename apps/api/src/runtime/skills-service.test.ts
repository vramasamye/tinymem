/**
 * The skills review service against real embedded storage: the semantics the REST routes and the
 * web review page share (list, review bundle, audited promote, audited deprecate).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NewSkill } from '@onememory-ai/core';
import { renderDefaultConfigYaml } from '@onememory-ai/config';

import { BackendError, createLocalBackend, openRuntime, type OnememoryBackend, type OnememoryRuntime } from './index';

let runtime: OnememoryRuntime;
let backend: OnememoryBackend;
let root: string;
let projectId: string;
let otherProjectId: string;
let sourceId: string;
let counter = 0;

beforeAll(async () => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-skills-service-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, '.onememory'), { recursive: true });
  writeFileSync(join(root, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');
  runtime = await openRuntime({ cwd: root, env: {}, startWorker: false });
  backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
  projectId = (await runtime.storage.store.createProject({ name: 'skills-service', root_path: root })).id;
  otherProjectId = (await runtime.storage.store.createProject({ name: 'elsewhere', root_path: join(root, 'other') })).id;
  sourceId = (
    await runtime.storage.store.createSource({
      kind: 'explicit',
      uri: 'conversation/session/skills-service',
      title: 'skills service fixture',
      project_id: projectId,
    })
  ).id;
});

afterAll(async () => {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
});

async function seedCandidate(options: { project?: string; evidence?: boolean } = {}) {
  counter += 1;
  const name = `deploy-oom-fix-${counter}`;
  const candidate: NewSkill = {
    project_id: options.project ?? projectId,
    name,
    description: 'Cloud Run deploys fail with OOM; raise the container memory limit.',
    version: '1.0.0',
    source: { failure_ids: [] },
    verification: {
      evidence:
        options.evidence === false
          ? []
          : [{ source_id: sourceId, kind: 'event', locator: 'session.jsonl:12', excerpt: 'deploy passed' }],
      verified_at: '2026-03-06T10:00:00.000Z',
    },
    path: `skills/${name}/SKILL.md`,
  };
  return runtime.storage.skills.insertSkill(candidate, { actor: 'system:generation' });
}

async function rejection(promise: Promise<unknown>): Promise<BackendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BackendError);
    return error as BackendError;
  }
  throw new Error('expected a rejection');
}

describe('skills review service', () => {
  test('list and review stay inside the route project', async () => {
    const mine = await seedCandidate();
    const theirs = await seedCandidate({ project: otherProjectId });

    const listed = await backend.listSkills(projectId);
    const ids = listed.skills.map((skill) => skill.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    const review = await backend.reviewSkill(projectId, mine.id);
    expect(review.skill.status).toBe('candidate');
    expect(review.skill.evidence_count).toBe(1);
    expect(review.markdown).toContain(`name: ${mine.name}`);
    expect(review.audit.map((event) => event.action)).toEqual(['created']);

    expect((await rejection(backend.reviewSkill(projectId, theirs.id))).code).toBe('not_found');
  });

  test('promote writes the reviewed bytes first, then flips to verified with an audit row', async () => {
    const skill = await seedCandidate();
    const review = await backend.reviewSkill(projectId, skill.id);

    const result = await backend.promoteSkill({ project_id: projectId, skill_id: skill.id, note: 'checked' });
    expect(result.skills_root_source).toBe('project-default');
    expect(result.written_path).toBe(join(root, 'skills', skill.name, 'SKILL.md'));
    expect(readFileSync(result.written_path, 'utf8')).toBe(review.markdown);
    expect(result.skill.status).toBe('verified');

    const after = await backend.reviewSkill(projectId, skill.id);
    const flip = after.audit.find((event) => event.action === 'status_changed');
    expect(flip?.details['written_path']).toBe(result.written_path);
    expect(flip?.details['surface']).toBe('api');

    // A second promotion is refused: only a candidate can be verified here.
    expect((await rejection(backend.promoteSkill({ project_id: projectId, skill_id: skill.id }))).code).toBe(
      'invalid_request',
    );
  });

  test('promote --runtime writes into that runtime root', async () => {
    const skill = await seedCandidate();
    const result = await backend.promoteSkill({ project_id: projectId, skill_id: skill.id, runtime: 'codex' });
    expect(result.skills_root_source).toBe('runtime-flag');
    expect(result.written_path.startsWith(root)).toBeTrue();
    expect(existsSync(result.written_path)).toBeTrue();
  });

  test('promote refuses dir+runtime, unknown runtimes, and missing evidence without writing', async () => {
    const skill = await seedCandidate();
    const both = await rejection(
      backend.promoteSkill({ project_id: projectId, skill_id: skill.id, dir: join(root, 'x'), runtime: 'codex' }),
    );
    expect(both.code).toBe('invalid_request');
    expect(existsSync(join(root, 'x'))).toBeFalse();

    const unknown = await rejection(backend.promoteSkill({ project_id: projectId, skill_id: skill.id, runtime: 'vim' }));
    expect(unknown.code).toBe('invalid_request');

    const bare = await seedCandidate({ evidence: false });
    const noEvidence = await rejection(backend.promoteSkill({ project_id: projectId, skill_id: bare.id }));
    expect(noEvidence.message).toContain('evidence');
    expect(existsSync(join(root, 'skills', bare.name))).toBeFalse();
    expect((await backend.reviewSkill(projectId, bare.id)).skill.status).toBe('candidate');
  });

  test('deprecate needs a reason, is audited, and refuses the terminal state cleanly', async () => {
    const skill = await seedCandidate();
    expect((await rejection(backend.deprecateSkill({ project_id: projectId, skill_id: skill.id, note: '  ' }))).code).toBe(
      'invalid_request',
    );

    const result = await backend.deprecateSkill({ project_id: projectId, skill_id: skill.id, note: 'wrong fix' });
    expect(result.skill.status).toBe('deprecated');
    const audit = (await backend.reviewSkill(projectId, skill.id)).audit;
    expect(audit.find((event) => event.action === 'status_changed')?.details['note']).toBe('wrong fix');

    const again = await rejection(backend.deprecateSkill({ project_id: projectId, skill_id: skill.id, note: 'again' }));
    expect(again.code).toBe('conflict');
  });
});
