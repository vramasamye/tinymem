/**
 * The cross-phrasing conflict tier end to end over REAL embedded storage (PGlite) and the REAL
 * vector index — the M11b `contradiction_accuracy` miss this work closes:
 *
 *   "Decision: use PostgreSQL with pgvector as the only database dialect"
 *   "Decision: use MySQL for the primary datastore"
 *
 * Different attribute templates, same question, incompatible answers. The template heuristic can
 * never form the candidate (it groups by identical template), so without the tier the pair stays
 * silently current. Here the vector channel supplies the candidates (semantic proximity) and the
 * router's `conflict` operation adjudicates them.
 *
 * Two invariants are pinned against real storage:
 *   - OFFLINE (no router / no `conflict` route): byte-identical to today — both rows stay active,
 *     no LLM-tier record, no cross-phrasing candidate is even generated;
 *   - ONLINE: the pair is a candidate, the model flags it, authority resolves it (newer wins),
 *     the loser is superseded through the audited path, and the record carries `tier: 'llm'`.
 *
 * The embedder and the vector index are real; only the model router is a double (src/testing.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokens, type MemoryRecord, type NewMemory } from '@onememory/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory/storage';

import { runConsolidation } from './run';
import { FakeRouter, TableEmbedder } from './testing';

const VECTOR_MODEL = 'test/model';
// `memory_vectors.embedding` is `vector(384)` (database-schema.md §5); the fixtures are 384-dim.
const VECTOR_DIM = 384;
const NOW = new Date('2026-10-01T00:00:00.000Z');

const PG = 'Decision: use PostgreSQL with pgvector as the only database dialect';
const MYSQL = 'Decision: use MySQL for the primary datastore';
// A compatible restatement of PG: close enough to be a candidate, but the model must clear it.
const PG_RESTATE = "Decision: PostgreSQL is the project's primary datastore";

/** A 2-axis vector on axes 380/381 (zero-padded) — the cosines below are exact by construction. */
function axis2(x: number, y: number): number[] {
  const vector = Array.from({ length: VECTOR_DIM }, () => 0);
  vector[380] = x;
  vector[381] = y;
  return vector;
}

//   PG × MYSQL     ≈ 0.894  — a candidate (≥ 0.75), NOT a near-duplicate (< 0.97)
//   PG × PG_RESTATE≈ 0.944  — a candidate, but compatible (the model clears it)
//   MYSQL × RESTATE≈ 0.697  — below the candidate floor: never probed
const VECTORS: Record<string, number[]> = {
  [PG]: axis2(1, 0),
  [MYSQL]: axis2(1, 0.5),
  [PG_RESTATE]: axis2(1, -0.35),
};

interface World {
  storage: OnememoryStorage;
  dataDir: string;
  projectId: string;
  sourceId: string;
  inserted: Map<string, MemoryRecord>;
  embedder: TableEmbedder;
}

async function insert(world: World, candidate: NewMemory): Promise<MemoryRecord> {
  const write = await world.storage.store.insertMemory(candidate);
  expect(write.outcome).toBe('inserted');
  const vector = VECTORS[candidate.content];
  if (vector === undefined) throw new Error(`no fixture vector for: ${candidate.content}`);
  await world.storage.vectors.upsert(write.memory.id, vector);
  world.inserted.set(candidate.content, write.memory);
  return write.memory;
}

function decision(world: World, content: string, observed_at: string): NewMemory {
  return {
    type: 'decision',
    content,
    importance: 0.9,
    confidence: 0.8,
    observed_at,
    project_id: world.projectId,
    source_id: world.sourceId,
    evidence: [
      {
        source_id: world.sourceId,
        kind: 'message',
        locator: `session.jsonl:${world.inserted.size + 1}`,
        excerpt: content.slice(0, 80),
      },
    ],
    extraction: { method: 'heuristic', prompt_version: 'fixture-v1', adapter: 'extraction' },
    tags: ['extracted'],
    token_estimate: estimateTokens(content),
  };
}

let world: World;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-conflict-'));
  const storage = await createEmbeddedDb(dataDir, { vector: { model: VECTOR_MODEL, dim: VECTOR_DIM } });
  const project = await storage.store.createProject({ name: 'conflict-fixture', root_path: dataDir });
  const source = await storage.store.createSource({
    kind: 'conversation',
    uri: 'session/conflict-fixture',
    title: 'conflict fixture',
    project_id: project.id,
  });
  world = {
    storage,
    dataDir,
    projectId: project.id,
    sourceId: source.id,
    inserted: new Map(),
    embedder: new TableEmbedder(VECTORS, VECTOR_MODEL, VECTOR_DIM),
  };
});

afterAll(async () => {
  await world.storage.close();
  await rm(world.dataDir, { recursive: true, force: true });
});

describe('the cross-phrasing conflict tier (real embedded storage)', () => {
  test('offline default is byte-identical; the conflict route resolves the miss', async () => {
    const pg = await insert(world, decision(world, PG, '2026-09-20T00:00:00.000Z'));
    const mysql = await insert(world, decision(world, MYSQL, '2026-09-10T00:00:00.000Z'));
    const restate = await insert(world, decision(world, PG_RESTATE, '2026-09-15T00:00:00.000Z'));

    // --- OFFLINE (no router): the template heuristic alone — nothing is a candidate ----------
    const offline = await runConsolidation({
      store: world.storage.store,
      vectors: world.storage.vectors,
      embedder: world.embedder,
      scope: { project_id: world.projectId },
      actor: 'test:conflict',
      now: () => NOW,
    });
    expect(offline.contradictions.resolved).toBe(0);
    expect(offline.contradictions.records).toEqual([]);
    for (const row of [pg, mysql, restate]) {
      const record = await world.storage.store.getMemory(row.id);
      expect(record?.status).toBe('active');
    }

    // --- a router WITHOUT a `conflict` route is still offline: no model call, no tier ---------
    // The gate is the route, not the router's existence (decision: arbiter runs only when a
    // `conflict` route is configured).
    const noConflictRoute = new FakeRouter({ configured: ['consolidate'], respond: () => ({ contradicts: true }) });
    const stillOffline = await runConsolidation({
      store: world.storage.store,
      vectors: world.storage.vectors,
      embedder: world.embedder,
      router: noConflictRoute,
      scope: { project_id: world.projectId },
      actor: 'test:conflict',
      now: () => NOW,
    });
    expect(stillOffline.contradictions.resolved).toBe(0);
    expect(noConflictRoute.requests).toHaveLength(0);
    // The degradation is explicit, never silent: the run says why cross-phrasing was skipped.
    expect(
      stillOffline.warnings.some((warning) => warning.includes('no `conflict` route configured')),
    ).toBeTrue();
    for (const row of [pg, mysql, restate]) {
      const record = await world.storage.store.getMemory(row.id);
      expect(record?.status).toBe('active');
    }

    // --- ONLINE: the vector channel makes the cross-phrasing pair a candidate ----------------
    const router = new FakeRouter({
      configured: ['conflict'],
      // The verdict the reasoning model would return: incompatible only for the MySQL claim.
      respond: (request) => ({ contradicts: /mysql/i.test(request.prompt) }),
    });
    const report = await runConsolidation({
      store: world.storage.store,
      vectors: world.storage.vectors,
      embedder: world.embedder,
      router,
      scope: { project_id: world.projectId },
      actor: 'test:conflict',
      now: () => NOW,
    });

    // Exactly one contradiction: the PG/MySQL pair. The compatible restatement is cleared.
    expect(report.contradictions.resolved).toBe(1);
    expect(report.contradictions.disputed_pairs).toBe(0);
    const record = report.contradictions.records[0]!;
    expect(record.tier).toBe('llm');
    expect([record.a_id, record.b_id].sort()).toEqual([pg.id, mysql.id].sort());
    expect(record.outcome).toBe('superseded');

    // Authority: the newer PG decision wins; MySQL is superseded through the audited path.
    expect(record.winner_id).toBe(pg.id);
    const superseded = await world.storage.store.getMemory(mysql.id);
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.superseded_by).toBe(pg.id);
    const winner = await world.storage.store.getMemory(pg.id);
    expect(winner?.status).toBe('active');

    // The compatible restatement is untouched — the model cleared it.
    const stillActive = await world.storage.store.getMemory(restate.id);
    expect(stillActive?.status).toBe('active');
    expect(stillActive?.superseded_by).toBeUndefined();
  });
});
