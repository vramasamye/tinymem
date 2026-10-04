/**
 * Shared integration scenarios — the M1 acceptance criteria, runnable against BOTH deployment
 * profiles (embedded PGlite always; Postgres server when `ONEMEMORY_PG_URL` is provided — the
 * CI matrix `embedded` / `postgres` from ADR-0002). Every scenario is self-contained and uses
 * per-run unique values so the server-target suite can re-run on a shared database.
 */

import { describe, expect, test } from 'bun:test';

import { InvalidTransitionError, memoryContentHash } from '@onememory/core';
import type { OnememoryEvent, SupersedeInput, SymbolFileInput, SymbolRecordInput } from '@onememory/core';

import { JobKindNotImplemented, createHandlerRegistry, createJobWorker } from '../jobs/worker';
import { NotFoundError, ValidationError } from '../repositories/util';
import { createEmbeddingIndex } from '../vectors/embedding-index';

import { makeEvent, makeMemory, makeSession, makeWorking, seedProjectAndSource, uniqueId } from './harness';
import type { OnememoryStorage } from '../drivers/types';
import type { StorageHandle } from './harness';

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** Migrations apply cleanly twice (idempotency — ADR-0002 / issue M1.3). */
export async function migrationIdempotencyScenario(storage: OnememoryStorage): Promise<void> {
  // createEmbeddedDb/createServerDb already migrated once during open.
  await storage.migrate();
  await storage.migrate();
  const result = await storage.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name IN (
        'users','projects','sources','events','memories','memory_vectors','entities',
        'memory_entities','edges','decisions','failures','skills','sessions','working_memory',
        'jobs','memory_events','system_state','repositories','file_fingerprints','code_symbols',
        'memory_code_refs'
      )`,
  );
  expect(result.rows[0]?.n).toBe(21);
}

// ---------------------------------------------------------------------------
// Store → get roundtrip
// ---------------------------------------------------------------------------

export async function storeGetRoundtripScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage);
  const candidate = makeMemory(ctx, { content: `This project uses Bun ${uniqueId().slice(0, 6)} for tests.` });
  const written = await storage.store.insertMemory(candidate);
  expect(written.outcome).toBe('inserted');

  const record = await storage.store.getMemory(written.memory.id);
  expect(record).not.toBeNull();
  if (!record) return;
  expect(record.id).toBe(written.memory.id);
  expect(record.type).toBe('semantic');
  expect(record.status).toBe('active');
  expect(record.content).toBe(candidate.content);
  expect(record.importance).toBe(candidate.importance);
  expect(record.confidence).toBe(candidate.confidence);
  expect(record.observed_at).toBe('2025-06-01T00:00:00.000Z');
  expect(record.valid_from).toBe('2025-06-01T00:00:00.000Z');
  expect(record.valid_until).toBeUndefined();
  expect(record.project_id).toBe(ctx.projectId);
  expect(record.tags).toEqual([]);
  expect(record.token_estimate).toBe(0);
  expect(record.provenance.source.id).toBe(ctx.sourceId);
  expect(record.provenance.source.kind).toBe('explicit');
  expect(record.provenance.evidence).toHaveLength(1);
  expect(record.provenance.extraction.method).toBe('heuristic');
  expect(record.provenance.extraction.prompt_version).toBe('fixture-v1');

  // provenance invariant: evidence is mandatory for durable memories
  const audit = await storage.store.listMemoryEvents(record.id);
  expect(audit.some((entry) => entry.action === 'created' && entry.to_status === 'active')).toBe(true);

  const missing = await storage.store.getMemory(uniqueId());
  expect(missing).toBeNull();
}

// ---------------------------------------------------------------------------
// Dedupe: same scope rejected, cross-scope allowed
// ---------------------------------------------------------------------------

export async function dedupeScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'dedupe-a');
  const other = await seedProjectAndSource(storage, 'dedupe-b');
  const content = `Postgres 17 is the storage engine ${uniqueId().slice(0, 6)}.`;

  // Same scope + same content → duplicate outcome (probe), NOT a second row.
  const first = await storage.store.insertMemory(makeMemory(ctx, { content }));
  expect(first.outcome).toBe('inserted');
  const second = await storage.store.insertMemory(makeMemory(ctx, { content }));
  expect(second.outcome).toBe('duplicate');
  expect(second.existing?.id).toBe(first.memory.id);

  // The coalesce unique index enforces it at the SQL level too (same scope, type, hash).
  const hash = memoryContentHash(content);
  await expect(
    storage.client.query(
      `INSERT INTO memories (id, type, content, content_hash, importance, confidence, observed_at, valid_from, source_id, project_id)
         VALUES ($1::uuid, 'semantic', $2, $3, 0.5, 0.5, now(), now(), $4::uuid, $5::uuid)`,
      [uniqueId(), content, hash, ctx.sourceId, ctx.projectId],
    ),
  ).rejects.toThrow(/memories_dedupe_idx/);

  // Different project scope → allowed (same statement may be valid in different projects).
  const crossScope = await storage.store.insertMemory(
    makeMemory({ ...ctx, projectId: other.projectId, sourceId: other.sourceId }, { content }),
  );
  expect(crossScope.outcome).toBe('inserted');
  expect(crossScope.memory.id).not.toBe(first.memory.id);

  // NULL scope coalesces: two scope-less memories with identical content+type collide.
  const globalContent = `Global fact ${uniqueId().slice(0, 6)}.`;
  const globalFirst = await storage.store.insertMemory(makeMemory(ctx, { content: globalContent, project_id: undefined }));
  expect(globalFirst.outcome).toBe('inserted');
  const globalSecond = await storage.store.insertMemory(makeMemory(ctx, { content: globalContent, project_id: undefined }));
  expect(globalSecond.outcome).toBe('duplicate');
  expect(globalSecond.existing?.id).toBe(globalFirst.memory.id);

  // findDuplicate is the stage-6 probe the pipeline calls directly.
  const probe = await storage.store.findDuplicate({ project_id: ctx.projectId }, 'semantic', hash);
  expect(probe?.id).toBe(first.memory.id);
  const probeMiss = await storage.store.findDuplicate({ project_id: ctx.projectId }, 'decision', hash);
  expect(probeMiss).toBeNull();
}

// ---------------------------------------------------------------------------
// Supersession (the Node 20 → Node 22 scenario from memory-model.md §5)
// ---------------------------------------------------------------------------

export async function supersessionScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'supersession');
  const tag = uniqueId().slice(0, 6);

  // "Node 20" — the current fact.
  const node20 = await storage.store.insertMemory(
    makeMemory(ctx, {
      content: `This project uses Node 20 for its runtime ${tag}.`,
      observed_at: '2024-01-15T00:00:00.000Z',
      valid_from: '2024-01-15T00:00:00.000Z',
      title: 'Node 20',
    }),
  );
  expect(node20.outcome).toBe('inserted');

  // "Node 22" supersedes it.
  const winnerCandidate = makeMemory(ctx, {
    content: `This project uses Node 22 for its runtime ${tag}.`,
    observed_at: '2025-06-01T00:00:00.000Z',
    valid_from: '2025-06-01T00:00:00.000Z',
    title: 'Node 22',
  });
  const supersedeInput: SupersedeInput = {
    winner: winnerCandidate,
    loser_id: node20.memory.id,
    actor: 'user:fixture',
    reason: 'explicit user statement wins (authority order)',
  };
  const result = await storage.store.supersede(supersedeInput);
  expect(result.outcome).toBe('superseded');
  if (result.outcome !== 'superseded') return;

  // Loser: status=superseded, valid_until=winner.observed_at, superseded_by=winner.id.
  expect(result.loser?.status).toBe('superseded');
  expect(result.loser?.valid_until).toBe('2025-06-01T00:00:00.000Z');
  expect(result.loser?.superseded_by).toBe(result.winner.id);
  expect(result.winner.status).toBe('active');
  expect(result.winner.valid_until).toBeUndefined();

  // Audit rows: loser created + status_changed(active→superseded); winner created.
  const loserAudit = await storage.store.listMemoryEvents(node20.memory.id);
  const loserTransition = loserAudit.find((entry) => entry.action === 'status_changed');
  expect(loserTransition).toBeDefined();
  expect(loserTransition?.from_status).toBe('active');
  expect(loserTransition?.to_status).toBe('superseded');
  expect(loserTransition?.actor).toBe('user:fixture');
  const winnerAudit = await storage.store.listMemoryEvents(result.winner.id);
  expect(winnerAudit.some((entry) => entry.action === 'created')).toBe(true);

  // Current query returns Node 22 only.
  const current = await storage.store.queryCurrent({ project_id: ctx.projectId });
  const contents = current.map((memory) => memory.content);
  expect(contents).toHaveLength(1);
  expect(contents[0]).toBe(winnerCandidate.content);

  // Point-in-time before the supersession returns Node 20.
  const asOf = await storage.store.queryAsOf('2024-06-01T00:00:00.000Z', { project_id: ctx.projectId });
  expect(asOf).toHaveLength(1);
  expect(asOf[0]?.content).toBe(node20.memory.content);
  expect(asOf[0]?.status).toBe('superseded'); // superseded retained for history

  // Full history returns both, oldest first.
  const history = await storage.store.historyOf(result.winner.id);
  expect(history).toHaveLength(2);
  expect(history[0]?.content).toBe(node20.memory.content);
  expect(history[1]?.content).toBe(winnerCandidate.content);

  // An illegal transition on the superseded memory is rejected by the machine.
  await expect(
    storage.store.updateMemoryStatus(node20.memory.id, 'active', { actor: 'system' }),
  ).rejects.toThrow(/invalid memory status transition superseded → active/);
}

// ---------------------------------------------------------------------------
// Status transitions are audited
// ---------------------------------------------------------------------------

export async function statusTransitionAuditScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'transitions');
  const written = await storage.store.insertMemory(
    makeMemory(ctx, { content: `Drift-checkable fact ${uniqueId().slice(0, 6)}.` }),
  );
  const id = written.memory.id;

  // active → stale (code drift) — audited
  const stale = await storage.store.updateMemoryStatus(id, 'stale', {
    actor: 'job:drift_scan',
    reason: 'linked code changed',
  });
  expect(stale.status).toBe('stale');
  // stale → active (re-verified) — audited as 'restored'
  const restored = await storage.store.updateMemoryStatus(id, 'active', {
    actor: 'job:verify_stale',
    reason: 're-verified against HEAD',
  });
  expect(restored.status).toBe('active');
  // active → archived (decay) — audited as 'archived'
  const archived = await storage.store.updateMemoryStatus(id, 'archived', {
    actor: 'job:decay',
    reason: 'prominence below threshold',
  });
  expect(archived.status).toBe('archived');
  // archived → active (manual restore) — audited as 'restored'
  const restoredAgain = await storage.store.updateMemoryStatus(id, 'active', {
    actor: 'user:fixture',
    reason: 'manual restore',
  });
  expect(restoredAgain.status).toBe('active');

  const audit = await storage.store.listMemoryEvents(id);
  const actions = audit.map((entry) => entry.action).reverse(); // listMemoryEvents is DESC
  expect(actions).toContain('status_changed');
  expect(actions).toContain('restored');
  expect(actions).toContain('archived');
  const archivedEntry = audit.find((entry) => entry.action === 'archived');
  expect(archivedEntry?.from_status).toBe('active');
  expect(archivedEntry?.to_status).toBe('archived');
  expect(archivedEntry?.details.reason).toBe('prominence below threshold');

  // Reinforcement bumps access counters (fire-and-forget, not audited).
  await storage.store.reinforce([id], '2026-10-03T12:30:00.000Z');
  const reinforced = await storage.store.getMemory(id);
  expect(reinforced?.access_count).toBe(1);
  expect(reinforced?.last_accessed_at).toBe('2026-10-03T12:30:00.000Z');
}

// ---------------------------------------------------------------------------
// Events ingest: dedupe + redactions passthrough + pending pipeline
// ---------------------------------------------------------------------------

export async function eventsIngestScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'events');
  const tag = uniqueId().slice(0, 8);
  const event: OnememoryEvent = makeEvent({
    kind: 'conversation.message',
    payload: {
      kind: 'conversation.message',
      role: 'user',
      content: `Remember: we standardize on pglite ${tag}`,
    },
    scope: { project_id: ctx.projectId, agent_id: 'claude-code' },
    redactions: [
      { kind: 'api-key', location: 'payload.content', length: 41 },
    ],
  });

  const stored = await storage.store.ingestEvent(event);
  expect(stored.status).toBe('stored');
  expect(stored.event_id).toBe(event.id);

  // Exact same content_hash + kind + project → duplicate, never a second row.
  const again = await storage.store.ingestEvent(event);
  expect(again.status).toBe('duplicate');
  expect(again.duplicate_of).toBe(event.id);

  // Pending events feed the async pipeline; redactions ride along (kind+location+length only).
  const pending = await storage.store.listPendingEvents(10);
  const row = pending.find((candidate) => candidate.id === event.id);
  expect(row).toBeDefined();
  expect(row?.kind).toBe('conversation.message');
  expect(row?.payload.role).toBe('user');
  expect(row?.redactions).toEqual([
    { kind: 'api-key', location: 'payload.content', length: 41 },
  ]);
  expect(row?.needs_review).toBe(false);

  // Mark processed (normalize failure marks needs_review, never drops the event).
  await storage.store.markEventProcessed(event.id, { process_error: 'boom', needs_review: true });
  const afterPending = await storage.store.listPendingEvents(10);
  expect(afterPending.find((candidate) => candidate.id === event.id)).toBeUndefined();
}

// ---------------------------------------------------------------------------
// Entity + edge primitives
// ---------------------------------------------------------------------------

export async function entityGraphScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'entities');
  const memory = (await storage.store.insertMemory(makeMemory(ctx, { content: `Entities bind here ${uniqueId().slice(0, 6)}.` }))).memory;

  const created = await storage.store.createEntity({
    kind: 'library',
    name: `PostgreSQL ${uniqueId().slice(0, 6)}`,
    project_id: ctx.projectId,
  });
  expect(created.normalized_name).toBe(created.name.toLowerCase());

  // findEntity is scope-coalesced: same normalized name, other project → separate entity.
  const found = await storage.store.findEntity({ project_id: ctx.projectId }, created.normalized_name);
  expect(found?.id).toBe(created.id);
  const global = await storage.store.createEntity({ kind: 'library', name: created.name });
  expect(global.id).not.toBe(created.id);

  await storage.store.bindMemoryEntities(memory.id, [{ entity_id: created.id, role: 'subject', weight: 2 }]);
  const bound = await storage.store.listMemoryEntities(memory.id);
  expect(bound).toHaveLength(1);
  expect(bound[0]?.id).toBe(created.id);

  // Bindings are idempotent.
  await storage.store.bindMemoryEntities(memory.id, [{ entity_id: created.id, role: 'context' }]);
  expect(await storage.store.listMemoryEntities(memory.id)).toHaveLength(1);

  // Merge: loser records merged_into (idempotent).
  const target = await storage.store.createEntity({ kind: 'library', name: `pg canonical ${uniqueId().slice(0, 6)}`, project_id: ctx.projectId });
  await storage.store.mergeEntities({ source_id: created.id, target_id: target.id });
  const merged = await storage.store.findEntity({ project_id: ctx.projectId }, created.normalized_name);
  expect(merged?.merged_into).toBe(target.id);
  await storage.store.mergeEntities({ source_id: created.id, target_id: target.id }); // no throw

  // Edges: unique per (from, to, relation), so addEdge is idempotent.
  const other = (await storage.store.insertMemory(makeMemory(ctx, { content: `Edge target ${uniqueId().slice(0, 6)}.` }))).memory;
  const edge = await storage.store.addEdge({
    from_memory_id: memory.id,
    to_memory_id: other.id,
    relation: 'related_to',
  });
  const edgeAgain = await storage.store.addEdge({
    from_memory_id: memory.id,
    to_memory_id: other.id,
    relation: 'related_to',
  });
  expect(edgeAgain.id).toBe(edge.id);
  const edges = await storage.store.listEdges(memory.id);
  expect(edges).toHaveLength(1);
}

// ---------------------------------------------------------------------------
// Working memory: insert + sweep (expired purged, promoted preserved)
// ---------------------------------------------------------------------------

export async function workingMemoryScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'working');
  const session = await storage.store.createSession(makeSession());
  const now = '2026-10-03T12:00:00.000Z';

  const expired = await storage.store.insertWorking(
    makeWorking(session.id, { kind: 'task', content: 'expired unpromoted', expires_at: '2026-10-03T11:00:00.000Z' }),
  );
  const live = await storage.store.insertWorking(
    makeWorking(session.id, { kind: 'open_question', content: 'still within TTL', expires_at: '2099-01-01T00:00:00.000Z' }),
  );
  const promotedCandidate = await storage.store.insertWorking(
    makeWorking(session.id, { kind: 'temp_decision', content: 'promoted before expiry', expires_at: '2026-10-03T11:00:00.000Z', importance: 0.6, source_id: ctx.sourceId }),
  );
  // Promotion: the scratch note became a durable memory (pipeline stage EXTRACT).
  const durable = await storage.store.insertMemory(makeMemory(ctx, { content: `Promoted scratch note ${uniqueId().slice(0, 6)}.` }));
  await storage.store.markWorkingPromoted(promotedCandidate.id, durable.memory.id);

  const sweep = await storage.store.sweepWorking(now);
  expect(sweep.purged).toBe(1);

  const remaining = await storage.store.listWorking(session.id);
  expect(remaining.map((row) => row.id).sort()).toEqual([live.id, promotedCandidate.id].sort());
  const promotedRow = remaining.find((row) => row.id === promotedCandidate.id);
  expect(promotedRow?.promoted_memory_id).toBe(durable.memory.id);

  // The expired unpromoted row is gone (working memory is the one table where deletion is allowed).
  const expiredGone = await storage.client.query(
    'SELECT count(*)::int AS n FROM working_memory WHERE id = $1::uuid',
    [expired.id],
  );
  expect(expiredGone.rows[0]?.n).toBe(0);
}

// ---------------------------------------------------------------------------
// Jobs: singleton enqueue, claim/complete, retry backoff, dead-letter, lease reclaim
// ---------------------------------------------------------------------------

export async function jobsScenario(storage: OnememoryStorage): Promise<void> {
  const key = `evt-${uniqueId().slice(0, 8)}`;

  // Singleton: same (kind, key) while pending/running → same job.
  const enqueued = await storage.jobs.enqueue({ kind: 'normalize', key, payload: { eventId: uniqueId() }, run_at: '2026-10-03T11:00:00.000Z' });
  expect(enqueued.outcome).toBe('enqueued');
  expect(enqueued.job.status).toBe('pending');
  const reenqueued = await storage.jobs.enqueue({ kind: 'normalize', key });
  expect(reenqueued.outcome).toBe('existing');
  expect(reenqueued.job.id).toBe(enqueued.job.id);

  // Claim (lease) → running, locked.
  const t0 = '2026-10-03T12:00:00.000Z';
  const claimed = await storage.jobs.claim({ claimant: 'w1', limit: 5, leaseSeconds: 60, now: t0 });
  expect(claimed.map((job) => job.id)).toContain(enqueued.job.id);
  const job = claimed.find((candidate) => candidate.id === enqueued.job.id);
  expect(job?.status).toBe('running');
  expect(job?.locked_by).toBe('w1');

  // A second claimer at the same instant gets nothing (SKIP LOCKED + lease held).
  const claimedAgain = await storage.jobs.claim({ claimant: 'w2', now: t0, leaseSeconds: 60 });
  expect(claimedAgain.find((candidate) => candidate.id === enqueued.job.id)).toBeUndefined();

  // Lease expiry reclaims the job for a crashed worker.
  const reclaimed = await storage.jobs.claim({
    claimant: 'w2',
    now: '2026-10-03T12:01:30.000Z',
    leaseSeconds: 60,
  });
  expect(reclaimed.find((candidate) => candidate.id === enqueued.job.id)?.locked_by).toBe('w2');

  // Complete → done; the same key can be enqueued again afterwards.
  await storage.jobs.complete(enqueued.job.id);
  const afterComplete = await storage.jobs.getJob(enqueued.job.id);
  expect(afterComplete?.status).toBe('done');
  expect(afterComplete?.locked_by).toBeNull();
  const freshEnqueue = await storage.jobs.enqueue({ kind: 'normalize', key, run_at: '2026-10-03T11:00:00.000Z' });
  expect(freshEnqueue.outcome).toBe('enqueued');

  // Retry with backoff: attempt 1 → pending with run_at in the future (base 2s, injectable clock).
  const t1 = '2026-10-03T12:05:00.000Z';
  const retryClaim = await storage.jobs.claim({ claimant: 'w1', now: t1 });
  const retryJob = retryClaim.find((candidate) => candidate.id === freshEnqueue.job.id);
  expect(retryJob).toBeDefined();
  const failed = await storage.jobs.fail(retryJob!.id, 'normalize handler exploded', { now: t1 });
  expect(failed.status).toBe('pending');
  expect(failed.attempts).toBe(1);
  expect(failed.last_error).toBe('normalize handler exploded');
  expect(new Date(failed.run_at).getTime()).toBe(new Date(t1).getTime() + 2000);

  // Not claimable before run_at; claimable after.
  const tooEarly = await storage.jobs.claim({ claimant: 'w3', now: '2026-10-03T12:05:01.000Z' });
  expect(tooEarly.find((candidate) => candidate.id === retryJob!.id)).toBeUndefined();
  const onTime = await storage.jobs.claim({ claimant: 'w3', now: '2026-10-03T12:05:02.000Z' });
  expect(onTime.find((candidate) => candidate.id === retryJob!.id)).toBeDefined();

  // Dead-letter at max_attempts.
  const deadKey = `dead-${uniqueId().slice(0, 8)}`;
  const dead = await storage.jobs.enqueue({ kind: 'normalize', key: deadKey, max_attempts: 2, run_at: '2026-10-03T11:00:00.000Z' });
  await storage.jobs.claim({ claimant: 'w4', now: '2026-10-03T12:10:00.000Z' });
  const once = await storage.jobs.fail(dead.job.id, 'first failure', {
    now: '2026-10-03T12:10:00.000Z',
  });
  expect(once.status).toBe('pending');
  await storage.jobs.claim({ claimant: 'w4', now: '2026-10-03T12:10:10.000Z' });
  const twice = await storage.jobs.fail(dead.job.id, 'final failure', {
    now: '2026-10-03T12:10:10.000Z',
  });
  expect(twice.status).toBe('dead');
  expect(twice.attempts).toBe(2);
  expect(twice.last_error).toBe('final failure');
}

// ---------------------------------------------------------------------------
// Worker loop: registry execution, JobKindNotImplemented honesty, graceful runOnce
// ---------------------------------------------------------------------------

export async function jobWorkerScenario(storage: OnememoryStorage): Promise<void> {
  const handled: string[] = [];
  const worker = createJobWorker({
    db: storage.client,
    registry: createHandlerRegistry({
      normalize: async ({ job }) => {
        handled.push(String(job.payload.key));
      },
    }),
    claimant: 'worker-test',
    pollIntervalMs: 25,
    onError: () => undefined,
  });

  // Handled kind completes.
  const okKey = `ok-${uniqueId().slice(0, 8)}`;
  const ok = await storage.jobs.enqueue({ kind: 'normalize', key: okKey, payload: { note: 1 } });
  // runOnce must only touch its own claim; claim everything first by another claimant? No —
  // runOnce claims whatever is ready; enqueue + runOnce directly.
  const attempted = await worker.runOnce();
  expect(attempted).toBeGreaterThanOrEqual(1);
  expect(handled).toContain(okKey);
  const doneJob = await storage.jobs.getJob(ok.job.id);
  expect(doneJob?.status).toBe('done');

  // Unimplemented kind fails loudly with JobKindNotImplemented — retried, never faked.
  const unimplementedKey = `unimpl-${uniqueId().slice(0, 8)}`;
  const unimplemented = await storage.jobs.enqueue({ kind: 'extract', key: unimplementedKey, max_attempts: 1 });
  const errors: unknown[] = [];
  const strictWorker = createJobWorker({
    db: storage.client,
    registry: createHandlerRegistry({}),
    claimant: 'worker-strict',
    onError: (error) => errors.push(error),
  });
  await strictWorker.runOnce();
  const failedJob = await storage.jobs.getJob(unimplemented.job.id);
  expect(failedJob?.status).toBe('dead');
  expect(failedJob?.attempts).toBe(1);
  expect(failedJob?.last_error).toMatch(/no handler registered for job kind 'extract'/);
  expect(errors[0]).toBeInstanceOf(JobKindNotImplemented);

  // start/stop smoke: the loop runs in the background and shuts down gracefully.
  worker.start();
  expect(worker.isRunning()).toBe(true);
  const startedKey = `loop-${uniqueId().slice(0, 8)}`;
  await storage.jobs.enqueue({ kind: 'normalize', key: startedKey });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await worker.stop();
  expect(worker.isRunning()).toBe(false);
  expect(handled).toContain(startedKey);
}

// ---------------------------------------------------------------------------
// EmbeddingIndex: pgvector KNN + GATE-1 float8 fallback
// ---------------------------------------------------------------------------

export async function vectorIndexScenario(storage: OnememoryStorage): Promise<void> {
  expect(storage.vectors.backend).toBe('pgvector');
  const ctx = await seedProjectAndSource(storage, 'vectors');
  const near = (await storage.store.insertMemory(makeMemory(ctx, { content: `vector near ${uniqueId().slice(0, 6)}` }))).memory;
  const far = (await storage.store.insertMemory(makeMemory(ctx, { content: `vector far ${uniqueId().slice(0, 6)}` }))).memory;

  const axis = (index: number) => Array.from({ length: 384 }, (_, i) => (i === index ? 1 : 0));
  await storage.vectors.upsert(near.id, axis(0));
  await storage.vectors.upsert(far.id, axis(1));

  const matches = await storage.vectors.search(axis(0), 2);
  expect(matches[0]?.memory_id).toBe(near.id);
  expect(matches[0]?.cosine).toBeGreaterThan(0.99);
  expect(matches[1]?.memory_id).toBe(far.id);
  expect(matches[1] && matches[1].cosine).toBeLessThan(0.1);

  // upsert replaces the stored vector for a memory (re-embedding moves it).
  await storage.vectors.upsert(near.id, axis(2));
  const reMatches = await storage.vectors.search(axis(2), 2);
  expect(reMatches[0]?.memory_id).toBe(near.id);
  expect(reMatches[0]?.cosine).toBeGreaterThan(0.99);
  expect(reMatches[1]?.memory_id).toBe(far.id);

  // minCosine filters below-threshold matches out.
  const filtered = await storage.vectors.search(axis(0), 5, { minCosine: 0.5 });
  expect(filtered).toHaveLength(0);

  await storage.vectors.remove(far.id);
  const afterRemove = await storage.vectors.search(axis(1), 5);
  expect(afterRemove.find((match) => match.memory_id === far.id)).toBeUndefined();
}

export async function float8FallbackScenario(storage: OnememoryStorage): Promise<void> {
  // Forced float8 backend exercises the GATE-1 fallback end-to-end on the same instance.
  const fallback = await createEmbeddingIndex(storage.client, {
    dim: 384,
    model: 'local/minilm-l6-v2',
    backend: 'float8',
  });
  expect(fallback.backend).toBe('float8');

  const ctx = await seedProjectAndSource(storage, 'float8');
  const a = (await storage.store.insertMemory(makeMemory(ctx, { content: `fallback a ${uniqueId().slice(0, 6)}` }))).memory;
  const b = (await storage.store.insertMemory(makeMemory(ctx, { content: `fallback b ${uniqueId().slice(0, 6)}` }))).memory;
  const axis = (index: number) => Array.from({ length: 384 }, (_, i) => (i === index ? 1 : 0));
  await fallback.upsert(a.id, axis(0));
  await fallback.upsert(b.id, axis(1));

  const matches = await fallback.search(axis(0), 2);
  expect(matches[0]?.memory_id).toBe(a.id);
  expect(matches[0]?.cosine).toBeCloseTo(1, 5);
  expect(matches[1]?.memory_id).toBe(b.id);
  expect(matches[1]?.cosine).toBeCloseTo(0, 5);

  // The fallback table exists; the pgvector table is untouched by the fallback index.
  const altTable = await storage.client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'memory_vectors_alt'",
  );
  expect(altTable.rows[0]?.n).toBe(1);

  // Dimension mismatches fail loudly (deployment config must match the model).
  await expect(fallback.upsert(a.id, [1, 2, 3])).rejects.toThrow(/dimension mismatch/);
}

// ---------------------------------------------------------------------------
// Hard purge (Store.deleteMemory) — delete ≠ forget: the 'purged' audit row survives
// ---------------------------------------------------------------------------

export async function purgeScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'purge');
  const tag = uniqueId().slice(0, 6);

  // A supersession pair: purging the WINNER must clear the loser's forward pointer, keep the loser.
  const node20 = await storage.store.insertMemory(
    makeMemory(ctx, {
      content: `This project uses Node 20 for its runtime ${tag}.`,
      observed_at: '2024-01-15T00:00:00.000Z',
      valid_from: '2024-01-15T00:00:00.000Z',
      title: 'Node 20',
    }),
  );
  expect(node20.outcome).toBe('inserted');
  const superseded = await storage.store.supersede({
    winner: makeMemory(ctx, {
      content: `This project uses Node 22 for its runtime ${tag}.`,
      observed_at: '2025-06-01T00:00:00.000Z',
      valid_from: '2025-06-01T00:00:00.000Z',
      title: 'Node 22',
    }),
    loser_id: node20.memory.id,
    actor: 'user:fixture',
    reason: 'newer wins',
  });
  expect(superseded.outcome).toBe('superseded');
  if (superseded.outcome !== 'superseded') return;
  const winnerId = superseded.winner.id;

  // The winner carries the full dependent payload: a vector, an entity binding, an edge.
  await storage.vectors.upsert(winnerId, new Array(384).fill(0.05));
  const entity = await storage.store.createEntity({
    kind: 'service',
    name: `node runtime ${tag}`,
    project_id: ctx.projectId,
  });
  await storage.store.bindMemoryEntities(winnerId, [{ entity_id: entity.id, role: 'subject' }]);
  const neighbour = (await storage.store.insertMemory(makeMemory(ctx, { content: `Edge target ${tag}.` }))).memory;
  await storage.store.addEdge({ from_memory_id: winnerId, to_memory_id: neighbour.id, relation: 'related_to' });

  // A promoted working row points at the winner: the purge un-links it; the row itself survives.
  const session = await storage.store.createSession(makeSession({ project_id: ctx.projectId }));
  const working = await storage.store.insertWorking(
    makeWorking(session.id, { kind: 'task', content: 'promoted note', expires_at: '2099-01-01T00:00:00.000Z' }),
  );
  await storage.store.markWorkingPromoted(working.id, winnerId);

  // Unknown id → null (never a throw).
  expect(await storage.store.deleteMemory(uniqueId(), { actor: 'coordinator-test' })).toBeNull();

  // Purge the winner.
  const purged = await storage.store.deleteMemory(winnerId, { actor: 'agent:fixture', reason: 'gdpr-style removal' });
  expect(purged).not.toBeNull();
  if (!purged) return;
  expect(purged.purged).toBe(true);
  expect(purged.memory.id).toBe(winnerId);
  expect(purged.memory.content).toContain(tag);

  // The row is gone; the cascaded dependents are gone.
  expect(await storage.store.getMemory(winnerId)).toBeNull();
  const vectorCount = await storage.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM memory_vectors WHERE memory_id = $1::uuid',
    [winnerId],
  );
  expect(vectorCount.rows[0]?.n).toBe(0);
  const bindingCount = await storage.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM memory_entities WHERE memory_id = $1::uuid',
    [winnerId],
  );
  expect(bindingCount.rows[0]?.n).toBe(0);
  const edgeCount = await storage.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM edges WHERE from_memory_id = $1::uuid OR to_memory_id = $1::uuid',
    [winnerId],
  );
  expect(edgeCount.rows[0]?.n).toBe(0);

  // The 'purged' audit row survives (memory_events is FK-less by design).
  const audit = await storage.store.listMemoryEvents(winnerId);
  const purgeEntry = audit.find((entry) => entry.action === 'purged');
  expect(purgeEntry).toBeDefined();
  expect(purgeEntry?.from_status).toBe('active');
  expect(purgeEntry?.actor).toBe('agent:fixture');
  expect((purgeEntry?.details as { reason?: string } | undefined)?.reason).toBe('gdpr-style removal');

  // The superseded loser survives; the purge cleared its forward pointer.
  const loser = await storage.store.getMemory(node20.memory.id);
  expect(loser).not.toBeNull();
  expect(loser?.superseded_by).toBeUndefined();
  expect(loser?.status).toBe('superseded');

  // The promoted working row survives, un-linked.
  const workingRow = (await storage.store.listWorking(session.id)).find((row) => row.id === working.id);
  expect(workingRow).toBeDefined();
  // (The working-memory mapper keeps SQL NULL as null; the memories mapper renders it undefined.)
  expect(workingRow?.promoted_memory_id).toBeNull();

  // Idempotent miss: purging again is a plain null.
  expect(await storage.store.deleteMemory(winnerId, { actor: 'coordinator-test' })).toBeNull();
}

// ---------------------------------------------------------------------------
// Code memory (M4 persistence — ADR-0008)
// ---------------------------------------------------------------------------

const hex40 = (char: string): string => char.repeat(40);
const sha = (value: number): string => value.toString(16).padStart(40, '0');

export async function codeMemoryPersistenceScenario(storage: OnememoryStorage): Promise<void> {
  const { projectId } = await seedProjectAndSource(storage, 'code-memory-project');
  const root = `/tmp/onemem-code-${uniqueId()}`;
  const repository = await storage.codeMemory.ensureRepository({ project_id: projectId, root_path: root });
  expect((await storage.codeMemory.ensureRepository({ project_id: projectId, root_path: root })).id).toBe(repository.id);
  expect((await storage.codeMemory.listRepositories(projectId)).map((row) => row.id)).toEqual([repository.id]);

  // A different project may register the same root; uniqueness is per (project, root).
  const otherProject = await storage.store.createProject({
    name: `code-memory-parallel-${uniqueId().slice(0, 8)}`,
    root_path: '/tmp/fixture',
  });
  const parallel = await storage.codeMemory.ensureRepository({ project_id: otherProject.id, root_path: root });
  expect(parallel.id).not.toBe(repository.id);

  const head1 = hex40('a');
  const first = await storage.codeMemory.saveSnapshot(repository.id, {
    root_path: root,
    head_commit: head1,
    hash_algorithm: 'git-sha1',
    mode: 'git',
    exclusion_globs: [],
    captured_at: '2026-10-04T00:00:00.000Z',
    files: [
      { path: 'src/a.ts', tier: 'committed', blob_sha: sha(1), mode: '100644' },
      { path: 'src/a.ts', tier: 'worktree', blob_sha: sha(2), mode: '100644' },
      { path: 'src/b.ts', tier: 'worktree', blob_sha: sha(3), mode: '100755' },
      { path: 'src/d.ts', tier: 'worktree', blob_sha: sha(5), mode: '100644' },
    ],
    skipped: [],
  });
  expect(first.rewritten).toBe(4);
  expect(first.deleted).toBe(0);
  expect(first.retained_unavailable).toBe(0);
  expect(first.repository.head_commit).toBe(head1);
  // Persistence never advances the ingestion checkpoint (ADR-0008) — that is the drift
  // pipeline's exclusive right, exercised only when changed knowledge is fully processed.
  expect(first.repository.last_ingested_commit).toBeNull();

  // Both tiers of one path coexist — the dual-tier primary key is the point of the migration.
  expect(
    (await storage.codeMemory.loadFingerprints(repository.id)).map((f) => `${f.tier}:${f.path}`),
  ).toEqual(['committed:src/a.ts', 'worktree:src/a.ts', 'worktree:src/b.ts', 'worktree:src/d.ts']);
  expect(
    (await storage.codeMemory.loadFingerprints(repository.id, { tier: 'committed' })).map((f) => f.blob_sha),
  ).toEqual([sha(1)]);
  expect(
    (await storage.codeMemory.loadFingerprints(repository.id, { paths: ['src/b.ts', 'missing.ts'] })).map((f) => f.file_mode),
  ).toEqual(['100755']);

  const metadata = await storage.codeMemory.loadSnapshotMetadata(repository.id);
  expect(metadata?.hash_algorithm).toBe('git-sha1');
  expect(metadata?.head_commit).toBe(head1);
  expect(metadata?.file_count).toBe(4);

  // Second capture: a.ts worktree bytes changed; b.ts went unavailable (retained with its
  // last-known hash); d.ts disappeared entirely (deleted); c.ts is new; HEAD moved.
  const secondSnapshot = {
    root_path: root,
    head_commit: hex40('b'),
    hash_algorithm: 'git-sha1' as const,
    mode: 'git' as const,
    exclusion_globs: [] as string[],
    captured_at: '2026-10-04T00:01:00.000Z',
    files: [
      { path: 'src/a.ts', tier: 'committed' as const, blob_sha: sha(1), mode: '100644' as const },
      { path: 'src/a.ts', tier: 'worktree' as const, blob_sha: sha(9), mode: '100644' as const },
      { path: 'src/c.ts', tier: 'worktree' as const, blob_sha: sha(4), mode: '100644' as const },
    ],
    skipped: [{ path: 'src/b.ts', tier: 'worktree' as const }],
  };
  const second = await storage.codeMemory.saveSnapshot(repository.id, secondSnapshot);
  expect(second.rewritten).toBe(3);
  expect(second.deleted).toBe(1);
  expect(second.retained_unavailable).toBe(1);
  expect(second.repository.head_commit).toBe(secondSnapshot.head_commit);
  expect(second.repository.last_ingested_commit).toBeNull();

  expect(
    (await storage.codeMemory.loadFingerprints(repository.id)).map((f) => `${f.tier}:${f.path}@${f.blob_sha}`),
  ).toEqual([
    `committed:src/a.ts@${sha(1)}`,
    `worktree:src/a.ts@${sha(9)}`,
    `worktree:src/b.ts@${sha(3)}`,
    `worktree:src/c.ts@${sha(4)}`,
  ]);

  // Saving the very same snapshot again rewrites nothing: already-current rows are untouched
  // (the conflict guard), so their updated_at stays the last-value-change timestamp.
  const aWorktree = (await storage.codeMemory.loadFingerprints(repository.id, {
    tier: 'worktree',
    paths: ['src/a.ts'],
  }))[0]!;
  const third = await storage.codeMemory.saveSnapshot(repository.id, secondSnapshot);
  expect(third.rewritten).toBe(0);
  expect(third.deleted).toBe(0);
  const aWorktreeAgain = (await storage.codeMemory.loadFingerprints(repository.id, {
    tier: 'worktree',
    paths: ['src/a.ts'],
  }))[0]!;
  expect(aWorktreeAgain.updated_at).toBe(aWorktree.updated_at);

  // Boundary checks: a snapshot from another root, an unknown repository, a malformed hash.
  await expect(
    storage.codeMemory.saveSnapshot(repository.id, {
      root_path: '/tmp/elsewhere', head_commit: null, hash_algorithm: 'git-sha1', mode: 'git',
      exclusion_globs: [], captured_at: '2026-10-04T00:02:00.000Z', files: [], skipped: [],
    }),
  ).rejects.toThrow(/invalid input for saveSnapshot root_path mismatch/);
  await expect(
    storage.codeMemory.saveSnapshot(uniqueId(), {
      root_path: root, head_commit: null, hash_algorithm: 'git-sha1', mode: 'git',
      exclusion_globs: [], captured_at: '2026-10-04T00:02:00.000Z', files: [], skipped: [],
    }),
  ).rejects.toThrow(/not found/);
  await expect(storage.codeMemory.loadSnapshotMetadata(uniqueId())).rejects.toThrow(/not found/);
  await expect(
    storage.codeMemory.saveSnapshot(repository.id, {
      root_path: root, head_commit: null, hash_algorithm: 'git-sha1', mode: 'git',
      exclusion_globs: [], captured_at: '2026-10-04T00:02:00.000Z',
      files: [{ path: 'x.ts', tier: 'worktree', blob_sha: 'not-hex', mode: '100644' }],
      skipped: [],
    }),
  ).rejects.toThrow(ValidationError);

  // Removing the repository cascades its fingerprint rows (schema ON DELETE CASCADE).
  await storage.client.query('DELETE FROM repositories WHERE id = $1::uuid', [repository.id]);
  expect(await storage.codeMemory.getRepository(repository.id)).toBeNull();
  expect(await storage.codeMemory.loadFingerprints(repository.id)).toEqual([]);
}

/**
 * Code refs (M4c): the persistence half of the drift oracle. Refs are worktree-tier evidence by
 * definition (no tier column — pinned in code against the normative worktree-tier drift query),
 * recordCodeRefs is an idempotent upsert, the latest snapshot's unreadable set is persisted so
 * drift can treat retained rows as suspects, and removal happens only via FK cascades.
 */
export async function codeMemoryRefsScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'code-refs-project');
  const inserted = await storage.store.insertMemory(
    makeMemory(ctx, { content: `the auth module validates sessions ${uniqueId().slice(0, 8)}` }),
  );
  expect(inserted.outcome).toBe('inserted');
  const root = `/tmp/onemem-code-refs-${uniqueId()}`;
  const repository = await storage.codeMemory.ensureRepository({ project_id: ctx.projectId, root_path: root });

  // A capture that could not read src/b.ts: its unavailable set must persist for drift's
  // suspicion (b.ts never had a row, so nothing is retained — retained_unavailable stays 0).
  const saved = await storage.codeMemory.saveSnapshot(repository.id, {
    root_path: root,
    head_commit: hex40('c'),
    hash_algorithm: 'git-sha1',
    mode: 'git',
    exclusion_globs: [],
    captured_at: '2026-10-05T00:00:00.000Z',
    files: [
      { path: 'src/a.ts', tier: 'committed', blob_sha: sha(1), mode: '100644' },
      { path: 'src/a.ts', tier: 'worktree', blob_sha: sha(2), mode: '100644' },
    ],
    skipped: [{ path: 'src/b.ts', tier: 'worktree' }],
  });
  expect(saved.retained_unavailable).toBe(0);
  const metadata = await storage.codeMemory.loadSnapshotMetadata(repository.id);
  expect(metadata?.skipped).toEqual([{ path: 'src/b.ts', tier: 'worktree' }]);
  expect(metadata?.skipped_count).toBe(1);

  // Idempotent upsert: re-recording a path updates its blob and keeps the original created_at.
  const recorded = await storage.codeMemory.recordCodeRefs({
    memory_id: inserted.memory.id,
    repository_id: repository.id,
    refs: [
      { path: 'src/a.ts', blob_sha: sha(2) },
      { path: 'src/b.ts', blob_sha: sha(3) },
    ],
  });
  expect(recorded.map((ref) => `${ref.path}@${ref.blob_sha}`)).toEqual([
    `src/a.ts@${sha(2)}`,
    `src/b.ts@${sha(3)}`,
  ]);
  const updated = await storage.codeMemory.recordCodeRefs({
    memory_id: inserted.memory.id,
    repository_id: repository.id,
    refs: [{ path: 'src/a.ts', blob_sha: sha(9) }],
  });
  expect(updated).toHaveLength(1);
  expect(updated[0]?.blob_sha).toBe(sha(9));
  const listed = await storage.codeMemory.listCodeRefs(repository.id);
  expect(listed.map((ref) => `${ref.path}@${ref.blob_sha}`)).toEqual([
    `src/a.ts@${sha(9)}`,
    `src/b.ts@${sha(3)}`,
  ]);
  expect(listed.find((ref) => ref.path === 'src/a.ts')?.created_at).toBe(
    recorded.find((ref) => ref.path === 'src/a.ts')?.created_at,
  );
  expect((await storage.codeMemory.listCodeRefs(repository.id, { paths: ['src/b.ts', 'no.ts'] })).map((ref) => ref.path)).toEqual(['src/b.ts']);
  expect(await storage.codeMemory.listCodeRefs(repository.id, { paths: [] })).toEqual([]);

  // Boundary rejection: unsafe paths, malformed hashes, duplicated paths, unknown rows.
  await expect(
    storage.codeMemory.recordCodeRefs({
      memory_id: inserted.memory.id,
      repository_id: repository.id,
      refs: [{ path: '../escape.ts', blob_sha: sha(1) }],
    }),
  ).rejects.toThrow(ValidationError);
  await expect(
    storage.codeMemory.recordCodeRefs({
      memory_id: inserted.memory.id,
      repository_id: repository.id,
      refs: [{ path: 'x.ts', blob_sha: 'not-hex' }],
    }),
  ).rejects.toThrow(ValidationError);
  await expect(
    storage.codeMemory.recordCodeRefs({
      memory_id: inserted.memory.id,
      repository_id: repository.id,
      refs: [
        { path: 'x.ts', blob_sha: sha(1) },
        { path: 'x.ts', blob_sha: sha(2) },
      ],
    }),
  ).rejects.toThrow(ValidationError);
  await expect(
    storage.codeMemory.recordCodeRefs({
      memory_id: uniqueId(),
      repository_id: repository.id,
      refs: [{ path: 'x.ts', blob_sha: sha(1) }],
    }),
  ).rejects.toThrow(/not found/);
  await expect(
    storage.codeMemory.recordCodeRefs({
      memory_id: inserted.memory.id,
      repository_id: uniqueId(),
      refs: [{ path: 'x.ts', blob_sha: sha(1) }],
    }),
  ).rejects.toThrow(/not found/);

  // Removal is the FK cascades' job (no delete API): the memory's refs die with the memory.
  await storage.store.deleteMemory(inserted.memory.id, { actor: 'coordinator-test' });
  expect(await storage.codeMemory.listCodeRefs(repository.id)).toEqual([]);

  // ...and a repository removal cascades any other memory's refs to it.
  const second = await storage.store.insertMemory(
    makeMemory(ctx, { content: `session tokens rotate hourly ${uniqueId().slice(0, 8)}` }),
  );
  await storage.codeMemory.recordCodeRefs({
    memory_id: second.memory.id,
    repository_id: repository.id,
    refs: [{ path: 'src/a.ts', blob_sha: sha(9) }],
  });
  await storage.client.query('DELETE FROM repositories WHERE id = $1::uuid', [repository.id]);
  expect(await storage.codeMemory.listCodeRefs(repository.id)).toEqual([]);
}

/**
 * Symbol tables (M4d, ADR-0008 `code_symbols.span_hash`): scoped replacement per covered file
 * with a per-file rewrite guard over `file_fingerprints.symbols_hash` (identical tables are
 * never rewritten), the hash landing on worktree-tier fingerprint rows only, symbol rows
 * dying with their fingerprint anchor (saveSnapshot), unavailable paths retaining last-known
 * rows, and the same boundary discipline as every other code-memory writer.
 */
export async function codeMemorySymbolsScenario(storage: OnememoryStorage): Promise<void> {
  const { projectId } = await seedProjectAndSource(storage, 'code-symbols-project');
  const root = `/tmp/onemem-symbols-${uniqueId()}`;
  const repository = await storage.codeMemory.ensureRepository({ project_id: projectId, root_path: root });
  const span = (value: number): string => value.toString(16).padStart(64, '0');

  await storage.codeMemory.saveSnapshot(repository.id, {
    root_path: root,
    head_commit: hex40('d'),
    hash_algorithm: 'git-sha1',
    mode: 'git',
    exclusion_globs: [],
    captured_at: '2026-10-06T00:00:00.000Z',
    files: [
      { path: 'src/a.ts', tier: 'committed', blob_sha: sha(1), mode: '100644' },
      { path: 'src/a.ts', tier: 'worktree', blob_sha: sha(2), mode: '100644' },
      { path: 'src/b.ts', tier: 'worktree', blob_sha: sha(3), mode: '100644' },
      { path: 'src/c.py', tier: 'worktree', blob_sha: sha(5), mode: '100644' },
    ],
    skipped: [],
  });

  const alpha: SymbolRecordInput = {
    name: 'alpha', kind: 'function', signature: 'function alpha ( )',
    line_start: 1, line_end: 1, span_hash: span(1),
  };
  const container: SymbolRecordInput = {
    name: 'Container', kind: 'class', signature: 'class Container',
    line_start: 3, line_end: 8, span_hash: span(2),
  };
  const beta: SymbolRecordInput = {
    name: 'beta', kind: 'function', signature: 'function beta ( )',
    line_start: 1, line_end: 1, span_hash: span(3),
  };
  const helper: SymbolRecordInput = {
    name: 'helper', kind: 'function', signature: 'def helper ( )',
    line_start: 1, line_end: 2, span_hash: span(5),
  };
  const table: SymbolFileInput[] = [
    {
      path: 'src/a.ts', language: 'typescript', symbols: [alpha, container],
      symbols_hash: span(11),
    },
    { path: 'src/b.ts', language: 'typescript', symbols: [beta], symbols_hash: span(13) },
    { path: 'src/c.py', language: 'python', symbols: [helper], symbols_hash: span(15) },
  ];

  const first = await storage.codeMemory.saveSymbolTable(repository.id, { files: table });
  expect(first.rewritten).toBe(3);
  expect(first.unchanged).toBe(0);
  expect(first.repository.last_ingested_commit).toBeNull(); // the checkpoint never moves here
  expect(first.repository.head_commit).toBe(hex40('d'));

  const stored = await storage.codeMemory.loadSymbols(repository.id);
  expect(stored.map((symbol) => `${symbol.path}:${symbol.name}:${symbol.kind}`)).toEqual([
    'src/a.ts:alpha:function',
    'src/a.ts:Container:class',
    'src/b.ts:beta:function',
    'src/c.py:helper:function',
  ]);
  expect(stored[0]).toMatchObject({
    signature: 'function alpha ( )', line_start: 1, line_end: 1, span_hash: span(1),
  });
  expect(stored.every((symbol) => symbol.repository_id === repository.id)).toBe(true);
  const storedTimes = stored.map((symbol) => `${symbol.path}:${symbol.updated_at}`);

  // The per-file hashes live on the WORKTREE-tier fingerprint rows only (symbols are extracted
  // from worktree bytes; the committed tier never claims symbol knowledge).
  const fingerprints = await storage.codeMemory.loadFingerprints(repository.id);
  expect(fingerprints.map((row) => `${row.tier}:${row.path}@${row.symbols_hash}`)).toEqual([
    `committed:src/a.ts@${null}`,
    `worktree:src/a.ts@${span(11)}`,
    `worktree:src/b.ts@${span(13)}`,
    `worktree:src/c.py@${span(15)}`,
  ]);

  // The rewrite guard: saving the very same tables rewrites nothing — every row keeps its
  // updated_at (only changed symbol tables are persisted, exactly like snapshot fingerprints).
  const again = await storage.codeMemory.saveSymbolTable(repository.id, { files: table });
  expect(again.rewritten).toBe(0);
  expect(again.unchanged).toBe(3);
  const storedAgain = await storage.codeMemory.loadSymbols(repository.id);
  expect(storedAgain.map((symbol) => `${symbol.path}:${symbol.updated_at}`)).toEqual(storedTimes);

  // A changed table for one file replaces only that file's rows (new span hash + a new
  // symbol; the old symbol is gone — replacement, not accumulation).
  const second = await storage.codeMemory.saveSymbolTable(repository.id, {
    files: [
      {
        path: 'src/a.ts', language: 'typescript',
        symbols: [{ ...alpha, span_hash: span(9) }, { ...container, name: 'renamed', span_hash: span(4) }],
        symbols_hash: span(21),
      },
      table[1]!, table[2]!,
    ],
  });
  expect(second.rewritten).toBe(1);
  expect(second.unchanged).toBe(2);
  const afterChange = await storage.codeMemory.loadSymbols(repository.id);
  const changedRows = afterChange.filter((symbol) => symbol.path === 'src/a.ts');
  expect(changedRows.map((symbol) => `${symbol.name}@${symbol.span_hash}`)).toEqual([
    `alpha@${span(9)}`,
    `renamed@${span(4)}`,
  ]);
  // Replacement, never accumulation: the file still has exactly its current table's rows.
  expect(changedRows).toHaveLength(2);
  expect(afterChange).toHaveLength(4); // a.ts(2) + b.ts(1) + c.py(1), unchanged files intact
  const untouchedBeta = afterChange.find((symbol) => symbol.path === 'src/b.ts')!;
  expect(untouchedBeta.span_hash).toBe(span(3)); // the guard left the untouched file's rows alone

  // Path filtering on the read side.
  expect(
    (await storage.codeMemory.loadSymbols(repository.id, { paths: ['src/c.py', 'no.ts'] }))
      .map((symbol) => symbol.name),
  ).toEqual(['helper']);
  expect(await storage.codeMemory.loadSymbols(repository.id, { paths: [] })).toEqual([]);

  // The anchor rule: a snapshot that DROPS src/c.py (deleted) removes its symbol rows with its
  // fingerprint; a snapshot that could not read src/b.ts retains b.ts's rows as last-known.
  await storage.codeMemory.saveSnapshot(repository.id, {
    root_path: root,
    head_commit: hex40('e'),
    hash_algorithm: 'git-sha1',
    mode: 'git',
    exclusion_globs: [],
    captured_at: '2026-10-06T00:01:00.000Z',
    files: [
      { path: 'src/a.ts', tier: 'committed', blob_sha: sha(1), mode: '100644' },
      { path: 'src/a.ts', tier: 'worktree', blob_sha: sha(9), mode: '100644' },
    ],
    skipped: [{ path: 'src/b.ts', tier: 'worktree' }],
  });
  const afterSnapshot = await storage.codeMemory.loadSymbols(repository.id);
  expect(afterSnapshot.map((symbol) => `${symbol.path}:${symbol.name}`)).toEqual([
    'src/a.ts:alpha',
    'src/a.ts:renamed',
    'src/b.ts:beta', // retained last-known: the capture could not read it
  ]);
  const retainedBeta = afterSnapshot.find((symbol) => symbol.path === 'src/b.ts')!;
  expect(retainedBeta.updated_at).toBe(untouchedBeta.updated_at);
  expect((await storage.codeMemory.loadFingerprints(repository.id)).map((row) => `${row.tier}:${row.path}`))
    .toEqual(['committed:src/a.ts', 'worktree:src/a.ts', 'worktree:src/b.ts']);

  // Boundary discipline: unknown repository, a covered path without a live worktree anchor
  // (the pipeline shape is saveSnapshot FIRST), and malformed extractions all reject.
  await expect(
    storage.codeMemory.saveSymbolTable(uniqueId(), { files: [table[0]!] }),
  ).rejects.toThrow(/not found/);
  await expect(
    storage.codeMemory.saveSymbolTable(repository.id, {
      files: [{ path: 'never-captured.ts', language: 'typescript', symbols: [], symbols_hash: span(1) }],
    }),
  ).rejects.toThrow(/not found/);
  await expect(
    storage.codeMemory.saveSymbolTable(repository.id, { files: [table[1]!, table[1]!] }),
  ).rejects.toThrow(ValidationError);
  await expect(
    storage.codeMemory.saveSymbolTable(repository.id, {
      files: [{ ...table[1]!, language: 'typescript' as const, symbols_hash: 'not-hex' }],
    }),
  ).rejects.toThrow(ValidationError);
  await expect(
    storage.codeMemory.saveSymbolTable(repository.id, {
      files: [
        { ...table[1]!, language: 'typescript' as const, symbols: [{ ...beta, kind: 'widget' as never }] },
      ],
    }),
  ).rejects.toThrow(ValidationError);
  await expect(storage.codeMemory.saveSymbolTable(repository.id, { files: [] })).rejects.toThrow(
    ValidationError,
  );

  // A legitimate save of an EMPTY symbol table (a source file that declares nothing) replaces
  // a.ts's rows with none — the hash is over an empty table, not a gap in coverage.
  const emptied = await storage.codeMemory.saveSymbolTable(repository.id, {
    files: [{ path: 'src/a.ts', language: 'typescript', symbols: [], symbols_hash: span(99) }],
  });
  expect(emptied.rewritten).toBe(1);
  expect(emptied.unchanged).toBe(0);
  expect((await storage.codeMemory.loadSymbols(repository.id)).map((symbol) => symbol.path)).toEqual([
    'src/b.ts', // retained last-known from the unreadable capture
  ]);

  // Removal is the repository FK cascade's job (no delete API), and it cascades symbol rows.
  await storage.client.query('DELETE FROM repositories WHERE id = $1::uuid', [repository.id]);
  expect(await storage.codeMemory.loadSymbols(repository.id)).toEqual([]);
}

/**
 * Drift apply (M4e): the persistence primitives the codememory drift applier drives — audited
 * stale, conservative ref retargeting, and the compare-and-set checkpoint — on BOTH legs.
 * Record refs → a new capture drifts one file and exactly renames another → apply → assert
 * stale + retarget + checkpoint advanced → a second apply is a no-op.
 */
export async function codeMemoryDriftApplyScenario(storage: OnememoryStorage): Promise<void> {
  const ctx = await seedProjectAndSource(storage, 'code-drift-apply-project');
  const memory = async (label: string): Promise<string> => {
    const inserted = await storage.store.insertMemory(
      makeMemory(ctx, { content: `${label} ${uniqueId().slice(0, 8)}` }),
    );
    expect(inserted.outcome).toBe('inserted');
    return inserted.memory.id;
  };
  const changed = await memory('a.ts computes totals');
  const renamed = await memory('b.ts parses input');
  const bystander = await memory('c.ts is constant');
  const root = `/tmp/onemem-drift-apply-${uniqueId()}`;
  const repository = await storage.codeMemory.ensureRepository({ project_id: ctx.projectId, root_path: root });
  const capture = (head: string, files: Array<[path: string, blob: string]>, skipped: string[] = []) =>
    storage.codeMemory.saveSnapshot(repository.id, {
      root_path: root,
      head_commit: head,
      hash_algorithm: 'git-sha1',
      mode: 'git',
      exclusion_globs: [],
      captured_at: '2026-10-07T00:00:00.000Z',
      files: files.map(([path, blob]) => ({ path, tier: 'worktree' as const, blob_sha: blob, mode: '100644' as const })),
      skipped: skipped.map((path) => ({ path, tier: 'worktree' as const })),
    });

  const head1 = hex40('1');
  await capture(head1, [['a.ts', sha(10)], ['b.ts', sha(20)], ['c.ts', sha(30)], ['locked.ts', sha(40)]]);
  for (const [memoryId, path, blob] of [
    [changed, 'a.ts', sha(10)],
    [renamed, 'b.ts', sha(20)],
    [bystander, 'c.ts', sha(30)],
  ] as const) {
    await storage.codeMemory.recordCodeRefs({ memory_id: memoryId, repository_id: repository.id, refs: [{ path, blob_sha: blob }] });
  }
  const baseline = await storage.codeMemory.advanceCheckpoint({
    repository_id: repository.id,
    expected_last_ingested_commit: null,
    to_commit: head1,
  });
  expect([baseline.outcome, baseline.previous_commit, baseline.current_commit]).toEqual(['advanced', null, head1]);
  expect(baseline.repository.last_ingested_commit).toBe(head1);

  // The drifting capture: a.ts edited, b.ts moved unchanged, locked.ts unreadable (retained).
  const head2 = hex40('2');
  await capture(head2, [['a.ts', sha(11)], ['moved/b.ts', sha(20)], ['c.ts', sha(30)]], ['locked.ts']);
  const auditsBefore = (await storage.store.listMemoryEvents(bystander)).length;

  // Apply: stale the content-changed memory, retarget the exact move, advance the checkpoint.
  const staled = await storage.store.updateMemoryStatus(changed, 'stale', { actor: 'job:drift_scan', reason: 'code_drift' });
  expect(staled.status).toBe('stale');
  const moved = await storage.codeMemory.retargetCodeRef({
    memory_id: renamed,
    repository_id: repository.id,
    from_path: 'b.ts',
    to_path: 'moved/b.ts',
  });
  expect(moved.outcome).toBe('retargeted');
  expect([moved.ref.path, moved.ref.blob_sha]).toEqual(['moved/b.ts', sha(20)]);
  const advanced = await storage.codeMemory.advanceCheckpoint({
    repository_id: repository.id,
    expected_last_ingested_commit: head1,
    to_commit: head2,
  });
  expect([advanced.outcome, advanced.previous_commit, advanced.current_commit]).toEqual(['advanced', head1, head2]);

  expect((await storage.store.getMemory(renamed))?.status).toBe('active');
  expect((await storage.store.getMemory(bystander))?.status).toBe('active');
  expect((await storage.store.listMemoryEvents(bystander)).length).toBe(auditsBefore);
  expect((await storage.codeMemory.listCodeRefs(repository.id)).map((ref) => [ref.memory_id, ref.path])).toEqual(
    [
      [changed, 'a.ts'],
      [renamed, 'moved/b.ts'],
      [bystander, 'c.ts'],
    ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
  );
  // Stale memories remain current knowledge until re-indexed.
  const current = await storage.store.queryCurrent({ project_id: ctx.projectId, limit: 20 });
  expect(current.map((row) => row.id)).toContain(changed);

  // Second apply of the same drift: every step is a safe no-op.
  await expect(
    storage.store.updateMemoryStatus(changed, 'stale', { actor: 'job:drift_scan' }),
  ).rejects.toThrow(InvalidTransitionError);
  const again = await storage.codeMemory.retargetCodeRef({
    memory_id: renamed,
    repository_id: repository.id,
    from_path: 'b.ts',
    to_path: 'moved/b.ts',
  });
  expect([again.outcome, again.ref.path]).toEqual(['already_retargeted', 'moved/b.ts']);
  const unchanged = await storage.codeMemory.advanceCheckpoint({
    repository_id: repository.id,
    expected_last_ingested_commit: head1,
    to_commit: head2,
  });
  expect([unchanged.outcome, unchanged.previous_commit, unchanged.current_commit]).toEqual(['unchanged', head2, head2]);

  // Retarget refuses anything the persisted worktree tier cannot prove.
  await storage.codeMemory.recordCodeRefs({
    memory_id: bystander,
    repository_id: repository.id,
    refs: [{ path: 'gone.ts', blob_sha: sha(40) }],
  });
  const retarget = (from_path: string, to_path: string, memory_id = bystander) =>
    storage.codeMemory.retargetCodeRef({ memory_id, repository_id: repository.id, from_path, to_path });
  expect((await retarget('c.ts', 'moved/b.ts')).outcome).toBe('source_present');
  expect((await retarget('gone.ts', 'c.ts')).outcome).toBe('conflict');
  expect((await retarget('gone.ts', 'moved/b.ts')).outcome).toBe('successor_mismatch'); // blob differs
  expect((await retarget('gone.ts', 'nowhere.ts')).outcome).toBe('successor_mismatch'); // no fingerprint
  // locked.ts holds the ref's exact blob, but only as a retained last-known (unreadable) value.
  const lockedRow = await storage.codeMemory.loadFingerprints(repository.id, { tier: 'worktree', paths: ['locked.ts'] });
  expect(lockedRow[0]?.blob_sha).toBe(sha(40));
  expect((await retarget('gone.ts', 'locked.ts')).outcome).toBe('successor_mismatch');
  expect((await storage.codeMemory.listCodeRefs(repository.id, { paths: ['gone.ts'] })).length).toBe(1);

  await expect(retarget('never.ts', 'c.ts', changed)).rejects.toThrow(NotFoundError);
  await expect(retarget('a.ts', 'c.ts', uniqueId())).rejects.toThrow(NotFoundError);
  await expect(
    storage.codeMemory.retargetCodeRef({ memory_id: changed, repository_id: uniqueId(), from_path: 'a.ts', to_path: 'c.ts' }),
  ).rejects.toThrow(NotFoundError);
  await expect(retarget('a.ts', 'a.ts', changed)).rejects.toThrow(ValidationError);
  await expect(retarget('a.ts', '../escape.ts', changed)).rejects.toThrow(ValidationError);

  // The checkpoint never moves behind the persisted head, and only from the expected prior.
  const back = await storage.codeMemory.advanceCheckpoint({
    repository_id: repository.id,
    expected_last_ingested_commit: head2,
    to_commit: head1,
  });
  expect([back.outcome, back.current_commit]).toEqual(['head_mismatch', head2]);
  const head3 = hex40('3');
  await capture(head3, [['a.ts', sha(11)], ['moved/b.ts', sha(20)], ['c.ts', sha(30)]]);
  const stale = await storage.codeMemory.advanceCheckpoint({
    repository_id: repository.id,
    expected_last_ingested_commit: head1,
    to_commit: head3,
  });
  expect([stale.outcome, stale.current_commit]).toEqual(['expectation_mismatch', head2]);
  expect((await storage.codeMemory.getRepository(repository.id))?.last_ingested_commit).toBe(head2);
  const forward = await storage.codeMemory.advanceCheckpoint({
    repository_id: repository.id,
    expected_last_ingested_commit: head2,
    to_commit: head3,
  });
  expect([forward.outcome, forward.previous_commit, forward.current_commit]).toEqual(['advanced', head2, head3]);
  await expect(
    storage.codeMemory.advanceCheckpoint({ repository_id: uniqueId(), expected_last_ingested_commit: null, to_commit: head3 }),
  ).rejects.toThrow(NotFoundError);
  await expect(
    storage.codeMemory.advanceCheckpoint({ repository_id: repository.id, expected_last_ingested_commit: null, to_commit: 'HEAD' }),
  ).rejects.toThrow(ValidationError);
}

// ---------------------------------------------------------------------------
// Suite runner — the same scenarios against BOTH deployment profiles (ADR-0002 CI matrix)
// ---------------------------------------------------------------------------

const STORAGE_SCENARIOS: ReadonlyArray<[title: string, scenario: (storage: OnememoryStorage) => Promise<void>]> = [
  ['migrations apply cleanly twice (idempotent)', migrationIdempotencyScenario],
  ['store → get roundtrip preserves every field', storeGetRoundtripScenario],
  ['dedupe: same scope rejected, cross-scope + NULL-scope allowed', dedupeScenario],
  ['supersession: loser closed, winner current, PIT + history correct', supersessionScenario],
  ['purge: row + cascaded dependents gone, audit survives, pointers cleared', purgeScenario],
  ['status transitions are audited; reinforce bumps counters', statusTransitionAuditScenario],
  ['events: dedupe by content_hash, redactions passthrough, pending pipeline', eventsIngestScenario],
  ['entity graph: scoped entities, merge', entityGraphScenario],
  ['working memory: sweep purges expired unpromoted, preserves promoted', workingMemoryScenario],
  ['jobs: singleton enqueue, claim/lease, backoff retry, dead-letter', jobsScenario],
  ['jobs worker: registry execution, JobKindNotImplemented, graceful loop', jobWorkerScenario],
  ['embedding index: pgvector KNN, upsert/replace, remove, minCosine', vectorIndexScenario],
  ['embedding index: float8 fallback end-to-end', float8FallbackScenario],
  ['code memory: dual-tier fingerprints persist; unavailable paths retained; checkpoint never advances', codeMemoryPersistenceScenario],
  ['code memory refs: idempotent upsert, path filters, unreadable set persisted, FK cascades', codeMemoryRefsScenario],
  ['code memory symbols: scoped replacement, rewrite guard, hashes on fingerprints, anchor pruning', codeMemorySymbolsScenario],
  ['code memory drift apply: audited stale, verified retarget, compare-and-set checkpoint, idempotent re-apply', codeMemoryDriftApplyScenario],
];

/**
 * Register the full integration suite against one deployment profile. `open` yields a fresh
 * handle per scenario (embedded: isolated temp dir; server: the shared pool, unique fixtures).
 */
export function runStorageIntegrationSuite(
  suiteName: string,
  open: () => Promise<StorageHandle>,
  options?: { enabled?: boolean },
): void {
  const describeFn = options?.enabled === false ? describe.skip : describe;
  describeFn(suiteName, () => {
    for (const [title, scenario] of STORAGE_SCENARIOS) {
      test(title, async () => {
        const handle = await open();
        try {
          await scenario(handle.storage);
        } finally {
          await handle.close();
        }
      });
    }
  });
}
