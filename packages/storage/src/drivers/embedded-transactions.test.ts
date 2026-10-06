/**
 * Embedded transactions under concurrency: the daemon serves concurrent requests over ONE
 * PGlite connection, so overlapping `transaction()` calls must not interleave inside a shared
 * BEGIN block (the failure mode was `ROLLBACK TO SAVEPOINT can only be used in transaction
 * blocks` and lost atomicity).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEmbeddedClient, type EmbeddedDatabase } from './embedded';

describe('EmbeddedDatabase.transaction under concurrency', () => {
  let dataDir: string;
  let db: EmbeddedDatabase;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'onemem-embedded-tx-'));
    db = await createEmbeddedClient(dataDir, { vectorExtension: false });
    await db.query('CREATE TABLE tx_probe (writer text NOT NULL, step int NOT NULL)');
  });

  afterAll(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('overlapping transactions each commit atomically', async () => {
    const writers = Array.from({ length: 8 }, (_, index) => `w${index}`);
    await Promise.all(
      writers.map((writer) =>
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO tx_probe (writer, step) VALUES ($1, 1)', [writer]);
          await new Promise((resolve) => setTimeout(resolve, 5));
          await tx.transaction(async (nested) => {
            await nested.query('INSERT INTO tx_probe (writer, step) VALUES ($1, 2)', [writer]);
          });
        }),
      ),
    );
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM tx_probe');
    expect(rows.rows[0]?.n).toBe(writers.length * 2);
  });

  test('a failing transaction rolls back only its own writes while others commit', async () => {
    await db.query('DELETE FROM tx_probe');
    const results = await Promise.allSettled([
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO tx_probe (writer, step) VALUES ('doomed', 1)");
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('boom');
      }),
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO tx_probe (writer, step) VALUES ('survivor', 1)");
      }),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    const rows = await db.query<{ writer: string }>('SELECT writer FROM tx_probe ORDER BY writer');
    expect(rows.rows.map((row) => row.writer)).toEqual(['survivor']);
  });

  test('a failing nested transaction rolls back to its savepoint only', async () => {
    await db.query('DELETE FROM tx_probe');
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO tx_probe (writer, step) VALUES ('outer', 1)");
      await tx
        .transaction(async (nested) => {
          await nested.query("INSERT INTO tx_probe (writer, step) VALUES ('inner', 2)");
          throw new Error('inner failure');
        })
        .catch(() => undefined);
    });
    const rows = await db.query<{ writer: string }>('SELECT writer FROM tx_probe');
    expect(rows.rows.map((row) => row.writer)).toEqual(['outer']);
  });
});
