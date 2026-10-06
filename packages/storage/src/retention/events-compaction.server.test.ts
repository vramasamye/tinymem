/**
 * The same retention compaction scenarios against a REAL Postgres server (Docker compose or
 * any Postgres + pgvector 0.7+). Skipped unless `ONEMEMORY_PG_URL` is set, so `bun test` stays
 * fully offline/local-first — CI sets the variable to run the server leg of the matrix.
 */

import { describe } from 'bun:test';

import { createServerDb } from '../drivers/server';
import type { StorageHandle } from '../integration/harness';

import { runRetentionCompactionSuite } from './events-compaction.scenarios';

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('retention events compaction (postgres server)', () => {
  let storage: Awaited<ReturnType<typeof createServerDb>> | null = null;

  runRetentionCompactionSuite('retention events compaction (postgres server)', async (): Promise<StorageHandle> => {
    if (storage === null) {
      storage = await createServerDb(connectionUrl!);
    }
    return { storage, dataDir: null, close: () => Promise.resolve() };
  });
});
