/**
 * NORMALIZE handler tests against an embedded PGlite store: pending events → structured forms,
 * `needs_review` flagging for unparseable events, and the downstream `extract` job.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';
import type { OnememoryEvent } from '@onememory-ai/core';

import { createNormalizeHandler } from './normalize';
import { FIXTURE_PROJECT_ID, FIXTURE_SESSION_ID, goldenSession } from '../testing/transcripts';

interface Handle {
  storage: OnememoryStorage;
  close(): Promise<void>;
}

const handles: Handle[] = [];

async function openStorage(): Promise<OnememoryStorage> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-m3-normalize-'));
  const storage = await createEmbeddedDb(dataDir);
  await storage.store.createProject({ id: FIXTURE_PROJECT_ID, name: 'm3-normalize-fixture' });
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
  return { id: 'job-normalize-1', kind: 'normalize', payload };
}

describe('createNormalizeHandler', () => {
  test('normalizes pending events and enqueues one extract job carrying the batch', async () => {
    const storage = await openStorage();
    const inputs = goldenSession();
    await ingest(storage, inputs.map((input) => input.event));

    const handler = createNormalizeHandler(storage.store, storage.jobs, { maxEvents: 50 });
    const result = await handler(job());

    expect(result.normalized).toBe(inputs.length);
    expect(result.needs_review).toBe(0);
    expect(result.extract_jobs).toBe(1);
    expect(result.event_ids).toHaveLength(inputs.length);

    const claimed = await storage.jobs.claim({ claimant: 'test' });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.kind).toBe('extract');
    const payload = claimed[0]!.payload as { event_ids: string[]; normalized: unknown[] };
    expect(payload.event_ids).toHaveLength(inputs.length);
    expect(payload.normalized).toHaveLength(inputs.length);
    const first = payload.normalized[0] as { source_id: string; text: string };
    expect(first.source_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.text.length).toBeGreaterThan(0);
  });

  test('events are not marked processed — EXTRACT owns that transition', async () => {
    const storage = await openStorage();
    await ingest(storage, [goldenSession()[0]!.event]);
    const handler = createNormalizeHandler(storage.store, storage.jobs);
    await handler(job());
    expect(await storage.store.listPendingEvents(10)).toHaveLength(1);
  });

  test('flags an unparseable event needs_review instead of dropping it', async () => {
    const storage = await openStorage();
    const inputs = goldenSession();
    await ingest(storage, inputs.slice(0, 3).map((input) => input.event));
    const corruptedId = inputs[1]!.event.id;
    await storage.client.query(
      `UPDATE events SET payload = $2::jsonb WHERE id = $1::uuid`,
      [corruptedId, JSON.stringify({ kind: 'conversation.message', role: 'user' })],
    );

    const handler = createNormalizeHandler(storage.store, storage.jobs);
    const result = await handler(job());

    expect(result.normalized).toBe(2);
    expect(result.needs_review).toBe(1);
    const row = await storage.client.query<{ needs_review: boolean; process_error: string | null }>(
      `SELECT needs_review, process_error FROM events WHERE id = $1::uuid`,
      [corruptedId],
    );
    expect(row.rows[0]!.needs_review).toBe(true);
    expect(row.rows[0]!.process_error).toContain('could not be re-validated');
  });

  test('an empty pending set is a no-op', async () => {
    const storage = await openStorage();
    const handler = createNormalizeHandler(storage.store, storage.jobs);
    const result = await handler(job());
    expect(result).toEqual({ normalized: 0, needs_review: 0, extract_jobs: 0, event_ids: [] });
    expect(await storage.jobs.claim({ claimant: 'test' })).toHaveLength(0);
  });

  test('the payload can scope the batch to specific events', async () => {
    const storage = await openStorage();
    const inputs = goldenSession();
    await ingest(storage, inputs.slice(0, 4).map((input) => input.event));
    const handler = createNormalizeHandler(storage.store, storage.jobs);
    const result = await handler(job({ event_ids: [inputs[2]!.event.id] }));
    expect(result.normalized).toBe(1);
    expect(result.event_ids).toEqual([inputs[2]!.event.id]);
  });

  test('enqueueExtract: false leaves the batch unqueued', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 2).map((input) => input.event));
    const handler = createNormalizeHandler(storage.store, storage.jobs, { enqueueExtract: false });
    const result = await handler(job());
    expect(result.normalized).toBe(2);
    expect(result.extract_jobs).toBe(0);
    expect(await storage.jobs.claim({ claimant: 'test' })).toHaveLength(0);
  });

  test('the enqueued extract job is a singleton while pending', async () => {
    const storage = await openStorage();
    await ingest(storage, goldenSession().slice(0, 2).map((input) => input.event));
    const handler = createNormalizeHandler(storage.store, storage.jobs);
    await handler(job());
    await handler(job());
    expect(await storage.jobs.claim({ claimant: 'test' })).toHaveLength(1);
    expect(FIXTURE_SESSION_ID.length).toBeGreaterThan(0);
  });
});
