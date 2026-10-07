/**
 * `updateProjectDigest` (M14.5 — the ONE write path for the renderable `projects.digest` rollup
 * the `memory_project_context` tool surface reads): the owned-namespace merge semantics.
 *
 * Runs on BOTH deployment profiles (ADR-0002 matrix): embedded PGlite always; the real Postgres
 * server when `ONEMEMORY_PG_URL` is set (the same skip discipline as `integration/
 * server.test.ts`, so `bun test` stays fully offline by default).
 *
 * What is pinned here:
 * - the merge REPLACES only the `decision_NN` / `failure_NN` / `procedure_NN` namespace — foreign
 *   keys (a manual summary, the M4f architecture-digest fields) are preserved verbatim;
 * - stale owned keys from a wider previous rollup never survive a refresh;
 * - the Zod boundary rejects keys outside the owned namespace and non-string values;
 * - an unknown project id is an honest null, never a fabricated row.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { uuidv7 } from '@onememory-ai/core';

import { createServerDb } from './drivers/server';
import type { OnememoryStorage } from './drivers/types';
import { openEmbeddedStorage, type StorageHandle } from './integration/harness';
import { updateProjectDigest } from './repositories/digest';
import { ValidationError } from './repositories/util';

const ENTRIES = {
  decision_01: 'Adopt Bun for install, test and dev.',
  decision_02: 'Use PostgreSQL as the primary database.',
  failure_01: 'Cloud Run deploys fail with OOM → Raise the container memory limit',
  procedure_01: 'Run migrations before serve',
} as const;

async function seedWithDigest(storage: OnememoryStorage): Promise<string> {
  const project = await storage.store.createProject({
    name: `digest-repo-fixture-${uuidv7().slice(0, 8)}`, // unique per run — server-profile parity
    root_path: '/tmp/digest-repo',
    digest: { summary: 'Invoice REST API in TypeScript', stack: ['typescript', 'postgres'] },
  });
  return project.id;
}

async function scenarioMergeReplacesOwnedNamespace(storage: OnememoryStorage): Promise<void> {
  const projectId = await seedWithDigest(storage);
  const updated = await updateProjectDigest(storage.client, projectId, { ...ENTRIES });
  expect(updated).not.toBeNull();
  expect(updated!.id).toBe(projectId);
  expect(updated!.digest['decision_01']).toBe(ENTRIES.decision_01);
  expect(updated!.digest['decision_02']).toBe(ENTRIES.decision_02);
  expect(updated!.digest['failure_01']).toBe(ENTRIES.failure_01);
  expect(updated!.digest['procedure_01']).toBe(ENTRIES.procedure_01);
  // Foreign keys survive verbatim.
  expect(updated!.digest['summary']).toBe('Invoice REST API in TypeScript');
  expect(updated!.digest['stack']).toEqual(['typescript', 'postgres']);

  // A narrower refresh: the stale wider keys are gone, the new ones stand.
  const refreshed = await updateProjectDigest(storage.client, projectId, {
    decision_01: 'Adopt pgvector for similarity search.',
  });
  expect(refreshed!.digest['decision_01']).toBe('Adopt pgvector for similarity search.');
  expect(refreshed!.digest['decision_02']).toBeUndefined();
  expect(refreshed!.digest['failure_01']).toBeUndefined();
  expect(refreshed!.digest['procedure_01']).toBeUndefined();
  expect(refreshed!.digest['summary']).toBe('Invoice REST API in TypeScript');

  // Empty entries clear the owned namespace and leave everything else.
  const cleared = await updateProjectDigest(storage.client, projectId, {});
  expect(Object.keys(cleared!.digest).sort()).toEqual(['stack', 'summary']);
}

async function scenarioUnknownProjectIsNull(storage: OnememoryStorage): Promise<void> {
  const missing = await updateProjectDigest(storage.client, '00000000-0000-7000-8000-00000000007f', {
    decision_01: 'x',
  });
  expect(missing).toBeNull();
}

async function scenarioBoundaryRejectsForeignKeysAndNonStrings(storage: OnememoryStorage): Promise<void> {
  const projectId = await seedWithDigest(storage);
  await expect(
    updateProjectDigest(storage.client, projectId, { summary: 'a foreign key is not for the digest pass' }),
  ).rejects.toThrow(ValidationError);
  // @ts-expect-error — the boundary must reject non-string values at runtime too.
  await expect(updateProjectDigest(storage.client, projectId, { decision_01: 42 })).rejects.toThrow();
  // An unpadded key (the jsonb-ordering contract) is rejected as well.
  await expect(
    updateProjectDigest(storage.client, projectId, { decision_1: 'unpadded' }),
  ).rejects.toThrow(ValidationError);
  // Nothing was written by the rejected calls.
  const project = await storage.store.getProject(projectId);
  expect(project!.digest['decision_01']).toBeUndefined();
  expect(project!.digest['summary']).toBe('Invoice REST API in TypeScript');
}

const SCENARIOS: Array<[title: string, scenario: (storage: OnememoryStorage) => Promise<void>]> = [
  ['the owned-namespace merge: replaces owned keys, preserves foreign keys, clears on empty', scenarioMergeReplacesOwnedNamespace],
  ['an unknown project id is an honest null', scenarioUnknownProjectIsNull],
  ['the Zod boundary rejects keys outside the owned namespace and non-string values', scenarioBoundaryRejectsForeignKeysAndNonStrings],
];

function runDigestScenarios(
  suiteName: string,
  open: () => Promise<StorageHandle>,
  options?: { enabled?: boolean },
): void {
  const describeFn = options?.enabled === false ? describe.skip : describe;
  describeFn(suiteName, () => {
    for (const [title, scenario] of SCENARIOS) {
      test(title, async () => {
        const handle = await open();
        try {
          await scenario(handle.storage);
        } finally {
          await handle.close();
        }
      });
    }
  });
}

runDigestScenarios('projects.digest repo (embedded / PGlite)', () => openEmbeddedStorage());

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('projects.digest repo (postgres server)', () => {
  let storage: OnememoryStorage | null = null;

  beforeAll(async () => {
    storage = await createServerDb(connectionUrl!);
  });
  afterAll(async () => {
    await storage?.close();
  });

  runDigestScenarios('scenarios', async (): Promise<StorageHandle> => {
    if (!storage) throw new Error('server suite opened before beforeAll completed');
    return { storage, dataDir: null, close: () => Promise.resolve() };
  });
});
