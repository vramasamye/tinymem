/**
 * Regression coverage for the code-memory job payloads (M14 follow-up 1).
 *
 * `enqueue` writes its (kind, key) idempotency key INTO the payload JSON (jobs_singleton_idx reads
 * `payload->>'key'`), so the stored payload is `{...fields, key}`. The `drift_scan`/`reindex`
 * payload schemas are strict, so without stripping that key every scheduled code-memory job
 * dead-lettered with `unrecognized_keys: ["key"]` — and no test ran those jobs through the worker,
 * so the break was latent. These tests parse a payload a REAL enqueue produced.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';

import { parseDriftScanJobPayload, parseReindexJobPayload } from './orchestration';

let storage: OnememoryStorage;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'onemem-codemem-job-'));
  storage = await createEmbeddedDb(dataDir);
});

afterAll(async () => {
  await storage.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('code-memory job payloads round-trip through a real enqueue', () => {
  test('drift_scan: the queue-injected key does not fail the strict parse', async () => {
    const project = await storage.store.createProject({ name: 'codemem-drift' });
    const { job } = await storage.jobs.enqueue({
      kind: 'drift_scan',
      key: `drift_scan:${project.id}`,
      payload: { project_id: project.id },
    });
    expect(job.payload.key).toBe(`drift_scan:${project.id}`);
    expect(parseDriftScanJobPayload(job.payload)).toEqual({ project_id: project.id });
  });

  test('reindex: the queue-injected key does not fail the strict parse', async () => {
    const project = await storage.store.createProject({ name: 'codemem-reindex' });
    const { job } = await storage.jobs.enqueue({
      kind: 'reindex',
      key: `reindex:${project.id}`,
      payload: { project_id: project.id },
    });
    expect(job.payload.key).toBe(`reindex:${project.id}`);
    expect(parseReindexJobPayload(job.payload)).toEqual({ project_id: project.id });
  });

  test('a genuinely unknown payload field still fails loudly (strictness is preserved)', () => {
    expect(() =>
      parseDriftScanJobPayload({ project_id: '00000000-0000-7000-8000-000000000001', scope: 'all' }),
    ).toThrow();
  });
});
