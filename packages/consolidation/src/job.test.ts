/**
 * The `consolidate` / `decay` job payloads (memory-model.md §8 stages 12–14): the daemon's
 * scheduled form of the CONSOLIDATE / DECAY lifecycle stages. Validated at the worker boundary
 * like every external input — a malformed payload fails the job loudly, never runs a pass over
 * an unintended scope.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEmbeddedDb } from '@onememory-ai/storage';

import { parseConsolidationJobPayload } from './job';

const PROJECT = '00000000-0000-7000-8002-000000000001';

describe('parseConsolidationJobPayload', () => {
  test('accepts a project-scoped payload', () => {
    expect(parseConsolidationJobPayload({ project_id: PROJECT })).toEqual({ project_id: PROJECT });
  });

  test('carries an optional audit actor override', () => {
    expect(parseConsolidationJobPayload({ project_id: PROJECT, actor: 'api' })).toEqual({
      project_id: PROJECT,
      actor: 'api',
    });
  });

  test('rejects a missing or non-uuid project_id — a pass never runs unscoped by accident', () => {
    expect(() => parseConsolidationJobPayload({})).toThrow();
    expect(() => parseConsolidationJobPayload({ project_id: 'not-a-uuid' })).toThrow();
  });

  test('rejects unknown keys (strict at the boundary)', () => {
    expect(() => parseConsolidationJobPayload({ project_id: PROJECT, scope: 'everything' })).toThrow();
  });

  test('tolerates the queue-injected key (enqueue stores it inside the payload JSON)', () => {
    // Regression: `enqueue` writes its (kind, key) idempotency key INTO the payload JSON
    // (jobs_singleton_idx reads payload->>'key'), so a strict parse without stripping it
    // dead-lettered every scheduled pass with `unrecognized_keys: ["key"]`.
    expect(
      parseConsolidationJobPayload({ project_id: PROJECT, key: `consolidate:${PROJECT}` }),
    ).toEqual({ project_id: PROJECT });
  });

  test('a payload stored by a real enqueue round-trips through the parser', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'onemem-cons-job-'));
    const storage = await createEmbeddedDb(dir);
    try {
      const project = await storage.store.createProject({ name: 'consolidate-job' });
      const { job } = await storage.jobs.enqueue({
        kind: 'consolidate',
        key: `consolidate:${project.id}`,
        payload: { project_id: project.id },
      });
      expect(job.payload.key).toBe(`consolidate:${project.id}`);
      expect(parseConsolidationJobPayload(job.payload)).toEqual({ project_id: project.id });
    } finally {
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
