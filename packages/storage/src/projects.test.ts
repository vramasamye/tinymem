/**
 * `findProjectByPath` (M17 — the cwd→project lookup, mission-5's named follow-up): the deepest
 * registered `root_path` containing a path wins, so a nested directory resolves to its own
 * project in a multi-project data dir. A `root_path IS NULL` project never matches; no match is
 * an honest null.
 *
 * Runs on BOTH deployment profiles (ADR-0002 matrix): embedded PGlite always; the real Postgres
 * server when `ONEMEMORY_PG_URL` is set (the same skip discipline as digest.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { uuidv7 } from '@onememory-ai/core';

import { createServerDb } from './drivers/server';
import type { OnememoryStorage } from './drivers/types';
import { openEmbeddedStorage, type StorageHandle } from './integration/harness';
import { findProjectByPath } from './repositories/projects';

async function seedMonorepo(storage: OnememoryStorage): Promise<{ outer: string; nested: string }> {
  const outer = await storage.store.createProject({
    name: `monorepo-outer-${uuidv7().slice(0, 8)}`, // unique per run — server-profile parity
    root_path: '/tmp/m17-monorepo',
  });
  const nested = await storage.store.createProject({
    name: `monorepo-nested-${uuidv7().slice(0, 8)}`,
    root_path: '/tmp/m17-monorepo/services/api',
  });
  return { outer: outer.id, nested: nested.id };
}

async function scenarioDeepestRootWins(storage: OnememoryStorage): Promise<void> {
  const { outer, nested } = await seedMonorepo(storage);

  expect((await findProjectByPath(storage.client, '/tmp/m17-monorepo/services/api/src/bin.ts'))!.id).toBe(nested);
  expect((await findProjectByPath(storage.client, '/tmp/m17-monorepo/services/api'))!.id).toBe(nested);
  expect((await findProjectByPath(storage.client, '/tmp/m17-monorepo/README.md'))!.id).toBe(outer);
  expect((await findProjectByPath(storage.client, '/tmp/m17-monorepo'))!.id).toBe(outer);
  // A sibling is NOT the nested project's root: the outer root is still the deepest ancestor.
  expect((await findProjectByPath(storage.client, '/tmp/m17-monorepo/services/web'))!.id).toBe(outer);
}

async function scenarioNoMatchAndNullRootNeverMatch(storage: OnememoryStorage): Promise<void> {
  await seedMonorepo(storage);
  const global = await storage.store.createProject({
    name: `global-no-root-${uuidv7().slice(0, 8)}`,
    // root_path absent → null (the pure-SaaS shape); such a project must never match a path.
  });

  expect(await findProjectByPath(storage.client, '/tmp/elsewhere/entirely')).toBeNull();
  expect(await findProjectByPath(storage.client, '/tmp/m17-monorepo-2')).toBeNull(); // prefix, not ancestor
  expect(await findProjectByPath(storage.client, '')).toBeNull();
  expect(global.root_path).toBeNull();
}

const SCENARIOS: Array<[title: string, scenario: (storage: OnememoryStorage) => Promise<void>]> = [
  ['the deepest registered root containing the path wins', scenarioDeepestRootWins],
  ['no match is an honest null; a null root_path never matches', scenarioNoMatchAndNullRootNeverMatch],
];

function runProjectScenarios(
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

runProjectScenarios('projects repo (embedded / PGlite)', () => openEmbeddedStorage());

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('projects repo (postgres server)', () => {
  let storage: OnememoryStorage | null = null;

  beforeAll(async () => {
    storage = await createServerDb(connectionUrl!);
  });
  afterAll(async () => {
    await storage?.close();
  });

  runProjectScenarios('scenarios', async (): Promise<StorageHandle> => {
    if (!storage) throw new Error('server suite opened before beforeAll completed');
    return { storage, dataDir: null, close: () => Promise.resolve() };
  });
});
