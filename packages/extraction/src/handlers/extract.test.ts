/**
 * EXTRACT handler integration tests against an embedded PGlite store: pending events → durable
 * memories with provenance and evidence, working memory with session creation, dedupe against
 * prior memories, `re_embed` enqueue, idempotency, and failure semantics.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEmbeddedDb,
  createHandlerRegistry,
  createJobWorker,
  type OnememoryStorage,
} from '@onememory-ai/storage';
import { memoryContentHash, type Extractor, type OnememoryEvent } from '@onememory-ai/core';

import { createHeuristicClassifier } from '../classifier';
import { createHeuristicExtractor } from '../heuristic/extractor';
import { createExtractHandler, type ExtractHandlerResult } from './extract';
import {
  FIXTURE_PROJECT_ID,
  FIXTURE_SESSION_ID,
  goldenSession,
  makeInput,
} from '../testing/transcripts';

interface Handle {
  storage: OnememoryStorage;
  close(): Promise<void>;
}

const handles: Handle[] = [];

async function openStorage(): Promise<OnememoryStorage> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-m3-extract-'));
  const storage = await createEmbeddedDb(dataDir);
  await storage.store.createProject({ id: FIXTURE_PROJECT_ID, name: 'm3-extract-fixture' });
  handles.push({
    storage,
    close: async () => {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  });
  return storage;
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

async function ingest(storage: OnememoryStorage, events: OnememoryEvent[]): Promise<void> {
  for (const event of events) {
    const result = await storage.store.ingestEvent(event);
    expect(result.status).toBe('stored');
  }
}

function job(payload: Record<string, unknown> = {}) {
  return { id: 'job-extract-1', kind: 'extract', payload };
}

function handlerFor(storage: OnememoryStorage, extractor?: Extractor) {
  return createExtractHandler(
    storage.store,
    storage.jobs,
    extractor ?? createHeuristicExtractor(),
    createHeuristicClassifier(),
  );
}

describe('createExtractHandler', () => {
  test('turns pending events into durable memories with provenance, working memory, and re_embed jobs', async () => {
    const storage = await openStorage();
    const inputs = goldenSession();
    await ingest(storage, inputs.map((input) => input.event));

    const result = await handlerFor(storage)(job());
    expect(result).toEqual({
      events_processed: inputs.length,
      memories_inserted: 8,
      duplicates: 0,
      working_inserted: 4,
      candidates_discarded: 0,
      needs_review: 0,
      re_embed_jobs: 1,
    } satisfies ExtractHandlerResult);

    // Every event is consumed by exactly one run.
    expect(await storage.store.listPendingEvents(50)).toHaveLength(0);

    const memories = await storage.store.queryCurrent({ project_id: FIXTURE_PROJECT_ID });
    expect(memories).toHaveLength(8);
    const decision = memories.find((memory) => memory.type === 'decision');
    expect(decision?.content).toContain('PostgreSQL');
    expect(decision?.subtype).toBe('decision.statement');
    expect(decision?.status).toBe('active');
    expect(decision?.provenance.extraction).toEqual({
      method: 'heuristic',
      prompt_version: 'heuristic-v2',
    });
    expect(decision?.provenance.source.kind).toBe('conversation');
    expect(decision?.provenance.source.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(decision?.provenance.evidence).toHaveLength(1);
    expect(decision?.provenance.evidence[0]!.locator.startsWith('event:')).toBe(true);
    expect(decision?.tags).toContain('extracted');

    const failure = memories.find((memory) => memory.type === 'failure');
    expect(failure?.content).toContain('resolved by: `bun test`');
    expect(failure?.provenance.evidence).toHaveLength(2);

    // Every durable memory has a `created` audit event anchored to the same source.
    for (const memory of memories) {
      const events = await storage.store.listMemoryEvents(memory.id);
      const created = events.find((event) => event.action === 'created');
      expect(created?.actor).toMatch(/^agent:/);
      expect(created?.details.source_id).toBe(memory.provenance.source.id);
    }

    const working = await storage.store.listWorking(FIXTURE_SESSION_ID);
    expect(working.map((row) => row.kind).sort()).toEqual([
      'current_error',
      'current_file',
      'hypothesis',
      'open_question',
    ]);
    for (const row of working) {
      expect(row.session_id).toBe(FIXTURE_SESSION_ID);
      expect(row.source_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.parse(row.created_at));
    }

    const claimed = await storage.jobs.claim({ claimant: 'test' });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.kind).toBe('re_embed');
    const payload = claimed[0]!.payload as { reason: string; items: Array<{ memory_id: string }> };
    expect(payload.reason).toBe('backfill');
    expect(payload.items).toHaveLength(8);
    expect(payload.items.map((item) => item.memory_id).sort()).toEqual(
      memories.map((memory) => memory.id).sort(),
    );
  });

  test('a second run is a no-op (events are consumed exactly once)', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().map((input) => input.event));
    const handler = handlerFor(storage);
    await handler(job());
    const second = await handler(job());
    expect(second).toEqual({
      events_processed: 0,
      memories_inserted: 0,
      duplicates: 0,
      working_inserted: 0,
      candidates_discarded: 0,
      needs_review: 0,
      re_embed_jobs: 0,
    } satisfies ExtractHandlerResult);
    expect(await storage.store.queryCurrent({ project_id: FIXTURE_PROJECT_ID })).toHaveLength(8);
  });

  test('duplicate candidates collapse via the dedupe probe across runs', async () => {
    const storage = await openStorage();
    const content = 'We decided to use PostgreSQL with pgvector as the storage engine.';
    const handler = handlerFor(storage);

    // First session states the decision once.
    await ingest(storage, [
      makeInput(
        'conversation.message',
        { kind: 'conversation.message', role: 'user', content },
        { sessionId: 'sess-m3-first', offsetSeconds: 0 },
      ).event,
    ]);
    const first = await handler(job());
    expect(first.memories_inserted).toBe(1);
    expect(first.duplicates).toBe(0);

    // A later session repeats the same decision: the probe finds the stored memory.
    await ingest(storage, [
      makeInput(
        'conversation.message',
        { kind: 'conversation.message', role: 'assistant', content },
        { sessionId: 'sess-m3-second', offsetSeconds: 10 },
      ).event,
    ]);
    const second = await handler(job());
    expect(second.memories_inserted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.events_processed).toBe(1);

    const stored = await storage.store.queryCurrent({ project_id: FIXTURE_PROJECT_ID });
    const decisions = stored.filter((memory) => memory.type === 'decision');
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.provenance.evidence).toHaveLength(1);
    // The stored memory answers the exact probe the next run will issue.
    const again = await storage.store.findDuplicate(
      { project_id: FIXTURE_PROJECT_ID, user_id: null },
      'decision',
      memoryContentHash(decision.content),
    );
    expect(again?.id).toBe(decision.id);
  });

  test('enqueueReEmbed: false skips the embedding backfill', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 2).map((input) => input.event));
    const handler = createExtractHandler(
      storage.store,
      storage.jobs,
      createHeuristicExtractor(),
      createHeuristicClassifier(),
      { enqueueReEmbed: false },
    );
    const result = await handler(job());
    expect(result.memories_inserted).toBeGreaterThan(0);
    expect(result.re_embed_jobs).toBe(0);
    expect(await storage.jobs.claim({ claimant: 'test' })).toHaveLength(0);
  });

  test('an extractor failure fails the job and leaves every event pending', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 3).map((input) => input.event));
    const exploding: Extractor = {
      async extract() {
        throw new Error('model exploded');
      },
    };
    await expect(handlerFor(storage, exploding)(job())).rejects.toThrow('model exploded');
    expect(await storage.store.listPendingEvents(10)).toHaveLength(3);
    expect(await storage.store.queryCurrent({ project_id: FIXTURE_PROJECT_ID })).toHaveLength(0);
  });

  test('an unparseable stored event is flagged needs_review, not dropped', async () => {
    const storage = await openStorage();
    const inputs = goldenSession().slice(0, 3);
    await ingest(storage, inputs.map((input) => input.event));
    const corruptedId = inputs[1]!.event.id;
    await storage.client.query(
      `UPDATE events SET payload = $2::jsonb WHERE id = $1::uuid`,
      [corruptedId, JSON.stringify({ kind: 'conversation.message', role: 7 })],
    );

    const result = await handlerFor(storage)(job());
    expect(result.needs_review).toBe(1);
    expect(result.events_processed).toBe(2);
    const row = await storage.client.query<{ needs_review: boolean }>(
      `SELECT needs_review FROM events WHERE id = $1::uuid`,
      [corruptedId],
    );
    expect(row.rows[0]!.needs_review).toBe(true);
    expect(await storage.store.listPendingEvents(10)).toHaveLength(0);
  });

  test('the extract job payload can scope the run to specific events', async () => {
    const storage = await openStorage();
    const inputs = goldenSession();
    await ingest(storage, inputs.map((input) => input.event));
    const result = await handlerFor(storage)(job({ event_ids: [inputs[0]!.event.id] }));
    expect(result.events_processed).toBe(1);
    expect(await storage.store.listPendingEvents(50)).toHaveLength(inputs.length - 1);
  });

  test('an invalid event_ids payload fails the job before any state changes', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 2).map((input) => input.event));
    await expect(handlerFor(storage)(job({ event_ids: 'nope' }))).rejects.toThrow();
    expect(await storage.store.listPendingEvents(10)).toHaveLength(2);
  });
});

describe('worker wiring', () => {
  test('an unregistered job kind retries, then dead-letters — the job is never lost', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 2).map((input) => input.event));

    const result = await handlerFor(storage)(job());
    expect(result.memories_inserted).toBeGreaterThan(0);
    expect(result.re_embed_jobs).toBe(1);

    // No handler is registered for `re_embed`: zero backoff makes the retry loop deterministic.
    const worker = createJobWorker({
      db: storage.client,
      registry: createHandlerRegistry({}),
      claimant: 'worker',
      backoffBaseSeconds: 0,
      onError: () => {},
    });
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    const rows = await storage.client.query<{
      status: string;
      attempts: number;
      last_error: string | null;
    }>(`SELECT status, attempts, last_error FROM jobs WHERE kind = 're_embed'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe('dead');
    expect(rows.rows[0]!.attempts).toBe(3);
    expect(rows.rows[0]!.last_error).toContain('no handler registered for job kind');
  });

  test('a registered re_embed handler completes the job', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 2).map((input) => input.event));
    const handler = handlerFor(storage);
    const first = await handler(job());
    expect(first.memories_inserted).toBeGreaterThan(0);

    const seen: string[] = [];
    const worker = createJobWorker({
      db: storage.client,
      registry: createHandlerRegistry({
        re_embed: async (context) => {
          const items = (context.job.payload as { items: Array<{ memory_id: string }> }).items;
          seen.push(...items.map((item) => item.memory_id));
        },
      }),
      claimant: 'worker',
    });
    await worker.runOnce();
    expect(seen).toHaveLength(first.memories_inserted);

    const rows = await storage.client.query<{ status: string }>(
      `SELECT status FROM jobs WHERE kind = 're_embed'`,
    );
    expect(rows.rows[0]!.status).toBe('done');
  });
});
