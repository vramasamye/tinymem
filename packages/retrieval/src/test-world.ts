/**
 * ⚠️ TEST-ONLY — the fixture world for the retrieval integration suites (never exported from
 * the package index; test files import this module by relative path).
 *
 * Seeds a real embedded PGlite (temp dir) with a coherent little project:
 *   - project "acme-api" (with a consolidation-style digest) + project "other-app" (no digest)
 *   - global entities (PostgreSQL, Node.js, Docker) + project entities (Cloud Run, Redis)
 *   - the Node 20 → Node 22 supersession pair (the temporal-correctness fixture)
 *   - deploy procedure, accepted decision (+ decisions payload), open + solved failures
 *     (+ failures payload), a preference, a project-overview semantic memory
 *   - graph edges, one of them not yet valid (edge-validity fixture)
 *   - working memory for session sess-fixture (one entry expires immediately)
 *
 * All fact timestamps are FIXED so every temporal assertion is deterministic. Vectors are
 * upserted through the TEST-ONLY hash-axis embedder (testing.ts).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NewMemory } from '@onememory-ai/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';

import { createTestEmbedder, type TestEmbedder } from './testing';

/** A deterministic "today" for the seeded world (fact timestamps are all before this). */
export const WORLD_NOW = '2027-01-15T00:00:00.000Z';

export interface WorldIds {
  projectId: string;
  otherProjectId: string;
  sourceId: string;
  explicitSourceId: string;
  sessionId: string;
  node20: string;
  node22: string;
  deploy: string;
  decision: string;
  failure: string;
  failureSolved: string;
  preference: string;
  overview: string;
  other: string;
  disputed: string;
  entities: { postgres: string; node: string; docker: string; cloudrun: string; redis: string };
}

export interface WorldHandle {
  storage: OnememoryStorage;
  embedder: TestEmbedder;
  ids: WorldIds;
  close(): Promise<void>;
}

export async function seedWorld(): Promise<WorldHandle> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-retrieval-test-'));
  const storage = await createEmbeddedDb(dataDir, {
    vector: { dim: 384, model: 'test/hash-axes', backend: 'auto' },
  });
  const embedder = createTestEmbedder();
  const { store, client } = storage;

  const project = await store.createProject({
    name: 'acme-api',
    root_path: '/dev/acme-api',
    description: 'Invoice API for Acme',
    digest: {
      summary: 'Invoice REST API in TypeScript',
      stack: ['typescript', 'node', 'postgres'],
      conventions: 'tabs, conventional commits',
    },
  });
  const otherProject = await store.createProject({ name: 'other-app', root_path: '/dev/other-app' });
  const source = await store.createSource({
    kind: 'conversation',
    uri: 'conversation/fixture-session',
    title: 'fixture conversation',
    project_id: project.id,
  });
  const explicitSource = await store.createSource({
    kind: 'explicit',
    uri: 'cli/onemem-remember',
    title: 'explicit user statement',
    project_id: project.id,
  });

  const entities = {
    // project_id omitted = global entity (storage writes NULL).
    postgres: (await store.createEntity({ kind: 'library', name: 'PostgreSQL', aliases: ['postgres', 'pg'] })).id,
    node: (await store.createEntity({ kind: 'language', name: 'Node.js', aliases: ['node', 'nodejs'] })).id,
    docker: (await store.createEntity({ kind: 'tool', name: 'Docker', aliases: ['docker'] })).id,
    cloudrun: (await store.createEntity({ project_id: project.id, kind: 'service', name: 'Cloud Run', aliases: ['cloud run'] })).id,
    redis: (await store.createEntity({ project_id: project.id, kind: 'tool', name: 'Redis', aliases: ['redis'] })).id,
  };

  const base = {
    project_id: project.id,
    source_id: source.id,
    evidence: [{ source_id: source.id, kind: 'message' as const, locator: 'session.jsonl:10', excerpt: 'fixture evidence' }],
    extraction: { method: 'heuristic' as const, prompt_version: 'fixture-v1' },
  };

  /** Insert a fixture memory with the fixture source/evidence defaults + a test vector. */
  // Pick (not Omit): NewMemory carries a loose-object index signature, and Omit over it drops
  // the named keys.
  const insert = async (
    memory: Pick<NewMemory, 'type' | 'content' | 'importance' | 'confidence' | 'observed_at'> &
      Partial<NewMemory>,
  ) => {
    const candidate: NewMemory = {
      project_id: project.id,
      source_id: source.id,
      evidence: base.evidence,
      extraction: base.extraction,
      ...memory,
    };
    const result = await store.insertMemory(candidate);
    if (result.outcome !== 'inserted') {
      throw new Error(`fixture: duplicate insert for "${result.memory.content.slice(0, 40)}"`);
    }
    await storage.vectors.upsert(result.memory.id, (await embedder.embed([result.memory.content]))[0]!);
    return result.memory;
  };

  // The Node 20 → Node 22 supersession pair (temporal-correctness fixture). `supersede` inserts
  // the winner and closes the loser's window in ONE transaction (loser: status superseded,
  // valid_until = winner.observed_at, superseded_by = winner.id).
  const node20 = await insert({
    type: 'semantic',
    title: 'Node version 20',
    content: 'The project runs on Node.js 20. Node version 20 is required for the build.',
    importance: 0.8,
    confidence: 0.85,
    observed_at: '2024-01-15T00:00:00.000Z',
  });
  await store.bindMemoryEntities(node20.id, [{ entity_id: entities.node, role: 'subject' }]);
  const superseded = await store.supersede({
    winner: {
      type: 'semantic',
      title: 'Node version 22',
      content: 'The project runs on Node.js 22. Node version 22 is required for the build.',
      content_summary: 'The project runs on Node.js 22.',
      importance: 0.85,
      confidence: 0.9,
      observed_at: '2025-06-01T00:00:00.000Z',
      project_id: project.id,
      source_id: source.id,
      evidence: base.evidence,
      extraction: base.extraction,
    },
    loser_id: node20.id,
    actor: 'fixture',
    reason: 'Node 22 superseded Node 20',
  });
  if (superseded.outcome !== 'superseded') throw new Error('fixture: supersession did not happen');
  const node22 = superseded.winner;
  await storage.vectors.upsert(node22.id, (await embedder.embed([node22.content]))[0]!);
  await store.bindMemoryEntities(node22.id, [{ entity_id: entities.node, role: 'subject' }]);

  const deploy = await insert({
    type: 'procedural',
    title: 'Deploy to Cloud Run',
    content: 'Deploy the API with gcloud run deploy from the docker container. Run the deploy script after the tests pass.',
    content_summary: 'Deploy the API with gcloud run deploy from the docker container.',
    importance: 0.75,
    confidence: 0.85,
    observed_at: '2025-07-02T00:00:00.000Z',
  });
  await store.bindMemoryEntities(deploy.id, [
    { entity_id: entities.cloudrun, role: 'subject' },
    { entity_id: entities.docker, role: 'context' },
  ]);

  const decision = await insert({
    type: 'decision',
    title: 'Use PostgreSQL as the primary database',
    content: 'Use PostgreSQL as the primary database for the invoice API. We chose PostgreSQL over SQLite for operational maturity and extensions.',
    content_summary: 'Use PostgreSQL as the primary database for the invoice API.',
    importance: 0.9,
    confidence: 0.95,
    observed_at: '2025-05-01T00:00:00.000Z',
    source_id: explicitSource.id,
  });
  await store.bindMemoryEntities(decision.id, [{ entity_id: entities.postgres, role: 'subject' }]);
  await client.query(
    `INSERT INTO decisions (memory_id, title, decision, alternatives, rationale, participants, decided_at, status)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::text[], $7::timestamptz, 'accepted')`,
    [
      decision.id,
      'Use PostgreSQL as the primary database',
      'PostgreSQL is the primary database for the invoice API',
      JSON.stringify([{ option: 'SQLite', why_rejected: 'No operational track record at Acme' }]),
      'Operational maturity and rich extensions; Acme already runs Postgres in production',
      ['team-lead', 'backend'],
      '2025-05-01T00:00:00.000Z',
    ],
  );

  const failure = await insert({
    type: 'failure',
    title: 'Cloud Run deploys OOM',
    content: 'Cloud Run deploys fail with OOM when the container exceeds its memory limits during migrations.',
    content_summary: 'Cloud Run deploys fail with OOM when memory limits are exceeded.',
    importance: 0.7,
    confidence: 0.8,
    observed_at: '2025-08-01T00:00:00.000Z',
  });
  await store.bindMemoryEntities(failure.id, [{ entity_id: entities.cloudrun, role: 'subject' }]);
  await client.query(
    `INSERT INTO failures (memory_id, problem, context, root_cause, solution, verification, status, signature_hash, first_seen_at, last_seen_at, occurrence_count)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, 'open', $7, $8::timestamptz, $9::timestamptz, 3)`,
    [
      failure.id,
      'Cloud Run deploys fail with OOM',
      'gcloud run deploy, migrations step',
      'Container memory limit (512MiB) too low for migrations',
      'Raise the container memory limit to 1GiB for deploys',
      null,
      'fixture-sig-oom',
      '2025-08-01T00:00:00.000Z',
      '2025-09-01T00:00:00.000Z',
    ],
  );

  const failureSolved = await insert({
    type: 'failure',
    title: 'PostgreSQL connection limit exhausted',
    content: 'PostgreSQL connections were exhausted during migrations. Fixed by raising the connection limit and adding pooling.',
    content_summary: 'PostgreSQL connections exhausted during migrations; fixed via pooling.',
    importance: 0.6,
    confidence: 0.75,
    observed_at: '2025-03-10T00:00:00.000Z',
  });
  await store.bindMemoryEntities(failureSolved.id, [{ entity_id: entities.postgres, role: 'subject' }]);
  await client.query(
    `INSERT INTO failures (memory_id, problem, context, root_cause, solution, verification, status, signature_hash, first_seen_at, last_seen_at, occurrence_count)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, 'solved', $7, $8::timestamptz, $9::timestamptz, 2)`,
    [
      failureSolved.id,
      'PostgreSQL connection limit exhausted during migrations',
      'migration scripts against the primary database',
      'Max connections too low for parallel migrations',
      'Raise max_connections and add connection pooling',
      'Migration suite green on 2025-03-10',
      'fixture-sig-connlimit',
      '2025-03-10T00:00:00.000Z',
      '2025-03-12T00:00:00.000Z',
    ],
  );

  const preference = await insert({
    type: 'preference',
    title: 'Prefer tabs',
    content: 'Prefer tabs over spaces in this repository. Formatting uses tabs everywhere.',
    content_summary: 'Prefer tabs over spaces in this repository.',
    importance: 0.5,
    confidence: 0.7,
    observed_at: '2025-01-20T00:00:00.000Z',
  });

  const overview = await insert({
    type: 'semantic',
    title: 'Invoice API overview',
    content: 'The service is a REST API for invoices, written in TypeScript.',
    content_summary: 'A REST API for invoices written in TypeScript.',
    importance: 0.6,
    confidence: 0.7,
    observed_at: '2025-02-01T00:00:00.000Z',
  });

  const other = await insert({
    type: 'semantic',
    content: 'The other-app uses SQLite as its database.',
    importance: 0.5,
    confidence: 0.6,
    observed_at: '2025-04-01T00:00:00.000Z',
    project_id: otherProject.id,
  });

  const disputed = await insert({
    type: 'semantic',
    title: 'SQLite claim (disputed)',
    content: 'The invoice API uses SQLite as its database.',
    importance: 0.55,
    confidence: 0.9,
    observed_at: '2025-05-02T00:00:00.000Z',
  });
  await store.updateMemoryStatus(disputed.id, 'disputed', {
    actor: 'fixture',
    reason: 'contradicts the accepted database decision',
  });

  // Graph edges: decision ↔ deploy (valid), failure ↔ decision (valid), and a NOT-YET-VALID
  // deploy → overview edge (valid_from in the future relative to WORLD_NOW).
  await store.addEdge({ from_memory_id: decision.id, to_memory_id: deploy.id, relation: 'related_to', project_id: project.id });
  await store.addEdge({ from_memory_id: failure.id, to_memory_id: decision.id, relation: 'related_to', project_id: project.id });
  await store.addEdge({
    from_memory_id: deploy.id,
    to_memory_id: overview.id,
    relation: 'related_to',
    project_id: project.id,
    valid_from: '2030-01-01T00:00:00.000Z',
  });
  await store.addEdge({
    from_memory_id: decision.id,
    to_memory_id: disputed.id,
    relation: 'contradicts',
    project_id: project.id,
  });

  // Session working memory (one live task, one live error, one already-expired row).
  const sessionId = 'sess-fixture';
  await store.createSession({
    id: sessionId,
    project_id: project.id,
    runtime: 'claude-code',
    started_at: '2025-12-01T00:00:00.000Z',
  });
  await store.insertWorking({
    session_id: sessionId,
    kind: 'task',
    content: 'Refactor the invoice export endpoint this week',
    importance: 0.5,
    confidence: 0.6,
    expires_at: '2099-01-01T00:00:00.000Z',
  });
  await store.insertWorking({
    session_id: sessionId,
    kind: 'current_error',
    content: 'The redis cache tests are red',
    importance: 0.4,
    confidence: 0.5,
    expires_at: '2099-01-01T00:00:00.000Z',
  });
  await store.insertWorking({
    session_id: sessionId,
    kind: 'open_question',
    content: 'Expired scratch note about the scratchpad',
    importance: 0.3,
    confidence: 0.4,
    expires_at: '2020-01-01T00:00:00.000Z',
  });

  return {
    storage,
    embedder,
    ids: {
      projectId: project.id,
      otherProjectId: otherProject.id,
      sourceId: source.id,
      explicitSourceId: explicitSource.id,
      sessionId,
      node20: node20.id,
      node22: node22.id,
      deploy: deploy.id,
      decision: decision.id,
      failure: failure.id,
      failureSolved: failureSolved.id,
      preference: preference.id,
      overview: overview.id,
      other: other.id,
      disputed: disputed.id,
      entities,
    },
    close: async () => {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
