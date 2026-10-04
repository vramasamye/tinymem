/**
 * Phase 1 cross-package acceptance: transcript events → heuristic extraction with provenance →
 * explicit audited supersession → current and historical retrieval.
 *
 * Automatic contradiction detection and supersession remain M14 work. This fixture exercises the
 * existing explicit Store.supersede primitive instead of pretending those later stages exist.
 */

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHeuristicClassifier,
  createHeuristicExtractor,
  createExtractHandler,
  storedEventToEnvelope,
} from '@onememory/extraction';
import { createRetrievalEngine } from '@onememory/retrieval';
import { createEmbeddedDb } from '@onememory/storage';
import type { NewMemory } from '@onememory/core';

import {
  FIXTURE_PROJECT_ID,
  FIXTURE_SESSION_ID,
  goldenSession,
  makeInput,
} from '../../../../packages/extraction/src/testing/transcripts';

test('transcript extraction and explicit supersession yield correct current and historical answers', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-extraction-temporal-'));
  let storage: Awaited<ReturnType<typeof createEmbeddedDb>> | undefined;

  try {
    storage = await createEmbeddedDb(dataDir);
    const project = await storage.store.createProject({
      id: FIXTURE_PROJECT_ID,
      name: 'temporal-transcript-fixture',
      root_path: dataDir,
    });

    const node20 = makeInput(
      'conversation.message',
      {
        kind: 'conversation.message',
        role: 'user',
        content: 'We upgraded to Node 20 for the project runtime.',
      },
      { projectId: project.id, sessionId: FIXTURE_SESSION_ID, offsetSeconds: 55 },
    );
    const node22 = makeInput(
      'conversation.message',
      {
        kind: 'conversation.message',
        role: 'user',
        content: 'We upgraded to Node 22 for the project runtime.',
      },
      { projectId: project.id, sessionId: 'sess-node22', offsetSeconds: 120 },
    );

    const transcript = [
      ...goldenSession().filter((input) =>
        !(input.event.payload.kind === 'conversation.message' &&
          input.event.payload.content.includes('upgraded to Node 22'))),
      node20,
    ];
    for (const input of transcript) {
      const outcome = await storage.store.ingestEvent(input.event);
      expect(outcome.status).toBe('stored');
    }

    const extractor = createHeuristicExtractor();
    const classifier = createHeuristicClassifier();
    const extraction = createExtractHandler(
      storage.store,
      storage.jobs,
      extractor,
      classifier,
      { enqueueReEmbed: false },
    );
    const extracted = await extraction({ id: 'extract-temporal-fixture', kind: 'extract', payload: {} });
    expect(extracted.events_processed).toBe(transcript.length);
    expect(extracted.memories_inserted).toBe(8);

    const extractedMemories = await storage.store.queryCurrent({ project_id: project.id });
    const older = extractedMemories.find((memory) => memory.content === 'Version: Node 20');
    const decision = extractedMemories.find((memory) => memory.type === 'decision');
    const failure = extractedMemories.find((memory) => memory.type === 'failure');
    expect(older).toBeDefined();
    expect(decision?.content).toContain('PostgreSQL');
    expect(failure?.content).toContain('resolved by: `bun test`');
    if (!older || !decision || !failure) {
      throw new Error('the golden transcript did not produce its version, decision, and failure');
    }
    for (const memory of [older, decision, failure]) {
      expect(memory.provenance.source.kind).toBe('conversation');
      expect(memory.provenance.evidence.length).toBeGreaterThan(0);
      expect(memory.provenance.extraction.method).toBe('heuristic');
    }

    // Supersede accepts an extracted candidate, not an already inserted winner. The explicit
    // choice below is fixture input; automatic matching/authority resolution belongs to M14.
    expect((await storage.store.ingestEvent(node22.event)).status).toBe('stored');
    const pending = await storage.store.listPendingEvents(25);
    expect(pending).toHaveLength(1);
    const source = await storage.store.createSource({
      kind: 'conversation',
      uri: 'session/sess-node22',
      project_id: project.id,
    });
    const later = await extractor.extract([{ event: storedEventToEnvelope(pending[0]!), source }]);
    const newer = later.memories.find((candidate) => candidate.content === 'Version: Node 22');
    expect(newer).toBeDefined();
    if (!newer) throw new Error('the later transcript did not produce its version candidate');
    const classified = classifier.classify(newer);
    expect(classified.durable_type).toBe('episodic');
    const winner: NewMemory = {
      type: classified.durable_type,
      ...(classified.subtype === undefined ? {} : { subtype: classified.subtype }),
      ...(newer.title === undefined ? {} : { title: newer.title }),
      content: newer.content,
      importance: newer.importance,
      confidence: newer.confidence,
      observed_at: node22.event.occurred_at,
      valid_from: node22.event.occurred_at,
      project_id: project.id,
      source_id: source.id,
      evidence: newer.evidence,
      extraction: {
        method: later.extraction_meta.method,
        prompt_version: later.extraction_meta.prompt_version,
      },
      tags: ['extracted', 'semantic_candidate'],
      token_estimate: Math.ceil(newer.content.length / 4),
    };
    const superseded = await storage.store.supersede({
      winner,
      loser_id: older.id,
      actor: 'user:phase1-fixture',
      reason: 'Node 22 replaced Node 20 in the project transcript',
    });
    expect(superseded.outcome).toBe('superseded');
    expect(superseded.loser?.superseded_by).toBe(superseded.winner.id);
    expect(superseded.loser?.valid_until).toBe(node22.event.occurred_at);
    expect(superseded.winner.provenance.evidence).toEqual(newer.evidence);
    const audit = await storage.store.listMemoryEvents(older.id);
    expect(audit.some((event) =>
      event.to_status === 'superseded' && event.actor === 'user:phase1-fixture')).toBe(true);
    await storage.store.markEventProcessed(node22.event.id);
    expect(await storage.store.listPendingEvents(25)).toHaveLength(0);

    const engine = createRetrievalEngine(storage, {
      now: () => new Date('2026-10-03T09:03:00.000Z'),
    });
    for (const [query, memory] of [
      ['PostgreSQL pgvector database', decision],
      ['Cannot find module schema resolved', failure],
    ] as const) {
      const response = await engine.search({ query, project_id: project.id, max_tokens: 500, explain: true });
      expect(response.memories.map((item) => item.id)).toContain(memory.id);
      expect(response.tokens.used).toBeLessThanOrEqual(response.tokens.budget);
      expect(response.memories.find((item) => item.id === memory.id)?.provenance.source_kind).toBe('conversation');
      expect(response.memories.find((item) => item.id === memory.id)?.explain.length).toBeGreaterThan(0);
    }
    const query = 'which Node version does the project run on';
    const current = await engine.search({ query, project_id: project.id });
    expect(current.memories.map((memory) => memory.id)).toContain(superseded.winner.id);
    expect(current.memories.map((memory) => memory.id)).not.toContain(older.id);

    const pointInTime = await engine.search({
      query,
      project_id: project.id,
      as_of: '2026-10-03T09:01:00.000Z',
    });
    expect(pointInTime.memories.map((memory) => memory.id)).toContain(older.id);
    expect(pointInTime.memories.map((memory) => memory.id)).not.toContain(superseded.winner.id);

    const history = await engine.search({ query, project_id: project.id, temporal_mode: 'historical' });
    expect(history.memories.map((memory) => memory.id)).toContain(older.id);
    expect(history.memories.map((memory) => memory.id)).toContain(superseded.winner.id);
  } finally {
    await storage?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
