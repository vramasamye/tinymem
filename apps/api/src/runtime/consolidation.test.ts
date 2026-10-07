/**
 * The daemon-side consolidation orchestration (M14 follow-up 1): the `consolidate` / `decay` job
 * bodies and the interval scheduler that feeds them.
 *
 * Real embedded storage: the store, the transition machine, and the audit trail are the real ones;
 * only the router is a double (offline — no `conflict` route).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokens, type MemoryRecord, type NewMemory } from '@onememory-ai/core';
import { createEmbeddedDb, type OnememoryStorage } from '@onememory-ai/storage';

import { FakeRouter } from '@onememory-ai/consolidation/testing';

import { createConsolidationOrchestration, createConsolidationScheduler, DECAY_STAGES } from './consolidation';
import type { SchedulerTimer } from '@onememory-ai/codememory';

const NOW = new Date('2026-10-01T00:00:00.000Z');

interface World {
  storage: OnememoryStorage;
  dataDir: string;
  projectId: string;
  sourceId: string;
  faded: MemoryRecord;
  version20: MemoryRecord;
  version22: MemoryRecord;
}

let world: World;

async function insert(storage: OnememoryStorage, projectId: string, sourceId: string, candidate: NewMemory): Promise<MemoryRecord> {
  const write = await storage.store.insertMemory(candidate);
  expect(write.outcome).toBe('inserted');
  return write.memory;
}

function memoryOf(
  projectId: string,
  sourceId: string,
  content: string,
  observed_at: string,
  extra: Partial<NewMemory> = {},
): NewMemory {
  return {
    type: 'episodic',
    content,
    importance: 0.65,
    confidence: 0.7,
    observed_at,
    project_id: projectId,
    source_id: sourceId,
    evidence: [{ source_id: sourceId, kind: 'message', locator: `session.jsonl:${content}`, excerpt: content }],
    extraction: { method: 'heuristic', prompt_version: 'fixture-v1', adapter: 'extraction' },
    tags: ['extracted'],
    token_estimate: estimateTokens(content),
    ...extra,
  };
}

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-orch-'));
  const storage = await createEmbeddedDb(dataDir);
  const project = await storage.store.createProject({ name: 'orch-fixture', root_path: dataDir });
  const source = await storage.store.createSource({
    kind: 'conversation',
    uri: 'session/orch-fixture',
    title: 'orch fixture',
    project_id: project.id,
  });
  const faded = await insert(storage, project.id, source.id, memoryOf(project.id, source.id, 'Wrote notes about the migration plan', '2024-01-01T00:00:00.000Z', { importance: 0.2, confidence: 0.4 }));
  const version20 = await insert(storage, project.id, source.id, memoryOf(project.id, source.id, 'Version: Node 20', '2026-01-10T00:00:00.000Z', { type: 'decision', importance: 0.9 }));
  const version22 = await insert(storage, project.id, source.id, memoryOf(project.id, source.id, 'Version: Node 22', '2026-06-10T00:00:00.000Z', { type: 'decision', importance: 0.9 }));
  world = { storage, dataDir, projectId: project.id, sourceId: source.id, faded, version20, version22 };
});

afterAll(async () => {
  await world.storage.close();
  await rm(world.dataDir, { recursive: true, force: true });
});

describe('createConsolidationOrchestration', () => {
  test('the consolidate job runs every pass and invalidates the cache for the project', async () => {
    const invalidated: string[] = [];
    const orchestration = createConsolidationOrchestration({
      store: world.storage.store,
      router: new FakeRouter(),
      now: () => NOW,
      invalidateCache: (projectId) => invalidated.push(projectId),
    });

    const report = await orchestration.run({ project_id: world.projectId });
    expect(report.contradictions.resolved).toBe(1); // the version pair resolved
    expect(report.decay.archived).toBeGreaterThanOrEqual(1); // the faded note archived
    expect(invalidated).toEqual([world.projectId]);
    expect(orchestration.status().last_ran_at).toBe(NOW.toISOString());
  });

  test('the decay job runs ONLY the decay pass — the contradiction pair is untouched', async () => {
    const invalidated: string[] = [];
    const orchestration = createConsolidationOrchestration({
      store: world.storage.store,
      router: new FakeRouter(),
      now: () => NOW,
      invalidateCache: (projectId) => invalidated.push(projectId),
    });

    const report = await orchestration.run({ project_id: world.projectId, stages: DECAY_STAGES });
    expect(report.contradictions).toEqual({ pairs: 0, resolved: 0, disputed_pairs: 0, records: [], skipped: [] });
    expect(report.merge.clusters).toBe(0);
    expect(report.derivations.derived).toBe(0);
    expect(invalidated).toEqual([world.projectId]);
  });
});

describe('createConsolidationScheduler', () => {
  function manualTimer(): { timer: SchedulerTimer; fire: () => Promise<void>; armed: () => number } {
    let callback: (() => void) | null = null;
    let count = 0;
    return {
      timer: {
        set(fn) {
          callback = fn;
          count += 1;
          return count;
        },
        clear() {
          callback = null;
        },
      },
      async fire() {
        const fn = callback;
        callback = null;
        fn?.();
        // Let the chained pass settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      armed: () => (callback === null ? 0 : 1),
    };
  }

  test('arms the timer and runs a pass per tick', async () => {
    const manual = manualTimer();
    let ticks = 0;
    const scheduler = createConsolidationScheduler({
      intervalMs: 1000,
      tick: async () => {
        ticks += 1;
      },
      timer: manual.timer,
    });
    expect(scheduler.isRunning()).toBeFalse();
    scheduler.start();
    expect(scheduler.isRunning()).toBeTrue();
    expect(manual.armed()).toBe(1);
    await manual.fire();
    expect(ticks).toBe(1);
    expect(manual.armed()).toBe(1); // re-armed after the pass settled
    await scheduler.stop();
    expect(scheduler.isRunning()).toBeFalse();
    expect(manual.armed()).toBe(0);
  });

  test('intervalMs <= 0 disables the schedule entirely (never arms the timer)', async () => {
    const manual = manualTimer();
    const scheduler = createConsolidationScheduler({ intervalMs: 0, tick: async () => {}, timer: manual.timer });
    scheduler.start();
    expect(scheduler.isRunning()).toBeFalse();
    expect(manual.armed()).toBe(0);
  });
});
