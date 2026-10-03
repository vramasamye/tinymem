/**
 * The same integration scenarios against a REAL Postgres server (Docker compose from M13 or any
 * Postgres + pgvector 0.7+). Skipped unless `ONEMEMORY_PG_URL` is set, so `bun test` stays
 * fully offline/local-first — CI sets the variable to run the server leg of the matrix.
 *
 * Fixtures are per-run unique (uuidv7 suffixes), so this suite is re-runnable against a shared
 * database without cross-run interference.
 */

import { afterAll, beforeAll, describe } from 'bun:test';

import { createServerDb } from '../drivers/server';
import type { OnememoryStorage } from '../drivers/types';

import type { StorageHandle } from './harness';
import { runStorageIntegrationSuite } from './scenarios';

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('storage integration (postgres server)', () => {
  let storage: OnememoryStorage | null = null;

  beforeAll(async () => {
    storage = await createServerDb(connectionUrl!);
  });

  afterAll(async () => {
    await storage?.close();
  });

  runStorageIntegrationSuite('scenarios', async (): Promise<StorageHandle> => {
    if (!storage) throw new Error('server suite opened before beforeAll completed');
    return { storage, dataDir: null, close: () => Promise.resolve() };
  });
});
