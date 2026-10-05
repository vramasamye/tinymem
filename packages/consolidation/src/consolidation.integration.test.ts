/**
 * The Phase 3 definition-of-done anchor (docs/plan/phased-plan.md): the Node 20 → 22 → 24
 * scenario end to end over REAL embedded storage (PGlite) and the REAL vector index:
 *
 *   - the newer fact supersedes the older by authority rules, through audited transitions, and
 *     the supersession chain stays queryable at any point in time;
 *   - an authority tie becomes `disputed` — excluded from current answers, still stored;
 *   - repeated/related facts consolidate into one semantic memory with `derived_from` edges;
 *   - near-duplicates merge into their highest-authority survivor (`merged` audit);
 *   - decay archives a faded episodic note but keeps an old decision (archive, never delete);
 *   - the whole pass is idempotent — a second run reports zeros.
 *
 * The embedder and the vector index are the package's test doubles with caller-controlled
 * vectors (src/testing.ts); the store, the transition machine, the audit trail, and the
 * dedupe/supersession/history paths are the real ones.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryRecord, NewMemory } from '@onememory/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory/storage';

import { runConsolidation } from './run';
import { runMergePass } from './merge';
import { TableEmbedder } from './testing';

const VECTOR_MODEL = 'test/model';
// The migrated `memory_vectors.embedding` column is `vector(384)` (database-schema.md §5), so the
// fixture vectors are 384-dimensional. The design is axis-based with zero padding — every
// pairwise cosine below is exact regardless of the trailing zeros.
const VECTOR_DIM = 384;
const NOW = new Date('2026-10-01T00:00:00.000Z');

// --- the vector table: pairwise cosines control every pass ------------------
//   node chain (e1/e2/e3), tie pair (e4/e5): orthogonal — no merge, no clustering
//   merge cluster (e6 x3): identical — cosine 1.0 ≥ 0.97
//   docker cluster: pairwise ≈ 0.79–0.95 — related (≥ 0.75) but NOT near-duplicates (< 0.97)
//   the faded note (e8): orthogonal to everything
const E = (index: number): number[] => Array.from({ length: VECTOR_DIM }, (_, i) => (i === index ? 1 : 0));

const VECTORS: Record<string, number[]> = {
  'Version: Node 20': E(0),
  'Version: Node 22': E(1),
  'Version: Node 24': E(2),
  'App port: 3000': E(3),
  'App port: 5000': E(4),
  'Tests run with bun test': E(5),
  'The suite runs on bun test': E(5),
  'bun test is the test runner': E(5),
  'Deployed the api with docker': pad([1, 0.5]),
  'docker deploy completed for the api service': pad([1, -0.2]),
  'Shipped the api through docker': pad([1, 0.15]),
  'Wrote notes about the migration plan': E(7),
  'Decision: use PostgreSQL for the main store': E(7),
  'Cache TTL: 300 seconds': E(9),
  'Cache TTL: 900 seconds': E(10),
  'Version: Bun 1.2': E(11),
  'Version: Bun 1.3': E(11),
  'Timeout: 30 seconds': E(17),
  'Timeout: 60 seconds': E(17),
  'Max depth: 10': E(13),
  'Max depth: 20': E(14),
  'Retry limit: 3': E(15),
  'Retry limit: 5': E(16),
};

/** Place a short vector on the last axes (zero-padded to VECTOR_DIM). */
function pad(head: number[]): number[] {
  const vector = Array.from({ length: VECTOR_DIM }, () => 0);
  for (let i = 0; i < head.length; i++) vector[VECTOR_DIM - head.length + i] = head[i]!;
  return vector;
}

interface World {
  storage: OnememoryStorage;
  dataDir: string;
  projectId: string;
  sourceId: string;
  /** An `explicit`-kind source — user statements outrank agent inference (memory-model §9). */
  explicitSourceId: string;
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

function memoryOf(
  world: World,
  overrides: { type?: NewMemory['type']; subtype?: string; content: string; observed_at: string; confidence?: number; importance?: number },
): NewMemory {
  const evidence = [
    {
      source_id: world.sourceId,
      kind: 'message' as const,
      locator: `session.jsonl:${world.inserted.size + 1}`,
      excerpt: overrides.content.slice(0, 80),
    },
  ];
  return {
    type: overrides.type ?? 'episodic',
    ...(overrides.subtype === undefined ? {} : { subtype: overrides.subtype }),
    content: overrides.content,
    importance: overrides.importance ?? 0.65,
    confidence: overrides.confidence ?? 0.7,
    observed_at: overrides.observed_at,
    project_id: world.projectId,
    source_id: world.sourceId,
    evidence,
    extraction: { method: 'heuristic', prompt_version: 'fixture-v1', adapter: 'extraction' },
    tags: ['extracted'],
    token_estimate: Math.ceil(overrides.content.length / 4),
  };
}

let world: World;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-consolidation-'));
  const storage = await createEmbeddedDb(dataDir, { vector: { model: VECTOR_MODEL, dim: VECTOR_DIM } });
  const project = await storage.store.createProject({ name: 'consolidation-fixture', root_path: dataDir });
  const source = await storage.store.createSource({
    kind: 'conversation',
    uri: 'session/consolidation-fixture',
    title: 'consolidation fixture',
    project_id: project.id,
  });
  const explicitSource = await storage.store.createSource({
    kind: 'explicit',
    uri: 'session/consolidation-fixture-explicit',
    title: 'consolidation fixture (explicit user statements)',
    project_id: project.id,
  });
  const embedder = new TableEmbedder(VECTORS, VECTOR_MODEL, VECTOR_DIM);
  world = {
    storage,
    dataDir,
    projectId: project.id,
    sourceId: source.id,
    explicitSourceId: explicitSource.id,
    inserted: new Map(),
    embedder,
  };

  // The Node 20 → 22 → 24 chain: same attribute, incompatible values, escalating time.
  await insert(world, memoryOf(world, { content: 'Version: Node 20', subtype: 'semantic.version', observed_at: '2026-01-10T00:00:00.000Z' }));
  await insert(world, memoryOf(world, { content: 'Version: Node 22', subtype: 'semantic.version', observed_at: '2026-06-10T00:00:00.000Z' }));
  await insert(world, memoryOf(world, { content: 'Version: Node 24', subtype: 'semantic.version', observed_at: '2026-09-10T00:00:00.000Z' }));

  // The authority tie: same template, different values, same class, same time, same confidence.
  await insert(world, memoryOf(world, { content: 'App port: 3000', observed_at: '2026-07-01T12:00:00.000Z', confidence: 0.6 }));
  await insert(world, memoryOf(world, { content: 'App port: 5000', observed_at: '2026-07-01T12:00:00.000Z', confidence: 0.6 }));

  // Near-duplicates: three phrasings of one fact, identical vectors (cosine 1.0).
  await insert(world, memoryOf(world, { content: 'Tests run with bun test', observed_at: '2026-08-01T00:00:00.000Z', confidence: 0.65 }));
  await insert(world, memoryOf(world, { content: 'The suite runs on bun test', observed_at: '2026-08-03T00:00:00.000Z', confidence: 0.65 }));
  await insert(world, memoryOf(world, { content: 'bun test is the test runner', observed_at: '2026-08-05T00:00:00.000Z', confidence: 0.65 }));

  // A contradictory pair with IDENTICAL embeddings (cosine 1.0 ≥ 0.97): a merge must never
  // pre-empt the arbitration — the pair has to reach authority resolution (or a dispute),
  // never a silent absorption (P1 review finding 2).
  await insert(world, memoryOf(world, { content: 'Version: Bun 1.2', observed_at: '2026-05-01T00:00:00.000Z' }));
  await insert(world, memoryOf(world, { content: 'Version: Bun 1.3', observed_at: '2026-08-01T00:00:00.000Z' }));

  // A corroborated, non-contradicting cluster about docker deployments.
  await insert(world, memoryOf(world, { content: 'Deployed the api with docker', observed_at: '2026-09-20T00:00:00.000Z', confidence: 0.7, importance: 0.8 }));
  await insert(world, memoryOf(world, { content: 'docker deploy completed for the api service', observed_at: '2026-09-22T00:00:00.000Z', confidence: 0.7, importance: 0.8 }));
  await insert(world, memoryOf(world, { content: 'Shipped the api through docker', observed_at: '2026-09-24T00:00:00.000Z', confidence: 0.7, importance: 0.8 }));

  // Decay: a faded episodic note vs an old, decay-resistant decision.
  await insert(world, memoryOf(world, { content: 'Wrote notes about the migration plan', observed_at: '2024-01-01T00:00:00.000Z', importance: 0.2, confidence: 0.4 }));
  await insert(world, memoryOf(world, { type: 'decision', content: 'Decision: use PostgreSQL for the main store', observed_at: '2024-01-01T00:00:00.000Z', importance: 0.9, confidence: 0.8 }));
});

afterAll(async () => {
  await world.storage.close();
  await rm(world.dataDir, { recursive: true, force: true });
});

describe('the Phase 3 DoD scenario (real embedded storage)', () => {
  test('Node 20 → 22 → 24: the newer fact supersedes the older by authority rules, audited, chain queryable', async () => {
    const report = await runConsolidation({
      store: world.storage.store,
      vectors: world.storage.vectors,
      embedder: world.embedder,
      scope: { project_id: world.projectId },
      actor: 'test:consolidation',
      now: () => NOW,
    });

    const node20 = world.inserted.get('Version: Node 20')!;
    const node22 = world.inserted.get('Version: Node 22')!;
    const node24 = world.inserted.get('Version: Node 24')!;

    // The chain: 20 closed into 22 (at 22's observation), 22 into 24, 24 active.
    const superseded20 = await world.storage.store.getMemory(node20.id);
    const superseded22 = await world.storage.store.getMemory(node22.id);
    const active24 = await world.storage.store.getMemory(node24.id);
    expect(superseded20?.status).toBe('superseded');
    expect(superseded20?.superseded_by).toBe(node22.id);
    expect(superseded20?.valid_until).toBe('2026-06-10T00:00:00.000Z');
    expect(superseded22?.status).toBe('superseded');
    expect(superseded22?.superseded_by).toBe(node24.id);
    expect(superseded22?.valid_until).toBe('2026-09-10T00:00:00.000Z');
    expect(active24?.status).toBe('active');

    // Audited transitions with the authority rule recorded.
    const audit20 = await world.storage.store.listMemoryEvents(node20.id);
    const transition20 = audit20.find((event) => event.action === 'status_changed');
    expect(transition20?.from_status).toBe('active');
    expect(transition20?.to_status).toBe('superseded');
    expect(transition20?.details['rule']).toBe('newer');
    expect(transition20?.details['contradiction']).toBe(true);

    // Full history walks the chain, oldest first.
    const history = await world.storage.store.historyOf(node20.id);
    expect(history.map((memory) => memory.content)).toEqual(['Version: Node 20', 'Version: Node 22', 'Version: Node 24']);

    // Point-in-time answers: mid-July the project "used" Node 22 (20's window closed in June).
    const asOfJuly = await world.storage.store.queryAsOf('2026-07-15T00:00:00.000Z', { project_id: world.projectId });
    const versions = asOfJuly.filter((memory) => memory.subtype === 'semantic.version');
    expect(versions.map((memory) => memory.content)).toEqual(['Version: Node 22']);

    // Current answers see Node 24 only.
    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    expect(current.filter((memory) => memory.subtype === 'semantic.version').map((memory) => memory.content)).toEqual([
      'Version: Node 24',
    ]);

    // The contradiction pairs this run resolved: the Node chain (two resolutions — the third
    // pair, 20×24, is subsumed by the chain), the Bun pair, and the port pair (a full tie).
    expect(report.contradictions.resolved).toBe(3);
    expect(report.contradictions.disputed_pairs).toBe(1);
    expect(report.warnings).toEqual([]);
  });

  test('an authority tie becomes disputed: excluded from current answers, still stored, conflict-linked', async () => {
    const port3000 = world.inserted.get('App port: 3000')!;
    const port5000 = world.inserted.get('App port: 5000')!;

    const disputedA = await world.storage.store.getMemory(port3000.id);
    const disputedB = await world.storage.store.getMemory(port5000.id);
    expect(disputedA?.status).toBe('disputed');
    expect(disputedB?.status).toBe('disputed');

    // Excluded from current answers.
    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    expect(current.some((memory) => memory.id === port3000.id || memory.id === port5000.id)).toBeFalse();

    // Still in storage, with the audited dispute and the conflict edge (never picked silently).
    // The edge direction is deterministic (older → newer) but the pair is tied in time, so the
    // assertion checks the link either way.
    const auditA = await world.storage.store.listMemoryEvents(port3000.id);
    expect(auditA.some((event) => event.to_status === 'disputed' && event.details['counterpart'] === port5000.id)).toBeTrue();
    const edges = await world.storage.store.listEdges(port3000.id);
    const conflictLink = edges.find((edge) => edge.relation === 'contradicts');
    expect(conflictLink).toBeDefined();
    expect(
      conflictLink?.from_memory_id === port5000.id || conflictLink?.to_memory_id === port5000.id,
    ).toBeTrue();
  });

  test('a contradictory pair with near-identical embeddings is arbitrated by authority, never merged', async () => {
    // The pair that would tempt a merge: identical vectors (cosine 1.0 ≥ 0.97), same scope,
    // same type — but the same attribute with incompatible values. The arbitration must run
    // BEFORE the merge can absorb the pair (otherwise the conflict disappears without a
    // dispute or a `contradicts` edge).
    const bun12 = world.inserted.get('Version: Bun 1.2')!;
    const bun13 = world.inserted.get('Version: Bun 1.3')!;

    // The pair reached AUTHORITY resolution (rule 'newer'), not a merge: the loser closed at
    // the winner's observation, audited as a contradiction.
    const loser = await world.storage.store.getMemory(bun12.id);
    expect(loser?.status).toBe('superseded');
    expect(loser?.superseded_by).toBe(bun13.id);
    expect(loser?.valid_until).toBe('2026-08-01T00:00:00.000Z');
    const loserAudit = await world.storage.store.listMemoryEvents(bun12.id);
    const transition = loserAudit.find((event) => event.action === 'status_changed');
    expect(transition?.details['rule']).toBe('newer');
    expect(transition?.details['contradiction']).toBe(true);

    // The pair is conflict-linked; the winner stays current.
    const edges = await world.storage.store.listEdges(bun12.id);
    expect(edges.some((edge) => edge.relation === 'contradicts')).toBeTrue();
    const winner = await world.storage.store.getMemory(bun13.id);
    expect(winner?.status).toBe('active');

    // NEITHER row carries a `merged` audit event — a merge never absorbed the conflict.
    for (const row of [bun12, bun13]) {
      const audit = await world.storage.store.listMemoryEvents(row.id);
      expect(audit.some((event) => event.action === 'merged')).toBeFalse();
    }
    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    expect(current.filter((memory) => memory.content.startsWith('Version: Bun')).map((m) => m.content)).toEqual([
      'Version: Bun 1.3',
    ]);
  });

  test('near-duplicates merge into their highest-authority survivor with a merged audit row', async () => {
    const m1 = world.inserted.get('Tests run with bun test')!;
    const m2 = world.inserted.get('The suite runs on bun test')!;
    const keeper = world.inserted.get('bun test is the test runner')!; // newest of an equal-authority cluster

    const survivor = await world.storage.store.getMemory(keeper.id);
    const absorbed1 = await world.storage.store.getMemory(m1.id);
    const absorbed2 = await world.storage.store.getMemory(m2.id);
    expect(survivor?.status).toBe('active');
    expect(absorbed1?.status).toBe('superseded');
    expect(absorbed1?.superseded_by).toBe(keeper.id);
    expect(absorbed2?.status).toBe('superseded');
    expect(absorbed2?.superseded_by).toBe(keeper.id);

    // The keeper's merged audit row records the union of the cluster's evidence (order-free).
    const audit = await world.storage.store.listMemoryEvents(keeper.id);
    const merged = audit.find((event) => event.action === 'merged');
    expect(merged).toBeDefined();
    expect((merged?.details['merged_from'] as string[]).sort()).toEqual([m1.id, m2.id].sort());
    expect(merged?.details['evidence_union_count']).toBe(3);

    // One active EPISODIC statement of the fact remains (the derived semantic row cites it);
    // the absorbed rows stay in history.
    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    expect(
      current
        .filter((memory) => memory.type === 'episodic' && memory.content.includes('bun test'))
        .map((memory) => memory.content),
    ).toEqual(['bun test is the test runner']);
    const history = await world.storage.store.historyOf(m1.id);
    expect(history.some((memory) => memory.id === keeper.id)).toBeTrue();
  });

  test('near-identical episodes corroborate into one semantic memory before the merge collapses them', async () => {
    // The starvation shape (P2 review finding 4): three near-identical episodic rows would
    // first merge into one keeper and never reach the ≥ 3 corroboration the derivation needs.
    // The derivation now runs BEFORE the merge: the episodes derive first (one semantic row,
    // `derived_from` edges to every source), then the merge collapses the duplicates — the
    // cluster members stay (the keeper active, the absorbed rows in history with evidence).
    const m1 = world.inserted.get('Tests run with bun test')!;
    const m2 = world.inserted.get('The suite runs on bun test')!;
    const keeper = world.inserted.get('bun test is the test runner')!;

    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    const derived = current.find(
      (memory) => memory.type === 'semantic' && memory.subtype === 'semantic.derived' && memory.content === keeper.content,
    );
    expect(derived).toBeDefined();
    if (!derived) throw new Error('the near-identical cluster was not derived');

    // The representative is the newest phrasing (all equally central — a tie broken by the
    // authority order); corroboration raised confidence and importance over the strongest member.
    expect(derived.observed_at).toBe('2026-08-05T00:00:00.000Z');
    expect(derived.valid_from).toBe('2026-08-01T00:00:00.000Z');
    expect(derived.confidence).toBe(0.75);
    expect(derived.importance).toBe(0.7);
    expect(derived.provenance.evidence).toHaveLength(3);

    // `derived_from` edges to EVERY source — including the two the merge later absorbed.
    const edges = await world.storage.store.listEdges(derived.id);
    const derivedFrom = edges.filter((edge) => edge.relation === 'derived_from');
    expect(derivedFrom.map((edge) => edge.to_memory_id).sort()).toEqual([m1.id, m2.id, keeper.id].sort());

    // Cluster members retained: the keeper stays active; both absorbed rows stay stored with
    // their evidence (history rows, never deleted).
    expect((await world.storage.store.getMemory(keeper.id))?.status).toBe('active');
    for (const absorbed of [m1, m2]) {
      const row = await world.storage.store.getMemory(absorbed.id);
      expect(row?.status).toBe('superseded');
      expect((row?.provenance.evidence.length ?? 0)).toBeGreaterThan(0);
    }
  });

  test('repeated related facts consolidate into one semantic memory with derived_from edges', async () => {
    const d1 = world.inserted.get('Deployed the api with docker')!;
    const d2 = world.inserted.get('docker deploy completed for the api service')!;
    const d3 = world.inserted.get('Shipped the api through docker')!;

    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    // Pinned to the docker cluster (the near-identical bun-test cluster derives its own
    // semantic row now that derivation runs before the merge).
    const derived = current.find(
      (memory) =>
        memory.type === 'semantic' &&
        memory.subtype === 'semantic.derived' &&
        memory.content.includes('docker'),
    );
    expect(derived).toBeDefined();
    if (!derived) throw new Error('the docker cluster was not derived');

    // The representative's statement (most central, the offline template), verbatim.
    expect(derived.content).toBe('Shipped the api through docker');
    expect(derived.observed_at).toBe('2026-09-24T00:00:00.000Z');
    expect(derived.valid_from).toBe('2026-09-20T00:00:00.000Z');
    // Corroboration: three independent observations raise confidence (0.7 → 0.8) and importance.
    expect(derived.confidence).toBe(0.8);
    expect(derived.importance).toBe(0.85);
    // Provenance: a real source and the union of every member's evidence. (The wire record's
    // extraction projection carries method/model/prompt_version — `adapter` is stored but not
    // surfaced on the read path, so the assertion stays on the round-tripped fields.)
    expect(derived.provenance.source.id).toBe(world.sourceId);
    expect(derived.provenance.evidence).toHaveLength(3);
    expect(derived.provenance.extraction.method).toBe('heuristic');
    expect(derived.provenance.extraction.prompt_version).toBe('consolidation/template-merge-1');
    expect(derived.tags).toContain('consolidated');

    // derived_from edges to EVERY source; the sources stay active (they are the evidence).
    const edges = await world.storage.store.listEdges(derived.id);
    const derivedFrom = edges.filter((edge) => edge.relation === 'derived_from');
    expect(derivedFrom.map((edge) => edge.to_memory_id).sort()).toEqual([d1.id, d2.id, d3.id].sort());
    for (const source of [d1, d2, d3]) {
      const record = await world.storage.store.getMemory(source.id);
      expect(record?.status).toBe('active');
    }

    // The cluster's entity is bound as the derived memory's subject.
    const entities = await world.storage.store.listMemoryEntities(derived.id);
    expect(entities.map((entity) => entity.name)).toEqual(['Docker']);
  });

  test('decay archives the faded note, keeps the old decision, and never deletes', async () => {
    const faded = world.inserted.get('Wrote notes about the migration plan')!;
    const decision = world.inserted.get('Decision: use PostgreSQL for the main store')!;

    const archived = await world.storage.store.getMemory(faded.id);
    expect(archived?.status).toBe('archived');
    const audit = await world.storage.store.listMemoryEvents(faded.id);
    const archiveEvent = audit.find((event) => event.action === 'archived');
    expect(archiveEvent).toBeDefined();
    expect(archiveEvent?.details['prominence']).toBeLessThan(archiveEvent?.details['threshold'] as number);
    expect(archiveEvent?.details['decay_resistant']).toBe(false);

    const kept = await world.storage.store.getMemory(decision.id);
    expect(kept?.status).toBe('active'); // decisions are decay-resistant

    // Archived rows are excluded from current answers but still retrievable (archive ≠ delete).
    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    expect(current.some((memory) => memory.id === faded.id)).toBeFalse();
    const stillThere = await world.storage.store.getMemory(faded.id);
    expect(stillThere?.content).toBe('Wrote notes about the migration plan');
  });

  test('a second run is a no-op (idempotent)', async () => {
    const second = await runConsolidation({
      store: world.storage.store,
      vectors: world.storage.vectors,
      embedder: world.embedder,
      scope: { project_id: world.projectId },
      actor: 'test:consolidation',
      now: () => NOW,
    });
    expect(second.merge.clusters).toBe(0);
    expect(second.merge.sources_closed).toBe(0);
    expect(second.contradictions.resolved).toBe(0);
    expect(second.contradictions.disputed_pairs).toBe(0);
    expect(second.derivations.derived).toBe(0);
    expect(second.decay.archived).toBe(0);
    expect(second.warnings).toEqual([]);
  });

  test('degraded mode (no embedder) still resolves contradictions and decays, with a warning', async () => {
    // A fresh pair of contradictory facts, resolved without any embedding provider.
    await insert(world, memoryOf(world, { content: 'Cache TTL: 300 seconds', observed_at: '2026-09-28T00:00:00.000Z' }));
    await insert(world, memoryOf(world, { content: 'Cache TTL: 900 seconds', observed_at: '2026-09-29T00:00:00.000Z' }));

    const report = await runConsolidation({
      store: world.storage.store,
      scope: { project_id: world.projectId },
      actor: 'test:consolidation',
      now: () => NOW,
    });
    expect(report.contradictions.resolved).toBe(1);
    expect(report.merge.clusters).toBe(0);
    expect(report.derivations.derived).toBe(0);
    expect(report.warnings.some((warning) => warning.includes('no embedding provider'))).toBeTrue();

    const ttl300 = world.inserted.get('Cache TTL: 300 seconds')!;
    const superseded = await world.storage.store.getMemory(ttl300.id);
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.superseded_by).toBe(world.inserted.get('Cache TTL: 900 seconds')!.id);
  });

  test('authority always resolves: an older explicit statement beats a newer inference; equal time falls to confidence', async () => {
    // An explicit user statement from August vs a newer, MORE confident inference from
    // September: only rule 1 (explicit > inference) can decide — never a temporal shape, never
    // a skip. (August keeps the explicit row above the decay threshold — the winner must be
    // older than the loser's window, not old enough to archive.)
    const explicitRow = await insert(
      world,
      {
        ...memoryOf(world, { content: 'Max depth: 10', observed_at: '2026-08-01T00:00:00.000Z', confidence: 0.9 }),
        source_id: world.explicitSourceId,
        evidence: [
          {
            source_id: world.explicitSourceId,
            kind: 'message',
            locator: 'session.jsonl:explicit-1',
            excerpt: 'Max depth: 10',
          },
        ],
      },
    );
    const inferredRow = await insert(
      world,
      memoryOf(world, { content: 'Max depth: 20', observed_at: '2026-09-26T00:00:00.000Z', confidence: 0.95 }),
    );

    // Equal time, different confidence: rule 4 decides — nothing is skipped for tying on recency.
    await insert(
      world,
      memoryOf(world, { content: 'Retry limit: 3', observed_at: '2026-09-27T00:00:00.000Z', confidence: 0.9 }),
    );
    await insert(
      world,
      memoryOf(world, { content: 'Retry limit: 5', observed_at: '2026-09-27T00:00:00.000Z', confidence: 0.6 }),
    );

    const report = await runConsolidation({
      store: world.storage.store,
      vectors: world.storage.vectors,
      embedder: world.embedder,
      scope: { project_id: world.projectId },
      actor: 'test:consolidation',
      now: () => NOW,
    });
    expect(report.contradictions.resolved).toBe(2);
    expect(report.contradictions.skipped).toEqual([]);
    const byRule = new Map(report.contradictions.records.map((record) => [record.rule, record]));
    expect(byRule.get('explicit')?.winner_id).toBe(explicitRow.id);
    expect(byRule.get('confidence')?.winner_id).toBe(world.inserted.get('Retry limit: 3')!.id);

    // The explicit winner closed the newer, more confident inference into a zero-width window
    // (valid_until === valid_from): the losing claim was never valid — no point-in-time view
    // ever shows it, and exactly one row stays current.
    const loser = await world.storage.store.getMemory(inferredRow.id);
    expect(loser?.status).toBe('superseded');
    expect(loser?.superseded_by).toBe(explicitRow.id);
    expect(loser?.valid_until).toBe('2026-09-26T00:00:00.000Z'); // its own valid_from — zero-width
    const loserAudit = await world.storage.store.listMemoryEvents(inferredRow.id);
    const loserTransition = loserAudit.find((event) => event.action === 'status_changed');
    expect(loserTransition?.details['rule']).toBe('explicit');
    expect(loserTransition?.details['window']).toBe('zero-width-never-valid');

    // The equal-time confidence pair: the confident row won, the other closed zero-width too.
    const retryLoser = await world.storage.store.getMemory(world.inserted.get('Retry limit: 5')!.id);
    expect(retryLoser?.status).toBe('superseded');
    expect(retryLoser?.superseded_by).toBe(world.inserted.get('Retry limit: 3')!.id);
    expect(retryLoser?.valid_until).toBe('2026-09-27T00:00:00.000Z');
    const retryAudit = await world.storage.store.listMemoryEvents(world.inserted.get('Retry limit: 5')!.id);
    expect(retryAudit.find((event) => event.action === 'status_changed')?.details['rule']).toBe('confidence');

    // Exactly one row of each pair is current; no point-in-time view ever shows a zero-width loser.
    const current = await world.storage.store.queryCurrent({ project_id: world.projectId });
    expect(current.filter((memory) => memory.content.startsWith('Max depth')).map((m) => m.content)).toEqual([
      'Max depth: 10',
    ]);
    expect(current.filter((memory) => memory.content.startsWith('Retry limit')).map((m) => m.content)).toEqual([
      'Retry limit: 3',
    ]);
    const asOf = await world.storage.store.queryAsOf('2026-09-27T00:00:00.000Z', { project_id: world.projectId });
    expect(asOf.filter((memory) => memory.content.startsWith('Max depth')).map((m) => m.content)).toEqual([
      'Max depth: 10',
    ]);
    expect(asOf.filter((memory) => memory.content.startsWith('Retry limit')).map((m) => m.content)).toEqual([
      'Retry limit: 3',
    ]);
  });

  test('the merge pass refuses a contradictory cluster handed to it directly (defense in depth)', async () => {
    // Normally unreachable (the contradiction pass runs first and resolves every detected
    // pair), but a skipped resolution must not turn into a silent absorption: two
    // contradictory statements with IDENTICAL vectors (cosine 1.0), handed straight to the
    // merge pass — it refuses the cluster and leaves the pair for dispute/resolution.
    const t30 = await insert(
      world,
      memoryOf(world, { content: 'Timeout: 30 seconds', observed_at: '2026-09-25T00:00:00.000Z' }),
    );
    const t60 = await insert(
      world,
      memoryOf(world, { content: 'Timeout: 60 seconds', observed_at: '2026-09-26T00:00:00.000Z' }),
    );
    const embeddings = new Map<string, readonly number[]>([
      [t30.id, VECTORS['Timeout: 30 seconds']!],
      [t60.id, VECTORS['Timeout: 60 seconds']!],
    ]);
    const result = await runMergePass(world.storage.store, [t30, t60], world.storage.vectors, embeddings, {
      actor: 'test:consolidation',
      now: NOW,
      cosineThreshold: 0.97,
      neighbors: 10,
    });

    // No cluster merged, no row absorbed; the refusal is explicit, never silent.
    expect(result.records).toEqual([]);
    expect(result.sourcesClosed).toBe(0);
    expect(
      result.warnings.some(
        (warning) => warning.includes('contradiction') && warning.includes(t30.id) && warning.includes(t60.id),
      ),
    ).toBeTrue();

    // Both rows untouched — left in the pool for dispute/resolution.
    for (const row of [t30, t60]) {
      const record = await world.storage.store.getMemory(row.id);
      expect(record?.status).toBe('active');
      expect(record?.superseded_by).toBeUndefined();
    }
  });
});
