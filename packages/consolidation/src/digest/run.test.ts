/**
 * The digest PASS over real embedded storage (PGlite): the full lifecycle the mission pins —
 * created → unchanged → refreshed (audited supersession) → the documented text-cycle gap — plus
 * the budget override, both skipped outcomes, and the never-throws failure path. Every write
 * rides the real audited Store paths (insertMemory / supersede / addEdge) and the real
 * `projects.digest` merge; nothing here uses a model or the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runDigest, runProjectDigest } from './run';
import { seedDigestWorld, WORLD_NOW, type DigestWorld } from './fixtures';

const pass = (world: DigestWorld) => ({
  store: world.storage.store,
  client: world.storage.client,
  project_id: world.projectId,
  now: WORLD_NOW,
});

describe('runDigest (the persisting pass, real PGlite)', () => {
  let world: DigestWorld;

  beforeEach(async () => {
    world = await seedDigestWorld({ foreignDigest: true }); // pins the foreign-key preservation
  });
  afterEach(async () => {
    await world.close();
  });

  test('created: one well-formed, in-budget digest memory + derived_from edges + projects.digest', async () => {
    const report = await runDigest(pass(world));
    expect(report.outcome).toBe('created');
    expect(report.memory_id).toBeTruthy();

    // --- the durable digest memory -----------------------------------------------------------
    const memory = await world.storage.store.getMemory(report.memory_id!);
    expect(memory).not.toBeNull();
    expect(memory!.type).toBe('semantic');
    expect(memory!.subtype).toBe('project_context');
    expect(memory!.tags).toEqual(['project_digest', 'project_context']);
    expect(memory!.status).toBe('active');
    expect(report.digest!.used).toBeLessThanOrEqual(750);
    expect(memory!.token_estimate).toBe(report.digest!.used);
    expect(memory!.provenance.evidence.length).toBeGreaterThan(0);
    expect(memory!.content).toContain('project: acme-api');
    expect(memory!.content).toContain('top decisions:');
    // Newest accepted decision first; the rejected one never appears.
    expect(memory!.content.indexOf('Adopt Bun for install, test and dev.')).toBeLessThan(
      memory!.content.indexOf('Use PostgreSQL as the primary database for the invoice API.'),
    );
    expect(memory!.content).not.toContain('SQLite for local development');
    expect(memory!.content).toContain('known failures:');
    expect(memory!.content).toContain('Cloud Run deploys fail with OOM → Raise the container memory limit to 1GiB for deploys');
    expect(memory!.content).toContain('procedures:');
    expect(memory!.content).toContain('Run migrations before serve');
    // Distractor types are never cited.
    expect(memory!.content).not.toContain('pair-programmed');
    expect(memory!.content).not.toContain('tabs over spaces');

    // --- derived_from edges to EXACTLY the cited sources ---------------------------------------
    const edges = (await world.storage.store.listEdges(report.memory_id!)).filter(
      (edge) => edge.relation === 'derived_from' && edge.from_memory_id === report.memory_id,
    );
    const targets = new Set(edges.map((edge) => edge.to_memory_id));
    const expected = new Set([
      world.cited.decisionB.id,
      world.cited.decisionA.id,
      world.cited.failureOpen.id,
      world.cited.failureSolved.id,
      world.cited.procedureA.id,
      world.cited.procedureB.id,
    ]);
    expect(targets).toEqual(expected);
    expect(report.digest!.source_ids.length).toBe(6);

    // --- projects.digest: the renderable record the MCP tool reads -----------------------------
    const project = await world.storage.store.getProject(world.projectId);
    expect(project!.digest['summary']).toBe('Invoice REST API in TypeScript'); // foreign key preserved
    expect(project!.digest['decision_01']).toBe(world.cited.decisionB.line);
    expect(project!.digest['decision_02']).toBe(world.cited.decisionA.line);
    expect(project!.digest['failure_01']).toBe(world.cited.failureOpen.line);
    expect(project!.digest['failure_02']).toBe(world.cited.failureSolved.line);
    expect(project!.digest['procedure_01']).toBe(world.cited.procedureA.line);
    expect(project!.digest['procedure_02']).toBe(world.cited.procedureB.line);

  });

  test('unchanged: re-running with the same content hash writes nothing new', async () => {
    const first = await runDigest(pass(world));
    expect(first.outcome).toBe('created');
    const second = await runDigest(pass(world));

    expect(second.outcome).toBe('unchanged');
    expect(second.memory_id).toBe(first.memory_id);
    expect(second.digest!.content_hash).toBe(first.digest!.content_hash);
    expect(second.warnings).toEqual([]);

    const memory = await world.storage.store.getMemory(second.memory_id!);
    expect(memory!.status).toBe('active');
    // No supersession chain appeared: the digest is still the only one.
    expect(await world.storage.store.historyOf(second.memory_id!)).toHaveLength(1);

  });

  test('refreshed: a changed rollup supersedes the predecessor through the audited transaction', async () => {
    const first = await runDigest(pass(world));
    expect(first.outcome).toBe('created');

    // A later accepted decision changes the rollup.
    await world.storage.store.insertMemory({
      type: 'decision',
      title: 'Adopt pgvector for similarity',
      content: 'Adopt pgvector for similarity search across memories.',
      content_summary: 'Adopt pgvector for similarity search.',
      importance: 0.8,
      confidence: 0.9,
      observed_at: '2026-10-01T00:00:00.000Z',
      valid_from: '2026-10-01T00:00:00.000Z',
      project_id: world.projectId,
      source_id: world.sourceId,
      evidence: [
        {
          source_id: world.sourceId,
          kind: 'message',
          locator: 'conversation/digest-fixture:new',
          excerpt: 'Adopt pgvector for similarity search across memories.',
        },
      ],
      extraction: { method: 'heuristic', prompt_version: 'digest-fixture-v1' },
      payload: {
        title: 'Adopt pgvector for similarity',
        decision: 'pgvector backs similarity search',
        alternatives: [],
        rationale: 'one index with the vectors',
        participants: [],
        decided_at: '2026-10-01T00:00:00.000Z',
        status: 'accepted',
      },
    });

    const refreshed = await runDigest(pass(world));
    expect(refreshed.outcome).toBe('refreshed');
    expect(refreshed.memory_id).not.toBe(first.memory_id);
    expect(refreshed.memory_id).toBeTruthy();
    expect(refreshed.digest!.used).toBeLessThanOrEqual(750);
    expect(refreshed.digest!.text).toContain('Adopt pgvector for similarity search.');

    // The predecessor closed into the winner — audited, with the digest's supersede reason.
    const loser = await world.storage.store.getMemory(first.memory_id!);
    expect(loser!.status).toBe('superseded');
    expect(loser!.superseded_by).toBe(refreshed.memory_id!);
    const audit = await world.storage.store.listMemoryEvents(first.memory_id!);
    const transition = audit.find((event) => event.action === 'status_changed');
    expect(transition!.to_status).toBe('superseded');
    expect(transition!.details['reason']).toBe('project_digest_refresh');
    expect(transition!.details['superseded_by']).toBe(refreshed.memory_id!);

    // The chain walks oldest-first; the current row is the only active digest.
    const history = await world.storage.store.historyOf(refreshed.memory_id!);
    expect(history.map((row) => row.id)).toEqual([first.memory_id!, refreshed.memory_id!]);
    const currentDigests = (await world.storage.store.queryCurrent({
      project_id: world.projectId,
      types: ['semantic'],
      limit: 100,
    })).filter((row) => row.subtype === 'project_context');
    expect(currentDigests).toHaveLength(1);
    expect(currentDigests[0]!.id).toBe(refreshed.memory_id!);

    // The renderable record followed the refresh (the newest decision is entry 01).
    const project = await world.storage.store.getProject(world.projectId);
    expect(project!.digest['decision_01']).toContain('Adopt pgvector for similarity search.');

  });

  test('the text-cycle gap is honest: a rollup that matches a superseded digest warns, never fabricates', async () => {
    const first = await runDigest(pass(world));
    expect(first.outcome).toBe('created');
    // Add a decision, refresh (text2), then archive it — the rollup text returns to text1, which
    // now matches the SUPERSEDED first digest: the dedupe index blocks re-inserting it (the
    // documented M4f-follow-up gap), so the pass reports unchanged + a warning, never a fake row.
    await world.storage.store.insertMemory({
      type: 'decision',
      title: 'Adopt pgvector for similarity',
      content: 'Adopt pgvector for similarity search across memories.',
      content_summary: 'Adopt pgvector for similarity search.',
      importance: 0.8,
      confidence: 0.9,
      observed_at: '2026-10-01T00:00:00.000Z',
      valid_from: '2026-10-01T00:00:00.000Z',
      project_id: world.projectId,
      source_id: world.sourceId,
      evidence: [
        {
          source_id: world.sourceId,
          kind: 'message',
          locator: 'conversation/digest-fixture:cycle',
          excerpt: 'Adopt pgvector for similarity search across memories.',
        },
      ],
      extraction: { method: 'heuristic', prompt_version: 'digest-fixture-v1' },
      payload: {
        title: 'Adopt pgvector for similarity',
        decision: 'pgvector backs similarity search',
        alternatives: [],
        participants: [],
        decided_at: '2026-10-01T00:00:00.000Z',
        status: 'accepted',
      },
    });
    const refreshed = await runDigest(pass(world));
    expect(refreshed.outcome).toBe('refreshed');

    const extraDecision = (await world.storage.store.queryCurrent({
      project_id: world.projectId,
      types: ['decision'],
      limit: 10,
    })).find((row) => row.title === 'Adopt pgvector for similarity');
    expect(extraDecision).toBeDefined();
    await world.storage.store.updateMemoryStatus(extraDecision!.id, 'archived', {
      actor: 'test:digest',
      reason: 'text-cycle fixture',
    });

    const cycled = await runDigest(pass(world));
    expect(cycled.outcome).toBe('unchanged');
    expect(cycled.warnings.some((warning) => warning.includes('superseded historical digest'))).toBe(true);
    // The current digest row is untouched by the failed refresh attempt.
    const stillCurrent = await world.storage.store.getMemory(refreshed.memory_id!);
    expect(stillCurrent!.status).toBe('active');

  });

  test('a budget override bounds the digest (used ≤ budget, whole lines kept)', async () => {
    const report = await runDigest({ ...pass(world), budget: 150 });
    expect(report.outcome).toBe('created');
    expect(report.digest!.budget).toBe(150);
    expect(report.digest!.used).toBeLessThanOrEqual(150);
    // The identity header always survives; whatever fit the allowances is whole-line packed.
    expect(report.digest!.text).toContain('project: acme-api');

  });

  test('skipped: a project with no digest sources reports honestly and writes nothing', async () => {
    const report = await runDigest({ ...pass(world), project_id: world.emptyProjectId });
    expect(report.outcome).toBe('skipped');
    expect(report.memory_id).toBeNull();
    expect(report.digest).not.toBeNull();
    expect(report.digest!.source_ids).toEqual([]);
    expect(report.warnings[0]).toContain('no decisions, failures, or procedures');

    const project = await world.storage.store.getProject(world.emptyProjectId);
    expect(Object.keys(project!.digest)).toHaveLength(0);
    const digests = (await world.storage.store.queryCurrent({
      project_id: world.emptyProjectId,
      types: ['semantic'],
      limit: 10,
    })).filter((row) => row.subtype === 'project_context');
    expect(digests).toHaveLength(0);

  });

  test('skipped: an unknown project reports honestly (never a fabricated digest)', async () => {
    const report = await runDigest({
      ...pass(world),
      project_id: '00000000-0000-7000-8000-000000000099',
    });
    expect(report.outcome).toBe('skipped');
    expect(report.digest).toBeNull();
    expect(report.warnings[0]).toContain('not found');

  });

  test('failed: a storage error is an honest failed outcome with a warning, never a throw', async () => {
    const report = await runDigest({
      ...pass(world),
      store: {
        ...world.storage.store,
        findDuplicate: async () => {
          throw new Error('probe failed (fixture)');
        },
      },
    });
    expect(report.outcome).toBe('failed');
    expect(report.memory_id).toBeNull();
    expect(report.warnings[0]).toContain('project digest pass failed');
    expect(report.warnings[0]).toContain('probe failed');

  });
});

describe('runProjectDigest (the read-only builder over real reads)', () => {
  test('pulls decisions/failures/procedures only, in the session-context order', async () => {
    const world = await seedDigestWorld();
    try {
      const candidate = await runProjectDigest({
        store: world.storage.store,
        client: world.storage.client,
        project_id: world.projectId,
        now: WORLD_NOW,
      });
      expect(candidate).not.toBeNull();
      expect(candidate!.sources).toEqual({ decisions: 2, failures: 2, procedures: 2 });
      expect(candidate!.sections.decisions).toEqual([world.cited.decisionB.line, world.cited.decisionA.line]);
      expect(candidate!.sections.failures).toEqual([world.cited.failureOpen.line, world.cited.failureSolved.line]);
      expect(candidate!.sections.procedures).toEqual([world.cited.procedureA.line, world.cited.procedureB.line]);
      expect(candidate!.kind).toBe('project_context');
      expect(candidate!.used).toBeLessThanOrEqual(750);
    } finally {
      await world.close();
    }
  });

  test('returns null for an unknown project', async () => {
    const world = await seedDigestWorld();
    try {
      const candidate = await runProjectDigest({
        store: world.storage.store,
        client: world.storage.client,
        project_id: '00000000-0000-7000-8000-000000000098',
        now: WORLD_NOW,
      });
      expect(candidate).toBeNull();
    } finally {
      await world.close();
    }
  });
});
