/**
 * The M14.6 acceptance scenarios end to end over REAL embedded storage (PGlite, migrated with
 * the real 0002_events_digest migration) and the REAL `EventsCompactor` port implementation —
 * no doubles:
 *
 *   - e2e (AC 6): a seeded project with many raw events compacts to the bounded row count;
 *   - the lineage invariant (AC 3): after compaction every memory still resolves its `sources`
 *     link, and every `event:<id>` evidence locator resolves through the digest table;
 *   - idempotency (AC 4): a second run within the same windows changes nothing;
 *   - dry-run prints the typed plan and mutates nothing;
 *   - blocked events (unprocessed / needs_review / process_error) are never silently purged;
 *   - retention 0 keeps raw events forever while the summarize tier still runs;
 *   - batching and the per-run cap stay correct, and a capped run resumes on the next pass.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  eventContentHash,
  validateOnememoryEvent,
  type MemoryRecord,
  type NewMemory,
  type OnememoryEvent,
  type StoredEvent,
} from '@onememory/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory/storage';

import { runEventsCompaction } from './run';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const DAY_MS = 86_400_000;
const at = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

interface World {
  storage: OnememoryStorage;
  dataDir: string;
  projectId: string;
  sourceId: string;
  secondSourceId: string;
  memories: MemoryRecord[];
  oldEventIds: string[];
}

let world: World;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-compaction-'));
  const storage = await createEmbeddedDb(dataDir);
  const project = await storage.store.createProject({
    name: 'compaction-fixture',
    root_path: '/tmp/fixture',
  });
  const source = await storage.store.createSource({
    kind: 'conversation',
    uri: 'session/sess-compaction',
    title: 'compaction fixture session',
    project_id: project.id,
  });
  const secondSource = await storage.store.createSource({
    kind: 'terminal',
    uri: 'terminal/sess-compaction',
    title: 'compaction fixture terminal',
    project_id: project.id,
  });
  world = {
    storage,
    dataDir,
    projectId: project.id,
    sourceId: source.id,
    secondSourceId: secondSource.id,
    memories: [],
    oldEventIds: [],
  };

  // --- seed the raw event log ------------------------------------------------
  const events: Array<{ daysAgo: number; state: 'clean' | 'raw' | 'review' | 'error' }> = [];
  for (let index = 0; index < 24; index++) events.push({ daysAgo: 100, state: 'clean' });
  for (let index = 0; index < 6; index++) events.push({ daysAgo: 40, state: 'clean' });
  for (let index = 0; index < 3; index++) events.push({ daysAgo: 100, state: 'raw' });
  for (let index = 0; index < 2; index++) events.push({ daysAgo: 100, state: 'review' });
  events.push({ daysAgo: 100, state: 'error' });
  for (let index = 0; index < 3; index++) events.push({ daysAgo: 1, state: 'raw' });

  const seeded: StoredEvent[] = [];
  for (let index = 0; index < events.length; index++) {
    const spec = events[index]!;
    const payload = {
      kind: 'conversation.message',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `fixture message ${index} (${spec.state})`,
    } as const;
    const result = validateOnememoryEvent({
      id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
      kind: 'conversation.message',
      occurred_at: at(spec.daysAgo),
      ingested_at: at(spec.daysAgo),
      source: { runtime: 'claude-code', adapter_version: '1.0.0' },
      scope: { project_id: project.id, session_id: 'sess-compaction' },
      payload,
      content_hash: eventContentHash(payload),
      redactions: [],
    });
    if (!result.ok) throw new Error(`fixture event ${index} failed validation`);
    const ingested = await storage.store.ingestEvent(result.value as OnememoryEvent);
    expect(ingested.status).toBe('stored');
    if (spec.state === 'clean' || spec.state === 'review' || spec.state === 'error') {
      await storage.store.markEventProcessed(ingested.event_id, {
        ...(spec.state === 'review' ? { needs_review: true } : {}),
        ...(spec.state === 'error' ? { process_error: 'fixture pipeline error' } : {}),
      });
    }
    const row = (await storage.compactor.listCompactableEvents({
      olderThan: new Date(NOW.getTime() + DAY_MS).toISOString(),
      limit: 1000,
    })).find((candidate) => candidate.id === ingested.event_id);
    if (row === undefined) throw new Error(`seeded event ${index} not readable`);
    seeded.push(row);
  }

  // The first 24 (old, clean) are the purge tier; remember them for the lineage assertions.
  world.oldEventIds = seeded.slice(0, 24).map((event) => event.id);

  // --- seed durable memories + an edge whose evidence anchors the old events -------
  for (let index = 0; index < 3; index++) {
    const event = seeded[index]!;
    const candidate: NewMemory = {
      type: 'semantic',
      content: `We standardize on fixture tooling ${index}`,
      importance: 0.7,
      confidence: 0.8,
      observed_at: event.occurred_at,
      source_id: index === 2 ? world.secondSourceId : world.sourceId,
      evidence: [
        {
          source_id: index === 2 ? world.secondSourceId : world.sourceId,
          kind: 'event',
          locator: `event:${event.id}`,
          excerpt: `fixture message ${index} (clean)`,
        },
      ],
      extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
      project_id: project.id,
    };
    const write = await storage.store.insertMemory(candidate);
    expect(write.outcome).toBe('inserted');
    world.memories.push(write.memory);
  }
  await storage.store.addEdge({
    from_memory_id: world.memories[0]!.id,
    to_memory_id: world.memories[1]!.id,
    relation: 'related_to',
    project_id: project.id,
    evidence: [
      {
        source_id: world.secondSourceId,
        kind: 'event',
        locator: `event:${seeded[0]!.id}`,
        excerpt: 'edge evidence on the first old event',
      },
    ],
  });
});

afterAll(async () => {
  await world.storage.close();
  await rm(world.dataDir, { recursive: true, force: true });
});

describe('runEventsCompaction (real PGlite, real EventsCompactor)', () => {
  test('seeding sanity: 39 raw events, none digested', async () => {
    expect(await world.storage.compactor.countRawEvents()).toBe(39);
    expect(await world.storage.compactor.countRawEvents({ project_id: world.projectId })).toBe(39);
    expect(await world.storage.compactor.digestedEventIds(world.oldEventIds)).toEqual(new Set());
  });

  test('e2e: compacts the old tier, summarizes the mid tier, keeps the blocked tier (AC 6)', async () => {
    const report = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: world.projectId },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(report.dry_run).toBeFalse();
    expect(report.windows).toEqual({ summary_window_days: 30, retention_window_days: 90 });
    expect(report.plan.to_summarize).toBe(30); // 24 old clean + 6 mid
    expect(report.plan.to_purge).toBe(24); // the old clean tier only
    expect(report.plan.kept).toBe(6); // 3 raw + 2 review + 1 error
    expect(report.summarized).toBe(30);
    expect(report.purged).toBe(24);
    // The ceiling: 3 young + 6 mid + 6 blocked raw rows remain.
    expect(report.raw_events_remaining).toBe(15);
    expect(report.plan.blocked.map((entry) => entry.reason).sort()).toEqual([
      'needs_review',
      'needs_review',
      'process_error',
      'unprocessed',
      'unprocessed',
      'unprocessed',
    ]);
    expect(report.warnings.some((warning) => warning.includes('kept: unprocessed'))).toBeTrue();
    expect(report.warnings.some((warning) => warning.includes('kept: needs_review'))).toBeTrue();
    expect(report.warnings.some((warning) => warning.includes('kept: process_error'))).toBeTrue();
  });

  test('the lineage invariant: every memory keeps its sources link and every event locator resolves (AC 3)', async () => {
    const digested = await world.storage.compactor.digestedEventIds(world.oldEventIds);
    expect(digested.size).toBe(24); // one digest per purged raw event

    const current = await world.storage.store.queryCurrent({
      project_id: world.projectId,
      limit: 1000,
    });
    expect(current.length).toBeGreaterThanOrEqual(3);
    for (const memory of current) {
      // No memory is left without a sources link: the anchor row still exists.
      const source = await world.storage.store.getSource(memory.provenance.source.id);
      expect(source).not.toBeNull();
      // Every evidence locator resolves: a raw row OR a digest summary — never a dead pointer.
      for (const span of memory.provenance.evidence) {
        if (!span.locator.startsWith('event:')) continue;
        const eventId = span.locator.slice('event:'.length);
        const stillRaw = (await world.storage.compactor.listCompactableEvents({
          olderThan: new Date(NOW.getTime() + 5 * DAY_MS).toISOString(),
          limit: 1000,
        })).some((event) => event.id === eventId);
        const digest = stillRaw ? null : await world.storage.compactor.getEventDigest(eventId);
        expect(stillRaw || digest !== null).toBeTrue();
        if (digest !== null) {
          expect(digest.event_id).toBe(eventId);
          expect(digest.kind).toBe('conversation.message');
          expect(digest.summary.length).toBeGreaterThan(0);
          expect(digest.summary.length).toBeLessThanOrEqual(400);
          expect(digest.summary).toContain('fixture message');
        }
      }
    }

    // The digest rows carry the source linkage read from the evidence spans (memories + edges):
    // the first old event is anchored by a memory span on the conversation source AND an edge
    // span on the terminal source — both distinct sources appear, deduped.
    const firstDigest = await world.storage.compactor.getEventDigest(world.oldEventIds[0]!);
    expect(firstDigest).not.toBeNull();
    expect([...firstDigest!.source_ids].sort()).toEqual(
      [world.sourceId, world.secondSourceId].sort(),
    );
    // The third memory anchored its event on the terminal source alone.
    const thirdDigest = await world.storage.compactor.getEventDigest(world.oldEventIds[2]!);
    expect(thirdDigest!.source_ids).toEqual([world.secondSourceId]);
  });

  test('the audit chain is preserved: kind, hashes and timestamps survive verbatim', async () => {
    const digest = await world.storage.compactor.getEventDigest(world.oldEventIds[1]!);
    expect(digest).not.toBeNull();
    expect(digest!.kind).toBe('conversation.message');
    expect(digest!.runtime).toBe('claude-code');
    expect(digest!.adapter_version).toBe('1.0.0');
    expect(digest!.occurred_at).toBe(at(100));
    expect(digest!.project_id).toBe(world.projectId);
    expect(digest!.session_id).toBe('sess-compaction');
    expect(digest!.payload_bytes).toBeGreaterThan(0);
    expect(digest!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('idempotency: a second run within the same windows changes nothing (AC 4)', async () => {
    const before = await world.storage.compactor.countRawEvents({ project_id: world.projectId });
    const second = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: world.projectId },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(second.plan.to_summarize).toBe(0); // the mid tier is digested and awaiting retention
    expect(second.plan.to_purge).toBe(0);
    expect(second.summarized).toBe(0);
    expect(second.purged).toBe(0);
    expect(second.batches).toBe(0);
    expect(second.raw_events_remaining).toBe(before);
    expect(
      await world.storage.compactor.countRawEvents({ project_id: world.projectId }),
    ).toBe(before);
    // The digest table did not grow: summarize-once held.
    expect((await world.storage.compactor.digestedEventIds(world.oldEventIds)).size).toBe(24);
  });

  test('time advances and the mid tier purges — the windows are honest', async () => {
    // 55 days later the mid tier (40d old) is past the retention window, and the former young
    // tier (now 56d old) crosses the summary window — summarized, raw kept.
    const later = new Date(NOW.getTime() + 55 * DAY_MS);
    const report = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: world.projectId },
      now: () => later,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(report.purged).toBe(6); // the former mid tier, already summarized, now old enough
    expect(report.summarized).toBe(3); // the former young tier crosses the summary window
    expect(report.raw_events_remaining).toBe(9); // 3 summarized-but-young-for-retention + 6 blocked
  });

  test('retention 0 keeps raw events forever while the summarize tier still runs', async () => {
    // A second project with one old, clean event.
    const project = await world.storage.store.createProject({ name: 'keep-forever-fixture' });
    const payload = {
      kind: 'conversation.message',
      role: 'user',
      content: 'keep forever fixture message',
    };
    const result = validateOnememoryEvent({
      id: '00000000-0000-7000-8000-00000000ffff',
      kind: 'conversation.message',
      occurred_at: at(400),
      ingested_at: at(400),
      source: { runtime: 'claude-code', adapter_version: '1.0.0' },
      scope: { project_id: project.id },
      payload,
      content_hash: eventContentHash(payload),
      redactions: [],
    });
    if (!result.ok) throw new Error('keep-forever fixture failed validation');
    const ingested = await world.storage.store.ingestEvent(result.value as OnememoryEvent);
    await world.storage.store.markEventProcessed(ingested.event_id);

    const report = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: project.id },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 0 },
    });
    expect(report.windows.retention_window_days).toBe(0);
    expect(report.plan.retention_cutoff).toBeNull();
    expect(report.plan.to_summarize).toBe(1);
    expect(report.plan.to_purge).toBe(0);
    expect(report.summarized).toBe(1);
    expect(report.purged).toBe(0);
    expect(report.raw_events_remaining).toBe(1); // the raw row stayed
    expect(await world.storage.compactor.getEventDigest(ingested.event_id)).not.toBeNull();
  });

  test('dry-run prints the typed plan and mutates nothing', async () => {
    // Fresh third project so counts are unambiguous.
    const project = await world.storage.store.createProject({ name: 'dry-run-fixture' });
    for (let index = 0; index < 5; index++) {
      const payload = {
        kind: 'terminal.output',
        command: `bun test ${index}`,
        exit_code: 0,
        output_digest: `${index} passed`,
      };
      const result = validateOnememoryEvent({
        id: `00000000-0000-7000-8000-${String(2000 + index).padStart(12, '0')}`,
        kind: 'terminal.output',
        occurred_at: at(100),
        ingested_at: at(100),
        source: { runtime: 'claude-code', adapter_version: '1.0.0' },
        scope: { project_id: project.id },
        payload,
        content_hash: eventContentHash(payload),
        redactions: [],
      });
      if (!result.ok) throw new Error('dry-run fixture failed validation');
      const ingested = await world.storage.store.ingestEvent(result.value as OnememoryEvent);
      await world.storage.store.markEventProcessed(ingested.event_id);
    }

    const plan = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: project.id },
      now: () => NOW,
      dryRun: true,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(plan.dry_run).toBeTrue();
    expect(plan.plan.to_summarize).toBe(5);
    expect(plan.plan.to_purge).toBe(5);
    expect(plan.plan.entries).toHaveLength(5);
    expect(plan.summarized).toBe(0);
    expect(plan.purged).toBe(0);
    expect(plan.batches).toBe(0);
    expect(plan.raw_events_remaining).toBe(5);
    // Nothing changed on disk.
    expect(await world.storage.compactor.countRawEvents({ project_id: project.id })).toBe(5);
    const ids = (await world.storage.compactor.listCompactableEvents({
      olderThan: new Date(NOW.getTime() + DAY_MS).toISOString(),
      limit: 1000,
      scope: { project_id: project.id },
    })).map((event) => event.id);
    expect(await world.storage.compactor.digestedEventIds(ids)).toEqual(new Set());

    // The executing run then does exactly what the plan said.
    const executed = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: project.id },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(executed.purged).toBe(5);
    expect(executed.raw_events_remaining).toBe(0);
  });

  test('batching applies one transaction per batch and drains to zero', async () => {
    const project = await world.storage.store.createProject({ name: 'batching-fixture' });
    for (let index = 0; index < 17; index++) {
      const payload = {
        kind: 'test.results',
        passed: index,
        failed: 0,
        duration_ms: 100 + index,
      };
      const result = validateOnememoryEvent({
        id: `00000000-0000-7000-8000-${String(3000 + index).padStart(12, '0')}`,
        kind: 'test.results',
        occurred_at: at(100),
        ingested_at: at(100),
        source: { runtime: 'claude-code', adapter_version: '1.0.0' },
        scope: { project_id: project.id },
        payload,
        content_hash: eventContentHash(payload),
        redactions: [],
      });
      if (!result.ok) throw new Error('batching fixture failed validation');
      const ingested = await world.storage.store.ingestEvent(result.value as OnememoryEvent);
      await world.storage.store.markEventProcessed(ingested.event_id);
    }

    const report = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: project.id },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90, batchLimit: 5 },
    });
    // 17 events in batches of 5: 5+5+5+2 = four transactions.
    expect(report.batches).toBe(4);
    expect(report.purged).toBe(17);
    expect(report.raw_events_remaining).toBe(0);
  });

  test('the per-run cap truncates honestly and the next pass resumes', async () => {
    const project = await world.storage.store.createProject({ name: 'cap-fixture' });
    for (let index = 0; index < 12; index++) {
      const payload = {
        kind: 'error.raised',
        origin: 'test',
        message: `cap fixture failure ${index}`,
        context: 'fixture',
      };
      const result = validateOnememoryEvent({
        id: `00000000-0000-7000-8000-${String(4000 + index).padStart(12, '0')}`,
        kind: 'error.raised',
        occurred_at: at(100),
        ingested_at: at(100),
        source: { runtime: 'claude-code', adapter_version: '1.0.0' },
        scope: { project_id: project.id },
        payload,
        content_hash: eventContentHash(payload),
        redactions: [],
      });
      if (!result.ok) throw new Error('cap fixture failed validation');
      const ingested = await world.storage.store.ingestEvent(result.value as OnememoryEvent);
      await world.storage.store.markEventProcessed(ingested.event_id);
    }

    const capped = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: project.id },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90, maxEventsPerRun: 7 },
    });
    expect(capped.truncated).toBeTrue();
    expect(capped.considered).toBe(7);
    expect(capped.purged).toBe(7);
    expect(capped.raw_events_remaining).toBe(5);
    expect(capped.warnings.some((warning) => warning.includes('the scan visited 7'))).toBeTrue();

    const resumed = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: project.id },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(resumed.truncated).toBeFalse();
    expect(resumed.purged).toBe(5);
    expect(resumed.raw_events_remaining).toBe(0);
  });

  test('a scoped pass never touches another project, and the unscoped pass covers every scope', async () => {
    const projectA = await world.storage.store.createProject({ name: 'scope-a' });
    const projectB = await world.storage.store.createProject({ name: 'scope-b' });
    for (const project of [projectA, projectB]) {
      const payload = {
        kind: 'file.changed',
        change: 'modified',
        path: `packages/${project.name}/src/file.ts`,
      };
      const result = validateOnememoryEvent({
        id: `00000000-0000-7000-8000-${project === projectA ? '00000000a001' : '00000000b001'}`,
        kind: 'file.changed',
        occurred_at: at(100),
        ingested_at: at(100),
        source: { runtime: 'claude-code', adapter_version: '1.0.0' },
        scope: { project_id: project.id },
        payload,
        content_hash: eventContentHash(payload),
        redactions: [],
      });
      if (!result.ok) throw new Error('scope fixture failed validation');
      const ingested = await world.storage.store.ingestEvent(result.value as OnememoryEvent);
      await world.storage.store.markEventProcessed(ingested.event_id);
    }

    const scoped = await runEventsCompaction({
      compactor: world.storage.compactor,
      scope: { project_id: projectA.id },
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(scoped.purged).toBe(1);
    expect(await world.storage.compactor.countRawEvents({ project_id: projectA.id })).toBe(0);
    expect(await world.storage.compactor.countRawEvents({ project_id: projectB.id })).toBe(1);

    const unscoped = await runEventsCompaction({
      compactor: world.storage.compactor,
      now: () => NOW,
      config: { summaryWindowDays: 30, retentionWindowDays: 90 },
    });
    expect(unscoped.scope.project_id).toBeNull();
    // Project B's leftover plus the keep-forever project's 400d-old event (digested earlier,
    // now simply past the retention window). The main project's blocked rows stay.
    expect(unscoped.purged).toBe(2);
    expect(await world.storage.compactor.countRawEvents({ project_id: projectB.id })).toBe(0);
  });
});
