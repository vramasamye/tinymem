/**
 * GATE-1 acceptance suite (ADR-0002, database-schema.md §5) — the formal, kept-in-repo version
 * of the throwaway probe that de-risked the central M1 assumption: **does pgvector work inside
 * PGlite (WASM Postgres) under Bun?** The verdict feeds `docs/plan/mission-reports/mission-1.md`.
 *
 * Every capability the schema relies on is verified against the REAL committed migration:
 *   1. the `vector` extension loads and registers its type;
 *   2. `vector(384)` DDL, HNSW index DDL, vector insert, and cosine `<=>` KNN all work;
 *   3. STORED generated tsvector + GIN index + plainto_tsquery match work;
 *   4. partial + expression unique indexes enforce (jobs singleton, memories dedupe);
 *   5. `FOR UPDATE SKIP LOCKED` claim semantics work;
 *   6. cell types round-trip (timestamptz, arrays, jsonb);
 *   7. migrations apply cleanly twice; data persists across close/reopen;
 *   8. the EmbeddingIndex backend seam selects honestly (auto→pgvector; forced pgvector fails
 *      loudly without the extension; auto falls back to float8).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toSql } from 'pgvector';

import { memoryContentHash, uuidv7 } from '@onememory-ai/core';

import { createEmbeddedClient, createEmbeddedDb } from '../drivers/embedded';
import { migrateEmbedded } from '../drivers/migrate';
import { EmbeddingIndexError, createEmbeddingIndex } from '../vectors/embedding-index';

describe('GATE-1: pglite-pgvector 0.0.9 under PGlite 0.5.8 / Bun', () => {
  let dataDir: string;
  let gate: Awaited<ReturnType<typeof createEmbeddedClient>>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'onemem-gate1-'));
    gate = await createEmbeddedClient(dataDir);
    await migrateEmbedded(gate.pglite);
  });

  afterAll(async () => {
    await gate.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('pgvector extension loads and registers the vector type', async () => {
    const extension = await gate.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'",
    );
    expect(extension.rows[0]?.n).toBe(1);

    const type = await gate.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_type WHERE typname = 'vector'",
    );
    expect(type.rows[0]?.n).toBeGreaterThan(0);

    const hnswOpclass = await gate.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_opclass WHERE opcname = 'vector_cosine_ops'",
    );
    expect(hnswOpclass.rows[0]?.n).toBeGreaterThan(0);
  });

  test('vector(384) DDL, HNSW index, insert, and cosine KNN work', async () => {
    await gate.query(
      `CREATE TABLE gate1_vec (id integer PRIMARY KEY, embedding vector(384))`,
    );
    // HNSW index DDL — the access method the committed schema ships.
    await gate.query(
      `CREATE INDEX gate1_hnsw ON gate1_vec USING hnsw (embedding vector_cosine_ops)`,
    );

    const axis = (index: number) => Array.from({ length: 384 }, (_, i) => (i === index ? 1 : 0));
    await gate.query('INSERT INTO gate1_vec (id, embedding) VALUES (1, $1::vector)', [
      toSql(axis(0)),
    ]);
    await gate.query('INSERT INTO gate1_vec (id, embedding) VALUES (2, $1::vector)', [
      toSql(axis(1)),
    ]);

    const knn = await gate.query<{ id: number; cosine: number }>(
      `SELECT id, 1 - (embedding <=> $1::vector) AS cosine
         FROM gate1_vec ORDER BY embedding <=> $1::vector LIMIT 2`,
      [toSql(axis(0))],
    );
    expect(knn.rows[0]?.id).toBe(1);
    expect(Number(knn.rows[0]?.cosine)).toBeCloseTo(1, 5);
    expect(knn.rows[1]?.id).toBe(2);
    expect(Number(knn.rows[1]?.cosine)).toBeCloseTo(0, 5);
  });

  test('STORED generated tsvector + GIN + plainto_tsquery work on the migrated table', async () => {
    const sourceId = uuidv7();
    await gate.query(
      `INSERT INTO sources (id, kind, uri, project_id) VALUES ($1::uuid, 'explicit', 'gate1://probe', NULL)`,
      [sourceId],
    );
    const memoryId = uuidv7();
    await gate.query(
      `INSERT INTO memories (id, type, content, content_hash, importance, confidence, observed_at, valid_from, source_id, title)
         VALUES ($1::uuid, 'semantic', 'This project uses Bun for tests and Postgres for storage',
                 $2, 0.6, 0.7, now(), now(), $3::uuid, 'gate1 probe')`,
      [memoryId, memoryContentHash('This project uses Bun for tests and Postgres for storage'), sourceId],
    );

    // The generated column is maintained by Postgres itself.
    const generated = await gate.query<{ search_text: unknown }>(
      'SELECT search_text FROM memories WHERE id = $1::uuid',
      [memoryId],
    );
    expect(generated.rows[0]?.search_text).toBeTruthy();

    // GIN-backed match via plainto_tsquery.
    const fts = await gate.query<{ id: string }>(
      `SELECT id FROM memories
        WHERE search_text @@ plainto_tsquery('simple', 'bun tests storage')
        ORDER BY id`,
      [],
    );
    expect(fts.rows.map((row) => row.id)).toContain(memoryId);

    // And it ranks the right row first.
    const rank = await gate.query<{ id: string }>(
      `SELECT id FROM memories
        WHERE search_text @@ plainto_tsquery('simple', 'bun tests')
        ORDER BY ts_rank(search_text, plainto_tsquery('simple', 'bun tests')) DESC`,
      [],
    );
    expect(rank.rows[0]?.id).toBe(memoryId);
  });

  test('partial + expression unique indexes enforce (jobs singleton, memories dedupe)', async () => {
    // jobs singleton: (kind, (payload->>'key')) WHERE status IN ('pending','running').
    const key = `gate1-${uuidv7().slice(0, 8)}`;
    const insert = (status: string) =>
      gate.query(
        `INSERT INTO jobs (id, kind, payload, status)
           VALUES ($1::uuid, 'normalize', $2::jsonb, $3)`,
        [uuidv7(), JSON.stringify({ key }), status],
      );
    await insert('pending');
    await expect(insert('pending')).rejects.toThrow(/jobs_singleton_idx/);
    await expect(insert('running')).rejects.toThrow(/jobs_singleton_idx/);
    // The partial predicate exempts terminal statuses.
    await insert('done');
    await insert('done');

    // memories dedupe: coalesce(NULL project) collides for NULL-scope rows with equal type+hash.
    const content = `gate1 dedupe ${uuidv7().slice(0, 8)}`;
    const hash = memoryContentHash(content);
    const row = (id: string) => [
      id,
      'semantic',
      content,
      hash,
      0.5,
      0.5,
    ] as const;
    const memoryInsert = (id: string) =>
      gate.query(
        `INSERT INTO memories (id, type, content, content_hash, importance, confidence, observed_at, valid_from, source_id)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, now(), now(), (SELECT id FROM sources LIMIT 1))`,
        [...row(id)],
      );
    await memoryInsert(uuidv7());
    await expect(memoryInsert(uuidv7())).rejects.toThrow(/memories_dedupe_idx/);
  });

  test('FOR UPDATE SKIP LOCKED claim semantics work (the jobs claim statement)', async () => {
    const key = `claim-${uuidv7().slice(0, 8)}`;
    const enqueued = await gate.query<{ id: string }>(
      `INSERT INTO jobs (id, kind, payload, run_at) VALUES ($1::uuid, 'normalize', $2::jsonb, '2026-10-03T00:00:00.000Z'::timestamptz) RETURNING id`,
      [uuidv7(), JSON.stringify({ key })],
    );
    const jobId = enqueued.rows[0]!.id;

    const claimed = await gate.query<{ id: string; locked_by: string }>(
      `UPDATE jobs
          SET status = 'running', locked_by = $1, locked_at = $2::timestamptz, updated_at = now()
        WHERE id IN (
          SELECT id FROM jobs
            WHERE (status = 'pending' AND run_at <= $2::timestamptz)
               OR (status = 'running' AND locked_at <= $2::timestamptz - ($3::text || ' seconds')::interval)
            ORDER BY run_at ASC
            LIMIT 10
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, locked_by`,
      ['gate1-w1', '2026-10-03T12:00:00.000Z', '60'],
    );
    const mine = claimed.rows.find((row) => row.id === jobId);
    expect(mine?.locked_by).toBe('gate1-w1');

    // The lease-expiry reclaim arm of the same statement (locked_at 90s in the past).
    await gate.query(`UPDATE jobs SET locked_at = now() - interval '90 seconds' WHERE id = $1::uuid`, [
      jobId,
    ]);
    const reclaimed = await gate.query<{ locked_by: string }>(
      `UPDATE jobs
          SET status = 'running', locked_by = $1, locked_at = $2::timestamptz, updated_at = now()
        WHERE id IN (
          SELECT id FROM jobs
            WHERE (status = 'pending' AND run_at <= $2::timestamptz)
               OR (status = 'running' AND locked_at <= $2::timestamptz - ($3::text || ' seconds')::interval)
            ORDER BY run_at ASC
            LIMIT 10
            FOR UPDATE SKIP LOCKED
        )
        RETURNING locked_by`,
      ['gate1-w2', new Date().toISOString(), '60'],
    );
    expect(reclaimed.rows.find((row) => row.locked_by === 'gate1-w2')).toBeDefined();
  });

  test('cell types round-trip: timestamptz, arrays, jsonb', async () => {
    const roundTrip = await gate.query<{
      at: string | Date;
      tags: string[];
      payload: Record<string, unknown>;
    }>(
      `SELECT now()::timestamptz AS at,
              ARRAY['a','b c','d']::text[] AS tags,
              '{"nested": {"n": [1,2,3]}, "s": "x"}'::jsonb AS payload`,
    );
    const { at, tags, payload } = roundTrip.rows[0]!;
    expect(new Date(at).getTime()).not.toBeNaN();
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toHaveLength(3);
    expect(payload.nested).toEqual({ n: [1, 2, 3] });

    // Parameterized array + jsonb writes round-trip too.
    const id = uuidv7();
    await gate.query(
      `INSERT INTO jobs (id, kind, payload) VALUES ($1::uuid, 'normalize', $2::jsonb)`,
      [id, JSON.stringify({ key: `rt-${id.slice(0, 8)}`, list: [1, 2, 3] })],
    );
    const readBack = await gate.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM jobs WHERE id = $1::uuid',
      [id],
    );
    expect(readBack.rows[0]?.payload).toEqual({ key: `rt-${id.slice(0, 8)}`, list: [1, 2, 3] });
  });

  test('migrations apply cleanly twice on the raw client', async () => {
    await migrateEmbedded(gate.pglite);
    await migrateEmbedded(gate.pglite);
    const tables = await gate.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name IN (
          'users','projects','sources','events','memories','memory_vectors','entities',
          'memory_entities','edges','decisions','failures','skills','sessions','working_memory',
          'jobs','memory_events','system_state','repositories','file_fingerprints','code_symbols',
          'memory_code_refs'
        )`,
    );
    expect(tables.rows[0]?.n).toBe(21);
  });

  test('data persists across close/reopen (rows, vectors, FTS)', async () => {
    // Own the dataDir directly — the harness close() deletes temp dirs, but this test needs the
    // bytes to survive a close so a "new process" can reopen them.
    const persistDir = await mkdtemp(join(tmpdir(), 'onemem-gate1-persist-'));
    try {
      const first = await createEmbeddedDb(persistDir);
      const marker = `persist ${uuidv7().slice(0, 8)}`;
      const project = await first.store.createProject({ name: `persist-${marker}` });
      const source = await first.store.createSource({
        kind: 'explicit',
        uri: `persist://${marker}`,
        project_id: project.id,
      });
      const written = await first.store.insertMemory({
        type: 'semantic',
        content: `Persistence marker ${marker} uses Bun`,
        importance: 0.5,
        confidence: 0.5,
        observed_at: '2025-01-01T00:00:00.000Z',
        source_id: source.id,
        project_id: project.id,
        evidence: [{ source_id: source.id, kind: 'message', locator: 'l', excerpt: marker }],
        extraction: { method: 'heuristic', prompt_version: 'gate1' },
      });
      const axis = Array.from({ length: 384 }, (_, i) => (i === 5 ? 1 : 0));
      await first.vectors.upsert(written.memory.id, axis);
      await first.close();

      // Reopen the same dataDir as a fresh process would — everything must still be there.
      const reopened = await createEmbeddedDb(persistDir);
      try {
        const memory = await reopened.store.getMemory(written.memory.id);
        expect(memory?.content).toContain(marker);

        const knn = await reopened.vectors.search(axis, 1);
        expect(knn[0]?.memory_id).toBe(written.memory.id);

        const fts = await reopened.client.query<{ id: string }>(
          `SELECT id FROM memories WHERE search_text @@ plainto_tsquery('simple', $1)`,
          [marker],
        );
        expect(fts.rows.map((row) => row.id)).toContain(written.memory.id);
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  test('EmbeddingIndex backend selection is honest (auto/forced/fallback)', async () => {
    // On a fully-migrated instance with the extension: auto → pgvector.
    const auto = await createEmbeddingIndex(gate, { dim: 384, model: 'gate1' });
    expect(auto.backend).toBe('pgvector');

    // Without the extension (models a PGlite build lacking vector support): auto → float8,
    // forced pgvector fails LOUDLY — deployment misconfiguration must not degrade silently.
    const plainDir = await mkdtemp(join(tmpdir(), 'onemem-gate1-plain-'));
    try {
      const plain = await createEmbeddedClient(plainDir, { vectorExtension: false });
      try {
        const fallback = await createEmbeddingIndex(plain, { dim: 384, model: 'gate1' });
        expect(fallback.backend).toBe('float8');
        await expect(
          createEmbeddingIndex(plain, { dim: 384, model: 'gate1', backend: 'pgvector' }),
        ).rejects.toBeInstanceOf(EmbeddingIndexError);
      } finally {
        await plain.close();
      }
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});
